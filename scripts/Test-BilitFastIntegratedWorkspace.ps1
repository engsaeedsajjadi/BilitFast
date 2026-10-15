param([switch]$InstallDependencies,[switch]$FullSuite)
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
Write-Host 'BilitFast Integrated Human ARCaptcha Workspace - Synthetic Tests' -ForegroundColor Cyan
if(-not (Get-Command node -ErrorAction SilentlyContinue)){throw 'Node.js 18+ is required for tests.'}
if($InstallDependencies){npm ci;if($LASTEXITCODE -ne 0){throw 'npm ci failed'}}
npm run test:integrated-human
if($LASTEXITCODE -ne 0){throw 'Integrated human workflow tests failed'}
npm run test:official-handoff
if($LASTEXITCODE -ne 0){throw 'Official browser handoff tests failed'}
node .\test\web-extension-connect.test.js
if($LASTEXITCODE -ne 0){throw 'Browser endpoint compatibility tests failed'}
if($FullSuite){npm test;if($LASTEXITCODE -ne 0){throw 'Full project regressions failed'}}
Write-Host 'Offline tests passed. Real SafirRail ARCaptcha and payment gateway were NOT tested.' -ForegroundColor Green
