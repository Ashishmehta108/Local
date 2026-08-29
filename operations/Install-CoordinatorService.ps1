param(
  [string]$InstallDirectory = "C:\Program Files\FileFinder Coordinator",
  [string]$DataDirectory = "C:\ProgramData\FileFinder"
)
$ErrorActionPreference = "Stop"
# Release media bundles node.exe, dist, migrations, and production dependencies.
$required = @("node.exe", "dist\src\index.js", "coordinator.env")
foreach ($item in $required) { if (-not (Test-Path (Join-Path $InstallDirectory $item))) { throw "Missing release file: $item" } }
New-Item -ItemType Directory -Force -Path $DataDirectory | Out-Null
$node = Join-Path $InstallDirectory "node.exe"
$environment = Join-Path $InstallDirectory "coordinator.env"
$entry = Join-Path $InstallDirectory "dist\src\index.js"
$command = ('"{0}" --env-file="{1}" "{2}"' -f $node, $environment, $entry)
if (Get-Service FileFinderCoordinator -ErrorAction SilentlyContinue) { Stop-Service FileFinderCoordinator; sc.exe delete FileFinderCoordinator | Out-Null }
sc.exe create FileFinderCoordinator binPath= $command start= auto DisplayName= "FileFinder Coordinator" | Out-Null
sc.exe failure FileFinderCoordinator reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
Start-Service FileFinderCoordinator
Write-Host "FileFinder Coordinator service installed."

