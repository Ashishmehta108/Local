param(
  [string]$CaddySource = ".\caddy.exe",
  [string]$InstallDirectory = "C:\Program Files\Caddy",
  [string]$DataDirectory = "C:\ProgramData\FileFinder"
)
$ErrorActionPreference = "Stop"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script from an Administrator PowerShell window."
}
$root = Split-Path $PSScriptRoot -Parent
$source = (Resolve-Path $CaddySource).Path
$target = Join-Path $InstallDirectory "caddy.exe"
$config = Join-Path $DataDirectory "Caddyfile"
$environment = Join-Path $DataDirectory "caddy.env"
New-Item -ItemType Directory -Force -Path $InstallDirectory, $DataDirectory, (Join-Path $DataDirectory "caddy-data") | Out-Null
Copy-Item -Force $source $target
Copy-Item -Force (Join-Path $root "operations\Caddyfile") $config
"XDG_DATA_HOME=C:/ProgramData/FileFinder/caddy-data" | Set-Content -LiteralPath $environment -Encoding ascii

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $target validate --config $config --adapter caddyfile
$validationExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
if ($validationExitCode -ne 0) { throw "Caddy configuration validation failed" }
if (Get-Service FileFinderCaddy -ErrorAction SilentlyContinue) {
  Stop-Service FileFinderCaddy -ErrorAction SilentlyContinue
  sc.exe delete FileFinderCaddy | Out-Null
  Start-Sleep -Seconds 2
}
$binaryPath = ('"{0}" run --config "{1}" --adapter caddyfile --envfile "{2}"' -f $target, $config, $environment)
New-Service -Name FileFinderCaddy -BinaryPathName $binaryPath -StartupType Automatic -DisplayName "FileFinder HTTPS Proxy" | Out-Null
sc.exe failure FileFinderCaddy reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to configure Caddy service recovery" }
Start-Service FileFinderCaddy
Start-Sleep -Seconds 3
if ((Get-Service FileFinderCaddy).Status -ne 'Running') { throw "Caddy service did not start" }
Write-Host "Caddy service installed. After first startup, distribute its internal root CA to VPN clients."
