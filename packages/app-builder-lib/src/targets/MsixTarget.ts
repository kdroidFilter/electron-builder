import { Arch, asArray, copyOrLinkFile, exec, InvalidConfigurationError, log, walk } from "builder-util"
import { getPath7za } from "../toolsets/7zip"
import { deepAssign } from "builder-util-runtime"
import { emptyDir, mkdirs, readdir, readFile, remove, writeFile } from "fs-extra"
import * as path from "path"
import { MsixOptions } from "../options/MsixOptions"
import { getWindowsKitsBundle } from "../toolsets/windows"
import { Target } from "../core"
import { getTemplatePath } from "../util/pathManager"
import type { VmManager } from "../vm/vm"
import { WinPackager } from "../winPackager"
import { createStageDir } from "./targetUtil"
import { isOldWin6 } from "../toolsets/windows"
import {
  APPX_ASSETS_DIR_NAME,
  buildCapabilitiesXml,
  buildExtensionsXml,
  buildSharedPackageContainerXml,
  buildStartMenuGroupXml,
  buildWindowsServicesXml,
  computeUserAssets,
  defaultTileTag,
  isScaledAssetsProvided,
  lockScreenTag,
  resolvePackageApplicationId,
  resolvePackageIdentityName,
  resourceLanguageTag,
  splashScreenTag,
  substituteManifestMacros,
} from "./appxUtil"

export default class MsixTarget extends Target {
  readonly options: MsixOptions = deepAssign({}, this.packager.platformSpecificBuildOptions, this.packager.config.msix)

  isAsyncSupported = false

  private readonly builtPackages = new Map<Arch, string>()
  private vendorPathKit: string | null = null
  private vm: VmManager | null = null

  constructor(
    private readonly packager: WinPackager,
    readonly outDir: string
  ) {
    super("msix")

    if (process.platform !== "darwin" && (process.platform !== "win32" || isOldWin6())) {
      throw new Error("MSIX is supported on Windows 10 or Windows Server 2012 R2 (version number 6.3+) and on macOS via Parallels Desktop")
    }
  }

