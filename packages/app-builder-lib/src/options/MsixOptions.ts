import { TargetSpecificOptions } from "../core"

export interface MsixWindowsService {
  /** The service name used in the Windows Service Control Manager. */
  readonly name: string
  /**
   * Relative path to the service executable within the package.
   * Defaults to the main app executable.
   */
  readonly executable?: string
}

export interface MsixSharedPackageContainer {
  /** The name for the shared package container. */
  readonly name: string
  /** Package family names of member packages. */
  readonly memberPackages?: Array<string>
}

export interface MsixOptions extends TargetSpecificOptions {
  /**
   * The application id. Defaults to `identityName`. This string contains alpha-numeric fields separated by periods.
   * Each field must begin with an ASCII alphabetic character.
   */
  readonly applicationId?: string

  /**
   * The background color of the app tile.
   * @default #464646
   */
  readonly backgroundColor?: string | null

  /**
   * A friendly name displayed to users. Corresponds to Properties.DisplayName. Defaults to the application product name.
   */
  readonly displayName?: string | null

  /**
   * The package identity name. Corresponds to Identity.Name. Defaults to the application name.
   */
  readonly identityName?: string | null

  /**
   * The Windows Store publisher. Not used if MSIX is built for testing.
   */
  readonly publisher?: string | null

  /**
   * A friendly name for the publisher displayed to users. Corresponds to Properties.PublisherDisplayName.
   * Defaults to company name from the application metadata.
   */
  readonly publisherDisplayName?: string | null

  /**
   * The list of supported languages listed in the Windows Store. The first entry (index 0) will be the default language.
   * @default ["en-US"]
   */
  readonly languages?: Array<string> | string | null

  /**
   * Whether to add auto launch extension. Defaults to `true` if electron-winstore-auto-launch is in the dependencies.
   */
  readonly addAutoLaunchExtension?: boolean

  /**
   * Relative path to custom extensions xml to be included in the AppxManifest.xml.
   */
  readonly customExtensionsPath?: string

  /**
   * The list of capabilities to be added to the AppxManifest.xml.
   * The `runFullTrust` capability is obligatory for Electron apps and will be auto-added if not specified.
   * @default ["runFullTrust"]
   */
  readonly capabilities?: Array<string> | null

  /**
   * Relative path to a custom AppxManifest.xml template located in the build resources directory.
   * Supports the same ${} template macros as the default template, plus MSIX-specific ones:
   * ${packageIntegrity}, ${windowsServices}, ${sharedPackageContainer}, ${startMenuGroups}
   */
  readonly customManifestPath?: string

  /**
   * Whether to overlay the app's name on top of tile images on the Start screen.
   * @default false
   */
  readonly showNameOnTiles?: boolean

  /** @private */
  readonly electronUpdaterAware?: boolean

  /**
   * Whether to set the build number in the version field.
   * @default false
   */
  readonly setBuildNumber?: boolean

  /**
   * Set the MinVersion field in the AppxManifest.xml.
   * @default "10.0.17763.0" (Windows 10 version 1809 — minimum for Store submissions)
   */
  readonly minVersion?: string | null

  /**
   * Set the MaxVersionTested field in the AppxManifest.xml.
   * @default same as minVersion
   */
  readonly maxVersionTested?: string | null

  /** @private */
  readonly makeappxArgs?: Array<string> | null

  /**
   * Whether to produce a .msixbundle when more than one architecture is built.
   * @default true
   */
  readonly createMsixbundle?: boolean

  /**
   * Whether to produce a .msixupload archive suitable for submission to the Microsoft Store Partner Center.
   * @default false
   */
  readonly createMsixupload?: boolean

  /**
   * Enforce package integrity (uap10:PackageIntegrity). Requires Windows 10 version 2004 (build 19041) or later.
   * When enabled, Windows verifies that no files have been tampered with after the package was signed.
   * @default false
   */
  readonly enforcePackageIntegrity?: boolean

  /**
   * Windows Services to register with the MSIX package (desktop6 namespace).
   * Requires Windows 10 version 2004 or later.
   */
  readonly windowsServices?: Array<MsixWindowsService>

  /**
   * Shared Package Container configuration (desktop9 namespace).
   * Allows multiple packages to share a single app container. Requires Windows 11.
   */
  readonly sharedPackageContainer?: MsixSharedPackageContainer

  /**
   * Start menu group name for the application (desktop7 namespace).
   * Groups the app with other apps in the Start menu. Requires Windows 11.
   */
  readonly startMenuGroup?: string
}
