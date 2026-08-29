param(
  [string]$DatabaseUrl = $env:DATABASE_URL,
  [string]$Destination = "C:\ProgramData\FileFinder\backups",
  [Parameter(Mandatory=$true)][string]$EncryptionCertificateThumbprint,
  [int]$DailyRetention = 7
)
$ErrorActionPreference = "Stop"
if (-not $DatabaseUrl) { throw "DATABASE_URL is required" }
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$plain = Join-Path $env:TEMP "filefinder-$stamp.dump"
$encrypted = Join-Path $Destination "filefinder-$stamp.dump.p7m"
try {
  & pg_dump.exe --dbname=$DatabaseUrl --format=custom --file=$plain
  if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }
  Protect-CmsMessage -Path $plain -To "Cert:\LocalMachine\My\$EncryptionCertificateThumbprint" -OutFile $encrypted
} finally {
  if (Test-Path $plain) { Remove-Item -Force $plain }
}
Get-ChildItem $Destination -Filter "filefinder-*.dump.p7m" | Sort-Object LastWriteTime -Descending | Select-Object -Skip $DailyRetention | Remove-Item -Force
Write-Host "Encrypted backup created: $encrypted"

