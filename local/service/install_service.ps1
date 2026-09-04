# 注册开机（登录）自启：Windows 计划任务，登录后 30 秒以隐藏窗口启动监督进程。
# 不需要管理员权限；任务只在当前用户登录时运行（本地端依赖桌面版微信和 WeChatDataAnalysis，本来就要登录）。
$ErrorActionPreference = 'Stop'
$task = 'WeChat AI Copilot Bridge'
$vbs = Join-Path $PSScriptRoot 'start_bridge.vbs'
$root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path (Join-Path $root 'config.yaml'))) {
  Write-Output "缺少 $root\config.yaml，请先从 config.yaml.example 复制并填写"; exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Output "找不到 node，请先安装 Node.js 20+"; exit 1 }

# 先停掉手动启动的实例，避免两份同时跑
& (Join-Path $PSScriptRoot 'stop_bridge.ps1') | Out-Null

$tr = 'wscript.exe "' + $vbs + '"'
schtasks /Create /F /TN "$task" /SC ONLOGON /DELAY 0000:30 /RL LIMITED /TR $tr | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Output "创建计划任务失败（退出码 $LASTEXITCODE）"; exit 1 }
Write-Output "已注册计划任务「$task」：登录后 30 秒自动启动"

# 立即启动一次
Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbs`"" -WindowStyle Hidden
Start-Sleep -Seconds 4
& (Join-Path $PSScriptRoot 'status.ps1')
