param([switch]$FullSuite)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
Write-Host "BilitFast Web extension tests" -ForegroundColor Cyan
Write-Host "Project: $root"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 18+ is required on the developer machine.' }
node --version
node --check .\extension\target-origin.js
if ($LASTEXITCODE -ne 0) { throw 'Invalid target-origin.js' }
node --check .\extension\popup.js
if ($LASTEXITCODE -ne 0) { throw 'Invalid popup.js' }
npm run test:web-extension
if ($LASTEXITCODE -ne 0) { throw 'Web extension tests failed' }
if ($FullSuite) {
  npm test
  if ($LASTEXITCODE -ne 0) { throw 'Full web suite failed' }
}
Write-Host 'TESTS PASSED. Live SafirRail authentication was NOT tested.' -ForegroundColor Green
