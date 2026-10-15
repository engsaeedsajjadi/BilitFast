param([switch]$FullSuite)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required for developer tests.' }
Write-Host 'BilitFast — Cookie Handoff Regression (synthetic test data only)' -ForegroundColor Cyan
node --check .\public\app.js
if ($LASTEXITCODE -ne 0) { throw 'app.js syntax check failed' }
node --check .\public\safir-connection.js
if ($LASTEXITCODE -ne 0) { throw 'safir-connection.js syntax check failed' }
node .\test\web-cookie-handoff.test.js
if ($LASTEXITCODE -ne 0) { throw 'API handoff regression failed' }
node .\test\single-extension-flow.test.js
if ($LASTEXITCODE -ne 0) { throw 'Browser extension flow regression failed' }
if ($FullSuite) {
  npm test
  if ($LASTEXITCODE -ne 0) { throw 'Full regression failed' }
}
Write-Host 'Cookie handoff tests passed. Live SafirRail login/reservation was not tested.' -ForegroundColor Green
