param(
  [string]$ProjectDirectory = (Split-Path $PSScriptRoot -Parent),
  [string]$TaskName = "FileFinder Coordinator"
)

$ErrorActionPreference = "Stop"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script from an Administrator PowerShell window."
}

$project = (Resolve-Path $ProjectDirectory).Path
$entryPoint = Join-Path $project "dist\src\index.js"
if (-not (Test-Path $entryPoint)) { throw "Build the coordinator first: pnpm build" }
$node = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
if (-not $node -and (Test-Path "C:\Program Files\nodejs\node.exe")) { $node = "C:\Program Files\nodejs\node.exe" }
if (-not $node) { throw "node.exe was not found" }

$action = New-ScheduledTaskAction -Execute $node -Argument 'dist\src\index.js' -WorkingDirectory $project
$trigger = New-ScheduledTaskTrigger -AtStartup
$taskPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 20 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Force | Out-Null
Write-Host "FileFinder coordinator will start automatically with Windows."
