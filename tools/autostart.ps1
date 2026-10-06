# Makes the queue server start by itself whenever you log in to Windows.
#
#   npm run autostart       set it up (and start the server now)
#   npm run autostart:off   remove it
#
# Why a scheduled task and not a button in the extension: Chrome profiles are
# sealed off from each other, so the queue needs something outside Chrome to
# hold it -- and anything Chrome itself launches can be killed with Chrome.
# A logon task is the plain, reliable version. The server idles at almost
# nothing; the phone link (cloudflared) only opens while a queue is running.

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$taskName = 'ROC Claim queue server'

if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "removed the logon task. The server keeps running until npm run down or a restart."
    exit 0
}

$runner = Join-Path $root 'tools\run-server.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`"" `
    -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# A laptop: do not skip the task on battery.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Starts the ROC Claim queue server (localhost:4321) at logon.' -Force | Out-Null
Write-Output "logon task '$taskName' registered"

& $runner
