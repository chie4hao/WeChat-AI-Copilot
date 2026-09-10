# 手动后台启动本地端（隐藏窗口，崩溃自动重启）。已在运行则什么都不做。
param([string]$TaskName = 'WeChat AI Copilot Bridge')
$ErrorActionPreference = 'Stop'
$vbs = Join-Path $PSScriptRoot 'start_bridge.vbs'
$root = Split-Path -Parent $PSScriptRoot
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  if (-not ($task.Actions | Where-Object { $_.WorkingDirectory -eq $root -and $_.Arguments -eq "`"$vbs`"" })) {
    throw '计划任务指向其他目录，请先运行 service:install 更新配置'
  }
  # 由 Windows 服务创建进程，避免继承终端/Codex 的进程作业。
  if ($task.State -eq 'Disabled') { Enable-ScheduledTask -TaskName $TaskName | Out-Null }
  if ($task.State -ne 'Running') { Start-ScheduledTask -TaskName $TaskName }
} else {
  Write-Output '未安装计划任务，使用后台启动；运行 service:install 可启用独立托管和异常恢复'
  Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbs`"" -WindowStyle Hidden
}
Start-Sleep -Seconds 3
& (Join-Path $PSScriptRoot 'status.ps1') -TaskName $TaskName
