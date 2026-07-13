<#
.SYNOPSIS
  Adapt a cloned project's mcp.json to this Windows/PowerShell environment.
.DESCRIPTION
  Thin wrapper over scripts/adapt-env.py. Run from a project root (or pass
  -ProjectDir) after cloning a project that was initialized on another OS, to
  re-root MCP server paths at this framework checkout and this OS interpreter.
.EXAMPLE
  scripts\adapt-env.ps1
.EXAMPLE
  scripts\adapt-env.ps1 --project-dir C:\src\myproject --dry-run
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
& $python (Join-Path $scriptDir 'adapt-env.py') @args
exit $LASTEXITCODE