  async build(appOutDir: string, arch: Arch): Promise<any> {
    const packager = this.packager
    const toolsetVersion = packager.config.toolsets?.winCodeSign
    if (toolsetVersion == null || toolsetVersion === "0.0.0") {
      throw new InvalidConfigurationError(
        'MSIX packaging requires a modern Windows Kits toolset. Please set "toolsets.winCodeSign" to "1.0.0" or "1.1.0" in your build configuration. ' +
          "The legacy winCodeSign-2.6.0 bundle does not include the Windows SDK version required for MSIX support."
      )
    }

    const artifactName = packager.expandArtifactBeautyNamePattern(this.options, "msix", arch)
    const artifactPath = path.join(this.outDir, artifactName)
    await packager.info.emitArtifactBuildStarted({
      targetPresentableName: "MSIX",
      file: artifactPath,
      arch,
    })

    const vendorPath = await getWindowsKitsBundle({ winCodeSign: toolsetVersion, arch })
    const vm = await packager.vm.value

    // Cache for use in finishBuild
    this.vendorPathKit = vendorPath.kit
    this.vm = vm

    this.builtPackages.set(arch, artifactPath)

    const stageDir = await createStageDir(this, packager, arch)

    const mappingFile = stageDir.getTempFile("mapping.txt")
    const makeAppXArgs = ["pack", "/o", "/f", vm.toVmFile(mappingFile), "/p", vm.toVmFile(artifactPath)]
    if (packager.compression === "store") {
      makeAppXArgs.push("/nc")
    }

    const mappingList: Array<Array<string>> = []
    mappingList.push(
      await Promise.all(
        (await walk(appOutDir)).map(file => {
          let msixPath = file.substring(appOutDir.length + 1)
          if (path.sep !== "\\") {
            msixPath = msixPath.replace(/\//g, "\\")
          }
          return `"${vm.toVmFile(file)}" "app\\${msixPath}"`
        })
      )
    )

    const userAssetDir = await packager.getResource(undefined, APPX_ASSETS_DIR_NAME)
    const assetInfo = await computeUserAssets(vm, vendorPath.appxAssets, userAssetDir)
    const userAssets = assetInfo.userAssets

    const manifestFile = stageDir.getTempFile("AppxManifest.xml")
    await this.writeManifest(manifestFile, arch, await this.computePublisherName(), userAssets)

    await packager.info.emitAppxManifestCreated(manifestFile)
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
    packager.debugLogger.add("msix.mapping", mapping)

    if (this.options.makeappxArgs != null) {
      makeAppXArgs.push(...this.options.makeappxArgs)
    }

    this.buildQueueManager.add(async () => {
      try {
        await vm.exec(vm.toVmFile(path.join(vendorPath.kit, "makeappx.exe")), makeAppXArgs)
        await packager.signIf(artifactPath)
      } finally {
        await stageDir.cleanup()
      }
      await packager.info.emitArtifactBuildCompleted({
        file: artifactPath,
        packager,
        arch,
        safeArtifactName: packager.computeSafeArtifactName(artifactName, "msix"),
        target: this,
        isWriteUpdateInfo: this.options.electronUpdaterAware,
      })
    })
  }

  async finishBuild(): Promise<void> {
    await super.finishBuild()

    const packagePaths = Array.from(this.builtPackages.values())
    if (packagePaths.length === 0) {
      return
    }

    let bundlePath: string | undefined
    if (this.options.createMsixbundle !== false && packagePaths.length > 1) {
      bundlePath = await this.createMsixBundle(packagePaths)
    }

    if (this.options.createMsixupload === true) {
      await this.createMsixUpload(bundlePath ?? packagePaths[0])
    }
  }

  private async createMsixBundle(packagePaths: ReadonlyArray<string>): Promise<string> {
    const packager = this.packager
    const vm = this.vm!
    const kitPath = this.vendorPathKit!

    const bundleName = packager.expandArtifactBeautyNamePattern(this.options, "msixbundle", Arch.x64)
    const bundlePath = path.join(this.outDir, bundleName)

    await packager.info.emitArtifactBuildStarted({
      targetPresentableName: "MSIX Bundle",
      file: bundlePath,
      arch: null,
    })

    const stagingDir = path.join(this.outDir, ".msixbundle-staging")
    await mkdirs(stagingDir)
    try {
      await Promise.all(packagePaths.map(p => copyOrLinkFile(p, path.join(stagingDir, path.basename(p)))))
      await vm.exec(vm.toVmFile(path.join(kitPath, "makeappx.exe")), ["bundle", "/o", "/d", vm.toVmFile(stagingDir), "/p", vm.toVmFile(bundlePath)])
    } finally {
      await remove(stagingDir)
    }

    await packager.signIf(bundlePath)

    await packager.info.emitArtifactBuildCompleted({
      file: bundlePath,
      packager,
      arch: null,
      safeArtifactName: packager.computeSafeArtifactName(bundleName, "msixbundle"),
      target: this,
      isWriteUpdateInfo: false,
    })

    return bundlePath
  }

  private async createMsixUpload(sourcePath: string): Promise<void> {
    const packager = this.packager
    const uploadName = packager.expandArtifactBeautyNamePattern(this.options, "msixupload", Arch.x64)
    const uploadPath = path.join(this.outDir, uploadName)

    await packager.info.emitArtifactBuildStarted({
      targetPresentableName: "MSIX Upload",
      file: uploadPath,
      arch: null,
    })

    const sevenZa = await getPath7za()
    await exec(sevenZa, ["a", "-tzip", uploadPath, sourcePath])

    await packager.info.emitArtifactBuildCompleted({
      file: uploadPath,
      packager,
      arch: null,
      safeArtifactName: packager.computeSafeArtifactName(uploadName, "msixupload"),
      target: this,
      isWriteUpdateInfo: false,
    })
  }

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
    const defaultMinVersion = "10.0.17763.0"

    const customManifestPath = await this.packager.getResource(options.customManifestPath)
    if (customManifestPath) {
      log.info({ manifestPath: log.filePath(customManifestPath) }, "custom msix manifest found")
    }
    const manifestFileContent = await readFile(customManifestPath || path.join(getTemplatePath("msix"), "appxmanifest.xml"), "utf8")
    const manifest = substituteManifestMacros(manifestFileContent, (p1): string => {
      switch (p1) {
        case "publisher":
          return publisher

        case "publisherDisplayName": {
          const name = options.publisherDisplayName || appInfo.companyName
          if (name == null) {
            throw new InvalidConfigurationError(`Please specify "author" in the application package.json — it is required because "msix.publisherDisplayName" is not set.`)
          }
          return name
        }

        case "version":
          return appInfo.getVersionInWeirdWindowsForm(options.setBuildNumber === true)

        case "applicationId":
          return resolvePackageApplicationId(options.applicationId, options.identityName, appInfo.name, "MSIX")

        case "identityName":
          return resolvePackageIdentityName(options.identityName, appInfo.name, "MSIX")

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
          return options.minVersion || defaultMinVersion

        case "maxVersionTested":
          return options.maxVersionTested || options.minVersion || defaultMinVersion

        case "sharedPackageContainer":
          return buildSharedPackageContainerXml(options.sharedPackageContainer)

        case "packageIntegrity":
          // uap10:PackageIntegrity belongs inside <Properties>, not <Capabilities>
          return options.enforcePackageIntegrity === true ? '<uap10:PackageIntegrity Level="turnOn" />' : ""

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
    const packager = this.packager
    const options = this.options

    const baseExtensions = await buildExtensionsXml({
      protocols: asArray(packager.config.protocols).concat(asArray(packager.platformSpecificBuildOptions.protocols)),
      fileAssociations: asArray(packager.config.fileAssociations).concat(asArray(packager.platformSpecificBuildOptions.fileAssociations)),
      addAutoLaunchExtension: options.addAutoLaunchExtension,
      customExtensionsPath: options.customExtensionsPath,
      appDir: packager.info.appDir,
      executable,
      displayName,
      dependencyNames: packager.info.metadata.dependencies,
    })

    const servicesXml = buildWindowsServicesXml(options.windowsServices, executable)
    const startMenuXml = buildStartMenuGroupXml(options.startMenuGroup, displayName)

    if (!servicesXml && !startMenuXml) {
      return baseExtensions
    }

    if (baseExtensions === "") {
      return `<Extensions>${servicesXml}${startMenuXml}</Extensions>`
    }

    return baseExtensions.replace("</Extensions>", `${servicesXml}${startMenuXml}</Extensions>`)
  }
}
