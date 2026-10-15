param([switch]$InstallDependencies, [switch]$FullSuite)
$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))
Write-Host "BilitFast web official-ARCaptcha handoff tests" -ForegroundColor Cyan
if ($InstallDependencies) {
  npm ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
}
npm run test:official-handoff
if ($LASTEXITCODE -ne 0) { throw 'Official handoff tests failed' }
node test/web-extension-connect.test.js
if ($LASTEXITCODE -ne 0) { throw 'Extension connect tests failed' }
if ($FullSuite) {
  npm test
  if ($LASTEXITCODE -ne 0) { throw 'Full regression failed' }
}
Write-Host 'Requested offline checks passed. Live SafirRail checkout NOT tested.' -ForegroundColor Green
