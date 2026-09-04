# 取消开机自启并停止本地端
$task = 'WeChat AI Copilot Bridge'
& (Join-Path $PSScriptRoot 'stop_bridge.ps1')
schtasks /Delete /F /TN "$task" 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Output "已删除计划任务「$task」" } else { Write-Output "计划任务不存在或已删除" }
