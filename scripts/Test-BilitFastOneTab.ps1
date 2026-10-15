param(
  [switch]$InstallDependencies,
  [switch]$FullSuite
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  Write-Host "BilitFast One-Tab first-party reservation tests"
  Write-Host "Node: $(node --version)"
  if ($LASTEXITCODE -ne 0) { throw 'Node.js not available' }
  if ($InstallDependencies) {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
  }
  npm run test:official-handoff
  if ($LASTEXITCODE -ne 0) { throw 'Official handoff tests failed' }
  if ($FullSuite) {
    npm test
    if ($LASTEXITCODE -ne 0) { throw 'Full regression suite failed' }
  }
  Write-Host 'PASS: One-tab regression checks completed.' -ForegroundColor Green
  Write-Host 'Real SafirRail ARCaptcha/checkout must still be tested in Chrome/Edge.'
} finally { Pop-Location }
