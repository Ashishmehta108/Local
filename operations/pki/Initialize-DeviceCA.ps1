param(
  [string]$OutputDirectory = "C:\ProgramData\FileFinder\pki",
  [string]$OpenSsl = "openssl.exe"
)
$ErrorActionPreference = "Stop"
$resolvedOpenSsl = Get-Command $OpenSsl -ErrorAction SilentlyContinue
if (-not $resolvedOpenSsl) {
  $gitOpenSsl = "C:\Program Files\Git\usr\bin\openssl.exe"
  if (-not (Test-Path $gitOpenSsl)) { throw "OpenSSL was not found. Install OpenSSL or Git for Windows." }
  $OpenSsl = $gitOpenSsl
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$key = Join-Path $OutputDirectory "device-ca.key.pem"
$cert = Join-Path $OutputDirectory "device-ca.crt.pem"
if (Test-Path $key) { throw "Device CA already exists at $OutputDirectory" }
& $OpenSsl genpkey -algorithm ED25519 -out $key
& $OpenSsl req -x509 -new -key $key -out $cert -days 3650 -subj "/CN=FileFinder Device CA"
if ($LASTEXITCODE -ne 0) { throw "OpenSSL failed to create the device CA" }
icacls $key /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" | Out-Null
Write-Host "Device CA created. Keep device-ca.key.pem restricted and offline when not issuing identities."

