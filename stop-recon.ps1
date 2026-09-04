# Stops the unattended recon watcher. Safe to run when nothing is running.

param(
    [switch]$Quiet
)

$root = $PSScriptRoot
$pidFile = Join-Path $root 'logs\recon.pid'

if (Test-Path $pidFile) {
    $recorded = (Get-Content $pidFile -Raw).Trim()
    if ($recorded) {
        $proc = Get-Process -Id $recorded -ErrorAction SilentlyContinue
        if ($proc) {
            Stop-Process -Id $recorded -Force -ErrorAction SilentlyContinue
            if (-not $Quiet) { Write-Output "stopped recon watcher (pid $recorded)" }
        }
    }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
}

if (-not $Quiet) { Write-Output 'done' }
