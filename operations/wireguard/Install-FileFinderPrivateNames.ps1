param(
  [string]$CoordinatorAddress = "10.77.0.1",
  [string]$CaddyRootCertificate
)
$ErrorActionPreference = "Stop"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script from an Administrator PowerShell window."
}
$hosts = "$env:SystemRoot\System32\drivers\etc\hosts"
$begin = "# BEGIN FILEFINDER PRIVATE NAMES"
$end = "# END FILEFINDER PRIVATE NAMES"
$content = Get-Content -LiteralPath $hosts -Raw
$pattern = "(?ms)^# BEGIN FILEFINDER PRIVATE NAMES.*?^# END FILEFINDER PRIVATE NAMES\r?\n?"
$content = [regex]::Replace($content, $pattern, "")
$block = @"
$begin
$CoordinatorAddress filefinder.office.local
$CoordinatorAddress agents.filefinder.office.local
$end
"@
Set-Content -LiteralPath $hosts -Value ($content.TrimEnd() + "`r`n" + $block + "`r`n") -Encoding ascii
Clear-DnsClientCache
if ($CaddyRootCertificate) {
  if (-not (Test-Path $CaddyRootCertificate)) { throw "Caddy root certificate not found: $CaddyRootCertificate" }
  Import-Certificate -FilePath $CaddyRootCertificate -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
}
Write-Host "Private FileFinder names now resolve to $CoordinatorAddress"
