param(
  [ValidateSet("x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc")]
  [string]$Target = "x86_64-pc-windows-msvc",
  [string]$SigningCertificateThumbprint = $env:WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
  cargo build --release --target $Target -p filefinder-agent
  if ($LASTEXITCODE -ne 0) { throw "Agent build failed" }
  $binaryDirectory = Join-Path $root "desktop\src-tauri\binaries"
  New-Item -ItemType Directory -Force -Path $binaryDirectory | Out-Null
  $agentSource = Join-Path $root "target\$Target\release\filefinder-agent.exe"
  $agentSidecar = Join-Path $binaryDirectory "filefinder-agent-$Target.exe"
  Copy-Item -Force $agentSource $agentSidecar
  if ($SigningCertificateThumbprint) {
    signtool.exe sign /sha1 $SigningCertificateThumbprint /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $agentSidecar
  }
  pnpm --filter @filefinder/desktop tauri build -- --target $Target
  if ($LASTEXITCODE -ne 0) { throw "Tauri packaging failed" }
  if ($SigningCertificateThumbprint) {
    Get-ChildItem "target\$Target\release\bundle" -Recurse -Include *.exe,*.msi | ForEach-Object {
      signtool.exe sign /sha1 $SigningCertificateThumbprint /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $_.FullName
    }
  }
} finally { Pop-Location }

