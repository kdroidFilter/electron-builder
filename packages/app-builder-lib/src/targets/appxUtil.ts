import { asArray, InvalidConfigurationError, log } from "builder-util"
import type { MsixWindowsService, MsixSharedPackageContainer } from "../options/MsixOptions"
import { Nullish } from "builder-util-runtime"
import { readdir, readFile } from "fs-extra"
import * as path from "path"
import { FileAssociation } from "../options/FileAssociation"
import { Protocol } from "../options/PlatformSpecificBuildOptions"
import { VmManager } from "../vm/vm"
import { CAPABILITIES, isValidCapabilityName } from "./AppxCapabilities"

export const APPX_ASSETS_DIR_NAME = "appx"

/** Escapes a string for safe use as an XML attribute value (double-quoted). Also valid for element text. */
export function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * Manifest macros whose substituted values are raw user/config text and therefore must be
 * XML-escaped before being placed into the (Appx/MSIX) manifest. Every other macro either
 * returns a prebuilt XML fragment (capabilities, extensions, lockScreen, defaultTile,
 * splashScreen, resourceLanguages, sharedPackageContainer, packageIntegrity) or a
 * validated/constant value (version, applicationId, identityName, arch, logo, square*Logo)
 * and must NOT be escaped.
 *
 * Note: `publisher` is emitted inside a single-quoted attribute (`Publisher='...'`). escapeXmlAttr
 * covers `& < >` (and harmlessly `"`), but not `'`; a `'` in a certificate CN remains a known
 * limitation of the single-quoted template.
 */
export const RAW_TEXT_MANIFEST_MACROS: ReadonlySet<string> = new Set([
  "publisher",
  "publisherDisplayName",
  "executable",
  "displayName",
  "description",
  "backgroundColor",
  "minVersion",
  "maxVersionTested",
])

/**
 * Substitutes `${macro}` placeholders in an Appx/MSIX manifest template. `resolve` returns the
 * RAW value for a macro; values for macros in {@link RAW_TEXT_MANIFEST_MACROS} are XML-escaped
 * here so individual call sites cannot forget to. `resolve` may throw for unknown macros.
 */
export function substituteManifestMacros(template: string, resolve: (macro: string) => string): string {
  return template.replace(/\${([a-zA-Z0-9]+)}/g, (_match, macro: string): string => {
    const value = resolve(macro)
    return RAW_TEXT_MANIFEST_MACROS.has(macro) ? escapeXmlAttr(value) : value
  })
}

export const DEFAULT_RESOURCE_LANG = "en-US"

export const vendorAssetsForDefaultAssets: Record<string, string> = {
  "StoreLogo.png": "SampleAppx.50x50.png",
  "Square150x150Logo.png": "SampleAppx.150x150.png",
  "Square44x44Logo.png": "SampleAppx.44x44.png",
  "Wide310x150Logo.png": "SampleAppx.310x150.png",
}

