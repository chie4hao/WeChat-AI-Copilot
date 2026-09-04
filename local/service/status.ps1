# 查看本地端运行状态：自启方式、监督进程、node 进程、最近日志
$root = Split-Path -Parent $PSScriptRoot
$task = 'WeChat AI Copilot Bridge'
$pidFile = Join-Path $root 'bridge.pid'

Write-Output "== 自启 =="
$t = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
$lnkPath = Join-Path ([Environment]::GetFolderPath('Startup')) "$task.lnk"
if ($t) { Write-Output ("计划任务：{0}（上次结果 {1}）" -f $t.State, (Get-ScheduledTaskInfo -TaskName $task).LastTaskResult) }
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
