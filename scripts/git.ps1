$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$history = Join-Path $projectRoot 'work/byok-history'
if (-not (Test-Path -LiteralPath $history)) {
    throw 'Alternate Git history is unavailable. Restore the supplied Git bundle.'
}
& git "--git-dir=$history" "--work-tree=$projectRoot" @args
exit $LASTEXITCODE
