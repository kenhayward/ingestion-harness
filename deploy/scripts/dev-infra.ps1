<#
.SYNOPSIS
  Start Postgres + SeaweedFS (+ the Word converter) for host-side development, migrate, and create buckets.
.EXAMPLE
  .\deploy\scripts\dev-infra.ps1 up      # or: down | reset
#>
param([ValidateSet('up', 'down', 'reset')][string]$Action = 'up')
$ErrorActionPreference = 'Stop'

$DeployDir = Resolve-Path (Join-Path $PSScriptRoot '..')
$RepoRoot = Resolve-Path (Join-Path $DeployDir '..')
$EnvFile = Join-Path $DeployDir '.env'
if (-not (Test-Path $EnvFile)) { Copy-Item (Join-Path $DeployDir '.env.example') $EnvFile }

$cfg = @{}
Get-Content $EnvFile | Where-Object { $_ -match '^\s*([A-Z0-9_]+)=(.*)$' } | ForEach-Object {
  $cfg[$Matches[1]] = $Matches[2]
}
$project = "$($cfg.COMPOSE_PROJECT_NAME)-dev"
$files = @('-f', (Join-Path $DeployDir 'docker-compose.yml'), '-f', (Join-Path $DeployDir 'docker-compose.dev.yml'))

function Invoke-Compose {
  docker compose --env-file $EnvFile -p $project @files @args
  if ($LASTEXITCODE -ne 0) { throw "docker compose $args failed ($LASTEXITCODE)" }
}

switch ($Action) {
  'up' {
    Invoke-Compose up -d --wait postgres seaweedfs converter
    $pgPort = if ($cfg.POSTGRES_PORT) { $cfg.POSTGRES_PORT } else { '5433' }
    $s3Port = if ($cfg.S3_PUBLIC_PORT) { $cfg.S3_PUBLIC_PORT } else { '8335' }
    $env:DATABASE_URL = "postgres://$($cfg.POSTGRES_USER):$($cfg.POSTGRES_PASSWORD)@localhost:$pgPort/$($cfg.POSTGRES_DB)"
    $env:S3_ENDPOINT = "http://localhost:$s3Port"
    $env:S3_ACCESS_KEY = $cfg.S3_ACCESS_KEY
    $env:S3_SECRET_KEY = $cfg.S3_SECRET_KEY
    $converterPort = if ($cfg.CONVERTER_PORT) { $cfg.CONVERTER_PORT } else { '3010' }
    $env:CONVERTER_URL = "http://localhost:$converterPort"
    Push-Location $RepoRoot; try { npm run migrate } finally { Pop-Location }
    Push-Location (Join-Path $RepoRoot 'worker'); try { uv run python -m ingest_worker.admin init-buckets } finally { Pop-Location }
    Write-Host "Infra ready. DATABASE_URL=$($env:DATABASE_URL -replace ':[^:@]+@', ':***@')  S3_ENDPOINT=$($env:S3_ENDPOINT)  CONVERTER_URL=$($env:CONVERTER_URL)"
  }
  'down' { Invoke-Compose down }
  'reset' { Invoke-Compose down -v }
}
