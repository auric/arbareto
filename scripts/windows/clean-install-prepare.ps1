# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Ihor Lifanov

# Runs in Windows Sandbox as the clean-install.wsb logon command, on Windows PowerShell 5.1.
# Installs only the prerequisites whose installer is in C:\arbareto\in. Omit an installer to keep that prerequisite missing (T156).
$ErrorActionPreference = 'Stop'
$in = 'C:\arbareto\in'
$out = 'C:\arbareto\out'
$log = Join-Path $out ('prepare-{0:yyyyMMdd-HHmmss}.log' -f (Get-Date))
function Log([string]$Message) { Write-Host $Message; Add-Content -LiteralPath $log -Value $Message -Encoding UTF8 }

# WebView2 detection keys and the pv rule: learn.microsoft.com/microsoft-edge/webview2/concepts/distribution
$wv2Id = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$wv2Keys = @("HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$wv2Id", "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$wv2Id")
$wv2Min = [version]'154.0.4258.37'
function WebView2Version {
  $best = $null
  foreach ($k in $wv2Keys) {
    $pv = (Get-ItemProperty -LiteralPath $k -Name pv -ErrorAction SilentlyContinue).pv
    Log "WebView2 pv at ${k}: $(if ($pv) { $pv } else { 'absent' })"
    $v = $null
    if ($pv -and [version]::TryParse($pv, [ref]$v) -and $v -gt [version]'0.0.0.0' -and ($null -eq $best -or $v -gt $best)) { $best = $v }
  }
  $best
}
function Run([string]$Path, [string[]]$Arguments) {
  $p = Start-Process -FilePath $Path -ArgumentList $Arguments -Wait -PassThru
  Log "Exit code $($p.ExitCode): $Path $($Arguments -join ' ')"
  if ($p.ExitCode -ne 0) { throw "Installer failed: $Path" }
}

$os = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
Log "OS: $($os.ProductName) $($os.DisplayVersion) build $($os.CurrentBuild).$($os.UBR) $env:PROCESSOR_ARCHITECTURE"
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Log "User: $env:USERDOMAIN\$env:USERNAME, elevated administrator: $admin"
Get-ChildItem -LiteralPath $in -File | ForEach-Object { Log "SHA256 $((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash) $($_.Name)" }
foreach ($tool in 'bun', 'node') { $c = Get-Command $tool -ErrorAction SilentlyContinue; Log "${tool}: $(if ($c) { $c.Source } else { 'absent' })" }

Log 'Image WebView2 before any install:'
$wv2 = WebView2Version
if ($null -eq $wv2 -or $wv2 -lt $wv2Min) {
  $wv2Installer = Join-Path $in 'webview2-installer.exe'
  if (Test-Path -LiteralPath $wv2Installer) {
    # Evergreen Standalone Installer. An elevated run installs per machine.
    Run $wv2Installer @('/silent', '/install')
    Log 'WebView2 after install:'
    $wv2 = WebView2Version
  } else { Log 'webview2-installer.exe is absent. WebView2 stays as the image has it.' }
}
Log "WebView2 result: $(if ($null -eq $wv2) { 'absent' } elseif ($wv2 -lt $wv2Min) { "$wv2 is below $wv2Min" } else { "$wv2 meets $wv2Min" })"

$gitInstaller = Join-Path $in 'git-installer.exe'
$gitDir = 'C:\Program Files\Git'
if (Test-Path -LiteralPath $gitInstaller) {
  # Inno Setup switches: git-for-windows/git wiki "Silent or Unattended Installation".
  Run $gitInstaller @('/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES', "/DIR=`"$gitDir`"")
  Log "Git: $(& "$gitDir\cmd\git.exe" --version) at $gitDir\cmd\git.exe"
} else { Log 'git-installer.exe is absent. Git stays missing.' }
Log "Log: $log"
