param(
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$ClientName = ("friend-{0}" -f (Get-Date -Format "yyyyMMdd-HHmmss")),
  [string]$PublicEndpoint,
  [string]$DesktopInstaller,
  [string]$OutputDirectory = ".\output\friend-installers",
  [string]$WireGuardDataDirectory = "C:\ProgramData\FileFinder\wireguard",
  [string]$PkiDirectory = "C:\ProgramData\FileFinder\pki"
)

$ErrorActionPreference = "Stop"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script from an Administrator PowerShell window."
}

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$makeNsis = @(
  "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe",
  "$env:LOCALAPPDATA\tauri\NSIS\Bin\makensis.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $makeNsis) { throw "The NSIS compiler is missing. Build the Tauri desktop installer once first." }
$requiredHostFiles = @(
  (Join-Path $WireGuardDataDirectory "filefinder-vpn.conf"),
  (Join-Path $PkiDirectory "device-ca.crt.pem"),
  (Join-Path $PkiDirectory "device-ca.key.pem"),
  "C:\ProgramData\FileFinder\caddy-data\caddy\pki\authorities\local\root.crt",
  (Join-Path $root "wireguard-amd64-1.1.msi")
)
foreach ($requiredHostFile in $requiredHostFiles) {
  if (-not (Test-Path -LiteralPath $requiredHostFile)) { throw "Required setup file is missing: $requiredHostFile" }
}
$openSsl = "C:\Program Files\Git\usr\bin\openssl.exe"
if (-not (Test-Path $openSsl)) {
  $openSslCommand = Get-Command openssl.exe -ErrorAction SilentlyContinue
  if (-not $openSslCommand) { throw "OpenSSL is required to issue the device identity." }
  $openSsl = $openSslCommand.Source
}
$endpointFile = Join-Path $WireGuardDataDirectory "public-endpoint.txt"
if (-not $PublicEndpoint -and (Test-Path $endpointFile)) {
  $PublicEndpoint = (Get-Content -LiteralPath $endpointFile -Raw).Trim()
}
if (-not $PublicEndpoint) {
  $publicIp = (Invoke-RestMethod -Uri "https://api.ipify.org").Trim()
  $PublicEndpoint = "$publicIp`:51820"
}
if ($PublicEndpoint -notmatch '^[A-Za-z0-9.-]+:\d+$') { throw "PublicEndpoint must look like vpn.example.net:51820 or 203.0.113.10:51820" }
Set-Content -LiteralPath $endpointFile -Value $PublicEndpoint -Encoding ascii

if (-not $DesktopInstaller) {
  $desktopCandidates = @(
    (Get-ChildItem (Join-Path $root "target\x86_64-pc-windows-msvc\release\bundle\nsis") -Filter "*-setup.exe" -File -ErrorAction SilentlyContinue),
    (Get-ChildItem (Join-Path $root "target\x86_64-pc-windows-msvc\release\bundle\msi") -Filter "*.msi" -File -ErrorAction SilentlyContinue)
  ) | Where-Object { $_ } | Sort-Object LastWriteTime -Descending
  $DesktopInstaller = $desktopCandidates | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $DesktopInstaller -or -not (Test-Path $DesktopInstaller)) {
  throw "Build FileFinder first with scripts\Prepare-WindowsDesktopRelease.ps1 or pass -DesktopInstaller."
}

$serverConfig = Join-Path $WireGuardDataDirectory "filefinder-vpn.conf"
$existingClientDirectory = Join-Path $WireGuardDataDirectory "clients\$ClientName"
if (Test-Path $existingClientDirectory) { throw "A WireGuard client named '$ClientName' already exists." }
$usedAddresses = Get-Content -LiteralPath $serverConfig | ForEach-Object {
  if ($_ -match 'AllowedIPs\s*=\s*10\.77\.0\.(\d+)/32') { [int]$Matches[1] }
}
$clientAddress = 10..254 | Where-Object { $_ -notin $usedAddresses } | Select-Object -First 1
if (-not $clientAddress) { throw "The WireGuard client address pool is full." }

$outputRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
$staging = Join-Path $outputRoot (".{0}-staging" -f $ClientName)
$outputExe = Join-Path $outputRoot ("FileFinder-Setup-{0}.exe" -f $ClientName)
if (Test-Path $outputExe) { throw "Installer already exists: $outputExe" }
New-Item -ItemType Directory -Force -Path $outputRoot, $staging | Out-Null
$serverBackup = Join-Path $env:TEMP ("filefinder-vpn-{0}.backup.conf" -f [guid]::NewGuid())
Copy-Item -LiteralPath $serverConfig -Destination $serverBackup
$peerCreated = $false

try {
  & (Join-Path $PSScriptRoot "New-FileFinderWireGuardClient.ps1") -ClientName $ClientName -ClientAddress $clientAddress -PublicEndpoint $PublicEndpoint
  $peerCreated = $true
  $generatedClient = Join-Path $WireGuardDataDirectory "clients\$ClientName\$ClientName.conf"
  Copy-Item -LiteralPath $generatedClient -Destination (Join-Path $staging "wireguard.conf")

  & (Join-Path $root "operations\pki\Issue-DeviceCertificate.ps1") -DeviceName $ClientName -PkiDirectory $PkiDirectory -OutputDirectory $staging
  Copy-Item -LiteralPath "C:\ProgramData\FileFinder\caddy-data\caddy\pki\authorities\local\root.crt" -Destination (Join-Path $staging "coordinator-ca.pem")
  Copy-Item -LiteralPath (Join-Path $root "wireguard-amd64-1.1.msi") -Destination (Join-Path $staging "wireguard-installer.msi")
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot "Install-FileFinderFriend.ps1") -Destination $staging

  $desktopExtension = [IO.Path]::GetExtension($DesktopInstaller).ToLowerInvariant()
  $desktopPayloadName = if ($desktopExtension -eq ".msi") { "FileFinder-Desktop-Setup.msi" } else { "FileFinder-Desktop-Setup.exe" }
  Copy-Item -LiteralPath $DesktopInstaller -Destination (Join-Path $staging $desktopPayloadName)

  $fingerprint = (& $openSsl x509 -in (Join-Path $staging "client.crt.pem") -noout -fingerprint -sha256).Split('=')[1].Replace(':', '').ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $fingerprint -notmatch '^[a-f0-9]{64}$') { throw "Could not calculate the device certificate fingerprint." }
  [ordered]@{
    clientName = $ClientName
    vpnAddress = "10.77.0.$clientAddress"
    endpoint = $PublicEndpoint
    certificateFingerprint = $fingerprint
    coordinatorUrl = "https://filefinder.office.local"
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $staging "friend-manifest.json") -Encoding utf8

  $fileCommands = Get-ChildItem -LiteralPath $staging -File | Sort-Object Name | ForEach-Object {
    'File /oname={0} "{1}"' -f $_.Name, $_.FullName
  }
  $nsis = @"
