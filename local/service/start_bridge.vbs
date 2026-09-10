' Keep the action alive and report supervisor failures to Windows Task Scheduler.
' (ASCII only: wscript reads .vbs with the ANSI code page.)
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
result = sh.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\supervisor.ps1""", 0, True)
' Normalize forced termination (-1) to a regular failure for RestartOnFailure.
If result <> 0 Then WScript.Quit 1
WScript.Quit 0
