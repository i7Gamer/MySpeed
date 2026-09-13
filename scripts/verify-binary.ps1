#Requires -Version 7.0
<#
.SYNOPSIS
    Runs the fail-closed MySpeed artifact verifier.

.DESCRIPTION
    This is a thin platform entrypoint. The shared Node/Bun verifier creates
    fresh synthetic data, refuses inherited service settings, proves a literal
    loopback listener belongs to the launched PID before its first HTTP request,
    checks API/client/PNG/database/restart/shutdown behavior, and retains logs.

    Full verification also requires independently provable outbound-network
    denial. The shared verifier currently proves that boundary from a Linux
    network namespace with no non-loopback routes. It refuses full execution on
    Windows and macOS; use ListenerFree only for the safe reset-path check until
    a disposable runner supplies a boundary the verifier can prove.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $Binary,
    [int] $Port = 0,
    [string] $Runtime = "node",
    [string] $FixtureRuntime = "node",
    [string] $EvidenceDirectory = "",
    [string] $OriginalBuildRoot = "",
    [switch] $ListenerFree
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$binaryPath = (Resolve-Path -LiteralPath $Binary).Path
$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$checker = Join-Path $PSScriptRoot "qualification/check-artifact.mjs"
$evidence = if ($EvidenceDirectory) {
    [System.IO.Path]::GetFullPath($EvidenceDirectory)
} elseif ($env:RUNNER_TEMP) {
    Join-Path $env:RUNNER_TEMP "myspeed-binary-evidence"
} else {
    Join-Path ([System.IO.Path]::GetTempPath()) "myspeed-binary-evidence"
}

$arguments = @(
    $checker,
    "--command", $binaryPath,
    "--artifact", $binaryPath,
    "--repo", $repository,
    "--fixture-runtime", $FixtureRuntime,
    "--evidence-dir", $evidence
)

if ($Port -ne 0) {
    $arguments += @("--port", [string]$Port)
}
if ($OriginalBuildRoot) {
    $arguments += @("--original-build-root", [System.IO.Path]::GetFullPath($OriginalBuildRoot))
}
if ($ListenerFree) {
    $arguments += @("--mode", "listener-free-reset")
}

& $Runtime @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Artifact verification failed with exit code $LASTEXITCODE. Evidence is under '$evidence'."
}
