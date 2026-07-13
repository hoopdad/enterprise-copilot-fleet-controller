<#
.SYNOPSIS
  Bootstrap the fleet-controller virtual environment (PowerShell entrypoint).
.DESCRIPTION
  Thin wrapper over scripts/setup.py so PowerShell and bash share one implementation.
  Detects a Python interpreter and creates .venv with the correct Windows layout.
#>
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-PythonExe {
  foreach ($name in @('python', 'python3', 'py')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  throw "No Python interpreter found on PATH. Install Python 3 and retry."
}

$python = Get-PythonExe
& $python (Join-Path $scriptDir 'setup.py') @args
exit $LASTEXITCODE
