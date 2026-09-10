# 常驻监督 node；本脚本自身异常退出由 Windows 计划任务重启。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$pidFile = Join-Path $root 'bridge.pid'
$supLog = Join-Path $logDir 'supervisor.log'
$entryPath = Join-Path $root 'src/index.js'

function Log($msg) { Add-Content -LiteralPath $supLog -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) -Encoding UTF8 }

# 按项目目录互斥，避免计划任务和手动启动同时创建两份进程。
$hasher = [System.Security.Cryptography.SHA256]::Create()
$hash = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant()))).Replace('-', '')
$hasher.Dispose()
$mutex = New-Object System.Threading.Mutex($false, "Local\WeChatCopilot-$hash")
$ownsMutex = $false
$child = $null
try {
  try { $ownsMutex = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (-not $ownsMutex) { Log '已有守护进程持有项目锁，本次退出'; exit 0 }

  if (Test-Path -LiteralPath $pidFile) {
    $old = $null
    try { $old = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json } catch {}
    if ($old.supervisor) {
      $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$($old.supervisor)"
      if ($existing -and $existing.ProcessId -ne $PID -and $existing.CommandLine -match [regex]::Escape((Join-Path $PSScriptRoot 'supervisor.ps1'))) {
        Log "已有旧版守护进程 $($existing.ProcessId) 在运行，本次退出"
        exit 0
      }
    }
    if ($old.node) {
      $orphan = Get-CimInstance Win32_Process -Filter "ProcessId=$($old.node)"
      if ($orphan -and $orphan.Name -eq 'node.exe' -and $orphan.CommandLine -match ('(?i)(?:^|[\s"])' + [regex]::Escape($entryPath) + '(?:[\s"]|$)')) {
        Log "清理上次异常退出遗留的本项目 node $($orphan.ProcessId)"
        Stop-Process -Id $orphan.ProcessId -Force
      }
    }
  }

  $nodeExe = (Get-Command node -ErrorAction Stop).Source
  Log "监督进程启动 pid=$PID node=$nodeExe"
  while ($true) {
    $started = Get-Date
    $child = Start-Process -FilePath $nodeExe -ArgumentList "`"$entryPath`"" -WorkingDirectory $root -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $logDir 'stdout-last.log') -RedirectStandardError (Join-Path $logDir 'stderr-last.log')
    @{ supervisor = $PID; node = $child.Id; startedAt = $started.ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath $pidFile -Encoding ASCII
    Log "node 已启动 pid=$($child.Id)"
    $child.WaitForExit()
    $ran = ((Get-Date) - $started).TotalSeconds
    $wait = if ($ran -lt 10) { 30 } else { 5 }
    Log ("node 退出（码 {0}，运行 {1:N0}s），{2}s 后重启" -f $child.ExitCode, $ran, $wait)
    $child.Dispose()
    $child = $null
    Start-Sleep -Seconds $wait
  }
} catch {
  Log "监督进程异常退出，交给计划任务恢复：$($_.Exception.Message)"
  exit 1
} finally {
  if ($child -and -not $child.HasExited) { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue }
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
