# 先停止计划任务，取消异常重启；只清理当前项目的进程。
param([string]$TaskName = 'WeChat AI Copilot Bridge')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root 'bridge.pid'
$supervisorPath = Join-Path $PSScriptRoot 'supervisor.ps1'
$launcherPath = Join-Path $PSScriptRoot 'start_bridge.vbs'
$entryPath = Join-Path $root 'src/index.js'

function Has-ScriptPath($process, $scriptPath) {
  return $process.CommandLine -match ('(?i)(?:^|[\s"])' + [regex]::Escape($scriptPath) + '(?:[\s"]|$)')
}
$processes = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe' OR Name='node.exe' OR Name='wscript.exe'")
$supervisors = @($processes | Where-Object { $_.Name -in @('powershell.exe', 'pwsh.exe') -and (Has-ScriptPath $_ $supervisorPath) })
$launchers = @($processes | Where-Object { $_.Name -eq 'wscript.exe' -and (Has-ScriptPath $_ $launcherPath) })
$nodes = @($processes | Where-Object {
  $_.Name -eq 'node.exe' -and ((Has-ScriptPath $_ $entryPath) -or
    ($_.ParentProcessId -in $supervisors.ProcessId -and $_.CommandLine -match '(?i)(?:^|\s)"?src[\\/]index\.js"?(?:\s|$)'))
})

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task -and ($task.Actions | Where-Object { $_.WorkingDirectory -eq $root -and $_.Arguments -eq "`"$launcherPath`"" })) {
  # 主动停止必须同时暂停周期检查，直到 service:start 显式恢复。
  Disable-ScheduledTask -TaskName $TaskName | Out-Null
  Stop-ScheduledTask -TaskName $TaskName
}
$stopped = 0
foreach ($process in @($launchers) + @($supervisors) + @($nodes)) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ProcessId)"
  if ($current -and $current.CreationDate -eq $process.CreationDate -and $current.CommandLine -eq $process.CommandLine) {
    $handle = Get-Process -Id $current.ProcessId -ErrorAction SilentlyContinue
    if ($handle) {
      $null = $handle.Handle
      Stop-Process -InputObject $handle -Force -ErrorAction SilentlyContinue
      if (-not $handle.WaitForExit(5000)) { throw "进程 $($current.ProcessId) 未能在 5 秒内退出" }
      $handle.Dispose()
    }
    $stopped++
  }
}
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Output "计划任务已停止，清理 $stopped 个本项目进程"
