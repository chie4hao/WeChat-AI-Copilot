# 查看本地端运行状态：计划任务、监督进程、node 进程、最近日志
$root = Split-Path -Parent $PSScriptRoot
$task = 'WeChat AI Copilot Bridge'
$pidFile = Join-Path $root 'bridge.pid'

Write-Output "== 计划任务 =="
$q = schtasks /Query /TN "$task" /FO LIST 2>$null
if ($LASTEXITCODE -eq 0) { $q | Where-Object { $_ -match '状态|Status|下次运行|Next Run|上次运行|Last Run' } } else { Write-Output "未安装（npm run service:install）" }

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
