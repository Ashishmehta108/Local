param(
  [Parameter(Mandatory=$true)][string]$PublicEndpoint,
  [ValidatePattern('^[A-Za-z0-9._-]+$')][string]$FirstClientName = "computer-01",
  [ValidateRange(2, 254)][int]$FirstClientAddress = 10,
  [string]$VpnPrefix = "10.77.0",
  [ValidateRange(1, 65535)][int]$ListenPort = 51820,
  [string]$OutputDirectory = "C:\ProgramData\FileFinder\wireguard",
  [string]$WireGuardDirectory = "C:\Program Files\WireGuard"
)
$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script from an Administrator PowerShell window."
}

$wg = Join-Path $WireGuardDirectory "wg.exe"
$wireguard = Join-Path $WireGuardDirectory "wireguard.exe"
if (-not (Test-Path $wg) -or -not (Test-Path $wireguard)) {
  throw "WireGuard is not installed in $WireGuardDirectory"
}
if ($PublicEndpoint -notmatch '^[A-Za-z0-9.-]+:\d+$') {
  throw "PublicEndpoint must look like vpn.example.net:51820 or 203.0.113.10:51820"
}

function New-WireGuardPrivateKey {
  (& $wg genkey).Trim()
}
function Get-WireGuardPublicKey([string]$PrivateKey) {
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = [Diagnostics.ProcessStartInfo]@{
    FileName = $wg
    Arguments = "pubkey"
    UseShellExecute = $false
    RedirectStandardInput = $true
    RedirectStandardOutput = $true
    CreateNoWindow = $true
  }
  $null = $process.Start()
  $process.StandardInput.WriteLine($PrivateKey)
  $process.StandardInput.Close()
  $publicKey = $process.StandardOutput.ReadToEnd().Trim()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw "wg pubkey failed" }
  $publicKey
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$clientDirectory = Join-Path $OutputDirectory "clients\$FirstClientName"
New-Item -ItemType Directory -Force -Path $clientDirectory | Out-Null

$serverPrivate = New-WireGuardPrivateKey
$serverPublic = Get-WireGuardPublicKey $serverPrivate
$clientPrivate = New-WireGuardPrivateKey
$clientPublic = Get-WireGuardPublicKey $clientPrivate
$serverConfig = Join-Path $OutputDirectory "filefinder-vpn.conf"
$clientConfig = Join-Path $clientDirectory "$FirstClientName.conf"

@"
[Interface]
PrivateKey = $serverPrivate
Address = $VpnPrefix.1/24
ListenPort = $ListenPort

[Peer]
# $FirstClientName
PublicKey = $clientPublic
AllowedIPs = $VpnPrefix.$FirstClientAddress/32
"@ | Set-Content -LiteralPath $serverConfig -Encoding ascii

@"
[Interface]
PrivateKey = $clientPrivate
Address = $VpnPrefix.$FirstClientAddress/32

[Peer]
PublicKey = $serverPublic
Endpoint = $PublicEndpoint
AllowedIPs = $VpnPrefix.1/32
PersistentKeepalive = 25
"@ | Set-Content -LiteralPath $clientConfig -Encoding ascii

icacls $OutputDirectory /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null
$service = Get-Service 'WireGuardTunnel$filefinder-vpn' -ErrorAction SilentlyContinue
if ($service) {
  & $wireguard /uninstalltunnelservice filefinder-vpn
  Start-Sleep -Seconds 2
}
& $wireguard /installtunnelservice $serverConfig
if ($LASTEXITCODE -ne 0) { throw "WireGuard tunnel service installation failed" }

if (-not (Get-NetFirewallRule -DisplayName "FileFinder WireGuard" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "FileFinder WireGuard" -Direction Inbound -Action Allow -Protocol UDP -LocalPort $ListenPort | Out-Null
}
if (-not (Get-NetFirewallRule -DisplayName "FileFinder HTTPS over VPN" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "FileFinder HTTPS over VPN" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 443 -RemoteAddress "$VpnPrefix.0/24" | Out-Null
}

Write-Host "WireGuard coordinator installed at $VpnPrefix.1:$ListenPort"
Write-Host "Client configuration: $clientConfig"
Write-Host "Server public key: $serverPublic"
