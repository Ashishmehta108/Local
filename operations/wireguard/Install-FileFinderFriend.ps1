param()

$ErrorActionPreference = "Stop"
$payloadDirectory = Split-Path -Parent $PSCommandPath
$logDirectory = "C:\ProgramData\FileFinder\logs"
$log = Join-Path $logDirectory "friend-install.log"

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
  $process = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"' + $PSCommandPath + '"')
  )
  exit $process.ExitCode
}

New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
Start-Transcript -LiteralPath $log -Append | Out-Null
try {
  $manifestPath = Join-Path $payloadDirectory "friend-manifest.json"
  if (-not (Test-Path $manifestPath)) { throw "Installer manifest is missing" }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ([string]$manifest.clientName -notmatch '^[A-Za-z0-9._-]+$') { throw "Invalid client name in installer" }
  $requiredPayloads = @(
    "wireguard-installer.msi", "wireguard.conf", "client.crt.pem",
    "client.key.pem", "coordinator-ca.pem"
  )
  foreach ($requiredPayload in $requiredPayloads) {
    if (-not (Test-Path (Join-Path $payloadDirectory $requiredPayload))) { throw "Installer payload is missing: $requiredPayload" }
  }
  if (-not (Test-Path (Join-Path $payloadDirectory "FileFinder-Desktop-Setup.exe")) -and
      -not (Test-Path (Join-Path $payloadDirectory "FileFinder-Desktop-Setup.msi"))) {
    throw "FileFinder desktop installer is missing from this package"
  }
  $wireGuardInstaller = Join-Path $payloadDirectory "wireguard-installer.msi"
  $wireGuardSignature = Get-AuthenticodeSignature -FilePath $wireGuardInstaller
  if ($wireGuardSignature.Status -ne "Valid" -or $wireGuardSignature.SignerCertificate.Subject -notmatch "WireGuard LLC") {
    throw "The bundled WireGuard installer does not have a valid WireGuard LLC signature"
  }
  $wireGuard = "C:\Program Files\WireGuard\wireguard.exe"
  if (-not (Test-Path $wireGuard)) {
    $install = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @(
      "/i", ('"' + $wireGuardInstaller + '"'), "/qn", "/norestart"
    )
    if ($install.ExitCode -notin @(0, 3010)) { throw "WireGuard installation failed with exit code $($install.ExitCode)" }
  }
  if (-not (Test-Path $wireGuard)) { throw "WireGuard did not install correctly" }

  $vpnDirectory = "C:\ProgramData\FileFinder\vpn"
  $identityDirectory = "C:\ProgramData\FileFinder Agent"
  New-Item -ItemType Directory -Force -Path $vpnDirectory, $identityDirectory | Out-Null
  $tunnelConfig = Join-Path $vpnDirectory ("filefinder-{0}.conf" -f $manifest.clientName)
  Copy-Item -Force (Join-Path $payloadDirectory "wireguard.conf") $tunnelConfig
  Copy-Item -Force (Join-Path $payloadDirectory "client.crt.pem") (Join-Path $identityDirectory "client.crt.pem")
  Copy-Item -Force (Join-Path $payloadDirectory "client.key.pem") (Join-Path $identityDirectory "client.key.pem")
  Copy-Item -Force (Join-Path $payloadDirectory "coordinator-ca.pem") (Join-Path $identityDirectory "coordinator-ca.pem")
  Set-Content -LiteralPath (Join-Path $identityDirectory "certificate-fingerprint.txt") -Value $manifest.certificateFingerprint -Encoding ascii
  icacls $vpnDirectory /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null
  icacls $identityDirectory /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" "${env:USERNAME}:(OI)(CI)R" | Out-Null

  $tunnelName = "filefinder-$($manifest.clientName)"
  if (Get-Service ('WireGuardTunnel$' + $tunnelName) -ErrorAction SilentlyContinue) {
    & $wireGuard /uninstalltunnelservice $tunnelName
    Start-Sleep -Seconds 2
  }
  & $wireGuard /installtunnelservice $tunnelConfig
  if ($LASTEXITCODE -ne 0) { throw "WireGuard tunnel installation failed" }

  $hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
  $hostsContent = Get-Content -LiteralPath $hostsPath -Raw
  $begin = "# BEGIN FILEFINDER PRIVATE NAMES"
  $end = "# END FILEFINDER PRIVATE NAMES"
  $hostsContent = [regex]::Replace($hostsContent, "(?ms)^# BEGIN FILEFINDER PRIVATE NAMES.*?^# END FILEFINDER PRIVATE NAMES\r?\n?", "")
  $hostsBlock = "$begin`r`n10.77.0.1 filefinder.office.local`r`n10.77.0.1 agents.filefinder.office.local`r`n$end"
  Set-Content -LiteralPath $hostsPath -Value ($hostsContent.TrimEnd() + "`r`n" + $hostsBlock + "`r`n") -Encoding ascii
  Clear-DnsClientCache
  Import-Certificate -FilePath (Join-Path $payloadDirectory "coordinator-ca.pem") -CertStoreLocation Cert:\LocalMachine\Root | Out-Null

  $desktopExe = Join-Path $payloadDirectory "FileFinder-Desktop-Setup.exe"
  $desktopMsi = Join-Path $payloadDirectory "FileFinder-Desktop-Setup.msi"
  if (Test-Path $desktopExe) {
    $desktopInstall = Start-Process $desktopExe -Wait -PassThru -ArgumentList "/S"
  } elseif (Test-Path $desktopMsi) {
    $desktopInstall = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @("/i", ('"' + $desktopMsi + '"'), "/qn", "/norestart")
  } else {
    throw "FileFinder desktop installer is missing from this package"
  }
  if ($desktopInstall.ExitCode -notin @(0, 3010)) { throw "FileFinder installation failed with exit code $($desktopInstall.ExitCode)" }

  $health = $null
  for ($attempt = 0; $attempt -lt 15; $attempt++) {
    try {
      $health = Invoke-RestMethod -Uri "https://filefinder.office.local/healthz" -TimeoutSec 3
      break
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  if (-not $health -or $health.status -ne "ok") {
    Write-Warning "FileFinder installed, but the coordinator is not reachable yet. Check that the host computer and router are online."
  }

  $appCandidates = @(
    "C:\Program Files\FileFinder\FileFinder.exe",
    "C:\Program Files (x86)\FileFinder\FileFinder.exe",
    (Join-Path $env:LOCALAPPDATA "FileFinder\FileFinder.exe")
  )
  $app = $appCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($app) { Start-Process $app }
} finally {
  Stop-Transcript | Out-Null
}
