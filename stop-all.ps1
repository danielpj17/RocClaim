# Stops whatever start-all.ps1 started. Safe to run when nothing is running.

param(
    [switch]$Quiet
)

$root = $PSScriptRoot
$logs = Join-Path $root 'logs'

function Stop-Recorded($name) {
    $pidFile = Join-Path $logs "$name.pid"
    if (-not (Test-Path $pidFile)) { return }
    $recorded = (Get-Content $pidFile -Raw).Trim()
    if ($recorded) {
        $proc = Get-Process -Id $recorded -ErrorAction SilentlyContinue
        if ($proc) {
            Stop-Process -Id $recorded -Force -ErrorAction SilentlyContinue
            if (-not $Quiet) { Write-Output "stopped $name (pid $recorded)" }
        }
    }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
}

Stop-Recorded 'server'
Stop-Recorded 'tunnel'
Remove-Item (Join-Path $logs 'tunnel.url') -ErrorAction SilentlyContinue

if (-not $Quiet) { Write-Output 'done' }
