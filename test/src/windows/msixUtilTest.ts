import {
  buildCapabilitiesXml,
  buildExtensionsXml,
  buildSharedPackageContainerXml,
  buildStartMenuGroupXml,
  buildWindowsServicesXml,
  defaultTileTag,
  escapeXmlAttr,
  isDefaultAssetIncluded,
  isScaledAssetsProvided,
  lockScreenTag,
  resolvePackageApplicationId,
  resolvePackageIdentityName,
  resourceLanguageTag,
  splashScreenTag,
  validateApplicationId,
  validateIdentityName,
} from "app-builder-lib/src/targets/appxUtil"

// ─── escapeXmlAttr ────────────────────────────────────────────────────────────

test("escapeXmlAttr: passes through plain strings unchanged", ({ expect }) => {
  expect(escapeXmlAttr("hello world")).toBe("hello world")
})

test("escapeXmlAttr: escapes double quotes", ({ expect }) => {
  expect(escapeXmlAttr('say "hi"')).toBe("say &quot;hi&quot;")
})

test("escapeXmlAttr: escapes ampersands", ({ expect }) => {
  expect(escapeXmlAttr("A&B")).toBe("A&amp;B")
})

test("escapeXmlAttr: escapes angle brackets", ({ expect }) => {
  expect(escapeXmlAttr("<script>")).toBe("&lt;script&gt;")
})

test("escapeXmlAttr: escapes combined special characters", ({ expect }) => {
  expect(escapeXmlAttr('<a href="x">test & demo</a>')).toBe("&lt;a href=&quot;x&quot;&gt;test &amp; demo&lt;/a&gt;")
})

// ─── validateApplicationId ────────────────────────────────────────────────────

test("validateApplicationId: accepts valid id", ({ expect }) => {
  expect(() => validateApplicationId("MyApp", "Test")).not.toThrow()
  expect(() => validateApplicationId("My.App.Id", "Test")).not.toThrow()
  expect(() => validateApplicationId("A", "Test")).not.toThrow()
  expect(() => validateApplicationId("A".repeat(64), "Test")).not.toThrow()
})

test("validateApplicationId: rejects id that is too short (empty)", ({ expect }) => {
  expect(() => validateApplicationId("", "Test")).toThrow("must be between 1 and 64")
})

test("validateApplicationId: rejects id that is too long (>64)", ({ expect }) => {
  expect(() => validateApplicationId("A".repeat(65), "Test")).toThrow("must be between 1 and 64")
})

test("validateApplicationId: rejects id with invalid characters", ({ expect }) => {
  expect(() => validateApplicationId("My-App", "Test")).toThrow("cannot contain")
  expect(() => validateApplicationId("1App", "Test")).toThrow("cannot contain")
})

test("validateApplicationId: rejects restricted DOS device names", ({ expect }) => {
  expect(() => validateApplicationId("CON", "Test")).toThrow("restricted values")
  expect(() => validateApplicationId("con", "Test")).toThrow("restricted values")
  expect(() => validateApplicationId("COM1", "Test")).toThrow("restricted values")
  expect(() => validateApplicationId("LPT9", "Test")).toThrow("restricted values")
})

// ─── validateIdentityName ─────────────────────────────────────────────────────

test("validateIdentityName: accepts valid identity name", ({ expect }) => {
  expect(() => validateIdentityName("MyApp", "Test")).not.toThrow()
  expect(() => validateIdentityName("My.App", "Test")).not.toThrow()
  expect(() => validateIdentityName("abc", "Test")).not.toThrow()
  expect(() => validateIdentityName("A".repeat(50), "Test")).not.toThrow()
})

test("validateIdentityName: rejects name shorter than 3 chars", ({ expect }) => {
  expect(() => validateIdentityName("AB", "Test")).toThrow("between 3 and 50")
})

test("validateIdentityName: rejects name longer than 50 chars", ({ expect }) => {
  expect(() => validateIdentityName("A".repeat(51), "Test")).toThrow("between 3 and 50")
})

test("validateIdentityName: rejects name with invalid characters", ({ expect }) => {
  expect(() => validateIdentityName("My App", "Test")).toThrow("cannot contain")
  expect(() => validateIdentityName("My@App", "Test")).toThrow("cannot contain")
})

