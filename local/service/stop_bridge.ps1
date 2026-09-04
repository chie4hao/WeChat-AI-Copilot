# 停止本地端：先停监督进程（否则它会把 node 拉起来），再停 node；最后按命令行兜底清理。
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root 'bridge.pid'
$stopped = 0
if (Test-Path $pidFile) {
  try {
    $info = Get-Content $pidFile -Raw | ConvertFrom-Json
    foreach ($id in @($info.supervisor, $info.node)) {
      if ($id -and (Get-Process -Id $id -ErrorAction SilentlyContinue)) { Stop-Process -Id $id -Force; $stopped++ }
    }
  } catch {}
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'src[\\/]index\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $stopped++ }
Write-Output "已停止 $stopped 个进程"
