<#
.SYNOPSIS
  Initialize a fleet-controller project (PowerShell entrypoint).
.DESCRIPTION
  Detects the host environment, ensures the framework virtual environment
  exists, then delegates to scripts/init.py (which drives the bash init engine
  via Git Bash on Windows). Arguments are passed straight through, e.g.:

    scripts\init.ps1 --config init.yml
    scripts\init.ps1 -c init.yml -s 2 -e 6

  Requires: Python 3, and Git Bash (Git for Windows) for the init engine. Set
  the FLEET_BASH environment variable to point at a specific bash.exe if needed.
#>
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$frameworkDir = Split-Path -Parent $scriptDir

function Get-PythonExe {
  foreach ($name in @('python', 'python3', 'py')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  throw "No Python interpreter found on PATH. Install Python 3 and retry."
}

$python = Get-PythonExe

# Ensure the venv/MCP interpreter exists before init runs its preflight.
$venvPython = Join-Path $frameworkDir '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
  Write-Host "Virtual environment missing — running setup first..." -ForegroundColor Yellow
  & $python (Join-Path $scriptDir 'setup.py')
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# Warn early if no bash is available for the init engine.
$gitBash = Get-Command bash.exe -ErrorAction SilentlyContinue
if (-not $gitBash -and -not $env:FLEET_BASH) {
  Write-Warning "No bash.exe found on PATH. The init engine needs Git Bash (Git for Windows). Set FLEET_BASH if installed elsewhere."
}

& $python (Join-Path $scriptDir 'init.py') @args
exit $LASTEXITCODE
