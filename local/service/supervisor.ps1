# 监督进程：启动 node src/index.js，退出后自动重启。
# 由 start_bridge.vbs 以隐藏窗口启动；开机自启通过 install_service.ps1 注册的计划任务触发。
# node 自己会把日志写到 logs/bridge-YYYY-MM-DD.log，这里的 stdout/stderr 文件只是崩溃时的兜底。

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot        # local/
Set-Location $root
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$pidFile = Join-Path $root 'bridge.pid'
$supLog = Join-Path $logDir 'supervisor.log'

function Log($msg) { Add-Content -Path $supLog -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) -Encoding UTF8 }

# 已经有一个监督进程在跑就直接退出，避免开两份
if (Test-Path $pidFile) {
  try {
    $old = Get-Content $pidFile -Raw | ConvertFrom-Json
    if ($old.supervisor -and (Get-Process -Id $old.supervisor -ErrorAction SilentlyContinue)) {
      Log "已有监督进程 $($old.supervisor) 在运行，本次退出"
      exit 0
    }
  } catch {}
}

$node = (Get-Command node -ErrorAction Stop).Source
Log "监督进程启动 pid=$PID node=$node"

while ($true) {
  $started = Get-Date
  $p = Start-Process -FilePath $node -ArgumentList 'src/index.js' -WorkingDirectory $root -NoNewWindow -PassThru `
        -RedirectStandardOutput (Join-Path $logDir 'stdout-last.log') -RedirectStandardError (Join-Path $logDir 'stderr-last.log')
  @{ supervisor = $PID; node = $p.Id; startedAt = $started.ToString('o') } | ConvertTo-Json -Compress | Set-Content -Path $pidFile -Encoding ASCII
  Log "node 已启动 pid=$($p.Id)"
  $p.WaitForExit()
  $ran = ((Get-Date) - $started).TotalSeconds
  # 10 秒内就退出说明启动即崩（配置错、端口被占等），等 30 秒再试，避免疯狂重启
  $wait = if ($ran -lt 10) { 30 } else { 5 }
  Log ("node 退出（码 {0}，运行 {1:N0}s），{2}s 后重启" -f $p.ExitCode, $ran, $wait)
  Start-Sleep -Seconds $wait
}
