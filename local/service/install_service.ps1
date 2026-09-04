# 注册登录自启：优先用计划任务（登录后 30 秒隐藏启动）；没有权限创建计划任务时退回到"启动"文件夹快捷方式。
# 两种方式都不需要管理员权限，都只在当前用户登录后运行（本地端依赖桌面版微信和 WeChatDataAnalysis，本来就要登录）。
$ErrorActionPreference = 'Stop'
$task = 'WeChat AI Copilot Bridge'
$vbs = Join-Path $PSScriptRoot 'start_bridge.vbs'
$root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path (Join-Path $root 'config.yaml'))) {
  Write-Output "缺少 $root\config.yaml，请先从 config.yaml.example 复制并填写"; exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Output "找不到 node，请先安装 Node.js 20+"; exit 1 }

# 先停掉已在运行的实例，避免两份同时跑
& (Join-Path $PSScriptRoot 'stop_bridge.ps1') | Out-Null

$how = $null
try {
  $action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $root
  $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $trigger.Delay = 'PT30S'
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
                -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
  Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null
  $how = "计划任务「$task」：登录后 30 秒自动启动"
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
Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbs`"" -WindowStyle Hidden
Start-Sleep -Seconds 4
& (Join-Path $PSScriptRoot 'status.ps1')
