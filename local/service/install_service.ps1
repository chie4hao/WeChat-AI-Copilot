# 注册登录自启：优先用计划任务（登录后 30 秒隐藏启动）；没有权限创建计划任务时退回到"启动"文件夹快捷方式。
# 两种方式都不需要管理员权限，都只在当前用户登录后运行（本地端依赖桌面版微信和 WeChatDataAnalysis，本来就要登录）。
param([string]$TaskName = 'WeChat AI Copilot Bridge')
$ErrorActionPreference = 'Stop'
$task = $TaskName
$vbs = Join-Path $PSScriptRoot 'start_bridge.vbs'
$root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path (Join-Path $root 'config.yaml'))) {
  Write-Output "缺少 $root\config.yaml，请先从 config.yaml.example 复制并填写"; exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Output "找不到 node，请先安装 Node.js 20+"; exit 1 }

# 先停掉已在运行的实例，避免两份同时跑
& (Join-Path $PSScriptRoot 'stop_bridge.ps1') -TaskName $task | Out-Null

$how = $null
try {
  $action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $root
  $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $trigger.Delay = 'PT30S'
  # 定时检查也能兜住手动启动后的异常退出、启动器被结束等情况。
  # 正常运行时 IgnoreNew 不会再创建进程；不设 RepetitionDuration，持续检查。
  $recovery = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
                -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
                -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $task -Action $action -Trigger @($trigger, $recovery) -Settings $settings -RunLevel Limited -Force | Out-Null
  $how = "计划任务「$task」：登录后 30 秒自动启动，每分钟检查并恢复已退出的守护进程"
} catch {
  Write-Output "创建计划任务失败（$($_.Exception.Message.Trim())），改用「启动」文件夹快捷方式"
  $lnkPath = Join-Path ([Environment]::GetFolderPath('Startup')) "$task.lnk"
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnkPath)
  $sc.TargetPath = 'wscript.exe'
  $sc.Arguments = "`"$vbs`""
  $sc.WorkingDirectory = $root
  $sc.WindowStyle = 7
  $sc.Description = 'WeChat AI Copilot bridge (auto start)'
  $sc.Save()
  $how = "启动文件夹快捷方式：$lnkPath"
}
Write-Output "已注册自启 → $how"

# 立即启动一次
& (Join-Path $PSScriptRoot 'start_bridge.ps1') -TaskName $task
