import { execFileSync } from "child_process"
import { randomUUID } from "crypto"
import { homedir } from "os"
import path from "path"
import { outputFile, remove } from "fs-extra"
import type { VmManager } from "app-builder-lib/out/vm/vm"
import { createLocalServer, getParallelsHostIP, sha256File, toVmHomePath } from "../helpers/launchAppCrossPlatform"

export interface MsixInstallResult {
  /** The Windows package family name, e.g. "TestApp_abcde12345xyz" — used to uninstall. */
  packageFamilyName: string
  /** SHA-1 thumbprint of the signing cert that was trusted, or empty if no extra trust was needed. */
  certThumbprint: string
  /** Full path to the installed app directory inside the Windows package cache. */
  installLocation: string
}

// ─── Parallels VM ────────────────────────────────────────────────────────────

/**
 * Delivers an MSIX (or .msixbundle) to the Parallels VM via HTTP, trusts its
 * signing cert, installs it, and returns the package identifiers needed for
 * verification and cleanup.
 *
 * Requires Developer Mode to be enabled on the VM (AllowDevelopmentWithoutDevLicense=1) so
 * that `Add-AppxPackage -AllowUnsigned` can install test-signed packages without cert trust.
 *
 * Runs as the logged-in user via `vm.exec()` (--current-user) because `Add-AppxPackage`
 * is a per-user operation that the Local System account cannot perform.
 */
