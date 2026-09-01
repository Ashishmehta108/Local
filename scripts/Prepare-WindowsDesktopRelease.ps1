param(
  [ValidateSet("x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc")]
  [string]$Target = "x86_64-pc-windows-msvc",
  [string]$SigningCertificateThumbprint = $env:WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT,
  [string]$CoordinatorUrl = $env:FILEFINDER_COORDINATOR_URL,
  [Alias("TokenOnlyAgentAuth")]
  [switch]$HostedAgentAuth
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$cargo = Get-Command cargo.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
if (-not $cargo) {
  $userCargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
  if (Test-Path $userCargo) { $cargo = $userCargo }
}
if (-not $cargo) { throw "cargo.exe was not found. Install Rust with rustup first." }
$signTool = $null
if ($SigningCertificateThumbprint) {
  $signTool = Get-Command signtool.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
  if (-not $signTool) {
    $kitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    $signTool = Get-ChildItem $kitsRoot -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
      Where-Object FullName -Match '\\x64\\signtool\.exe$' |
      Sort-Object FullName -Descending |
      Select-Object -ExpandProperty FullName -First 1
  }
  if (-not $signTool) { throw "signtool.exe was not found. Install the Windows SDK signing tools." }
}
$cargoDirectory = Split-Path $cargo -Parent
if (($env:Path -split ';') -notcontains $cargoDirectory) {
  $env:Path = "$cargoDirectory;$env:Path"
}
if ($CoordinatorUrl) {
  if ($CoordinatorUrl -notmatch '^https://') { throw "Commercial coordinator URL must use HTTPS." }
  $env:VITE_COORDINATOR_URL = $CoordinatorUrl.TrimEnd('/')
}
$env:VITE_REQUIRE_AGENT_CERTIFICATE = if ($HostedAgentAuth) { "false" } else { "true" }
$env:VITE_REQUIRE_AGENT_SIGNATURES = "true"
Push-Location $root
try {
  & $cargo build --release --target $Target -p filefinder-agent
  if ($LASTEXITCODE -ne 0) { throw "Agent build failed" }
  $binaryDirectory = Join-Path $root "desktop\src-tauri\binaries"
  New-Item -ItemType Directory -Force -Path $binaryDirectory | Out-Null
  $agentSource = Join-Path $root "target\$Target\release\filefinder-agent.exe"
  $agentSidecar = Join-Path $binaryDirectory "filefinder-agent-$Target.exe"
  Copy-Item -Force $agentSource $agentSidecar
  if ($SigningCertificateThumbprint) {
    & $signTool sign /sha1 $SigningCertificateThumbprint /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $agentSidecar
    if ($LASTEXITCODE -ne 0) { throw "Agent signing failed" }
  }
  pnpm --filter @filefinder/desktop tauri build -- --target $Target
  if ($LASTEXITCODE -ne 0) { throw "Tauri packaging failed" }
  if ($SigningCertificateThumbprint) {
    Get-ChildItem "target\$Target\release\bundle" -Recurse -Include *.exe,*.msi | ForEach-Object {
      & $signTool sign /sha1 $SigningCertificateThumbprint /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $_.FullName
      if ($LASTEXITCODE -ne 0) { throw "Installer signing failed: $($_.FullName)" }
    }
  }
} finally { Pop-Location }

