param(
    [ValidateSet('Install', 'Start', 'Stop', 'Status', 'Uninstall')]
    [string]$Action = 'Status',
    [string]$ConfigPath,
    [ValidatePattern('^[a-zA-Z0-9 _]{1,80}$')]
    [string]$TaskName = 'BYOK Agent MCP'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($Action -eq 'Install') {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        throw 'That scheduled task already exists. Uninstall it before replacing it.'
    }
    if (-not $ConfigPath) { throw 'Supply an absolute configuration path.' }
    $configFile = (Resolve-Path -LiteralPath $ConfigPath).Path
    if ($configFile.Contains('"') -or $projectRoot.Contains('"')) { throw 'Paths cannot contain quotes.' }
    $nodePath = (Get-Command node -CommandType Application).Source
    $serviceEntry = Join-Path $projectRoot 'src/service.mjs'
    $launcher = Join-Path $projectRoot ('work/start-service-' + $TaskName + '.ps1')
    New-Item -ItemType Directory -Path (Split-Path -Parent $launcher) -Force | Out-Null
    $escapedConfig = $configFile.Replace("'", "''")
    $escapedNode = $nodePath.Replace("'", "''")
    $escapedEntry = $serviceEntry.Replace("'", "''")
    $launcherText = @"
`$ErrorActionPreference = 'Stop'
`$env:BYOK_CONFIG = '$escapedConfig'
& '$escapedNode' '$escapedEntry'
exit `$LASTEXITCODE
"@
    Set-Content -LiteralPath $launcher -Value $launcherText -Encoding utf8
    $powershellPath = (Get-Command powershell.exe -CommandType Application).Source
    $taskAction = New-ScheduledTaskAction -Execute $powershellPath -Argument (
        '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $launcher + '"') -WorkingDirectory $projectRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
    $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew -StartWhenAvailable
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger `
        -Settings $settings -Principal $principal -Description 'Local BYOK MCP background worker' | Out-Null
    Write-Output 'Installed. Set persistent provider and service token environment variables, then start the task.'
} elseif ($Action -eq 'Start') {
    Start-ScheduledTask -TaskName $TaskName
} elseif ($Action -eq 'Stop') {
    Stop-ScheduledTask -TaskName $TaskName
} elseif ($Action -eq 'Uninstall') {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
} else {
    Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
    Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object LastRunTime, LastTaskResult, NextRunTime
}