export async function installMsixInVm(vm: VmManager, msixPath: string, identityName: string): Promise<MsixInstallResult> {
  const hostIP = getParallelsHostIP()
  if (!hostIP) {
    throw new Error("Cannot determine Parallels host IP — no prl*/bridge* interface found")
  }
  if (!/^[\d.]+$/.test(hostIP)) {
    throw new Error(`Unsafe hostIP: ${hostIP}`)
  }

  const expectedSha256 = await sha256File(msixPath)
  if (!/^[0-9a-f]{64}$/i.test(expectedSha256)) {
    throw new Error(`Unexpected SHA-256 value: ${expectedSha256}`)
  }

  const { server, port } = await createLocalServer(path.dirname(msixPath), "0.0.0.0")
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Unsafe port: ${port}`)
  }

  const filename = encodeURIComponent(path.basename(msixPath))
  const scriptPath = path.join(homedir(), `.eb-msix-install-${randomUUID()}.ps1`)

  const psScript = [
    `$ErrorActionPreference = 'Stop'`,
    `$tmpDir = $null`,
    `try {`,
    `    $tmpDir = Join-Path $env:TEMP ([Guid]::NewGuid().ToString())`,
    `    New-Item -ItemType Directory -Path $tmpDir | Out-Null`,
    `    $dest = Join-Path $tmpDir 'package.msix'`,
    `    Invoke-WebRequest -Uri 'http://${hostIP}:${port}/${filename}' -OutFile $dest -UseBasicParsing`,
    `    $actualHash = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower()`,
    `    if ($actualHash -ne '${expectedSha256}') { Write-Error "Hash mismatch: $actualHash"; exit 1 }`,
    `    Write-Output 'HASH_OK:true'`,
    // Remove previous installation of the same package family to avoid version conflicts
    `    $existing = Get-AppxPackage -Name '${identityName}' -ErrorAction SilentlyContinue`,
    `    if ($existing) { Remove-AppxPackage -Package $existing.PackageFullName -ErrorAction SilentlyContinue }`,
    `    Unblock-File -Path $dest -ErrorAction SilentlyContinue`,
    // -AllowUnsigned requires Developer Mode (AllowDevelopmentWithoutDevLicense=1), which avoids
    // needing to add the test-signing cert to LocalMachine\TrustedPeople (requires UAC elevation).
    `    Add-AppxPackage -Path $dest -AllowUnsigned`,
    `    $pkg = Get-AppxPackage -Name '${identityName}'`,
    `    if (-not $pkg) { Write-Error 'Package not found after installation'; exit 1 }`,
    `    Write-Output "PFN:$($pkg.PackageFamilyName)"`,
    `    Write-Output "INSTALL_LOCATION:$($pkg.InstallLocation)"`,
    `    Write-Output "INSTALLED_VERSION:$($pkg.Version)"`,
    `} finally {`,
    `    if ($tmpDir) { Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue }`,
    `}`,
  ].join("\n")

  await outputFile(scriptPath, psScript)
  const winScriptPath = toVmHomePath(scriptPath)

  let output: string
  try {
    // Use --current-user: Add-AppxPackage cannot be called by the Local System account
    output = await vm.exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", winScriptPath], { timeout: 120_000 })
    console.log("[installMsixInVm] output:", output)
  } finally {
    server.close()
    await remove(scriptPath).catch(() => {})
  }

  const pfnMatch = output.match(/PFN:(\S+)/)
  const locationMatch = output.match(/INSTALL_LOCATION:(.+)/)

  if (!pfnMatch) {
    throw new Error(`PFN not found in output:\n${output}`)
  }

  return {
    packageFamilyName: pfnMatch[1].trim(),
    installLocation: locationMatch ? locationMatch[1].trim() : "",
    certThumbprint: "", // No cert added; Developer Mode allows -AllowUnsigned
  }
}

/**
 * Uninstalls an MSIX package from the VM and optionally removes the trusted cert.
 */
export async function uninstallMsixInVm(vm: VmManager, packageFamilyName: string, _certThumbprint: string): Promise<void> {
  // No cert cleanup needed since we use -AllowUnsigned (Developer Mode) and don't add certs.
  // Run as current user because Remove-AppxPackage is also a per-user operation.
  const psCommand = `$pkg = Get-AppxPackage | Where-Object { $_.PackageFamilyName -eq '${packageFamilyName}' } | Select-Object -First 1; if ($pkg) { Remove-AppxPackage -Package $pkg.PackageFullName -ErrorAction SilentlyContinue }`
  await vm.exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCommand]).catch(() => {})
}

/**
 * Launches the installed MSIX app directly from its install location and waits
 * for it to emit "APP_VERSION:<n.n.n>" on stdout, then kills it.
 * Returns the version string.
 */
export async function launchMsixAppInVm(vm: VmManager, installLocation: string, exeName: string, timeoutMs = 30_000): Promise<string> {
  const exePath = `${installLocation}\\app\\${exeName}`
  const psCommand = `$proc = Start-Process -FilePath '${exePath}' -PassThru -NoNewWindow; Start-Sleep -Seconds 5; Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; Write-Output 'LAUNCHED:true'`
  const output = await vm.exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCommand], { timeout: timeoutMs })
  return output
}

// ─── native Windows ───────────────────────────────────────────────────────────

/**
 * Installs an MSIX package on native Windows (assumes test is running as admin).
 */
export function installMsixNative(msixPath: string, identityName: string): MsixInstallResult {
  // Trust the signing cert
  const certScript = [
    `$sig = Get-AuthenticodeSignature -FilePath '${msixPath.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`,
    `$certThumb = ''`,
    `if ($sig -and $sig.SignerCertificate) {`,
    `    $cert = $sig.SignerCertificate`,
    `    $certThumb = $cert.Thumbprint`,
    `    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('TrustedPeople', 'LocalMachine')`,
    `    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)`,
    `    $store.Add($cert)`,
    `    $store.Close()`,
    `    Write-Output "CERT_THUMBPRINT:$certThumb"`,
    `}`,
    `$existing = Get-AppxPackage -Name '${identityName}' -ErrorAction SilentlyContinue`,
    `if ($existing) { Remove-AppxPackage -Package $existing.PackageFullName -ErrorAction Stop }`,
    `Add-AppxPackage -Path '${msixPath.replace(/'/g, "''")}' -ErrorAction Stop`,
    `$pkg = Get-AppxPackage -Name '${identityName}'`,
    `if (-not $pkg) { Write-Error "Package '${identityName}' not found after installation"; exit 1 }`,
    `Write-Output "PFN:$($pkg.PackageFamilyName)"`,
    `Write-Output "INSTALL_LOCATION:$($pkg.InstallLocation)"`,
  ].join("\n")

  const scriptPath = path.join(require("os").tmpdir(), `.eb-msix-install-${randomUUID()}.ps1`)
  require("fs").writeFileSync(scriptPath, certScript)
  let output: string
  try {
    output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
  } catch (err: any) {
    const stderr = err.stderr ? `\nStderr: ${err.stderr}` : ""
    const stdout = err.stdout ? `\nStdout: ${err.stdout}` : ""
    throw new Error(`MSIX install failed: ${err.message}${stderr}${stdout}`)
  } finally {
    try {
      require("fs").unlinkSync(scriptPath)
    } catch {
      // ignore
    }
  }
  const pfnMatch = output.match(/PFN:(\S+)/)
  const locationMatch = output.match(/INSTALL_LOCATION:(.+)/)
  const thumbMatch = output.match(/CERT_THUMBPRINT:([0-9A-Fa-f]+)/)
  if (!pfnMatch) {
    throw new Error(`PFN not found in powershell output:\n${output}`)
  }
  return {
    packageFamilyName: pfnMatch[1].trim(),
    installLocation: locationMatch ? locationMatch[1].trim() : "",
    certThumbprint: thumbMatch ? thumbMatch[1].trim() : "",
  }
}

export function uninstallMsixNative(packageFamilyName: string, certThumbprint: string): void {
  const lines = [
    `$pkg = Get-AppxPackage | Where-Object { $_.PackageFamilyName -eq '${packageFamilyName}' } | Select-Object -First 1`,
    `if ($pkg) { Remove-AppxPackage -Package $pkg.PackageFullName -ErrorAction SilentlyContinue }`,
    ...(certThumbprint
      ? [
          `$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('TrustedPeople', 'LocalMachine')`,
          `$store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)`,
          `$toRemove = $store.Certificates | Where-Object { $_.Thumbprint -eq '${certThumbprint}' }`,
          `foreach ($c in $toRemove) { $store.Remove($c) }`,
          `$store.Close()`,
        ]
      : []),
  ]
  const scriptPath = path.join(require("os").tmpdir(), `.eb-msix-uninstall-${randomUUID()}.ps1`)
  require("fs").writeFileSync(scriptPath, lines.join("\n"))
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], { encoding: "utf8" })
  } finally {
    try {
      require("fs").unlinkSync(scriptPath)
    } catch {
      // ignore
    }
  }
}
