param([string]$Destination = ".\release\coordinator")
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
  pnpm build
  if ($LASTEXITCODE -ne 0) { throw "Coordinator build failed" }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Copy-Item -Force (Get-Command node.exe).Source (Join-Path $Destination "node.exe")
  Copy-Item -Recurse -Force "dist" $Destination
  Copy-Item -Recurse -Force "db" $Destination
  Copy-Item -Recurse -Force "operations" $Destination
  Copy-Item -Force "package.json", "pnpm-lock.yaml" $Destination
  pnpm --filter filefinder-coordinator deploy --prod (Join-Path $Destination "runtime")
  Copy-Item -Recurse -Force (Join-Path $Destination "runtime\node_modules") $Destination
  Remove-Item -Recurse -Force (Join-Path $Destination "runtime")
  Write-Host "Coordinator release staged at $Destination"
} finally { Pop-Location }