Unicode true
RequestExecutionLevel admin
SilentInstall silent
AutoCloseWindow true
SetCompressor /SOLID lzma
Name "FileFinder Setup for $ClientName"
OutFile "$outputExe"
Section
  SetOutPath "`$PLUGINSDIR"
  $($fileCommands -join "`r`n  ")
  ExecWait '"`$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "`$PLUGINSDIR\Install-FileFinderFriend.ps1"' `$0
  SetErrorLevel `$0
SectionEnd
"@
  $nsisPath = Join-Path $staging "package.nsi"
  Set-Content -LiteralPath $nsisPath -Value $nsis -Encoding utf8
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & $makeNsis /V4 $nsisPath
  $packageExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
  if ($packageExitCode -ne 0 -or -not (Test-Path $outputExe)) { throw "Windows failed to create the friend installer." }
  Write-Host "Friend installer created: $outputExe"
  Write-Host "Your friend only needs to run this EXE and approve UAC."
} catch {
  if ($peerCreated) {
    Copy-Item -Force -LiteralPath $serverBackup -Destination $serverConfig
    Remove-Item -LiteralPath $existingClientDirectory -Recurse -Force -ErrorAction SilentlyContinue
    $wireGuard = "C:\Program Files\WireGuard\wireguard.exe"
    & $wireGuard /uninstalltunnelservice filefinder-vpn | Out-Null
    Start-Sleep -Seconds 2
    & $wireGuard /installtunnelservice $serverConfig | Out-Null
  }
  throw
} finally {
  if (Test-Path $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  Remove-Item -LiteralPath $serverBackup -Force -ErrorAction SilentlyContinue
}
