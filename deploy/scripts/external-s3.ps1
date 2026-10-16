<#
.SYNOPSIS
  A throwaway SeaweedFS outside the compose stack, standing in for "someone else's S3" so the
  external publishing-target path runs against a real S3 server (own endpoint, own keys).
.DESCRIPTION
  up    starts it on localhost:8433 with bucket ext-published and sets the IH_TEST_EXTERNAL_S3_*
        variables in this session
  env   prints (and sets) the IH_TEST_EXTERNAL_S3_* variables the integration tests read
  down  stops it (no volume: its data is gone)
  From containers of the dev stack the endpoint is http://host.docker.internal:8433.
.EXAMPLE
  .\deploy\scripts\external-s3.ps1 up      # or: env | down
#>
param([ValidateSet('up', 'env', 'down')][string]$Action = 'up')
$ErrorActionPreference = 'Stop'

$DeployDir = Resolve-Path (Join-Path $PSScriptRoot '..')
$Name = 'ih-external-s3'
$Port = if ($env:IH_EXTERNAL_S3_PORT) { $env:IH_EXTERNAL_S3_PORT } else { '8433' }
$Bucket = 'ext-published'
$AccessKey = if ($env:IH_EXTERNAL_S3_ACCESS_KEY) { $env:IH_EXTERNAL_S3_ACCESS_KEY } else { 'ext-test-access' }
$SecretKey = if ($env:IH_EXTERNAL_S3_SECRET_KEY) { $env:IH_EXTERNAL_S3_SECRET_KEY } else { 'ext-test-secret' }

# The same pinned image as compose (one copy of the tag: deploy/docker-compose.yml).
function Get-SeaweedImage {
  $line = Select-String -Path (Join-Path $DeployDir 'docker-compose.yml') -Pattern 'image:\s*(chrislusf/seaweedfs:\S+)' |
    Select-Object -First 1
  if (-not $line) { throw 'no seaweedfs image in docker-compose.yml' }
  $line.Matches[0].Groups[1].Value
}

function Set-TestEnv {
  $vars = [ordered]@{
    IH_TEST_EXTERNAL_S3_ENDPOINT   = "http://localhost:$Port"
    IH_TEST_EXTERNAL_S3_REGION     = 'us-east-1'
    IH_TEST_EXTERNAL_S3_ACCESS_KEY = $AccessKey
    IH_TEST_EXTERNAL_S3_SECRET_KEY = $SecretKey
    IH_TEST_EXTERNAL_S3_BUCKET     = $Bucket
  }
  foreach ($k in $vars.Keys) {
    Set-Item -Path "env:$k" -Value $vars[$k]
    Write-Output "$k=$($vars[$k])"
  }
}

# Echoed inside the container: Windows PowerShell would prefix a BOM to a pipe into docker.
function Invoke-WeedShell([string]$command) {
  $out = docker exec $Name sh -c "echo $command | weed shell"
  if ($LASTEXITCODE -ne 0) { return $null }
  ($out | Out-String)
}

function Start-ExternalS3 {
  $running = docker ps -q --filter "name=^$Name$"
  if ($running) {
    Write-Host "$Name is already running"
  } else {
    # The identity file is rendered here and handed over base64 in an environment variable: nothing
    # is mounted, and no double quote reaches docker's command line (Windows PowerShell mangles them).
    $config = (Get-Content (Join-Path $DeployDir 'seaweedfs/s3.json.template') -Raw).
      Replace('__ACCESS_KEY__', $AccessKey).Replace('__SECRET_KEY__', $SecretKey)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($config))
    $script = 'echo $S3_JSON_B64 | base64 -d > /tmp/s3.json && exec weed server -dir=/data -volume.max=0 -master.volumeSizeLimitMB=1024 -s3 -s3.port=8333 -s3.config=/tmp/s3.json -s3.iam.readOnly=false'
    docker run -d --rm --name $Name -p "127.0.0.1:${Port}:8333" -e "S3_JSON_B64=$encoded" `
      --entrypoint /bin/sh (Get-SeaweedImage) -c $script | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker run failed ($LASTEXITCODE)" }
  }
  # Any HTTP answer (an anonymous request gets 403) means the S3 port is up.
  $up = $false
  for ($i = 0; $i -lt 60 -and -not $up; $i++) {
    $code = & curl.exe -s -o NUL -w '%{http_code}' "http://localhost:$Port/"
    if ($code -and $code -ne '000') { $up = $true } else { Start-Sleep -Seconds 1 }
  }
  if (-not $up) { docker logs $Name; throw "$Name did not answer on port $Port" }
  # The bucket through weed shell (no S3 client needed on the host); it may exist already.
  $made = $false
  for ($i = 0; $i -lt 30 -and -not $made; $i++) {
    [void](Invoke-WeedShell "s3.bucket.create -name $Bucket")
    $list = Invoke-WeedShell 's3.bucket.list'
    if ($list -and $list -match [regex]::Escape($Bucket)) { $made = $true } else { Start-Sleep -Seconds 1 }
  }
  if (-not $made) { throw "could not create bucket $Bucket" }
  Write-Host "External S3 ready on http://localhost:$Port (bucket $Bucket); variables set in this session:"
  Set-TestEnv
}

switch ($Action) {
  'up' { Start-ExternalS3 }
  'env' { Set-TestEnv }
  'down' {
    # Absent already is fine: under 'Stop', Windows PowerShell 5.1 turns docker's stderr into a
    # terminating NativeCommandError, so swallow it.
    try { docker stop $Name 2>$null | Out-Null } catch {}
    $global:LASTEXITCODE = 0
  }
}
