<#
.SYNOPSIS
  Windows equivalent of deploy.sh: build images and (re)deploy the stack on this host.
.EXAMPLE
  .\deploy\scripts\deploy.ps1
  .\deploy\scripts\deploy.ps1 -ImageTag abc1234 -NoBuild     # roll back
  .\deploy\scripts\deploy.ps1 -EnvFile C:\ingestion\staging.env
#>
param(
  [string]$EnvFile = (Join-Path $PSScriptRoot '..\.env'),
  [string]$ImageTag,
  [switch]$NoBuild
)
$ErrorActionPreference = 'Stop'

$DeployDir = Resolve-Path (Join-Path $PSScriptRoot '..')
$RepoRoot = Resolve-Path (Join-Path $DeployDir '..')
if (-not (Test-Path $EnvFile)) { throw "env file not found: $EnvFile (copy deploy/.env.example)" }
if (-not $ImageTag) { $ImageTag = (git -C $RepoRoot rev-parse --short HEAD).Trim() }
$env:IMAGE_TAG = $ImageTag
$ComposeFile = Join-Path $DeployDir 'docker-compose.yml'

function Invoke-Compose {
  docker compose --env-file $EnvFile -f $ComposeFile @args
  if ($LASTEXITCODE -ne 0) { throw "docker compose $args failed ($LASTEXITCODE)" }
}

Write-Host "==> deploying IMAGE_TAG=$ImageTag using $EnvFile"
if (-not $NoBuild) { Invoke-Compose build --pull }
Invoke-Compose up -d postgres seaweedfs
Invoke-Compose run --rm init-buckets
Invoke-Compose run --rm migrate
Invoke-Compose up -d --remove-orphans api worker app

$appPort = (Select-String -Path $EnvFile -Pattern '^APP_PORT=(.+)$').Matches.Groups[1].Value
if (-not $appPort) { $appPort = '8081' }
foreach ($path in '/healthz', '/readyz', '/api/specs', '/api/models') {
  $ok = $false
  for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
    try { Invoke-WebRequest -UseBasicParsing "http://localhost:$appPort$path" | Out-Null; $ok = $true }
    catch { Start-Sleep -Seconds 2 }
  }
  if (-not $ok) { throw "smoke test failed: $path" }
  Write-Host "ok   $path"
}
Write-Host "==> deployed $ImageTag"
Invoke-Compose ps
