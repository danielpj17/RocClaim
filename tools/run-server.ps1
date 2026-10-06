# Starts the queue server hidden, unless it is already running.
#
# Run at every Windows logon by the scheduled task tools/autostart.ps1 sets up,
# so the extension's queue always has a server to talk to without anyone typing
# npm run up. Safe to run any number of times: a second copy sees the port taken
# and does nothing.

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$logs = Join-Path $root 'logs'
if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }

$cfg = Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json
$port = $cfg.port

$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    Write-Output "already running on port $port"
    exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }

$server = Start-Process -FilePath $node -ArgumentList @('server.js') `
    -WorkingDirectory $root `
    -RedirectStandardOutput (Join-Path $logs 'server.log') `
    -RedirectStandardError  (Join-Path $logs 'server.err') `
    -WindowStyle Hidden -PassThru
# stop-all.ps1 (npm run down) finds it by this file.
$server.Id | Out-File (Join-Path $logs 'server.pid') -Encoding ascii
Write-Output "queue server started, pid $($server.Id) -> http://localhost:$port"
