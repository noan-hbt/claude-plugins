$ErrorActionPreference = 'Stop'

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host "$([char]0x2717) Git and winget unavailable. Install Git from https://git-scm.com, then rerun."
        exit 1
    }
    Write-Host "$([char]0x2022) Installing Git."
    & winget install --id Git.Git --exact --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) {
        Write-Host "$([char]0x2717) Git unavailable after installation. Open a new terminal, then rerun."
        exit 1
    }
}

$repositoryPath = Join-Path (Join-Path $HOME 'dev') 'claude-plugins'
if (Test-Path -LiteralPath $repositoryPath) {
    if (-not (Test-Path -LiteralPath (Join-Path $repositoryPath '.git'))) {
        Write-Host "$([char]0x2717) $repositoryPath exists without a Git checkout. Move it aside, then rerun."
        exit 1
    }
    Write-Host "$([char]0x2022) Updating $repositoryPath."
    & $git.Source -C $repositoryPath pull --ff-only
} else {
    New-Item -ItemType Directory -Path (Split-Path -Parent $repositoryPath) -Force | Out-Null
    Write-Host "$([char]0x2022) Cloning into $repositoryPath."
    & $git.Source clone https://github.com/noan-hbt/claude-plugins.git $repositoryPath
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& (Join-Path $repositoryPath 'megaclaude/install.ps1') @args
exit $LASTEXITCODE
