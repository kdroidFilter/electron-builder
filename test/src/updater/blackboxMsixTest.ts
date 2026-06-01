/**
 * MSIX blackbox e2e tests.
 *
 * These tests build real MSIX / .msixbundle packages, install them in a
 * Parallels Windows VM (or native Windows when running on CI), and verify
 * that `Get-AppxPackage` sees the installed package and that the manifest
 * contains the expected elements.
 *
 * Skip conditions:
 * - macOS without a Parallels Windows VM  → context.skip()
 * - Linux  → context.skip()
 */

import { PM } from "app-builder-lib/out/node-module-collector"
import { Arch, Platform } from "electron-builder"
import { move } from "fs-extra"
import * as os from "os"
import * as path from "path"
import { afterAll, beforeAll, TestContext } from "vitest"
import { assertPack, modifyPackageJson, PackedContext } from "../helpers/packTester"
import { ELECTRON_VERSION } from "../helpers/testConfig"
import { spawn } from "builder-util/out/util"
import { TmpDir } from "builder-util/out/util"
import { optionsForFlakyE2E, windowsVmPromise } from "./blackboxUpdateHelpers"
import { installMsixInVm, installMsixNative, launchMsixAppInVm, uninstallMsixInVm, uninstallMsixNative } from "./blackboxInstallMsix"
import type { MsixInstallResult } from "./blackboxInstallMsix"

// Route all electron-builder temp files through the user home directory so that
// Parallels VM can access them via the always-available \\Mac\Home share.
// APP_BUILDER_TMP_DIR is read once on first TmpDir use — set it before any tests run.
const MSIX_TEST_TMP = path.join(os.homedir(), ".eb-msix-test-tmp")
process.env.APP_BUILDER_TMP_DIR = MSIX_TEST_TMP

import { mkdirs, remove } from "fs-extra"

beforeAll(async () => {
  await mkdirs(MSIX_TEST_TMP)
})

afterAll(async () => {
  await remove(MSIX_TEST_TMP).catch(() => {})
})

// The identity name used for all MSIX e2e test packages.
// Must be unique to avoid colliding with AppX test installations.
const TEST_IDENTITY_NAME = "TestAppMsix"

// Shared CSC link used by AppX tests — same cert for MSIX signing.
const TEST_CSC_LINK =
  "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"
const TEST_CSC_KEY_PASSWORD = "test"

async function buildMsixApp(
  expect: any,
  tmpDir: TmpDir,
  target: Map<Platform, Map<Arch, Array<string>>>,
  msixConfig: object,
  packed: (ctx: PackedContext) => Promise<void>
): Promise<void> {
  await assertPack(
    expect,
    "test-app",
    {
      targets: target,
      config: {
        cscLink: TEST_CSC_LINK,
        cscKeyPassword: TEST_CSC_KEY_PASSWORD,
        productName: "TestApp",
        executableName: "TestApp",
        appId: "com.test.msix",
        compression: "store",
        electronLanguages: ["en"],
        electronFuses: {
          runAsNode: false,
          enableCookieEncryption: true,
          enableNodeOptionsEnvironmentVariable: false,
          enableNodeCliInspectArguments: false,
          enableEmbeddedAsarIntegrityValidation: true,
          onlyLoadAppFromAsar: true,
          loadBrowserProcessSpecificV8Snapshot: false,
          grantFileProtocolExtraPrivileges: false,
        },
        // MSIX requires a modern toolset — winCodeSign-2.6.0 (legacy/0.0.0) does not
        // include the windows-kits-bundle-10_0_26100_0 makeappx.exe that supports .msix
        toolsets: { winCodeSign: "1.0.0" as const },
        // Pin version so artifact filenames are predictable
        extraMetadata: { name: "testapp", version: "1.0.0" },
        msix: {
          identityName: TEST_IDENTITY_NAME,
          publisherDisplayName: "Test Publisher",
          // Use hyphens — prlctl exec does not quote arguments containing spaces,
          // so spaces in artifact paths cause makeappx to receive broken arguments.
          artifactName: "${productName}-${version}-${arch}.${ext}",
          ...msixConfig,
        },
        publish: null,
      },
    },
    {
      signedWin: true,
      packageManager: PM.PNPM,
      packed,
      projectDirCreated: async (projectDir, _dir, runtimeEnv) => {
        await modifyPackageJson(
          projectDir,
          data => {
            data.devDependencies = { electron: ELECTRON_VERSION }
          },
          true
        )
        await modifyPackageJson(
          projectDir,
          data => {
            data.pnpm = {
              supportedArchitectures: { os: ["current"], cpu: ["x64"] },
            }
          },
          false
        )
        await spawn("pnpm", ["install"], { cwd: projectDir, stdio: "inherit", env: runtimeEnv })
      },
    }
  )
}

