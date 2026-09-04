# 手动后台启动本地端（隐藏窗口，崩溃自动重启）。已在运行则什么都不做。
$vbs = Join-Path $PSScriptRoot 'start_bridge.vbs'
Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbs`"" -WindowStyle Hidden
Start-Sleep -Seconds 3
& (Join-Path $PSScriptRoot 'status.ps1')
