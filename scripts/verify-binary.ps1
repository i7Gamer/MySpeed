#Requires -Version 7.0
<#
.SYNOPSIS
    Smoke-tests a compiled MySpeed binary before it is uploaded to a release.

.DESCRIPTION
    Boots the executable in a throwaway working directory, waits for the health
    endpoint, then confirms that the api and the bundled client are actually
    served. Dumps the boot log and exits non-zero if any of that fails, so a
    binary that does not run never becomes a release asset.

    The counterpart to scripts/verify-image.sh. One check deliberately does not
    carry over: the image is reached through a published port, so its callers
    arrive from the bridge gateway and a password-less instance refuses them
    with a 401. A binary tested over loopback is waved through by design
    (server/middlewares/password.js), so there is no 401 to assert here. What is
    asserted instead is that the boot printed a setup token at all - on a fresh
    install that banner is the only way in from another machine.

.EXAMPLE
    scripts/verify-binary.ps1 -Binary ./MySpeed.exe
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $Binary,

    # Not 5216. Anyone running this on a machine that already hosts MySpeed
    # would otherwise interview that instance instead of the binary under test,
    # and the check would pass without ever having started one.
    [int] $Port = 5399
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# The first boot downloads the three provider CLIs before the server listens.
# Overridable so the wait can be tightened on a fast network or in a test.
$MaxAttempts = if ($env:VERIFY_MAX_ATTEMPTS) { [int] $env:VERIFY_MAX_ATTEMPTS } else { 60 }
$SleepSeconds = if ($env:VERIFY_SLEEP_SECONDS) { [int] $env:VERIFY_SLEEP_SECONDS } else { 5 }

$HealthTimeoutSeconds = 5
$RequestTimeoutSeconds = 10
$StopTimeoutMs = 15000
$LogTailLines = 50
$HttpOk = 200

$base = "http://127.0.0.1:$Port"

if (-not (Test-Path -LiteralPath $Binary)) { throw "No binary to verify at '$Binary'." }
$binaryPath = (Resolve-Path -LiteralPath $Binary).Path

# The server resolves data/ and bin/ against the current directory, so a
# throwaway one keeps a verification run from leaving a database behind - or
# from picking up one that is already there.
$work = Join-Path ([System.IO.Path]::GetTempPath()) "myspeed-verify-$PID"
New-Item -ItemType Directory -Path $work -Force | Out-Null

# Two files because a process cannot redirect both streams to one.
$stdoutLog = Join-Path $work "boot.out.log"
$stderrLog = Join-Path $work "boot.err.log"

$server = $null

function Get-BootLog {
    @($stdoutLog, $stderrLog)
        | Where-Object { Test-Path -LiteralPath $_ }
        | ForEach-Object { Get-Content -LiteralPath $_ -ErrorAction SilentlyContinue }
}

function Exit-Failed([string] $message) {
    Write-Host "::error::$message"
    Write-Host "--- boot log (last $LogTailLines lines) ---"
    Get-BootLog | Select-Object -Last $LogTailLines | ForEach-Object { Write-Host $_ }
    exit 1
}

# Connection refused throws rather than returning a status, and during the boot
# wait that is the expected answer - so the caller decides what a failure means.
function Invoke-Endpoint([string] $path, [hashtable] $headers = @{}, [int] $timeout = $RequestTimeoutSeconds) {
    try {
        return Invoke-WebRequest -Uri "$base$path" -Headers $headers -TimeoutSec $timeout -SkipHttpErrorCheck
    } catch {
        return $null
    }
}

try {
    Write-Host "Starting $binaryPath on port $Port ..."
    $env:SERVER_PORT = $Port
    $server = Start-Process -FilePath $binaryPath -WorkingDirectory $work -PassThru -NoNewWindow `
        -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog

    Write-Host "Waiting for $base/api/health ..."
    $healthy = $false
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        $health = Invoke-Endpoint "/api/health" @{} $HealthTimeoutSeconds
        if ($null -ne $health -and $health.StatusCode -eq $HttpOk -and $health.Content -match '"status":"ok"') {
            Write-Host "  healthy after ~$($attempt * $SleepSeconds)s"
            $healthy = $true
            break
        }

        # The case this whole script exists for: a binary built for the wrong
        # CPU dies here with "Illegal instruction" instead of ever listening.
        if ($server.HasExited) {
            Exit-Failed "The binary exited with code $($server.ExitCode) before becoming healthy."
        }

        Start-Sleep -Seconds $SleepSeconds
    }

    if (-not $healthy) { Exit-Failed "The binary never reported healthy; refusing to publish it." }

    Write-Host "Checking the setup token banner ..."
    $token = [regex]::Match((Get-BootLog) -join "`n", 'Setup token: ([0-9a-f]{16,})').Groups[1].Value
    if (-not $token) {
        Exit-Failed "The server never printed a setup token, so a fresh install could not be reached from another machine."
    }

    # Health only proves the process is up and the database opened; make sure
    # the things users actually consume are served as well. The token is passed
    # even though loopback does not need it, so this keeps working if that
    # exemption ever narrows.
    Write-Host "Checking the api ..."
    $status = Invoke-Endpoint "/api/speedtests/status" @{ "x-password" = $token }
    if ($null -eq $status -or $status.StatusCode -ne $HttpOk -or $status.Content -notmatch '"running"') {
        Exit-Failed "The api did not answer as expected."
    }

    # No build/ sits in the working directory, so a 200 here is the embedded
    # client rather than one the server happened to find on disk.
    Write-Host "Checking the bundled client ..."
    $client = Invoke-Endpoint "/"
    if ($null -eq $client -or $client.StatusCode -ne $HttpOk) {
        Exit-Failed "The bundled client was not served."
    }

    Write-Host "Binary verified."
} finally {
    if ($null -ne $server -and -not $server.HasExited) {
        $server.Kill($true)
        $server.WaitForExit($StopTimeoutMs) | Out-Null
    }

    try { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction Stop } catch { }
}
