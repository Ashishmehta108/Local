param(
  [Parameter(Mandatory=$true)][string]$Backup,
  [string]$DatabaseUrl = $env:DATABASE_URL
)
$ErrorActionPreference = "Stop"
if (-not $DatabaseUrl) { throw "DATABASE_URL is required" }
if (-not (Test-Path $Backup)) { throw "Backup does not exist: $Backup" }
$plain = Join-Path $env:TEMP "filefinder-restore-$([guid]::NewGuid()).dump"
try {
  Unprotect-CmsMessage -Path $Backup | Set-Content -AsByteStream $plain
  & pg_restore.exe --dbname=$DatabaseUrl --clean --if-exists --no-owner $plain
  if ($LASTEXITCODE -ne 0) { throw "pg_restore failed" }
} finally {
  if (Test-Path $plain) { Remove-Item -Force $plain }
}
Write-Host "Restore completed. Run Test-FileFinderHealth.ps1 before reopening access."

