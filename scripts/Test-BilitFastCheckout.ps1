param([switch]$InstallDependencies, [switch]$FullSuite)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  Write-Host ('Project: ' + $root)
  node --version
  npm --version
  if ($InstallDependencies) {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
  }
  npm run test:checkout
  if ($LASTEXITCODE -ne 0) { throw 'Checkout regression failed' }
  if ($FullSuite) {
    npm test
    if ($LASTEXITCODE -ne 0) { throw 'Full regression suite failed' }
  }
  Write-Host 'Checkout tests passed. Live SafirRail and bank flows are NOT verified.' -ForegroundColor Green
} finally { Pop-Location }
