Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
command = """" & base & "\node.exe"" """ & base & "\app\bin\autoswitch.mjs"" start"
sh.Run command, 0, False
