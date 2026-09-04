# Starts the control panel and a public tunnel to it, DETACHED.
#
# "Detached" is the whole point. Anything started from the VS Code terminal --
# or by an agent -- dies when that thing closes. These do not: Start-Process
# hands them off to Windows, so you can close VS Code, close Claude, and log
# out of the editor entirely and the watcher keeps running.
#
#   .\start-all.ps1           real BYU adapter
#   .\start-all.ps1 -Fake     fake site, touches nothing real
#
# It prints the public https URL and pushes it to your phone, because a
# quick tunnel gets a new random hostname every time it starts.
#
# Stop it with .\stop-all.ps1

param(
    [switch]$Fake
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$logs = Join-Path $root 'logs'
if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }

$cloudflared = Join-Path $env:USERPROFILE 'bin\cloudflared.exe'
if (-not (Test-Path $cloudflared)) {
    Write-Output "cloudflared not found at $cloudflared"
    exit 1
}

# Read the port and ntfy topic straight out of the config the app itself uses,
# so these can never drift apart.
$cfg = Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json
$port = $cfg.port
$topic = $cfg.notify.topic
$ntfyServer = $cfg.notify.server
$localCfgPath = Join-Path $root 'config.local.json'
if (Test-Path $localCfgPath) {
    $localCfg = Get-Content $localCfgPath -Raw | ConvertFrom-Json
    if ($localCfg.notify -and $localCfg.notify.topic) { $topic = $localCfg.notify.topic }
    if ($localCfg.notify -and $localCfg.notify.server) { $ntfyServer = $localCfg.notify.server }
}

& (Join-Path $root 'stop-all.ps1') -Quiet

# --- control panel --------------------------------------------------------
$serverArgs = @('server.js')
if ($Fake) { $serverArgs += '--fake' }

$server = Start-Process -FilePath 'node' -ArgumentList $serverArgs `
    -WorkingDirectory $root `
    -RedirectStandardOutput (Join-Path $logs 'server.log') `
    -RedirectStandardError  (Join-Path $logs 'server.err') `
    -WindowStyle Hidden -PassThru
$server.Id | Out-File (Join-Path $logs 'server.pid') -Encoding ascii
Write-Output "control panel  pid $($server.Id)  ->  http://localhost:$port"

# --- tunnel ---------------------------------------------------------------
$tunnel = Start-Process -FilePath $cloudflared `
    -ArgumentList @('tunnel', '--url', "http://localhost:$port") `
    -WorkingDirectory $root `
    -RedirectStandardOutput (Join-Path $logs 'tunnel.log') `
    -RedirectStandardError  (Join-Path $logs 'tunnel.err') `
    -WindowStyle Hidden -PassThru
$tunnel.Id | Out-File (Join-Path $logs 'tunnel.pid') -Encoding ascii

# cloudflared announces the hostname on stderr, a second or two in.
$url = $null
foreach ($i in 1..45) {
    Start-Sleep -Milliseconds 700
    # -join, because -match against an array filters the array instead of
    # capturing, and leaves $Matches empty.
    $text = @(
        (Get-Content (Join-Path $logs 'tunnel.err') -Raw -ErrorAction SilentlyContinue)
        (Get-Content (Join-Path $logs 'tunnel.log') -Raw -ErrorAction SilentlyContinue)
    ) -join "`n"
    $m = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($m.Success) {
        $url = $m.Value
        break
    }
}

if (-not $url) {
    Write-Output "tunnel did not report a URL. See logs\tunnel.err"
    exit 1
}

# The server mints the remote key on first start, so read it only now.
$token = $null
if (Test-Path $localCfgPath) {
    $localCfg = Get-Content $localCfgPath -Raw | ConvertFrom-Json
    if ($localCfg.ui -and $localCfg.ui.token) { $token = $localCfg.ui.token }
}
if (-not $token) {
    Write-Output "no remote key found in config.local.json -- the tunnel would be unusable"
    exit 1
}

# The key rides in the query once; the panel swaps it for a cookie and drops it
# from the address bar, so a screenshot of the open page does not leak it.
$keyedUrl = "$url/?k=$token"

$keyedUrl | Out-File (Join-Path $logs 'tunnel.url') -Encoding ascii
Write-Output "tunnel         pid $($tunnel.Id)  ->  $keyedUrl"

if ($topic) {
    try {
        $body = "ROC Claim control panel is up:`n$keyedUrl`n`nThis link is new each restart. Open it once and the key is remembered."
        Invoke-RestMethod -Uri "$ntfyServer/$topic" -Method Post -Body ([Text.Encoding]::UTF8.GetBytes($body)) `
            -Headers @{ Title = 'ROC Claim is running'; Tags = 'ticket' } | Out-Null
        Write-Output "pushed the URL to ntfy topic '$topic'"
    } catch {
        Write-Output "could not push to ntfy: $($_.Exception.Message)"
    }
} else {
    Write-Output "no ntfy topic set, so the URL was not pushed"
}

Write-Output ''
Write-Output 'Both survive closing VS Code. Stop them with .\stop-all.ps1'
