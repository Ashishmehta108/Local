param(
  [Parameter(Mandatory=$true)][string]$ReleaseDirectory,
  [string]$InstallDirectory = "C:\Program Files\FileFinder Coordinator",
  [string]$BackupScript = "C:\Program Files\FileFinder Coordinator\operations\Backup-FileFinder.ps1",
  [Parameter(Mandatory=$true)][string]$EncryptionCertificateThumbprint
)
$ErrorActionPreference = "Stop"
& $BackupScript -EncryptionCertificateThumbprint $EncryptionCertificateThumbprint
Stop-Service FileFinderCoordinator
$rollback = "$InstallDirectory.rollback"
if (Test-Path $rollback) { Remove-Item -Recurse -Force $rollback }
Rename-Item $InstallDirectory $rollback
try {
  Copy-Item -Recurse -Force $ReleaseDirectory $InstallDirectory
  $node = Join-Path $InstallDirectory "node.exe"
  $environmentArgument = "--env-file=$(Join-Path $InstallDirectory 'coordinator.env')"
  $migration = Join-Path $InstallDirectory "dist\scripts\migrate.js"
  & $node $environmentArgument $migration
  if ($LASTEXITCODE -ne 0) { throw "Database migration failed" }
  Start-Service FileFinderCoordinator
  Start-Sleep -Seconds 3
  & (Join-Path $InstallDirectory "operations\Test-FileFinderHealth.ps1")
} catch {
  if (Get-Service FileFinderCoordinator -ErrorAction SilentlyContinue) { Stop-Service FileFinderCoordinator -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force $InstallDirectory
  Rename-Item $rollback $InstallDirectory
  Start-Service FileFinderCoordinator
  throw
}
Write-Host "Coordinator update completed; rollback files remain at $rollback"
