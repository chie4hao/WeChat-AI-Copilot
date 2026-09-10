# 查看本地端运行状态：自启方式、监督进程、node 进程、最近日志
param([string]$TaskName = 'WeChat AI Copilot Bridge')
$root = Split-Path -Parent $PSScriptRoot
$task = $TaskName
$pidFile = Join-Path $root 'bridge.pid'

Write-Output "== 自启 =="
$t = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
$lnkPath = Join-Path ([Environment]::GetFolderPath('Startup')) "$task.lnk"
if ($t) {
  if ($t.State -eq 'Running') { Write-Output '计划任务：Running（正在托管守护进程）' }
  elseif ($t.State -eq 'Disabled') { Write-Output '计划任务：已暂停（service:start 恢复）' }
  else { Write-Output ("计划任务：{0}（上次结果 {1}）" -f $t.State, (Get-ScheduledTaskInfo -TaskName $task).LastTaskResult) }
  if ($t.Triggers | Where-Object { $_.Repetition.Interval -eq 'PT1M' }) { Write-Output '自动恢复：每分钟检查，已有运行实例时跳过' }
  else { Write-Output '尚未安装周期恢复，请运行 service:install' }
}
elseif (Test-Path $lnkPath) { Write-Output "启动文件夹快捷方式：$lnkPath" }
else { Write-Output "未安装（npm run service:install）" }

Write-Output "== 进程 =="
if (Test-Path $pidFile) {
  $info = Get-Content $pidFile -Raw | ConvertFrom-Json
  $sup = Get-Process -Id $info.supervisor -ErrorAction SilentlyContinue
  $node = Get-Process -Id $info.node -ErrorAction SilentlyContinue
  Write-Output ("监督进程 {0}: {1}" -f $info.supervisor, $(if ($sup) { '运行中' } else { '未运行' }))
  Write-Output ("node {0}: {1}（启动于 {2}）" -f $info.node, $(if ($node) { '运行中' } else { '未运行' }), $info.startedAt)
} else {
  Write-Output "没有 bridge.pid，未通过监督进程启动"
}

Write-Output "== 最近日志 =="
$log = Get-ChildItem (Join-Path $root 'logs') -Filter 'bridge-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($log) { Write-Output $log.FullName; Get-Content $log.FullName -Encoding UTF8 -Tail 8 } else { Write-Output "还没有日志" }