test("validateIdentityName: rejects restricted DOS device names", ({ expect }) => {
  expect(() => validateIdentityName("CON", "Test")).toThrow("restricted values")
  expect(() => validateIdentityName("NUL", "Test")).toThrow("restricted values")
})

// ─── resourceLanguageTag ──────────────────────────────────────────────────────

test("resourceLanguageTag: null input defaults to en-US", ({ expect }) => {
  expect(resourceLanguageTag(null)).toBe('<Resource Language="en-US" />')
})

test("resourceLanguageTag: empty array defaults to en-US", ({ expect }) => {
  expect(resourceLanguageTag([])).toBe('<Resource Language="en-US" />')
})

test("resourceLanguageTag: single language", ({ expect }) => {
  expect(resourceLanguageTag(["de-DE"])).toBe('<Resource Language="de-DE" />')
})

test("resourceLanguageTag: multiple languages", ({ expect }) => {
  const result = resourceLanguageTag(["en-US", "de-DE", "ja-JP"])
  expect(result).toBe('<Resource Language="en-US" />\n<Resource Language="de-DE" />\n<Resource Language="ja-JP" />')
})

test("resourceLanguageTag: normalizes underscores to hyphens", ({ expect }) => {
  expect(resourceLanguageTag(["en_US"])).toBe('<Resource Language="en-US" />')
})

test("resourceLanguageTag: trims whitespace around language codes", ({ expect }) => {
  expect(resourceLanguageTag([" en-US "])).toBe('<Resource Language="en-US" />')
})

// ─── lockScreenTag ────────────────────────────────────────────────────────────

test("lockScreenTag: returns empty string when no BadgeLogo asset", ({ expect }) => {
  expect(lockScreenTag(["Square44x44Logo.png", "StoreLogo.png"])).toBe("")
})

test("lockScreenTag: returns lock screen element when BadgeLogo asset present", ({ expect }) => {
  const result = lockScreenTag(["BadgeLogo.scale-100.png"])
  expect(result).toBe('<uap:LockScreen Notification="badgeAndTileText" BadgeLogo="assets\\BadgeLogo.png" />')
})

// ─── defaultTileTag ───────────────────────────────────────────────────────────

test("defaultTileTag: basic tile without name overlay", ({ expect }) => {
  const result = defaultTileTag([], false)
  expect(result).toContain('Wide310x150Logo="assets\\Wide310x150Logo.png"')
  expect(result).not.toContain("ShowNameOnTiles")
  expect(result).toContain("/>")
})

test("defaultTileTag: includes LargeTile when present in assets", ({ expect }) => {
  const result = defaultTileTag(["LargeTile.png"], false)
  expect(result).toContain('Square310x310Logo="assets\\LargeTile.png"')
})

test("defaultTileTag: includes SmallTile when present in assets", ({ expect }) => {
  const result = defaultTileTag(["SmallTile.png"], false)
  expect(result).toContain('Square71x71Logo="assets\\SmallTile.png"')
})

test("defaultTileTag: adds ShowNameOnTiles when showNameOnTiles is true", ({ expect }) => {
  const result = defaultTileTag([], true)
  expect(result).toContain("<uap:ShowNameOnTiles>")
  expect(result).toContain('Tile="wide310x150Logo"')
  expect(result).toContain('Tile="square150x150Logo"')
  expect(result).toContain("</uap:DefaultTile>")
})

// ─── splashScreenTag ──────────────────────────────────────────────────────────

test("splashScreenTag: returns empty string when no SplashScreen asset", ({ expect }) => {
  expect(splashScreenTag(["StoreLogo.png"])).toBe("")
})

test("splashScreenTag: returns splash screen element when asset present", ({ expect }) => {
  expect(splashScreenTag(["SplashScreen.png"])).toBe('<uap:SplashScreen Image="assets\\SplashScreen.png" />')
})

// ─── isDefaultAssetIncluded ───────────────────────────────────────────────────

