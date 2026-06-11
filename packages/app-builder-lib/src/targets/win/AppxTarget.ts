import { Arch, asArray, copyOrLinkFile, InvalidConfigurationError, log, walk } from "builder-util"
import { Nullish } from "builder-util-runtime"

import * as path from "path"
import { AppXOptions } from "../../index.js"
import { getWindowsKitsBundle, isOldWin6 } from "../../toolsets/winCodeSign.js"
import { Target } from "../../core.js"
import { getTemplatePath } from "../../util/pathManager.js"
import { VmManager } from "../../vm/vm.js"
import { WinPackager } from "../../winPackager.js"
import { createStageDir } from "../targetUtil.js"
import { CAPABILITIES, isValidCapabilityName } from "./AppxCapabilities.js"
import _fsExtra from "fs-extra"
const { emptyDir, readdir, readFile, writeFile } = _fsExtra

const APPX_ASSETS_DIR_NAME = "appx"

const vendorAssetsForDefaultAssets: Record<string, string> = {
  "StoreLogo.png": "SampleAppx.50x50.png",
  "Square150x150Logo.png": "SampleAppx.150x150.png",
  "Square44x44Logo.png": "SampleAppx.44x44.png",
  "Wide310x150Logo.png": "SampleAppx.310x150.png",
}

const restrictedApplicationIdValues = [
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]

const DEFAULT_RESOURCE_LANG = "en-US"

export default class AppXTarget extends Target {
  readonly options: AppXOptions = this.packager.getOptionsForTarget<AppXOptions>("appx")

  isAsyncSupported = false

  constructor(
    private readonly packager: WinPackager,
    readonly outDir: string
  ) {
    super("appx")

    if (process.platform !== "darwin" && (process.platform !== "win32" || isOldWin6())) {
      throw new Error("AppX is supported only on Windows 10 or Windows Server 2012 R2 (version number 6.3+)")
    }
  }