export const restrictedApplicationIdValues = [
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

export async function computeUserAssets(vm: VmManager, vendorPath: string, userAssetDir: string | null) {
  const mappings: Array<string> = []
  let userAssets: Array<string>
  const allAssets: Array<string> = []
  if (userAssetDir == null) {
    userAssets = []
  } else {
    userAssets = (await readdir(userAssetDir)).filter(it => !it.startsWith(".") && !it.endsWith(".db") && it.includes("."))
    for (const name of userAssets) {
      mappings.push(`"${vm.toVmFile(userAssetDir)}${vm.pathSep}${name}" "assets\\${name}"`)
      allAssets.push(path.join(userAssetDir, name))
    }
  }

  for (const defaultAsset of Object.keys(vendorAssetsForDefaultAssets)) {
    if (userAssets.length === 0 || !isDefaultAssetIncluded(userAssets, defaultAsset)) {
      const file = path.join(vendorPath, "appxAssets", vendorAssetsForDefaultAssets[defaultAsset])
      mappings.push(`"${vm.toVmFile(file)}" "assets\\${defaultAsset}"`)
      allAssets.push(file)
    }
  }

  return { userAssets, mappings, allAssets }
}

export function validateApplicationId(result: string, contextLabel: string): void {
  const validCharactersRegex = /^([A-Za-z][A-Za-z0-9]*)(\.[A-Za-z][A-Za-z0-9]*)*$/
  if (result.length < 1 || result.length > 64) {
    throw new InvalidConfigurationError(`${contextLabel} Application.Id must be between 1 and 64 characters in length: ${result}`)
  }
  if (!validCharactersRegex.test(result)) {
    throw new InvalidConfigurationError(
      `${contextLabel} Application.Id must contain only alpha-numeric characters separated by periods, where each segment starts with an alphabetic character: ${result}`
    )
  }
  if (restrictedApplicationIdValues.includes(result.toUpperCase())) {
    throw new InvalidConfigurationError(`${contextLabel} Application.Id cannot contain restricted values ${JSON.stringify(restrictedApplicationIdValues)}: ${result}`)
  }
}

export function validateIdentityName(result: string, contextLabel: string): void {
  const validCharactersRegex = /^[a-zA-Z0-9.-]+$/
  if (result.length < 3 || result.length > 50) {
    throw new InvalidConfigurationError(`${contextLabel} identityName must be between 3 and 50 characters in length: ${result}`)
  }
  if (!validCharactersRegex.test(result)) {
    throw new InvalidConfigurationError(`${contextLabel} identityName must contain only alpha-numeric, period, and dash characters: ${result}`)
  }
  if (restrictedApplicationIdValues.includes(result.toUpperCase())) {
    throw new InvalidConfigurationError(`${contextLabel} identityName cannot contain restricted values ${JSON.stringify(restrictedApplicationIdValues)}: ${result}`)
  }
}

export function resourceLanguageTag(userLanguages: Array<string> | Nullish): string {
  if (userLanguages == null || userLanguages.length === 0) {
    userLanguages = [DEFAULT_RESOURCE_LANG]
  }
  return userLanguages.map(it => `<Resource Language="${escapeXmlAttr(it.trim().replace(/_/g, "-"))}" />`).join("\n")
}

export function lockScreenTag(userAssets: Array<string>): string {
  if (isDefaultAssetIncluded(userAssets, "BadgeLogo.png")) {
    return '<uap:LockScreen Notification="badgeAndTileText" BadgeLogo="assets\\BadgeLogo.png" />'
  }
  return ""
}

export function defaultTileTag(userAssets: Array<string>, showNameOnTiles: boolean): string {
  const defaultTiles: Array<string> = ["<uap:DefaultTile", 'Wide310x150Logo="assets\\Wide310x150Logo.png"']

  if (isDefaultAssetIncluded(userAssets, "LargeTile.png")) {
    defaultTiles.push('Square310x310Logo="assets\\LargeTile.png"')
  }
  if (isDefaultAssetIncluded(userAssets, "SmallTile.png")) {
    defaultTiles.push('Square71x71Logo="assets\\SmallTile.png"')
  }

  if (showNameOnTiles) {
    defaultTiles.push(">")
    defaultTiles.push("<uap:ShowNameOnTiles>")
    defaultTiles.push("<uap:ShowOn", 'Tile="wide310x150Logo"', "/>")
    defaultTiles.push("<uap:ShowOn", 'Tile="square150x150Logo"', "/>")
    defaultTiles.push("</uap:ShowNameOnTiles>")
    defaultTiles.push("</uap:DefaultTile>")
  } else {
    defaultTiles.push("/>")
  }
  return defaultTiles.join(" ")
}

export function splashScreenTag(userAssets: Array<string>): string {
  if (isDefaultAssetIncluded(userAssets, "SplashScreen.png")) {
    return '<uap:SplashScreen Image="assets\\SplashScreen.png" />'
  }
  return ""
}

export function isDefaultAssetIncluded(userAssets: Array<string>, defaultAsset: string): boolean {
  const defaultAssetName = defaultAsset.substring(0, defaultAsset.indexOf("."))
  return userAssets.some(it => it.includes(defaultAssetName))
}

export function isScaledAssetsProvided(userAssets: Array<string>): boolean {
  return userAssets.some(it => it.includes(".scale-") || it.includes(".targetsize-"))
}

/**
 * Resolves the final applicationId value from config, stripping any leading numeric prefix
 * from identityName (a common user mistake), then validates it.
 */
export function resolvePackageApplicationId(applicationId: string | undefined, identityName: string | null | undefined, appName: string, contextLabel: string): string {
  let result: string
  const identitynumber = parseInt(identityName as string, 10) || NaN

  if (applicationId) {
    result = applicationId
  } else if (!isNaN(identitynumber) && identityName !== null && identityName !== undefined) {
    if (identityName[0] === "0") {
      log.warn(`Remove the 0${identitynumber}`)
      result = identityName.replace("0" + identitynumber.toString(), "")
    } else {
      log.warn(`Remove the ${identitynumber}`)
      result = identityName.replace(identitynumber.toString(), "")
    }
  } else {
    result = identityName || appName
  }

  validateApplicationId(result, contextLabel)
  return result
}

export function resolvePackageIdentityName(identityName: string | null | undefined, appName: string, contextLabel: string): string {
  const result = identityName || appName
  validateIdentityName(result, contextLabel)
  return result
}

export function buildCapabilitiesXml(capabilityNames: Array<string> | null | undefined): string {
  const caps = asArray(capabilityNames)
  const capSet = new Set(caps)

  const invalid = Array.from(capSet).filter(cap => !isValidCapabilityName(cap))
  if (invalid.length > 0) {
    throw new Error(`invalid windows capabilit${invalid.length === 1 ? "y" : "ies"} specified: ${invalid.join(", ")}`)
  }

  capSet.add("runFullTrust")

  const capabilityStrings = CAPABILITIES.filter(cap => capSet.has(cap.name)).map(cap => `  ${cap.toXMLString()}`)
  return capabilityStrings.join("\n")
}

export interface ExtensionsInput {
  protocols: Array<Protocol>
  fileAssociations: Array<FileAssociation>
  addAutoLaunchExtension?: boolean
  customExtensionsPath?: string
  appDir: string
  executable: string
  displayName: string
  dependencyNames?: Record<string, string> | null
}

export async function buildExtensionsXml(input: ExtensionsInput): Promise<string> {
  const { protocols, fileAssociations, appDir, executable, displayName, customExtensionsPath } = input

  let isAddAutoLaunch = input.addAutoLaunchExtension
  if (isAddAutoLaunch === undefined) {
    isAddAutoLaunch = input.dependencyNames != null && input.dependencyNames["electron-winstore-auto-launch"] != null
  }

  if (!isAddAutoLaunch && protocols.length === 0 && fileAssociations.length === 0 && customExtensionsPath === undefined) {
    return ""
  }

  let extensions = "<Extensions>"

  if (isAddAutoLaunch) {
    extensions += `
        <desktop:Extension Category="windows.startupTask" Executable="${escapeXmlAttr(executable)}" EntryPoint="Windows.FullTrustApplication">
          <desktop:StartupTask TaskId="SlackStartup" Enabled="true" DisplayName="${escapeXmlAttr(displayName)}" />
        </desktop:Extension>`
  }

  for (const protocol of protocols) {
    for (const scheme of asArray(protocol.schemes)) {
      extensions += `
          <uap:Extension Category="windows.protocol">
            <uap:Protocol Name="${escapeXmlAttr(scheme)}">
               <uap:DisplayName>${escapeXmlAttr(protocol.name)}</uap:DisplayName>
             </uap:Protocol>
          </uap:Extension>`
    }
  }

  for (const fileAssociation of fileAssociations) {
    for (const ext of asArray(fileAssociation.ext)) {
      const extEsc = escapeXmlAttr(ext)
      extensions += `
          <uap:Extension Category="windows.fileTypeAssociation">
            <uap:FileTypeAssociation Name="${extEsc}">
              <uap:SupportedFileTypes>
                <uap:FileType>.${extEsc}</uap:FileType>
              </uap:SupportedFileTypes>
            </uap:FileTypeAssociation>
          </uap:Extension>`
    }
  }

  if (customExtensionsPath !== undefined) {
    const extensionsPath = path.resolve(appDir, customExtensionsPath)
    extensions += await readFile(extensionsPath, "utf8")
  }

  extensions += "</Extensions>"
  return extensions
}

export function buildWindowsServicesXml(services: ReadonlyArray<MsixWindowsService> | undefined, defaultExecutable: string): string {
  if (!services || services.length === 0) {
    return ""
  }
  return services
    .map(svc => {
      const exe = escapeXmlAttr(svc.executable || defaultExecutable)
      const startupType = escapeXmlAttr(svc.startupType ?? "manual")
      const argsAttr = svc.arguments != null ? ` Arguments="${escapeXmlAttr(svc.arguments)}"` : ""
      return `
        <desktop6:Extension Category="windows.service" Executable="${exe}" EntryPoint="Windows.FullTrustApplication">
          <desktop6:Service Name="${escapeXmlAttr(svc.name)}" StartupType="${startupType}"${argsAttr} />
        </desktop6:Extension>`
    })
    .join("")
}

export function buildSharedPackageContainerXml(container: MsixSharedPackageContainer | null | undefined): string {
  if (!container) {
    return ""
  }
  const members = (container.memberPackages ?? []).map(pkg => `    <desktop9:Package FamilyName="${escapeXmlAttr(pkg)}" />`).join("\n")
  return `<desktop9:SharedPackageContainer Name="${escapeXmlAttr(container.name)}">\n${members}\n  </desktop9:SharedPackageContainer>`
}

export function buildStartMenuGroupXml(startMenuGroup: string | undefined, _displayName: string): string {
  if (!startMenuGroup) {
    return ""
  }
  return `
        <desktop7:Extension Category="windows.appMigration">
          <desktop7:AppMigration AumId="${escapeXmlAttr(startMenuGroup)}" DeepLink="" />
        </desktop7:Extension>`
}