test("isDefaultAssetIncluded: detects exact match", ({ expect }) => {
  expect(isDefaultAssetIncluded(["StoreLogo.png"], "StoreLogo.png")).toBe(true)
})

test("isDefaultAssetIncluded: detects scaled variants", ({ expect }) => {
  expect(isDefaultAssetIncluded(["StoreLogo.scale-100.png"], "StoreLogo.png")).toBe(true)
})

test("isDefaultAssetIncluded: returns false when not present", ({ expect }) => {
  expect(isDefaultAssetIncluded(["Square44x44Logo.png"], "StoreLogo.png")).toBe(false)
})

// ─── isScaledAssetsProvided ───────────────────────────────────────────────────

test("isScaledAssetsProvided: returns false for plain assets", ({ expect }) => {
  expect(isScaledAssetsProvided(["StoreLogo.png", "Square44x44Logo.png"])).toBe(false)
})

test("isScaledAssetsProvided: returns true for .scale- variant", ({ expect }) => {
  expect(isScaledAssetsProvided(["BadgeLogo.scale-100.png"])).toBe(true)
})

test("isScaledAssetsProvided: returns true for .targetsize- variant", ({ expect }) => {
  expect(isScaledAssetsProvided(["Square44x44Logo.targetsize-16.png"])).toBe(true)
})

// ─── buildCapabilitiesXml ─────────────────────────────────────────────────────

test("buildCapabilitiesXml: always includes runFullTrust", ({ expect }) => {
  const result = buildCapabilitiesXml([])
  expect(result).toContain("runFullTrust")
})

test("buildCapabilitiesXml: includes requested capability", ({ expect }) => {
  const result = buildCapabilitiesXml(["internetClient"])
  expect(result).toContain('Name="internetClient"')
  expect(result).toContain("runFullTrust")
})

test("buildCapabilitiesXml: throws for invalid capability name", ({ expect }) => {
  expect(() => buildCapabilitiesXml(["fakeCapThatDoesNotExist"])).toThrow("invalid windows capabilit")
})

test("buildCapabilitiesXml: handles null input (defaults to runFullTrust only)", ({ expect }) => {
  const result = buildCapabilitiesXml(null)
  expect(result).toContain("runFullTrust")
})

test("buildCapabilitiesXml: includes uap-namespaced capabilities", ({ expect }) => {
  const result = buildCapabilitiesXml(["picturesLibrary"])
  expect(result).toContain('<uap:Capability Name="picturesLibrary"')
})

test("buildCapabilitiesXml: includes device capabilities", ({ expect }) => {
  const result = buildCapabilitiesXml(["webcam"])
  expect(result).toContain('<DeviceCapability Name="webcam"')
})

// ─── buildExtensionsXml ───────────────────────────────────────────────────────

test("buildExtensionsXml: returns empty string when nothing configured", async ({ expect }) => {
  const result = await buildExtensionsXml({
    protocols: [],
    fileAssociations: [],
    appDir: "/some/dir",
    executable: "app\\MyApp.exe",
    displayName: "My App",
  })
  expect(result).toBe("")
})

test("buildExtensionsXml: generates protocol handler extension", async ({ expect }) => {
  const result = await buildExtensionsXml({
    protocols: [{ name: "MyApp Protocol", schemes: ["myapp"] }],
    fileAssociations: [],
    appDir: "/some/dir",
    executable: "app\\MyApp.exe",
    displayName: "My App",
  })
  expect(result).toContain("<Extensions>")
  expect(result).toContain('Category="windows.protocol"')
  expect(result).toContain('Name="myapp"')
  expect(result).toContain("MyApp Protocol")
  expect(result).toContain("</Extensions>")
})

test("buildExtensionsXml: generates file association extension", async ({ expect }) => {
  const result = await buildExtensionsXml({
    protocols: [],
    fileAssociations: [{ ext: "myf" }],
    appDir: "/some/dir",
    executable: "app\\MyApp.exe",
    displayName: "My App",
  })
  expect(result).toContain('Category="windows.fileTypeAssociation"')
  expect(result).toContain('Name="myf"')
  expect(result).toContain(".myf")
})

