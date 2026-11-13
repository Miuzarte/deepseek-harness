<#
.SYNOPSIS
Package the Windows x64 desktop build from this checkout.

.DESCRIPTION
Runs the repository's own packaging entry point after preparing the shell for
it: proxy variables for the runtime downloads, no inherited DSH_DESKTOP_*
overrides, and the Windows tar ahead of Git's. The desktop application must be
closed first, because it holds files under apps/desktop/.desktop-build.

.PARAMETER Dir
Emit only the unpacked win-unpacked directory, skipping the NSIS installer.

.PARAMETER SkipInstall
Do not run pnpm install before packaging.

.PARAMETER Proxy
HTTP proxy for the Electron, Node, Python, and npm downloads. Defaults to
$env:DSH_BUILD_PROXY, then $env:HTTPS_PROXY, then http://127.0.0.1:7890 when
that port is listening.

.PARAMETER NoProxy
Send downloads directly even when a proxy is configured or detected.

.PARAMETER DryRun
Print the resolved configuration and planned commands without running them.

.EXAMPLE
pwsh -File .\build-desktop.ps1

.EXAMPLE
pwsh -File .\build-desktop.ps1 -Dir -SkipInstall -NoProxy
#>
[CmdletBinding()]
param(
  [switch]$Dir,
  [switch]$SkipInstall,
  [switch]$NoProxy,
  [string]$Proxy,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot
Set-Location $repoRoot

function Test-LoopbackPort {
  param([int]$Port)
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $pending = $client.ConnectAsync('127.0.0.1', $Port)
    return $pending.Wait(300) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Get-RunningDesktopProcesses {
  $marker = (Join-Path $repoRoot 'apps\desktop\.desktop-build').ToLowerInvariant()
  Get-CimInstance Win32_Process -Filter "Name = 'DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant().StartsWith($marker) } |
    Select-Object ProcessId, ExecutablePath
}

# --- Preflight -------------------------------------------------------------

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) { throw 'node is not on PATH; install Node.js >= 24.9' }
$nodeVersion = (& node --version).Trim().TrimStart('v')
if ([version]$nodeVersion -lt [version]'24.9.0') {
  throw "node $nodeVersion is older than the required 24.9.0"
}
if ($null -eq (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw 'pnpm is not on PATH; install pnpm 11.28.5 (corepack enable)'
}

$running = @(Get-RunningDesktopProcesses)
if ($running.Count -gt 0) {
  $pids = ($running | ForEach-Object { $_.ProcessId }) -join ', '
  $message = "the desktop app is running from this checkout (pid $pids); quit it from the tray first, it holds apps\desktop\.desktop-build"
  if ($DryRun) { Write-Warning $message } else { throw $message }
}

# --- Download configuration ------------------------------------------------

$proxyUrl = $null
if (-not $NoProxy) {
  if ($Proxy) { $proxyUrl = $Proxy }
  elseif ($env:DSH_BUILD_PROXY) { $proxyUrl = $env:DSH_BUILD_PROXY }
  elseif ($env:HTTPS_PROXY) { $proxyUrl = $env:HTTPS_PROXY }
  elseif (Test-LoopbackPort 7890) { $proxyUrl = 'http://127.0.0.1:7890' }
}
if ($proxyUrl) {
  $env:HTTPS_PROXY = $proxyUrl
  $env:HTTP_PROXY = $proxyUrl
  $env:https_proxy = $proxyUrl
  $env:http_proxy = $proxyUrl
  # Node's fetch and @electron/get read neither the Windows system proxy nor the
  # unprefixed variables unless these two switches are on.
  $env:NODE_USE_ENV_PROXY = '1'
  $env:ELECTRON_GET_USE_PROXY = 'true'
  $env:GLOBAL_AGENT_HTTPS_PROXY = $proxyUrl
  $env:GLOBAL_AGENT_HTTP_PROXY = $proxyUrl
  $env:NO_PROXY = 'localhost,127.0.0.1,::1'
} else {
  Write-Host 'proxy: none (downloads go direct)'
}

# The packaging guard rejects a wildcard bind when these leak in from a dev shell.
Remove-Item Env:DSH_DESKTOP_HOST -ErrorAction SilentlyContinue
Remove-Item Env:DSH_DESKTOP_PORT -ErrorAction SilentlyContinue

# Untracked local settings; a fresh clone has none and packaging stops on the first step.
$settingsFile = Join-Path $repoRoot 'apps\desktop\.env.windows'
if (-not (Test-Path $settingsFile)) {
  throw "missing $settingsFile; copy apps\desktop\.env.windows.example there and fill in the local packaging settings"
}
# Git Bash's GNU tar reads B:\ as a remote host; System32 ships bsdtar instead.
$env:Path = "$env:SystemRoot\System32;$env:Path"

# --- Steps -----------------------------------------------------------------

$packageArgs = if ($Dir) {
  @('exec', 'tsx', 'apps/desktop/scripts/package-target.ts', 'win-x64', '--unsigned', '--dir')
} else {
  @('run', 'package:desktop:win:x64:unsigned')
}

if ($DryRun) {
  Write-Host "node:  $nodeVersion"
  Write-Host "proxy: $(if ($proxyUrl) { $proxyUrl } else { 'none' })"
  if (-not $SkipInstall) { Write-Host 'would run: pnpm install --frozen-lockfile' }
  Write-Host "would run: pnpm $($packageArgs -join ' ')"
  exit 0
}

$started = Get-Date
if (-not $SkipInstall) {
  Write-Host '==> pnpm install --frozen-lockfile'
  $previousCi = $env:CI
  $env:CI = 'true'
  try {
    & pnpm install --frozen-lockfile
    $installExit = $LASTEXITCODE
  } finally {
    if ($previousCi) { $env:CI = $previousCi } else { Remove-Item Env:CI -ErrorAction SilentlyContinue }
  }
  if ($installExit -ne 0) { throw "pnpm install failed with exit code $installExit" }
}

Write-Host "==> pnpm $($packageArgs -join ' ')"
& pnpm @packageArgs
if ($LASTEXITCODE -ne 0) {
  $evidence = Get-ChildItem (Join-Path $repoRoot 'apps\desktop\.desktop-build\packaging-runs') -Directory -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($evidence) { Write-Host "evidence: $($evidence.FullName)" }
  throw "desktop packaging failed with exit code $LASTEXITCODE"
}

# --- Result ----------------------------------------------------------------

$artifacts = Join-Path $repoRoot 'apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts'
$elapsed = [int]((Get-Date) - $started).TotalSeconds
Write-Host "done in ${elapsed}s"
Write-Host "unpacked: $(Join-Path $artifacts 'win-unpacked\DeepSeek Harness.exe')"
if (-not $Dir) {
  Get-ChildItem $artifacts -Filter '*.exe' -File -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host "installer: $($_.FullName)" }
}
