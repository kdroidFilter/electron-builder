/**
 * Regression tests for Appx/MSIX manifest XML escaping.
 *
 * These are pure, cross-platform unit tests (no makeappx / no platform gating): they render the
 * real manifest templates with hostile inputs and assert the result is well-formed XML. This guards
 * the latent bug where raw config text (description, displayName, …) was interpolated unescaped into
 * attribute positions — note that appInfo's `smarten()` only fixes quotes, NOT `&`/`<`/`>`.
 */
import { readFileSync } from "fs"
import * as path from "path"
import { XMLValidator } from "fast-xml-parser"
import { RAW_TEXT_MANIFEST_MACROS, substituteManifestMacros } from "app-builder-lib/src/targets/appxUtil"

const TEMPLATES_DIR = path.join(__dirname, "../../../packages/app-builder-lib/templates")
const MSIX_TEMPLATE = path.join(TEMPLATES_DIR, "msix", "appxmanifest.xml")
const APPX_TEMPLATE = path.join(TEMPLATES_DIR, "appx", "appxmanifest.xml")

// Hostile / edge-case values for every macro the templates reference. Raw-text macros carry
// `& < > "` (and the smart quote left untouched by escaping); fragment macros are valid XML;
// validated/constant macros use plain values (they are intentionally NOT escaped).
const HOSTILE_DESCRIPTION = 'A & B <c> "q" “smart”'
const MACRO_VALUES: Record<string, string> = {
  // raw text (must be escaped by substituteManifestMacros)
  publisher: "CN=A & B",
  publisherDisplayName: "Pub & <Co>",
  executable: "app\\A & B.exe",
  displayName: 'A & B <c> "q"',
  description: HOSTILE_DESCRIPTION,
  backgroundColor: "#464646",
  minVersion: "10.0.17763.0",
  maxVersionTested: "10.0.17763.0",
  // validated / constant (NOT escaped — must contain no special chars)
  identityName: "MyApp",
  applicationId: "MyApp",
  arch: "x64",
  version: "1.0.0.0",
  logo: "assets\\StoreLogo.png",
  square150x150Logo: "assets\\Square150x150Logo.png",
  square44x44Logo: "assets\\Square44x44Logo.png",
  // prebuilt XML fragments (must NOT be escaped)
  capabilities: '<Capabilities>\n  <rescap:Capability Name="runFullTrust"/>\n</Capabilities>',
  extensions: "",
  resourceLanguages: '<Resource Language="en-US" />',
  lockScreen: "",
  defaultTile: '<uap:DefaultTile Wide310x150Logo="assets\\Wide310x150Logo.png" />',
  splashScreen: "",
  packageIntegrity: '<uap10:PackageIntegrity Level="turnOn" />',
  sharedPackageContainer: "",
}

function renderTemplate(templatePath: string): string {
  const template = readFileSync(templatePath, "utf8")
  return substituteManifestMacros(template, macro => {
    if (!(macro in MACRO_VALUES)) {
      throw new Error(`Test does not provide a value for manifest macro '${macro}' — add it to MACRO_VALUES`)
    }
    return MACRO_VALUES[macro]
  })
}

// ─── substituteManifestMacros (helper logic) ──────────────────────────────────

test("substituteManifestMacros: escapes raw-text macros, emits XML fragments verbatim", ({ expect }) => {
  const out = substituteManifestMacros('<a d="${description}">${capabilities}</a>', macro => {
    switch (macro) {
      case "description":
        return 'A & B <c> "q"'
      case "capabilities":
        return '<Capabilities><Capability Name="x"/></Capabilities>'
      default:
        throw new Error(`unexpected macro ${macro}`)
    }
  })
  expect(out).toBe('<a d="A &amp; B &lt;c&gt; &quot;q&quot;"><Capabilities><Capability Name="x"/></Capabilities></a>')
})

test("substituteManifestMacros: propagates resolver errors for unknown macros", ({ expect }) => {
  expect(() =>
    substituteManifestMacros("${nope}", () => {
      throw new Error("Macro nope is not defined")
    })
  ).toThrow("Macro nope is not defined")
})

test("RAW_TEXT_MANIFEST_MACROS: raw-text macros escaped, fragment/constant macros not", ({ expect }) => {
  for (const m of ["publisher", "publisherDisplayName", "executable", "displayName", "description", "backgroundColor", "minVersion", "maxVersionTested"]) {
    expect(RAW_TEXT_MANIFEST_MACROS.has(m)).toBe(true)
  }
  for (const m of ["capabilities", "extensions", "lockScreen", "defaultTile", "splashScreen", "resourceLanguages", "sharedPackageContainer", "packageIntegrity", "version", "applicationId", "identityName", "arch", "logo"]) {
    expect(RAW_TEXT_MANIFEST_MACROS.has(m)).toBe(false)
  }
})

// ─── full-template well-formedness with hostile inputs ────────────────────────

test("MSIX template renders well-formed XML with hostile description/displayName", ({ expect }) => {
  const xml = renderTemplate(MSIX_TEMPLATE)
  expect(XMLValidator.validate(xml)).toBe(true)
  // description (with & and <, which smarten() does NOT fix) is escaped in both positions
  expect(xml).toContain("<Description>A &amp; B &lt;c&gt; &quot;q&quot; “smart”</Description>")
  expect(xml).toContain('Description="A &amp; B &lt;c&gt; &quot;q&quot; “smart”"')
  // no raw unescaped ampersand/angle bracket from the hostile inputs leaked through
  expect(xml).not.toContain("A & B <c>")
})

test("AppX template renders well-formed XML with hostile description/displayName", ({ expect }) => {
  const xml = renderTemplate(APPX_TEMPLATE)
  expect(XMLValidator.validate(xml)).toBe(true)
  expect(xml).toContain('Description="A &amp; B &lt;c&gt; &quot;q&quot; “smart”"')
  expect(xml).not.toContain("A & B <c>")
})