test("buildExtensionsXml: adds auto-launch extension when dependency detected", async ({ expect }) => {
  const result = await buildExtensionsXml({
    protocols: [],
    fileAssociations: [],
    appDir: "/some/dir",
    executable: "app\\MyApp.exe",
    displayName: "My App",
    dependencyNames: { "electron-winstore-auto-launch": "1.0.0" },
  })
  expect(result).toContain('Category="windows.startupTask"')
  expect(result).toContain('"My App"')
})

test("buildExtensionsXml: explicit addAutoLaunchExtension=false prevents auto-launch even with dependency", async ({ expect }) => {
  const result = await buildExtensionsXml({
    protocols: [],
    fileAssociations: [],
    appDir: "/some/dir",
    executable: "app\\MyApp.exe",
    displayName: "My App",
    addAutoLaunchExtension: false,
    dependencyNames: { "electron-winstore-auto-launch": "1.0.0" },
  })
  expect(result).toBe("")
})

test("buildExtensionsXml: handles multiple schemes per protocol", async ({ expect }) => {
  const result = await buildExtensionsXml({
    protocols: [{ name: "MyApp", schemes: ["myapp", "myapp2"] }],
    fileAssociations: [],
    appDir: "/some/dir",
    executable: "app\\MyApp.exe",
    displayName: "My App",
  })
  expect(result).toContain('Name="myapp"')
  expect(result).toContain('Name="myapp2"')
})

test("buildExtensionsXml: handles multiple file associations each with multiple extensions", async ({ expect }) => {
  const result = await buildExtensionsXml({
    protocols: [],
    fileAssociations: [{ ext: ["txt", "log"] }, { ext: "md" }],
    appDir: "/some/dir",
    executable: "app\\MyApp.exe",
    displayName: "My App",
  })
  expect(result).toContain('Name="txt"')
  expect(result).toContain('Name="log"')
  expect(result).toContain('Name="md"')
})

// ─── resolvePackageApplicationId ─────────────────────────────────────────────

test("resolvePackageApplicationId: uses explicit applicationId when provided", ({ expect }) => {
  expect(resolvePackageApplicationId("MyExplicit", "SomeName", "appname", "Test")).toBe("MyExplicit")
})

test("resolvePackageApplicationId: falls back to identityName when no applicationId", ({ expect }) => {
  expect(resolvePackageApplicationId(undefined, "MyIdentity", "appname", "Test")).toBe("MyIdentity")
})

test("resolvePackageApplicationId: falls back to appName when both are absent", ({ expect }) => {
  expect(resolvePackageApplicationId(undefined, undefined, "myApp", "Test")).toBe("myApp")
})

test("resolvePackageApplicationId: strips leading numeric prefix from identityName", ({ expect }) => {
  // This is the numeric-prefix stripping behaviour preserved from the original AppX code
  const result = resolvePackageApplicationId(undefined, "12345Test.App", "appname", "Test")
  expect(result).toBe("Test.App")
})

test("resolvePackageApplicationId: strips leading zero-prefixed numeric from identityName", ({ expect }) => {
  const result = resolvePackageApplicationId(undefined, "01234Test.App", "appname", "Test")
  expect(result).toBe("Test.App")
})

test("resolvePackageApplicationId: throws for invalid resulting id", ({ expect }) => {
  expect(() => resolvePackageApplicationId("CON", undefined, "appname", "Test")).toThrow("restricted values")
})

// ─── resolvePackageIdentityName ───────────────────────────────────────────────

test("resolvePackageIdentityName: uses identityName when provided", ({ expect }) => {
  expect(resolvePackageIdentityName("MyId", "fallback", "Test")).toBe("MyId")
})

test("resolvePackageIdentityName: falls back to appName when identityName is null", ({ expect }) => {
  expect(resolvePackageIdentityName(null, "fallback", "Test")).toBe("fallback")
})

test("resolvePackageIdentityName: falls back to appName when identityName is undefined", ({ expect }) => {
  expect(resolvePackageIdentityName(undefined, "fallback", "Test")).toBe("fallback")
})

test("resolvePackageIdentityName: throws for invalid identity name", ({ expect }) => {
  expect(() => resolvePackageIdentityName("AB", "fallback", "Test")).toThrow("between 3 and 50")
})

