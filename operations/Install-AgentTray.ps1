param(
  [string]$InstallDirectory = "C:\Program Files\FileFinder",
  [string]$Config = "C:\ProgramData\FileFinder Agent\agent-config.json"
)
$ErrorActionPreference = "Stop"
$agent = Join-Path $InstallDirectory "filefinder-agent.exe"
if (-not (Test-Path $agent)) { throw "Agent executable not found: $agent" }
if (-not (Test-Path $Config)) { throw "Agent configuration not found: $Config" }
$action = New-ScheduledTaskAction -Execute $agent -Argument ('"' + $Config + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "FileFinder Agent" -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName "FileFinder Agent"
Write-Host "FileFinder tray agent installed for $env:USERNAME."

