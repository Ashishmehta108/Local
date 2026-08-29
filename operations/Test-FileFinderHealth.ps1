param([string]$Coordinator = "https://filefinder.office.local")
$ErrorActionPreference = "Stop"
$health = Invoke-RestMethod "$Coordinator/healthz"
$ready = Invoke-RestMethod "$Coordinator/readyz"
if ($health.status -ne "ok" -or $ready.status -ne "ready") { throw "Coordinator health check failed" }
Write-Host "FileFinder coordinator is healthy and database-ready."

