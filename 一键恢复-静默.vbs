' Silent restore: start SnowLuma + QQ bridge with no prompt and no keyboard input.
' Double-click this file. Two minimized windows will appear; keep them alive.
' If you cannot type into cmd windows (remote desktop / phone), use THIS file
' instead of the .bat ones.

Option Explicit
Dim sh, base
Set sh = CreateObject("WScript.Shell")
base = "F:\ai\qq-bridge\"

sh.CurrentDirectory = base
sh.Run "cmd /c """ & base & "start-snowluma.bat""", 7, False
WScript.Sleep 7000
sh.Run "cmd /c """ & base & "start.bat""", 7, False
WScript.Sleep 1200
sh.Popup "SnowLuma + QQ bridge started." & vbCrLf & vbCrLf & _
         "Check: http://127.0.0.1:3100 (console)" & vbCrLf & _
         "       http://127.0.0.1:5099 (SnowLuma)", 6, "Restore", 64
