$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    $installCommand = 'winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements'
    Write-Host "$([char]0x2022) Node.js missing. Install: $installCommand"
    if ($args -contains '--dry-run') { exit 1 }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host "$([char]0x2717) winget unavailable. Install Node.js 18+ from https://nodejs.org, then rerun."
        exit 1
    }
    $answer = Read-Host 'Install Node.js LTS now? [y/N]'
    if ($answer -notmatch '^(y|yes)$') { exit 1 }
    & winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Host "$([char]0x2717) Node.js unavailable after installation. Open a new terminal, then rerun."
        exit 1
    }
}

& $node.Source (Join-Path $PSScriptRoot 'install.js') @args
exit $LASTEXITCODE
