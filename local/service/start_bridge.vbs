' Launch supervisor.ps1 in a fully hidden window. Used by both the scheduled task and manual start.
' (ASCII only: wscript reads .vbs with the ANSI code page.)
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\supervisor.ps1""", 0, False