describe.heavy("msix", optionsForFlakyE2E, () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Test 1 — single-arch .msix: build → install → verify → uninstall
  // ─────────────────────────────────────────────────────────────────────────
  test("single-arch msix installs and uninstalls via VM", optionsForFlakyE2E, async (context: TestContext) => {
    const { expect } = context
    const vm = await windowsVmPromise
    const isNativeWindows = process.platform === "win32"

    if (!isNativeWindows && vm == null) {
      context.skip()
      return
    }

    const tmpDir = new TmpDir("msix-single-arch")
    let builtDir: string | undefined
    let result: MsixInstallResult | undefined

    try {
      await buildMsixApp(expect, tmpDir, Platform.WINDOWS.createTarget(["msix"], Arch.x64), {}, async (ctx: PackedContext) => {
        builtDir = await tmpDir.getTempDir({ prefix: "built" })
        await move(ctx.outDir, builtDir)
      })

      if (!builtDir) {
        throw new Error("Build did not produce output")
      }

      const msixFiles = require("fs")
        .readdirSync(builtDir)
        .filter((f: string) => f.endsWith(".msix"))
      expect(msixFiles.length).toBeGreaterThan(0)
      const msixPath = path.join(builtDir, msixFiles[0])

      if (isNativeWindows) {
        result = installMsixNative(msixPath, TEST_IDENTITY_NAME)
      } else {
        result = await installMsixInVm(vm!, msixPath, TEST_IDENTITY_NAME)
      }

      expect(result.packageFamilyName).toMatch(/^TestAppMsix_/)
      expect(result.installLocation).not.toBe("")
    } finally {
      if (result) {
        try {
          if (isNativeWindows) {
            uninstallMsixNative(result.packageFamilyName, result.certThumbprint)
          } else if (vm) {
            await uninstallMsixInVm(vm, result.packageFamilyName, result.certThumbprint)
          }
        } catch (e) {
          console.error("MSIX cleanup failed:", e)
        }
      }
      await tmpDir.cleanup().catch(() => {})
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Test 2 — multi-arch .msixbundle: build → install → verify → uninstall
  // ─────────────────────────────────────────────────────────────────────────
  test("multi-arch msixbundle installs via VM", optionsForFlakyE2E, async (context: TestContext) => {
    const { expect } = context
    const vm = await windowsVmPromise
    const isNativeWindows = process.platform === "win32"

    if (!isNativeWindows && vm == null) {
      context.skip()
      return
    }

    const tmpDir = new TmpDir("msix-bundle")
    let builtDir: string | undefined
    let result: MsixInstallResult | undefined

    try {
      await buildMsixApp(expect, tmpDir, Platform.WINDOWS.createTarget(["msix"], Arch.ia32, Arch.x64), { createMsixbundle: true }, async (ctx: PackedContext) => {
        builtDir = await tmpDir.getTempDir({ prefix: "built-bundle" })
        await move(ctx.outDir, builtDir)
      })

      if (!builtDir) {
        throw new Error("Build did not produce output")
      }

      const bundleFiles = require("fs")
        .readdirSync(builtDir)
        .filter((f: string) => f.endsWith(".msixbundle"))
      expect(bundleFiles.length).toBeGreaterThan(0)
      const bundlePath = path.join(builtDir, bundleFiles[0])

      if (isNativeWindows) {
        result = installMsixNative(bundlePath, TEST_IDENTITY_NAME)
      } else {
        result = await installMsixInVm(vm!, bundlePath, TEST_IDENTITY_NAME)
      }

      expect(result.packageFamilyName).toMatch(/^TestAppMsix_/)
      expect(result.installLocation).not.toBe("")
    } finally {
      if (result) {
        try {
          if (isNativeWindows) {
            uninstallMsixNative(result.packageFamilyName, result.certThumbprint)
          } else if (vm) {
            await uninstallMsixInVm(vm, result.packageFamilyName, result.certThumbprint)
          }
        } catch (e) {
          console.error("MSIX cleanup failed:", e)
        }
      }
      await tmpDir.cleanup().catch(() => {})
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Test 3 — enforcePackageIntegrity: install, verify manifest via
  // Get-AppxPackageManifest, and confirm uap10:PackageIntegrity is present
  // ─────────────────────────────────────────────────────────────────────────
  test("msix with enforcePackageIntegrity installs and manifest contains integrity element", optionsForFlakyE2E, async (context: TestContext) => {
    const { expect } = context
    const vm = await windowsVmPromise
    const isNativeWindows = process.platform === "win32"

    if (!isNativeWindows && vm == null) {
      context.skip()
      return
    }

    const tmpDir = new TmpDir("msix-integrity")
    let builtDir: string | undefined
    let result: MsixInstallResult | undefined

    try {
      await buildMsixApp(expect, tmpDir, Platform.WINDOWS.createTarget(["msix"], Arch.x64), { enforcePackageIntegrity: true }, async (ctx: PackedContext) => {
        builtDir = await tmpDir.getTempDir({ prefix: "built-integrity" })
        await move(ctx.outDir, builtDir)
      })

      if (!builtDir) {
        throw new Error("Build did not produce output")
      }

      const msixFiles = require("fs")
        .readdirSync(builtDir)
        .filter((f: string) => f.endsWith(".msix"))
      expect(msixFiles.length).toBeGreaterThan(0)
      const msixPath = path.join(builtDir, msixFiles[0])

      if (isNativeWindows) {
        result = installMsixNative(msixPath, TEST_IDENTITY_NAME)
      } else {
        result = await installMsixInVm(vm!, msixPath, TEST_IDENTITY_NAME)
      }

      expect(result.packageFamilyName).toMatch(/^TestAppMsix_/)

      // Verify the installed manifest contains the PackageIntegrity element
      let manifestXml: string
      if (isNativeWindows) {
        const psOut = require("child_process").execFileSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", `(Get-AppxPackageManifest -Package '${result.packageFamilyName}').OuterXml`],
          { encoding: "utf8" }
        )
        manifestXml = psOut
      } else {
        manifestXml = await vm!.exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-AppxPackageManifest -Package '${result.packageFamilyName}').OuterXml`])
      }

      expect(manifestXml).toContain("PackageIntegrity")
    } finally {
      if (result) {
        try {
          if (isNativeWindows) {
            uninstallMsixNative(result.packageFamilyName, result.certThumbprint)
          } else if (vm) {
            await uninstallMsixInVm(vm, result.packageFamilyName, result.certThumbprint)
          }
        } catch (e) {
          console.error("MSIX cleanup failed:", e)
        }
      }
      await tmpDir.cleanup().catch(() => {})
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Test 4 — launch: install, find exe inside package, launch it, verify
  // ─────────────────────────────────────────────────────────────────────────
  test("msix app executable launches from install location", optionsForFlakyE2E, async (context: TestContext) => {
    const { expect } = context
    const vm = await windowsVmPromise

    // Launch test only supported via Parallels VM (native Windows test infra
    // would need an interactive desktop session which CI runners can't guarantee)
    if (vm == null) {
      context.skip()
      return
    }

    const tmpDir = new TmpDir("msix-launch")
    let builtDir: string | undefined
    let result: MsixInstallResult | undefined

    try {
      await buildMsixApp(expect, tmpDir, Platform.WINDOWS.createTarget(["msix"], Arch.x64), {}, async (ctx: PackedContext) => {
        builtDir = await tmpDir.getTempDir({ prefix: "built-launch" })
        await move(ctx.outDir, builtDir)
      })

      if (!builtDir) {
        throw new Error("Build did not produce output")
      }

      const msixFiles = require("fs")
        .readdirSync(builtDir)
        .filter((f: string) => f.endsWith(".msix"))
      const msixPath = path.join(builtDir, msixFiles[0])
      result = await installMsixInVm(vm, msixPath, TEST_IDENTITY_NAME)

      // The Electron app is a full-trust Windows.FullTrustApplication: its exe is
      // directly accessible at installLocation\app\TestApp.exe without MSIX sandbox
      // restrictions for launch purposes.
      const output = await launchMsixAppInVm(vm, result.installLocation, "TestApp.exe", 30_000)
      expect(output).toContain("LAUNCHED:true")
    } finally {
      if (result) {
        try {
          // vm is non-null: the early return above guarantees it
          await uninstallMsixInVm(vm, result.packageFamilyName, result.certThumbprint)
        } catch (e) {
          console.error("MSIX cleanup failed:", e)
        }
      }
      await tmpDir.cleanup().catch(() => {})
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Test 5 — windows services: manifest contains desktop6 extension
  // ─────────────────────────────────────────────────────────────────────────
  test("msix with windowsServices manifest contains desktop6 extension", optionsForFlakyE2E, async (context: TestContext) => {
    const { expect } = context
    const vm = await windowsVmPromise
    const isNativeWindows = process.platform === "win32"

    if (!isNativeWindows && vm == null) {
      context.skip()
      return
    }

    const tmpDir = new TmpDir("msix-services")
    let builtDir: string | undefined
    let result: MsixInstallResult | undefined

    try {
      await buildMsixApp(
        expect,
        tmpDir,
        Platform.WINDOWS.createTarget(["msix"], Arch.x64),
        {
          windowsServices: [
            {
              name: "TestAppSvc",
            },
          ],
        },
        async (ctx: PackedContext) => {
          builtDir = await tmpDir.getTempDir({ prefix: "built-svc" })
          await move(ctx.outDir, builtDir)
        }
      )

      if (!builtDir) {
        throw new Error("Build did not produce output")
      }

      const msixFiles = require("fs")
        .readdirSync(builtDir)
        .filter((f: string) => f.endsWith(".msix"))
      expect(msixFiles.length).toBeGreaterThan(0)
      const msixPath = path.join(builtDir, msixFiles[0])

      if (isNativeWindows) {
        result = installMsixNative(msixPath, TEST_IDENTITY_NAME)
      } else {
        result = await installMsixInVm(vm!, msixPath, TEST_IDENTITY_NAME)
      }

      // Verify manifest via Get-AppxPackageManifest
      let manifestXml: string
      if (isNativeWindows) {
        manifestXml = require("child_process").execFileSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", `(Get-AppxPackageManifest -Package '${result.packageFamilyName}').OuterXml`],
          { encoding: "utf8" }
        )
      } else {
        manifestXml = await vm!.exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-AppxPackageManifest -Package '${result.packageFamilyName}').OuterXml`])
      }

      expect(manifestXml).toContain("windows.service")
      expect(manifestXml).toContain("TestAppSvc")
    } finally {
      if (result) {
        try {
          if (isNativeWindows) {
            uninstallMsixNative(result.packageFamilyName, result.certThumbprint)
          } else if (vm) {
            await uninstallMsixInVm(vm, result.packageFamilyName, result.certThumbprint)
          }
        } catch (e) {
          console.error("MSIX cleanup failed:", e)
        }
      }
      await tmpDir.cleanup().catch(() => {})
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Test 6 — msixupload: verify the .msixupload ZIP is produced and valid
  // ─────────────────────────────────────────────────────────────────────────
  test("msix with createMsixupload produces a valid zip archive", optionsForFlakyE2E, async (context: TestContext) => {
    const { expect } = context
    const vm = await windowsVmPromise
    const isNativeWindows = process.platform === "win32"

    // This test only needs makeappx to build; it doesn't need to install.
    if (!isNativeWindows && vm == null) {
      context.skip()
      return
    }

    const tmpDir = new TmpDir("msix-upload")
    let builtDir: string | undefined

    try {
      await buildMsixApp(
        expect,
        tmpDir,
        Platform.WINDOWS.createTarget(["msix"], Arch.ia32, Arch.x64),
        {
          createMsixbundle: true,
          createMsixupload: true,
        },
        async (ctx: PackedContext) => {
          builtDir = await tmpDir.getTempDir({ prefix: "built-upload" })
          await move(ctx.outDir, builtDir)
        }
      )

      if (!builtDir) {
        throw new Error("Build did not produce output")
      }

      const allFiles = require("fs").readdirSync(builtDir)
      const uploadFiles = allFiles.filter((f: string) => f.endsWith(".msixupload"))
      const bundleFiles = allFiles.filter((f: string) => f.endsWith(".msixbundle"))

      expect(uploadFiles.length).toBeGreaterThan(0)
      expect(bundleFiles.length).toBeGreaterThan(0)

      // Verify the .msixupload is a valid ZIP by reading its local file header signature (PK\x03\x04)
      const uploadPath = path.join(builtDir, uploadFiles[0])
      const header = Buffer.alloc(4)
      const fd = require("fs").openSync(uploadPath, "r")
      require("fs").readSync(fd, header, 0, 4, 0)
      require("fs").closeSync(fd)
      expect(header.toString("hex")).toBe("504b0304")
    } finally {
      await tmpDir.cleanup().catch(() => {})
    }
  })
})
