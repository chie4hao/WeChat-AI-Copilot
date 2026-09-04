# 取消自启（计划任务和启动文件夹快捷方式都清掉）并停止本地端
$task = 'WeChat AI Copilot Bridge'
& (Join-Path $PSScriptRoot 'stop_bridge.ps1')
if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $task -Confirm:$false
  Write-Output "已删除计划任务「$task」"
}
$lnkPath = Join-Path ([Environment]::GetFolderPath('Startup')) "$task.lnk"
if (Test-Path $lnkPath) { Remove-Item $lnkPath -Force; Write-Output "已删除启动文件夹快捷方式" }
Write-Output "自启已取消"
