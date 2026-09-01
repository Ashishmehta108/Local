param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$DeviceName,
  [string]$PkiDirectory = "C:\ProgramData\FileFinder\pki",
  [string]$OutputDirectory = ".\device-identity",
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
$key = Join-Path $OutputDirectory "client.key.pem"
$csr = Join-Path $OutputDirectory "client.csr.pem"
$cert = Join-Path $OutputDirectory "client.crt.pem"
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $OpenSsl genpkey -algorithm ED25519 -out $key
if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $previousErrorActionPreference; throw "OpenSSL failed to create the device private key" }
& $OpenSsl req -new -key $key -out $csr -subj "/CN=$DeviceName"
if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $previousErrorActionPreference; throw "OpenSSL failed to create the device certificate request" }
& $OpenSsl x509 -req -in $csr -CA (Join-Path $PkiDirectory "device-ca.crt.pem") -CAkey (Join-Path $PkiDirectory "device-ca.key.pem") -CAcreateserial -out $cert -days 397
if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $previousErrorActionPreference; throw "OpenSSL failed to issue the device certificate" }
$ErrorActionPreference = $previousErrorActionPreference
Remove-Item $csr
icacls $key /inheritance:r /grant:r "${env:USERNAME}:F" "SYSTEM:F" | Out-Null
Write-Host "Issued mTLS identity for $DeviceName in $OutputDirectory"
$fingerprint = (& $OpenSsl x509 -in $cert -noout -fingerprint -sha256).Split('=')[1].Replace(':', '').ToLowerInvariant()
Write-Host "Certificate fingerprint for enrolment: $fingerprint"
