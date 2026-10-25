# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Ihor Lifanov

# Runs on PowerShell 7 and Windows PowerShell 5.1.
# -Json prints one JSON line per sample. -IntervalMs <n> samples every n ms until the caller ends this process.
param([int]$RootPid = 0, [switch]$Json, [int]$IntervalMs = 0)

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
  foreach ($p in $tree) {
    $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    $bytes = if ($gp) { [int64]$gp.PrivateMemorySize64 } else { [int64]0 }
    $total += $bytes
    if ($p.Name -eq 'msedgewebview2.exe') { $webView2 += $bytes }
  }
  ConvertTo-Json -Compress -InputObject ([ordered]@{ timeMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); rootPid = $RootPid; processes = $tree.Count; webView2PrivateBytes = $webView2; totalPrivateBytes = $total })
}

function TextReport($All) {
  $tree = Tree $All
  $root = $tree[0]
  "Root $RootPid start=$($root.CreationDate) path=$($root.ExecutablePath)"
  "Cmd: $($root.CommandLine)"
  $perf = @{}; Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { $perf[[int]$_.IDProcess] = [int64]$_.WorkingSetPrivate }
  $rows = foreach ($p in $tree) {
    $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    $type = ''
    if ($p.Name -eq 'msedgewebview2.exe') { $type = if ($p.CommandLine -match '--type=(\S+)') { $Matches[1] } else { 'browser' } }
    $grp = switch ($p.Name) { 'arbareto.exe' {'Tauri'} 'msedgewebview2.exe' {'WebView2'} 'arbareto-git.exe' {'Bun'} default {'Other'} }
    [pscustomobject]@{ PID=$p.ProcessId; PPID=$p.ParentProcessId; Name=$p.Name; Type=$type; Group=$grp
      PrivWS_MB=[math]::Round($perf[[int]$p.ProcessId]/1MB,1)
      Private_MB=[math]::Round($gp.PrivateMemorySize64/1MB,1)
      WS_MB=[math]::Round($gp.WorkingSet64/1MB,1) }
  }
  $rows | Format-Table -AutoSize | Out-String -Width 200
  'Totals (WS double-counts shared pages):'
  function Sum($Items, [string]$Name) { [math]::Round(($Items | Measure-Object $Name -Sum).Sum, 1) }
  $rows | Group-Object Group | ForEach-Object { [pscustomobject]@{ Group=$_.Name; Count=$_.Count
    PrivWS_MB=Sum $_.Group PrivWS_MB; Private_MB=Sum $_.Group Private_MB; WS_MB=Sum $_.Group WS_MB } } | Format-Table -AutoSize | Out-String
  ''
  "TOTAL MEMORY: {0} MB" -f (Sum $rows PrivWS_MB)
  "  The sum of the private working set of all {0} processes in the tree (Task Manager 'Memory' column)." -f $rows.Count
  "  Other sums: private bytes (commit) {0} MB; working set {1} MB (counts shared pages more than once)." -f (Sum $rows Private_MB), (Sum $rows WS_MB)
}

$clock = [Diagnostics.Stopwatch]::StartNew()
for ($next = 0; ; $next += $IntervalMs) {
  if ($Json) { JsonSample $all } else { TextReport $all }
  if ($IntervalMs -eq 0) { break }
  # The interval runs from the start of one sample to the start of the next. A late sample starts the next one at once.
  $wait = $next + $IntervalMs - $clock.ElapsedMilliseconds
  if ($wait -gt 0) { Start-Sleep -Milliseconds $wait } else { $next = $clock.ElapsedMilliseconds - $IntervalMs }
  $all = Get-CimInstance Win32_Process
}
