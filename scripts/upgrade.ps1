<#
.SYNOPSIS
  Upgrade a fleet-controller project to the latest framework version (PowerShell).
.DESCRIPTION
  Delegates to scripts/upgrade.sh via Git Bash (the migrations are bash scripts).
  Prefers Git Bash over the WSL launcher for Windows-path compatibility. Set the
  FLEET_BASH environment variable to override the bash executable.
.EXAMPLE
  scripts\upgrade.ps1 -n            # dry run
  scripts\upgrade.ps1 -p C:\src\myproject
#>
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-BashExe {
  if ($env:FLEET_BASH -and (Test-Path $env:FLEET_BASH)) { return $env:FLEET_BASH }
  $candidates = @(
    'C:\Program Files\Git\bin\bash.exe',
    'C:\Program Files (x86)\Git\bin\bash.exe',
    (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe')
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  $onPath = Get-Command bash.exe -ErrorAction SilentlyContinue
  if ($onPath -and $onPath.Source -notmatch 'System32') { return $onPath.Source }
  throw "No Git Bash found. Install Git for Windows or set FLEET_BASH to a bash.exe."
}

$bash = Get-BashExe
& $bash (Join-Path $scriptDir 'upgrade.sh') @args
exit $LASTEXITCODE