// ─── buildWindowsServicesXml ──────────────────────────────────────────────────

test("buildWindowsServicesXml: returns empty string for undefined services", ({ expect }) => {
  expect(buildWindowsServicesXml(undefined, "app\\App.exe")).toBe("")
})

test("buildWindowsServicesXml: returns empty string for empty array", ({ expect }) => {
  expect(buildWindowsServicesXml([], "app\\App.exe")).toBe("")
})

test("buildWindowsServicesXml: generates service extension with default start type", ({ expect }) => {
  const result = buildWindowsServicesXml([{ name: "MySvc" }], "app\\App.exe")
  expect(result).toContain('Category="windows.service"')
  expect(result).toContain('Name="MySvc"')
  expect(result).toContain('StartType="auto"')
  expect(result).toContain('Executable="app\\App.exe"')
})

test("buildWindowsServicesXml: uses custom executable when provided", ({ expect }) => {
  const result = buildWindowsServicesXml([{ name: "MySvc", executable: "app\\svc.exe" }], "app\\App.exe")
  expect(result).toContain('Executable="app\\svc.exe"')
})

test("buildWindowsServicesXml: includes Arguments attribute when present", ({ expect }) => {
  const result = buildWindowsServicesXml([{ name: "MySvc", arguments: "--flag" }], "app\\App.exe")
  expect(result).toContain('Arguments="--flag"')
})

test("buildWindowsServicesXml: escapes special characters in service name", ({ expect }) => {
  const result = buildWindowsServicesXml([{ name: 'Svc "A" & B' }], "app\\App.exe")
  expect(result).toContain('Name="Svc &quot;A&quot; &amp; B"')
  expect(result).not.toContain('"Svc "A"')
})

test("buildWindowsServicesXml: generates multiple service extensions", ({ expect }) => {
  const result = buildWindowsServicesXml([{ name: "Svc1" }, { name: "Svc2", startType: "manual" }], "app\\App.exe")
  expect(result).toContain('Name="Svc1"')
  expect(result).toContain('Name="Svc2"')
  expect(result).toContain('StartType="manual"')
})

// ─── buildSharedPackageContainerXml ──────────────────────────────────────────

test("buildSharedPackageContainerXml: returns empty string for undefined", ({ expect }) => {
  expect(buildSharedPackageContainerXml(undefined)).toBe("")
})

test("buildSharedPackageContainerXml: generates container element", ({ expect }) => {
  const result = buildSharedPackageContainerXml({ name: "MyContainer" })
  expect(result).toContain('Name="MyContainer"')
  expect(result).toContain("desktop9:SharedPackageContainer")
})

test("buildSharedPackageContainerXml: includes member packages", ({ expect }) => {
  const result = buildSharedPackageContainerXml({ name: "MyContainer", memberPackages: ["com.example.App1_abc", "com.example.App2_xyz"] })
  expect(result).toContain('FamilyName="com.example.App1_abc"')
  expect(result).toContain('FamilyName="com.example.App2_xyz"')
})

test("buildSharedPackageContainerXml: escapes special chars in container name", ({ expect }) => {
  const result = buildSharedPackageContainerXml({ name: 'My"Container' })
  expect(result).toContain('Name="My&quot;Container"')
})

// ─── buildStartMenuGroupXml ───────────────────────────────────────────────────

test("buildStartMenuGroupXml: returns empty string when not configured", ({ expect }) => {
  expect(buildStartMenuGroupXml(undefined, "My App")).toBe("")
})

test("buildStartMenuGroupXml: generates desktop7 extension element", ({ expect }) => {
  const result = buildStartMenuGroupXml("My Suite", "My App")
  expect(result).toContain('Category="windows.appMigration"')
  expect(result).toContain("desktop7:AppMigration")
  expect(result).toContain('AumId="My App"')
})

test("buildStartMenuGroupXml: escapes special chars in displayName", ({ expect }) => {
  const result = buildStartMenuGroupXml("suite", 'My "App" & Co')
  expect(result).toContain('AumId="My &quot;App&quot; &amp; Co"')
})
