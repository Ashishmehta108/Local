param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$ClientName,
  [Parameter(Mandatory=$true)][ValidateRange(2, 254)][int]$ClientAddress,
  [Parameter(Mandatory=$true)][string]$PublicEndpoint,
  [string]$VpnPrefix = "10.77.0",
  [string]$DataDirectory = "C:\ProgramData\FileFinder\wireguard",
  [string]$WireGuardDirectory = "C:\Program Files\WireGuard"
)
$ErrorActionPreference = "Stop"
$wg = Join-Path $WireGuardDirectory "wg.exe"
$serverConfig = Join-Path $DataDirectory "filefinder-vpn.conf"
if (-not (Test-Path $wg) -or -not (Test-Path $serverConfig)) { throw "Initialize the WireGuard coordinator first." }
if ($PublicEndpoint -notmatch '^[A-Za-z0-9.-]+:\d+$') { throw "PublicEndpoint must include a host and port." }

$serverPrivate = ((Get-Content $serverConfig | Select-String '^PrivateKey = ' | Select-Object -First 1).Line -replace '^PrivateKey = ','').Trim()
$serverPublic = ($serverPrivate | & $wg pubkey).Trim()
$clientPrivate = (& $wg genkey).Trim()
$clientPublic = ($clientPrivate | & $wg pubkey).Trim()
$clientDirectory = Join-Path $DataDirectory "clients\$ClientName"
New-Item -ItemType Directory -Force -Path $clientDirectory | Out-Null
$clientConfig = Join-Path $clientDirectory "$ClientName.conf"

Add-Content -LiteralPath $serverConfig -Encoding ascii -Value @"

[Peer]
# $ClientName
PublicKey = $clientPublic
AllowedIPs = $VpnPrefix.$ClientAddress/32
"@
@"
[Interface]
PrivateKey = $clientPrivate
Address = $VpnPrefix.$ClientAddress/32

[Peer]
PublicKey = $serverPublic
Endpoint = $PublicEndpoint
AllowedIPs = $VpnPrefix.1/32
PersistentKeepalive = 25
"@ | Set-Content -LiteralPath $clientConfig -Encoding ascii

& (Join-Path $WireGuardDirectory "wireguard.exe") /uninstalltunnelservice filefinder-vpn
if ($LASTEXITCODE -ne 0) { throw "Could not stop the WireGuard coordinator tunnel." }
Start-Sleep -Seconds 2
& (Join-Path $WireGuardDirectory "wireguard.exe") /installtunnelservice $serverConfig
if ($LASTEXITCODE -ne 0) { throw "Could not restart the WireGuard coordinator tunnel." }
Write-Host "Created $clientConfig"
