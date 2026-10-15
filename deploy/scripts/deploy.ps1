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
$base = "http://localhost:$appPort"

# The API logs a new admin token on every start (ADR 0006).
$adminToken = $null
for ($i = 0; $i -lt 30 -and -not $adminToken; $i++) {
  # Only the API's own line counts: request URLs in the log can't contain it (no spaces).
  $log = docker compose --env-file $EnvFile -f $ComposeFile logs --no-log-prefix api 2>$null | Out-String
  $found = [regex]::Matches($log, '(?m)^ADMIN TOKEN \(valid until the next restart\): (ih_[A-Za-z0-9_-]{43})')
  if ($found.Count) { $adminToken = $found[$found.Count - 1].Groups[1].Value } else { Start-Sleep -Seconds 2 }
}
if (-not $adminToken) { throw 'admin token not found in the api log' }

function Get-Status($path, $session) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing "$base$path" -WebSession $session
    return [int]$r.StatusCode
  } catch { return [int]$_.Exception.Response.StatusCode }
}

foreach ($path in '/healthz', '/readyz') {
  $ok = $false
  for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
    try { Invoke-WebRequest -UseBasicParsing "$base$path" | Out-Null; $ok = $true }
    catch { Start-Sleep -Seconds 2 }
  }
  if (-not $ok) { throw "smoke test failed: $path" }
  Write-Host "ok   $path"
}
$anon = New-Object Microsoft.PowerShell.Commands.WebRequestSession
if ((Get-Status '/api/specs' $anon) -ne 401) { throw 'smoke test failed: /api/specs must need a session' }
Write-Host 'ok   /api/specs without a session -> 401'
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-WebRequest -UseBasicParsing "$base/api/auth/login" -Method Post -WebSession $session `
  -ContentType 'application/json' -Body (@{ login = 'admin'; password = $adminToken } | ConvertTo-Json) | Out-Null
foreach ($path in '/api/specs', '/api/models', '/api/results', '/api/users') {
  if ((Get-Status $path $session) -ne 200) { throw "smoke test failed: $path" }
  Write-Host "ok   $path"
}
Write-Host "==> deployed $ImageTag"
Invoke-Compose ps
Write-Host "==> ADMIN TOKEN (valid until the API restarts): $adminToken"
Write-Host "    Sign in as admin with it as the password, then add users under Access (ADR 0013)."
