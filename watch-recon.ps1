# Unattended recon capture, DETACHED.
#
# Polls one claim page at the normal 8-12s interval, fingerprints every load,
# and permanently archives any poll that differs from the baseline. It knows
# nothing about how the page is built, so it works before the detector exists
# -- and with an ntfy topic set it is already a working notify-only watcher.
#
#   .\watch-recon.ps1                                  football (STFB)
#   .\watch-recon.ps1 -Url https://.../events/STWVB    any other sport
#
# RECORD_WATCH_TARGET makes record-watch.js skip the navigate-and-press-Enter
# step and run headless, which is what lets this run with nobody at the laptop.
#
# Stop it with .\stop-recon.ps1

# -Interactive opens a real visible browser and waits, so you can clear the
# site's human-verification check yourself and navigate to the page you want.
# It then polls that page in the same session. Without it, the run is headless
# against a fixed URL -- which the site's bot check currently rejects.
param(
    [string]$Url = 'https://byutickets.evenue.net/students/events/STFB',
    [switch]$Interactive
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$logs = Join-Path $root 'logs'
if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }

& (Join-Path $root 'stop-recon.ps1') -Quiet

Remove-Item (Join-Path $root '.record-done') -ErrorAction SilentlyContinue

if ($Interactive) {
    # record-watch.js runs headed and waits when no target is preset.
    $env:RECORD_WATCH_TARGET = ''
} else {
    $env:RECORD_WATCH_TARGET = $Url
}

$proc = Start-Process -FilePath 'node' -ArgumentList @('record-watch.js') `
    -WorkingDirectory $root `
    -RedirectStandardOutput (Join-Path $logs 'recon.log') `
    -RedirectStandardError  (Join-Path $logs 'recon.err') `
    -WindowStyle Hidden -PassThru
$proc.Id | Out-File (Join-Path $logs 'recon.pid') -Encoding ascii

Write-Output "recon watcher  pid $($proc.Id)"
if ($Interactive) {
    Write-Output "mode           interactive -- a browser window is opening"
    Write-Output "               clear the human check, go to the page you want to watch,"
    Write-Output "               then create .record-done to lock it in and start polling"
} else {
    Write-Output "target         $Url"
}
Write-Output "log            logs\recon.log"
Write-Output ''
Write-Output 'Survives closing VS Code. Stop it with .\stop-recon.ps1'
