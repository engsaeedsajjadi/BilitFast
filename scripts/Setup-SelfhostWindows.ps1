param(
  [Parameter(Mandatory=$true)][string]$Domain,
  [switch]$Start
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker is not installed. This script runs on the customer VPS / server with Docker, not end-user computers.'
  }
  if (-not (Test-Path .env)) {
    docker run --rm -v "${root}:/work" -w /work node:22-alpine node scripts/setup-selfhost.js $Domain
    if ($LASTEXITCODE -ne 0) { throw 'Generating installation configuration failed.' }
  } else { Write-Host 'Using existing .env; security keys were NOT reset.' }
  if ($Start) {
    docker compose -f compose.selfhost.yml up -d --build
    if ($LASTEXITCODE -ne 0) { throw 'Docker deployment failed.' }
    docker compose -f compose.selfhost.yml ps
  } else {
    Write-Host 'Config prepared. Run: docker compose -f compose.selfhost.yml up -d --build'
  }
} finally { Pop-Location }