  // https://docs.microsoft.com/en-us/windows/uwp/packaging/create-app-package-with-makeappx-tool#mapping-files
  async build(appOutDir: string, arch: Arch): Promise<any> {
    const packager = this.packager
    const artifactName = packager.expandArtifactBeautyNamePattern(this.options, "appx", arch)
    const artifactPath = path.join(this.outDir, artifactName)
    await packager.emitArtifactBuildStarted({
      targetPresentableName: "AppX",
      file: artifactPath,
      arch,
    })

    const vendorPath = await getWindowsKitsBundle({ winCodeSign: this.packager.config.toolsets?.winCodeSign, arch: arch, resourcesDir: this.packager.buildResourcesDir })
    const vm = await packager.vm.value

    const stageDir = await createStageDir(this, packager, arch)

    const mappingFile = stageDir.getTempFile("mapping.txt")
    const makeAppXArgs = ["pack", "/o" /* overwrite the output file if it exists */, "/f", vm.toVmFile(mappingFile), "/p", vm.toVmFile(artifactPath)]
    if (packager.compression === "store") {
      makeAppXArgs.push("/nc")
    }

    const mappingList: Array<Array<string>> = []
    mappingList.push(
      await Promise.all(
        (await walk(appOutDir)).map(file => {
          let appxPath = file.substring(appOutDir.length + 1)
          if (path.sep !== "\\") {
            appxPath = appxPath.replace(/\//g, "\\")
          }
          return `"${vm.toVmFile(file)}" "app\\${appxPath}"`
        })
      )
    )

    const userAssetDir = await this.packager.getResource(undefined, APPX_ASSETS_DIR_NAME)
    const assetInfo = await computeUserAssets(vm, vendorPath.appxAssets, userAssetDir)
    const userAssets = assetInfo.userAssets

    const manifestFile = stageDir.getTempFile("AppxManifest.xml")
    await this.writeManifest(manifestFile, arch, await this.computePublisherName(), userAssets)

    await packager.emitAppxManifestCreated(manifestFile)
    mappingList.push(assetInfo.mappings)
    mappingList.push([`"${vm.toVmFile(manifestFile)}" "AppxManifest.xml"`])

    if (isScaledAssetsProvided(userAssets)) {
      const outFile = vm.toVmFile(stageDir.getTempFile("resources.pri"))
      const makePriPath = vm.toVmFile(path.join(vendorPath.kit, "makepri.exe"))

      const assetRoot = stageDir.getTempFile("appx/assets")
      await emptyDir(assetRoot)
      await Promise.all(assetInfo.allAssets.map(it => copyOrLinkFile(it, path.join(assetRoot, path.basename(it)))))

      await vm.exec(makePriPath, [
        "new",
        "/Overwrite",
        "/Manifest",
        vm.toVmFile(manifestFile),
        "/ProjectRoot",
        vm.toVmFile(path.dirname(assetRoot)),
        "/ConfigXml",
        vm.toVmFile(path.join(getTemplatePath("appx"), "priconfig.xml")),
        "/OutputFile",
        outFile,
      ])

      // in addition to resources.pri, resources.scale-140.pri and other such files will be generated
      for (const resourceFile of (await readdir(stageDir.dir)).filter(it => it.startsWith("resources.")).sort()) {
        mappingList.push([`"${vm.toVmFile(stageDir.getTempFile(resourceFile))}" "${resourceFile}"`])
      }
      makeAppXArgs.push("/l")
    }

    let mapping = "[Files]"
    for (const list of mappingList) {
      mapping += "\r\n" + list.join("\r\n")
    }
    await writeFile(mappingFile, mapping)
    packager.debugLogger.add("appx.mapping", mapping)

    if (this.options.makeappxArgs != null) {
      makeAppXArgs.push(...this.options.makeappxArgs)
    }
    this.buildQueueManager.add(async () => {
      await vm.exec(vm.toVmFile(path.join(vendorPath.kit, "makeappx.exe")), makeAppXArgs)
      await packager.signIf(artifactPath)

      await stageDir.cleanup()

      await packager.emitArtifactBuildCompleted({
        file: artifactPath,
        packager,
        arch,
        safeArtifactName: packager.computeSafeArtifactName(artifactName, "appx"),
        target: this,
        isWriteUpdateInfo: this.options.electronUpdaterAware,
      })
    })
  }

  // https://github.com/electron-userland/electron-builder/issues/2108#issuecomment-333200711
  private async computePublisherName() {
    const signtoolManager = await this.packager.signingManager.value
    return signtoolManager.computePublisherName(this, this.options.publisher)
  }

  private async writeManifest(outFile: string, arch: Arch, publisher: string, userAssets: Array<string>) {
    const appInfo = this.packager.appInfo
    const options = this.options
    const executable = `app\\${appInfo.productFilename}.exe`
    const displayName = options.displayName || appInfo.productName
    const capabilities = this.getCapabilities()
    const extensions = await this.getExtensions(executable, displayName)
    const archSpecificMinVersion = arch === Arch.arm64 ? "10.0.16299.0" : "10.0.14316.0"

    const customManifestPath = await this.packager.getResource(this.options.customManifestPath)
    if (customManifestPath) {
      log.info({ manifestPath: log.filePath(customManifestPath) }, "custom appx manifest found")
    }
    const manifestFileContent = await readFile(customManifestPath || path.join(getTemplatePath("appx"), "appxmanifest.xml"), "utf8")
    const manifest = substituteManifestMacros(manifestFileContent, (p1): string => {
      switch (p1) {
        case "publisher":
          return publisher

        case "publisherDisplayName": {
          const name = options.publisherDisplayName || appInfo.companyName
          if (name == null) {
            throw new InvalidConfigurationError(`Please specify "author" in the application package.json — it is required because "appx.publisherDisplayName" is not set.`)
          }
          return name
        }

        case "version":
          return appInfo.getVersionInWeirdWindowsForm(options.setBuildNumber === true)

        case "applicationId":
          return resolvePackageApplicationId(options.applicationId, options.identityName, appInfo.name, "AppX")

        case "identityName":
          return resolvePackageIdentityName(options.identityName, appInfo.name, "AppX")

        case "executable":
          return executable

        case "displayName":
          return displayName

        case "description":
          return appInfo.description || appInfo.productName

        case "backgroundColor":
          return options.backgroundColor || "#464646"

        case "logo":
          return "assets\\StoreLogo.png"

        case "square150x150Logo":
          return "assets\\Square150x150Logo.png"

        case "square44x44Logo":
          return "assets\\Square44x44Logo.png"

        case "lockScreen":
          return lockScreenTag(userAssets)

        case "defaultTile":
          return defaultTileTag(userAssets, options.showNameOnTiles || false)

        case "splashScreen":
          return splashScreenTag(userAssets)

        case "arch":
          return arch === Arch.ia32 ? "x86" : arch === Arch.arm64 ? "arm64" : "x64"

        case "resourceLanguages":
          return resourceLanguageTag(asArray(options.languages))

        case "capabilities":
          return capabilities

        case "extensions":
          return extensions

        case "minVersion":
          return options.minVersion || archSpecificMinVersion

        case "maxVersionTested":
          return options.maxVersionTested || options.minVersion || archSpecificMinVersion

        default:
          throw new Error(`Macro ${p1} is not defined`)
      }
    })
    await writeFile(outFile, manifest)
  }

  private getCapabilities(): string {
    const inner = buildCapabilitiesXml(this.options.capabilities)
    return `<Capabilities>\n${inner}\n</Capabilities>`
  }

  private async getExtensions(executable: string, displayName: string): Promise<string> {
    const uriSchemes = asArray(this.packager.config.protocols).concat(asArray(this.packager.platformOptions.protocols))

    const fileAssociations = asArray(this.packager.config.fileAssociations).concat(asArray(this.packager.platformOptions.fileAssociations))

    let isAddAutoLaunchExtension = this.options.addAutoLaunchExtension
    if (isAddAutoLaunchExtension === undefined) {
      const deps = this.packager.metadata.dependencies
      isAddAutoLaunchExtension = deps != null && deps["electron-winstore-auto-launch"] != null
    }

    if (!isAddAutoLaunchExtension && uriSchemes.length === 0 && fileAssociations.length === 0 && this.options.customExtensionsPath === undefined) {
      return ""
    }

    let extensions = "<Extensions>"

    if (isAddAutoLaunchExtension) {
      extensions += `
        <desktop:Extension Category="windows.startupTask" Executable="${executable}" EntryPoint="Windows.FullTrustApplication">
          <desktop:StartupTask TaskId="SlackStartup" Enabled="true" DisplayName="${displayName}" />
        </desktop:Extension>`
    }

    for (const protocol of uriSchemes) {
      for (const scheme of asArray(protocol.schemes)) {
        extensions += `
          <uap:Extension Category="windows.protocol">
            <uap:Protocol Name="${scheme}">
               <uap:DisplayName>${protocol.name}</uap:DisplayName>
             </uap:Protocol>
          </uap:Extension>`
      }
    }

    for (const fileAssociation of fileAssociations) {
      for (const ext of asArray(fileAssociation.ext)) {
        extensions += `
          <uap:Extension Category="windows.fileTypeAssociation">
            <uap:FileTypeAssociation Name="${ext}">
              <uap:SupportedFileTypes>
                <uap:FileType>.${ext}</uap:FileType>
              </uap:SupportedFileTypes>
            </uap:FileTypeAssociation>
          </uap:Extension>`
      }
    }

    if (this.options.customExtensionsPath !== undefined) {
      const extensionsPath = path.resolve(this.packager.appDir, this.options.customExtensionsPath)
      extensions += await readFile(extensionsPath, "utf8")
    }

    extensions += "</Extensions>"
    return extensions
  }
}
