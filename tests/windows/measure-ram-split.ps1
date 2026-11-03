# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Ihor Lifanov

# The -Json sampler of scripts/windows/measure-ram.ps1 with the same total, plus the private bytes of each process kind (T048).
# Runs on PowerShell 7 and Windows PowerShell 5.1. It prints one JSON line per sample. -IntervalMs <n> samples every n ms until the caller ends this process.
# Kinds: shell (arbareto.exe), service (arbareto-git.exe), git (git*.exe, sh.exe, conhost.exe), and msedgewebview2.exe by `--type=` (browser without one).
param([int]$RootPid = 0, [int]$IntervalMs = 0)

function Fail([string]$Message) { [Console]::Error.WriteLine($Message); exit 1 }

if ($IntervalMs -lt 0) { Fail "-IntervalMs must be 0 or more, not $IntervalMs." }
$all = Get-CimInstance Win32_Process
if (-not $RootPid) {
  $r = @($all | Where-Object Name -eq 'arbareto.exe')
  if ($r.Count -eq 0) { Fail 'No arbareto.exe process runs. Start the app or pass -RootPid.' }
  if ($r.Count -gt 1) { Fail "More than one arbareto.exe runs (PIDs $($r.ProcessId -join ', ')). Pass -RootPid." }
  $RootPid = $r[0].ProcessId
}

# A child must start after its parent. An older process with this ParentProcessId reused a dead parent's PID.
function Tree($All) {
  $byPid = @{}; $All | ForEach-Object { $byPid[[int]$_.ProcessId] = $_ }
  $root = $byPid[$RootPid]
  if (-not $root) { Fail "No process with PID $RootPid runs." }
  $tree = [System.Collections.Generic.List[object]]::new(); $tree.Add($root)
  for ($i = 0; $i -lt $tree.Count; $i++) {
    $p = $tree[$i]
    $All | Where-Object { $_.ParentProcessId -eq $p.ProcessId -and $_.ProcessId -ne $p.ProcessId -and $_.CreationDate -ge $p.CreationDate } | ForEach-Object { $tree.Add($_) }
  }
  , $tree
}

# A process that ends between the CIM read and Get-Process counts 0 bytes.
function JsonSample($All) {
  $tree = Tree $All
  $webView2 = [int64]0; $total = [int64]0
  $g = @{ shell = [int64]0; service = [int64]0; git = [int64]0; wvBrowser = [int64]0; wvRenderer = [int64]0; wvGpu = [int64]0; wvOther = [int64]0; other = [int64]0 }
  $gitCount = 0
  foreach ($p in $tree) {
    $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    $bytes = if ($gp) { [int64]$gp.PrivateMemorySize64 } else { [int64]0 }
    $total += $bytes
    if ($p.Name -eq 'msedgewebview2.exe') {
      $webView2 += $bytes
      $t = if ($p.CommandLine -match '--type=(\S+)') { $Matches[1] } else { 'browser' }
      if ($t -eq 'browser') { $g.wvBrowser += $bytes } elseif ($t -eq 'renderer') { $g.wvRenderer += $bytes } elseif ($t -eq 'gpu-process') { $g.wvGpu += $bytes } else { $g.wvOther += $bytes }
    } elseif ($p.Name -eq 'arbareto.exe') { $g.shell += $bytes }
    elseif ($p.Name -eq 'arbareto-git.exe') { $g.service += $bytes }
    elseif ($p.Name -like 'git*.exe' -or $p.Name -eq 'sh.exe' -or $p.Name -eq 'conhost.exe') { $g.git += $bytes; $gitCount++ }
    else { $g.other += $bytes }
  }
  ConvertTo-Json -Compress -InputObject ([ordered]@{ timeMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); rootPid = $RootPid; processes = $tree.Count; webView2PrivateBytes = $webView2; totalPrivateBytes = $total; shell = $g.shell; service = $g.service; git = $g.git; gitCount = $gitCount; wvBrowser = $g.wvBrowser; wvRenderer = $g.wvRenderer; wvGpu = $g.wvGpu; wvOther = $g.wvOther; other = $g.other })
}

$clock = [Diagnostics.Stopwatch]::StartNew()
for ($next = 0; ; $next += $IntervalMs) {
  JsonSample $all
  if ($IntervalMs -eq 0) { break }
  # The interval runs from the start of one sample to the start of the next. A late sample starts the next one at once.
  $wait = $next + $IntervalMs - $clock.ElapsedMilliseconds
  if ($wait -gt 0) { Start-Sleep -Milliseconds $wait } else { $next = $clock.ElapsedMilliseconds - $IntervalMs }
  $all = Get-CimInstance Win32_Process
}
