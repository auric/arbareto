# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Ihor Lifanov

# Host mode writes a filled putty-tests.wsb into -Stage. It reads only the given paths and writes only under -Stage.
# -InSandbox mode runs in Windows Sandbox as the logon command, on Windows PowerShell 5.1. It installs Git and opens a test console.
# No mode reads or writes the PuTTY registry key, Pageant, ~/.ssh, or known_hosts of the host.
[CmdletBinding(DefaultParameterSetName = 'Host')]
param(
  [Parameter(ParameterSetName = 'Host')][string]$Checkout = (Join-Path $PSScriptRoot '..\..'),
  [Parameter(Mandatory, ParameterSetName = 'Host')][string]$PuttyDir,
  [Parameter(Mandatory, ParameterSetName = 'Host')][string]$BunExe,
  [Parameter(Mandatory, ParameterSetName = 'Host')][string]$GitInstaller,
  [Parameter(ParameterSetName = 'Host')][string]$Stage = (Join-Path $env:USERPROFILE 'arbareto-sandbox\putty'),
  [Parameter(Mandatory, ParameterSetName = 'Sandbox')][switch]$InSandbox,
  [Parameter(Mandatory, ParameterSetName = 'Sandbox')][string]$GitInstallerName
)
$ErrorActionPreference = 'Stop'
$puttyPrograms = 'plink.exe', 'pageant.exe', 'puttygen.exe'

function Need([string]$Path, [string]$Type, [string]$What) {
  if (-not (Test-Path -LiteralPath $Path -PathType $Type)) { throw "$What is absent: $Path" }
  (Resolve-Path -LiteralPath $Path).ProviderPath
}

if (-not $InSandbox) {
  $Checkout = Need $Checkout Container 'Checkout folder'
  [void](Need (Join-Path $Checkout 'package.json') Leaf 'package.json of the checkout')
  [void](Need (Join-Path $Checkout 'node_modules\ssh2') Container 'node_modules\ssh2 (run bun install in the checkout)')
  $PuttyDir = Need $PuttyDir Container 'PuTTY folder'
  foreach ($p in $puttyPrograms) { [void](Need (Join-Path $PuttyDir $p) Leaf "PuTTY program $p") }
  $BunExe = Need $BunExe Leaf 'Bun binary'
  # The Sandbox console finds Bun through PATH, so the file name must be bun.exe.
  if ((Split-Path -Leaf $BunExe) -ne 'bun.exe') { throw "The Bun binary must have the name bun.exe: $BunExe" }
  $GitInstaller = Need $GitInstaller Leaf 'Git for Windows installer'
  $out = Join-Path $Stage 'out'
  [void](New-Item -ItemType Directory -Force -Path $out)
  $values = @{
    CHECKOUT = $Checkout; PUTTY_DIR = $PuttyDir; BUN_DIR = (Split-Path -Parent $BunExe)
    GIT_INSTALLER_DIR = (Split-Path -Parent $GitInstaller); GIT_INSTALLER_NAME = (Split-Path -Leaf $GitInstaller)
    OUT = (Resolve-Path -LiteralPath $out).ProviderPath
  }
  $wsb = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'putty-tests.wsb') -Raw
  foreach ($k in $values.Keys) { $wsb = $wsb.Replace("{{$k}}", [Security.SecurityElement]::Escape($values[$k])) }
  if ($wsb -match '\{\{') { throw 'putty-tests.wsb holds a placeholder that this script does not fill.' }
  $target = Join-Path $Stage 'putty-tests.wsb'
  Set-Content -LiteralPath $target -Value $wsb -Encoding UTF8
  Write-Host "Wrote $target. Open it to start Windows Sandbox."
  return
}

$checkoutIn = 'C:\arbareto\checkout'
$puttyIn = 'C:\arbareto\putty'
$bunIn = 'C:\arbareto\bun'
$out = 'C:\arbareto\out'
$log = Join-Path $out ('putty-prepare-{0:yyyyMMdd-HHmmss}.log' -f (Get-Date))
function Log([string]$Message) { Write-Host $Message; Add-Content -LiteralPath $log -Value $Message -Encoding UTF8 }

$os = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
Log "OS: $($os.ProductName) $($os.DisplayVersion) build $($os.CurrentBuild).$($os.UBR) $env:PROCESSOR_ARCHITECTURE"
$bun = Need (Join-Path $bunIn 'bun.exe') Leaf 'Bun binary'
$gitInstaller = Need (Join-Path 'C:\arbareto\git-installer' $GitInstallerName) Leaf 'Git for Windows installer'
$files = @($bun, $gitInstaller) + ($puttyPrograms | ForEach-Object { Need (Join-Path $puttyIn $_) Leaf "PuTTY program $_" })
foreach ($f in $files) { Log "SHA256 $((Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash) $f" }

$gitDir = 'C:\Program Files\Git'
# Inno Setup switches: git-for-windows/git wiki "Silent or Unattended Installation".
$p = Start-Process -FilePath $gitInstaller -ArgumentList @('/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES', "/DIR=`"$gitDir`"") -Wait -PassThru
Log "Exit code $($p.ExitCode): $gitInstaller"
if ($p.ExitCode -ne 0) { throw "Installer failed: $gitInstaller" }
$git = Need "$gitDir\cmd\git.exe" Leaf 'Installed git.exe'
Log "Git: $(& $git --version) at $git"
Log "Bun: $(& $bun --version) at $bun"

# These values exist only in this console process and its children.
$env:ARBARETO_TEST_SANDBOX = '1'
$env:ARBARETO_TEST_PUTTY_DIR = $puttyIn
$env:ARBARETO_TEST_GIT = $git
$env:Path = "$bunIn;$gitDir\cmd;$env:Path"
Set-Location -LiteralPath $checkoutIn
Log 'Environment: ARBARETO_TEST_SANDBOX=1, ARBARETO_TEST_PUTTY_DIR, ARBARETO_TEST_GIT, PATH with Bun and Git.'
Log "Run the tests in this console, for example: bun test ./tests/windows/putty-facts.test.ts 2>&1 | Tee-Object -FilePath $out\putty-facts.log"
Log "Log: $log"
