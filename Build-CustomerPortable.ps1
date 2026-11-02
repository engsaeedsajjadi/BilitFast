# Build ONLY on the seller's Windows workstation with Node.js/npm installed.
# Customer receives node.exe + Windows node_modules and needs no npm or Docker.
param(
  [string]$OutputDir = ""
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This builder must run on Windows to package Windows dependencies.' }
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root
try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required on SELLER machine for building.' }
  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm is required on SELLER machine for building.' }
  $pub = Join-Path $root 'config\license-public.pem'
  if (-not (Test-Path -LiteralPath $pub)) { throw 'Missing config\license-public.pem; initialize or restore the original seller public key BEFORE building.' }
  if (-not (Test-Path -LiteralPath (Join-Path $root 'scripts\portable-run.js'))) { throw 'Portable launcher sources are missing.' }
  if (Test-Path (Join-Path $root '.env')) { throw 'Build from a clean source folder without .env; NEVER distribute data/secrets.' }
  if (Test-Path (Join-Path $root 'data\installation.json')) { throw 'Source already has installation data. Build from a clean source folder.' }
  if (Test-Path (Join-Path $root 'data\db.json')) { throw 'Source already has database data. Build from a clean source folder.' }
  if (-not $OutputDir) { $OutputDir = Join-Path $root 'customer-release' }
  $OutputDir = [System.IO.Path]::GetFullPath($OutputDir)
  if ((Test-Path -LiteralPath $OutputDir)) { throw "Output already exists: $OutputDir. Use an empty new location; do not overwrite a customer data folder." }
  Write-Host 'Installing production dependencies and checking source on SELLER computer...'
  & npm.cmd ci --omit=dev
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
  foreach($argsForNpm in @(@('test'),@('run','audit:security'),@('run','test:enterprise'),@('run','check:delivery'))) {
    & npm.cmd @argsForNpm
    if ($LASTEXITCODE -ne 0) { throw "Test/preflight failed: npm $($argsForNpm -join ' ')" }
  }
  & node test/portable-prep.test.js
  if ($LASTEXITCODE -ne 0) { throw 'Portable first-run checks failed' }
  # node -p returns actual node.exe even when PATH resolves a version manager shim.
  $nodeExe = ((& node -p 'process.execPath') | Select-Object -First 1).Trim()
  if (-not (Test-Path -LiteralPath $nodeExe)) { throw 'Actual Node.exe path cannot be found.' }
  $stage = Join-Path $OutputDir 'BilitFast-3.13.3-Windows-Portable'
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  foreach($folder in @('api','lib','public','models','extension','node_modules')) {
    Copy-Item -LiteralPath (Join-Path $root $folder) -Destination $stage -Recurse -Force
  }
  New-Item -ItemType Directory -Path (Join-Path $stage 'config') -Force | Out-Null
  Copy-Item -LiteralPath $pub -Destination (Join-Path $stage 'config') -Force
  foreach($name in @('config.json','cities.json','selfhost-server.js','server.js','dev-server.js','START-BILITFAST.cmd')) {
    Copy-Item -LiteralPath (Join-Path $root $name) -Destination $stage -Force
  }
  New-Item -ItemType Directory -Path (Join-Path $stage 'scripts') -Force | Out-Null
  foreach($name in @('portable-run.js','portable-init.js')) {
    Copy-Item -LiteralPath (Join-Path $root "scripts\$name") -Destination (Join-Path $stage 'scripts') -Force
  }
  New-Item -ItemType Directory -Path (Join-Path $stage 'runtime') -Force | Out-Null
  Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $stage 'runtime\node.exe') -Force
  $licensePath = Join-Path (Split-Path -Parent $nodeExe) 'LICENSE'
  if (Test-Path -LiteralPath $licensePath) { Copy-Item -LiteralPath $licensePath -Destination (Join-Path $stage 'runtime\LICENSE-NODE.txt') }
  Copy-Item -LiteralPath (Join-Path $root 'PORTABLE-WINDOWS-DELIVERY-FA.md') -Destination (Join-Path $stage 'README-CUSTOMER-FA.md')
  # Make sure the payload never carries the seller's keys or the previous customer's data.
  foreach($relative in @('vendor-private.pem','config\license-private.pem','scripts\license-admin.js','.env','data\db.json','data\installation.json')) {
    if (Test-Path -LiteralPath (Join-Path $stage $relative)) { throw "Release would leak sensitive/restricted material: $relative" }
  }
  & (Join-Path $stage 'runtime\node.exe') --check (Join-Path $stage 'scripts\portable-run.js')
  if ($LASTEXITCODE -ne 0) { throw 'Portable launcher syntax validation failed' }
  $archive = Join-Path $OutputDir 'BilitFast-3.13.3-Windows-Portable.zip'
  Compress-Archive -LiteralPath $stage -DestinationPath $archive -CompressionLevel Optimal
  if (-not (Test-Path $archive)) { throw 'ZIP was not created.' }
  Write-Host 'READY: ' $archive
  Write-Host 'Only send this customer ZIP. Never send the seller source folder with private keys.'
  Write-Host 'Test from extracted ZIP on a CLEAN Windows machine BEFORE selling.'
} finally { Pop-Location }
