[CmdletBinding()]
param(
    [ValidateSet('Library','ValidateRequest','InvokeHostedToolChild')]
    [string]$Mode = 'Library',
    [string]$RequestPath,
    [string]$ExpectedRequestSha256
)

# This wrapper is only an owned child-process observation primitive. It neither
# qualifies a release nor authorizes acquisition, publication, or host changes.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:SchemaVersion = 1
$script:Repository = 'i7Gamer/MySpeed'
$script:ImageOS = 'win25-vs2026'
$script:ImageVersionPattern = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
$script:RequestLimitBytes = 65536
$script:ResultLimitBytes = 262144
$script:ToolStreamLimitBytes = 65536
$script:ProbeStreamLimitBytes = 4096
$script:ToolDurationMilliseconds = 30000
$script:ProbeDurationMilliseconds = 10000
$script:CleanupDurationMilliseconds = 5000
$script:MaximumArgumentCount = 256
$script:MaximumArgumentLength = 32767
$script:RequiredErrorModeFlags = 3
$script:Sha40Pattern = '^[a-f0-9]{40}$'
$script:Sha256Pattern = '^[a-f0-9]{64}$'
$script:PositiveDecimalPattern = '^[1-9][0-9]{0,19}$'
$script:NoncePattern = '^[a-f0-9]{32}$'
$script:OperationPattern = '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'
$script:FailureExitCode = 1

function Assert-MyspeedExactKeys {
    param([object]$Value, [string[]]$Expected, [string]$Label)
    if ($null -eq $Value) { throw "$Label is missing" }
    $keys = if ($Value -is [System.Collections.IDictionary]) { @($Value.Keys) } else { @($Value.PSObject.Properties.Name) }
    $actual = @($keys | Sort-Object -CaseSensitive)
    $wanted = @($Expected | Sort-Object -CaseSensitive)
    if (($actual -join "`n") -cne ($wanted -join "`n")) { throw "$Label keys are invalid" }
}

function Assert-MyspeedJsonString {
    param([object]$Value, [string]$Label)
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) { throw "$Label must be a nonempty string" }
    return $Value
}

function Assert-MyspeedJsonInteger {
    param([object]$Value, [string]$Label)
    if ($Value -isnot [int] -and $Value -isnot [long]) { throw "$Label must be a JSON integer" }
    return [int64]$Value
}

function Assert-MyspeedJsonBoolean {
    param([object]$Value, [string]$Label)
    if ($Value -isnot [bool]) { throw "$Label must be a JSON boolean" }
    return [bool]$Value
}

function Assert-MyspeedCanonicalPath {
    param([string]$Path, [string]$Label)
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path.IndexOf([char]0) -ge 0 -or
        $Path -cnotmatch '^[A-Za-z]:\\' -or $Path.IndexOf(':', 2) -ge 0 -or
        $Path -match '[\x00-\x1f<>"|?*]') {
        throw "$Label must be a canonical absolute Windows path"
    }
    $canonical = [IO.Path]::GetFullPath($Path)
    if (-not [string]::Equals($canonical.TrimEnd('\'), $Path.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must be a canonical absolute Windows path"
    }
    foreach ($component in $canonical.Substring(3).Split('\')) {
        $stem = $component.Split('.')[0]
        if ($stem -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$') {
            throw "$Label contains a reserved Windows path component"
        }
    }
    return $canonical
}

function Assert-MyspeedOrdinaryFile {
    param([string]$Path, [string]$Label)
    $canonical = Assert-MyspeedCanonicalPath $Path $Label
    if (-not (Test-Path -LiteralPath $canonical -PathType Leaf)) { throw "$Label must be an existing ordinary file" }
    $item = Get-Item -LiteralPath $canonical -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "$Label must be an existing ordinary file"
    }
    return $canonical
}

function Assert-MyspeedOrdinaryDirectory {
    param([string]$Path, [string]$Label)
    $canonical = Assert-MyspeedCanonicalPath $Path $Label
    if (-not (Test-Path -LiteralPath $canonical -PathType Container)) { throw "$Label must be an existing ordinary directory" }
    $item = Get-Item -LiteralPath $canonical -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "$Label must be an existing ordinary directory"
    }
    return $canonical.TrimEnd('\')
}

function Get-MyspeedSha256 {
    param([string]$Path)
    $stream = $null
    $algorithm = $null
    try {
        $stream = New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $algorithm = [Security.Cryptography.SHA256]::Create()
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        if ($null -ne $algorithm) { $algorithm.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Get-MyspeedBytesSha256 {
    param([byte[]]$Bytes)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Get-MyspeedDefaultRequestFileOperations {
    return @{
        Open = {
            param([string]$path)
            New-Object IO.FileStream($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        }
        Length = { param([IO.FileStream]$handle) [int64]$handle.Length }
        ReadAll = {
            param([IO.FileStream]$handle, [int]$length)
            $bytes = New-Object byte[] $length
            $offset = 0
            while ($offset -lt $length) {
                $read = $handle.Read($bytes, $offset, $length - $offset)
                if ($read -le 0) { throw 'Request ended before its observed length' }
                $offset += $read
            }
            if ($handle.ReadByte() -ne -1) { throw 'Request grew beyond its observed length' }
            return [byte[]]$bytes
        }
        Close = { param([IO.FileStream]$handle) $handle.Dispose() }
    }
}

function Read-MyspeedBoundedRequestBytes {
    param([string]$Path, [int]$MaximumBytes, [System.Collections.IDictionary]$FileOperations)
    if ($null -eq $FileOperations) { $FileOperations = Get-MyspeedDefaultRequestFileOperations }
    Assert-MyspeedExactKeys $FileOperations @('Open','Length','ReadAll','Close') 'Request file operations'
    $handle = $null
    $opened = $false
    $primaryFailure = $null
    $closeFailure = $null
    $bytes = $null
    try {
        $handle = & $FileOperations.Open $Path
        if ($null -eq $handle) { throw 'Request file handle was not returned' }
        $opened = $true
        $length = & $FileOperations.Length $handle
        if (-not (Test-MyspeedPrimitiveInteger $length) -or [int64]$length -le 0 -or
            [int64]$length -gt $MaximumBytes) { throw 'Request length is outside its bound' }
        $bytes = [byte[]]@(& $FileOperations.ReadAll $handle ([int]$length))
        if ($bytes.Length -ne [int]$length) { throw 'Request byte read was incomplete' }
    } catch { $primaryFailure = $_.Exception.Message }
    finally {
        if ($opened) { try { & $FileOperations.Close $handle } catch { $closeFailure = $_.Exception.Message } }
    }
    if ($null -ne $primaryFailure -and $null -ne $closeFailure) {
        throw "Request read failed: $primaryFailure; request handle cleanup failed: $closeFailure"
    }
    if ($null -ne $primaryFailure) { throw $primaryFailure }
    if ($null -ne $closeFailure) { throw "Request handle cleanup failed: $closeFailure" }
    return [byte[]]$bytes
}

function ConvertFrom-MyspeedStrictUtf8Json {
    param([byte[]]$Bytes)
    $encoding = New-Object Text.UTF8Encoding($false, $true)
    $text = $encoding.GetString($Bytes)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xfeff) { throw 'Request must not contain a byte-order mark' }
    return $text | ConvertFrom-Json -ErrorAction Stop
}

function Read-MyspeedToolChildRequest {
    param([string]$Path, [string]$ExpectedSha256, [System.Collections.IDictionary]$FileOperations)
    if ($ExpectedSha256 -cnotmatch $script:Sha256Pattern) { throw 'Expected request hash is invalid' }
    $requestPath = Assert-MyspeedOrdinaryFile $Path 'Request path'
    $requestBytes = Read-MyspeedBoundedRequestBytes $requestPath $script:RequestLimitBytes $FileOperations
    $actualRequestSha = Get-MyspeedBytesSha256 $requestBytes
    if ($actualRequestSha -cne $ExpectedSha256) { throw 'Request hash differed' }
    $request = ConvertFrom-MyspeedStrictUtf8Json $requestBytes
    $keys = @('schemaVersion','expectedRunId','expectedRunAttempt','expectedEventSha','expectedSourceSha',
        'nonce','operationId','toolPath','toolSha256','arguments','workingDirectory','streamLimitBytes',
        'maximumDurationMilliseconds','isProbe','resultPath')
    Assert-MyspeedExactKeys $request $keys 'Tool child request'
    if ((Assert-MyspeedJsonInteger $request.schemaVersion 'Request schema version') -ne $script:SchemaVersion) {
        throw 'Request schema version is invalid'
    }
    foreach ($name in @('expectedRunId','expectedRunAttempt')) {
        $value = Assert-MyspeedJsonString $request.$name "Request $name"
        if ($value -cnotmatch $script:PositiveDecimalPattern) { throw "Request $name is invalid" }
    }
    foreach ($name in @('expectedEventSha','expectedSourceSha')) {
        $value = Assert-MyspeedJsonString $request.$name "Request $name"
        if ($value -cnotmatch $script:Sha40Pattern) { throw "Request $name is invalid" }
    }
    $nonce = Assert-MyspeedJsonString $request.nonce 'Request nonce'
    if ($nonce -cnotmatch $script:NoncePattern) { throw 'Request nonce is invalid' }
    $operationId = Assert-MyspeedJsonString $request.operationId 'Request operation ID'
    if ($operationId -cnotmatch $script:OperationPattern) { throw 'Request operation ID is invalid' }
    $isProbe = Assert-MyspeedJsonBoolean $request.isProbe 'Request probe flag'
    $streamLimit = Assert-MyspeedJsonInteger $request.streamLimitBytes 'Request stream limit'
    $duration = Assert-MyspeedJsonInteger $request.maximumDurationMilliseconds 'Request duration limit'
    $expectedStream = if ($isProbe) { $script:ProbeStreamLimitBytes } else { $script:ToolStreamLimitBytes }
    $expectedDuration = if ($isProbe) { $script:ProbeDurationMilliseconds } else { $script:ToolDurationMilliseconds }
    if ($streamLimit -ne $expectedStream -or $duration -ne $expectedDuration) {
        throw 'Request limits do not match the operation class'
    }
    if ($request.arguments -isnot [Array] -or $request.arguments.Count -gt $script:MaximumArgumentCount) {
        throw 'Request arguments must be a bounded JSON array'
    }
    $arguments = New-Object 'System.Collections.Generic.List[string]'
    foreach ($argument in $request.arguments) {
        if ($argument -isnot [string] -or $argument.IndexOf([char]0) -ge 0 -or
            $argument.Length -gt $script:MaximumArgumentLength) { throw 'Request arguments are invalid' }
        [void]$arguments.Add($argument)
    }
    $toolPath = Assert-MyspeedOrdinaryFile (Assert-MyspeedJsonString $request.toolPath 'Request tool path') 'Request tool path'
    $toolSha = Assert-MyspeedJsonString $request.toolSha256 'Request tool hash'
    if ($toolSha -cnotmatch $script:Sha256Pattern -or (Get-MyspeedSha256 $toolPath) -cne $toolSha) {
        throw 'Request tool hash differed'
    }
    $workingDirectory = Assert-MyspeedOrdinaryDirectory `
        (Assert-MyspeedJsonString $request.workingDirectory 'Request working directory') 'Request working directory'
    $taskRoot = [IO.Path]::GetDirectoryName($requestPath)
    $expectedRootName = "myspeed-cpu-readiness-$nonce"
    if ([IO.Path]::GetFileName($taskRoot) -cne $expectedRootName -or
        [IO.Path]::GetFileName($requestPath) -cne "$operationId.request.json") {
        throw 'Request path is outside the exact nonce task root'
    }
    $resultPath = Assert-MyspeedCanonicalPath `
        (Assert-MyspeedJsonString $request.resultPath 'Request result path') 'Request result path'
    if ([IO.Path]::GetDirectoryName($resultPath) -cne $taskRoot -or
        [IO.Path]::GetFileName($resultPath) -cne "$operationId.result.json") {
        throw 'Result path is outside the exact nonce task root'
    }
    if (Test-Path -LiteralPath $resultPath) { throw 'Result path already exists; create-new is required' }
    return [pscustomobject]([ordered]@{
        schemaVersion=$script:SchemaVersion; expectedRunId=$request.expectedRunId
        expectedRunAttempt=$request.expectedRunAttempt; expectedEventSha=$request.expectedEventSha
        expectedSourceSha=$request.expectedSourceSha; nonce=$nonce; operationId=$operationId
        toolPath=$toolPath; toolSha256=$toolSha; arguments=@($arguments); workingDirectory=$workingDirectory
        streamLimitBytes=[int]$streamLimit; maximumDurationMilliseconds=[int]$duration
        isProbe=$isProbe; resultPath=$resultPath; requestPath=$requestPath; requestSha256=$actualRequestSha
    })
}

function Get-MyspeedHostedToolChildContext {
    return [pscustomobject]@{
        GITHUB_ACTIONS=$env:GITHUB_ACTIONS; CI=$env:CI; RUNNER_OS=$env:RUNNER_OS; RUNNER_ARCH=$env:RUNNER_ARCH
        RUNNER_ENVIRONMENT=$env:RUNNER_ENVIRONMENT; GITHUB_REPOSITORY=$env:GITHUB_REPOSITORY
        ImageOS=$env:ImageOS; ImageVersion=$env:ImageVersion; GITHUB_RUN_ID=$env:GITHUB_RUN_ID
        GITHUB_RUN_ATTEMPT=$env:GITHUB_RUN_ATTEMPT; GITHUB_SHA=$env:GITHUB_SHA; RUNNER_TEMP=$env:RUNNER_TEMP
        CL=$env:CL; _CL_=$env:_CL_; LINK=$env:LINK; _LINK_=$env:_LINK_
        Is64BitProcess=[Environment]::Is64BitProcess; PSEdition=$PSVersionTable.PSEdition
        PSVersionMajor=$PSVersionTable.PSVersion.Major
        PowerShellPath=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName; SystemRoot=$env:SystemRoot
    }
}

function Assert-MyspeedHostedToolChildContext {
    param([object]$Request, [object]$Context)
    if ($null -eq $Context) { $Context = Get-MyspeedHostedToolChildContext }
    $contextKeys = @('GITHUB_ACTIONS','CI','RUNNER_OS','RUNNER_ARCH','RUNNER_ENVIRONMENT','GITHUB_REPOSITORY',
        'ImageOS','ImageVersion','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA','RUNNER_TEMP','CL','_CL_',
        'LINK','_LINK_','Is64BitProcess','PSEdition','PSVersionMajor','PowerShellPath','SystemRoot')
    Assert-MyspeedExactKeys $Context $contextKeys 'Hosted context'
    $expected = [ordered]@{
        GITHUB_ACTIONS='true'; CI='true'; RUNNER_OS='Windows'; RUNNER_ARCH='X64'
        RUNNER_ENVIRONMENT='github-hosted'; GITHUB_REPOSITORY=$script:Repository; ImageOS=$script:ImageOS
        GITHUB_RUN_ID=$Request.expectedRunId; GITHUB_RUN_ATTEMPT=$Request.expectedRunAttempt
        GITHUB_SHA=$Request.expectedEventSha
    }
    foreach ($entry in $expected.GetEnumerator()) {
        $actual = $Context.($entry.Key)
        if ($actual -isnot [string] -or $actual -cne [string]$entry.Value) {
            throw "Hosted context identity mismatch: $($entry.Key)"
        }
    }
    if ($Context.ImageVersion -isnot [string] -or $Context.ImageVersion -cnotmatch $script:ImageVersionPattern) {
        throw 'Hosted context ImageVersion is invalid'
    }
    foreach ($name in @('CL','_CL_','LINK','_LINK_')) {
        if ($null -ne $Context.$name -and $Context.$name -cne '') { throw "Hosted context $name must be empty" }
    }
    if ($Context.Is64BitProcess -isnot [bool] -or -not $Context.Is64BitProcess -or
        $Context.PSEdition -cne 'Desktop' -or (Assert-MyspeedJsonInteger $Context.PSVersionMajor 'Hosted context PowerShell version') -ne 5) {
        throw 'Hosted context must be x64 Windows PowerShell 5.1 Desktop'
    }
    $systemRoot = Assert-MyspeedOrdinaryDirectory $Context.SystemRoot 'Hosted context SystemRoot'
    $expectedPowerShell = [IO.Path]::Combine($systemRoot, 'System32\WindowsPowerShell\v1.0\powershell.exe')
    $actualPowerShell = Assert-MyspeedOrdinaryFile $Context.PowerShellPath 'Hosted context PowerShell path'
    if (-not [string]::Equals($actualPowerShell, $expectedPowerShell, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Hosted context PowerShell path differed'
    }
    $runnerTemp = Assert-MyspeedOrdinaryDirectory $Context.RUNNER_TEMP 'Hosted context RUNNER_TEMP'
    $expectedRoot = [IO.Path]::Combine($runnerTemp, "myspeed-cpu-readiness-$($Request.nonce)")
    if ([IO.Path]::GetDirectoryName($Request.requestPath) -cne $expectedRoot) {
        throw 'Hosted context task root differed'
    }
    return $runnerTemp
}

function Initialize-MyspeedToolChildNativeType {
    if ('MySpeed.Qualification.ToolChildNative' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

namespace MySpeed.Qualification {
    public sealed class DrainResult {
        public byte[] Bytes = new byte[0];
        public bool LimitExceeded;
        public string Failure;
    }

    public sealed class ToolChildRunResult {
        public long ChildProcessId;
        public long ExitCode;
        public bool HasExitCode;
        public bool TimedOut;
        public long DurationMilliseconds;
        public byte[] Stdout = new byte[0];
        public byte[] Stderr = new byte[0];
        public bool OutputDrainProven;
        public bool ChildJobMembershipProven;
        public bool ChildExitProven;
        public bool HandlesClosedProven;
        public string[] Failures = new string[0];
    }

    public static class ToolChildNative {
        private const int DrainBufferBytes = 4096;
        private const int WaitSliceMilliseconds = 10;
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
        [DllImport("kernel32.dll")]
        public static extern uint SetErrorMode(uint mode);
        [DllImport("kernel32.dll")]
        public static extern uint GetErrorMode();

        public static bool CurrentProcessInJob() {
            bool result;
            if (!IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out result)) {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "IsProcessInJob(current) failed");
            }
            return result;
        }

        private static bool ProcessInJob(Process process) {
            bool result;
            if (!IsProcessInJob(process.Handle, IntPtr.Zero, out result)) {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "IsProcessInJob(child) failed");
            }
            return result;
        }

        private static string Quote(string value) {
            if (value == null || value.IndexOf('\0') >= 0) throw new ArgumentException("Child arguments must be strings without NUL");
            if (value.Length > 0 && value.IndexOfAny(new char[] {' ', '\t', '\n', '\v', '"'}) < 0) return value;
            StringBuilder result = new StringBuilder();
            result.Append('"');
            int slashes = 0;
            foreach (char character in value) {
                if (character == '\\') { slashes++; continue; }
                if (character == '"') {
                    result.Append('\\', (slashes * 2) + 1);
                    result.Append('"');
                    slashes = 0;
                    continue;
                }
                if (slashes > 0) { result.Append('\\', slashes); slashes = 0; }
                result.Append(character);
            }
            if (slashes > 0) result.Append('\\', slashes * 2);
            result.Append('"');
            return result.ToString();
        }

        private static string JoinArguments(string[] arguments) {
            List<string> quoted = new List<string>();
            foreach (string argument in arguments) quoted.Add(Quote(argument));
            return String.Join(" ", quoted.ToArray());
        }

        private static async Task<DrainResult> DrainAsync(Stream stream, int limit) {
            DrainResult result = new DrainResult();
            try {
                using (MemoryStream bytes = new MemoryStream()) {
                    byte[] buffer = new byte[DrainBufferBytes];
                    while (true) {
                        int count = await stream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
                        if (count == 0) break;
                        int remaining = limit - (int)bytes.Length;
                        if (remaining > 0) bytes.Write(buffer, 0, Math.Min(remaining, count));
                        if (count > remaining) { result.LimitExceeded = true; break; }
                    }
                    result.Bytes = bytes.ToArray();
                }
            } catch (Exception error) {
                result.Failure = error.GetType().Name + ": " + error.Message;
            }
            return result;
        }

        private static void AddFailure(List<string> failures, string value) {
            if (!String.IsNullOrEmpty(value)) failures.Add(value);
        }

        public static ToolChildRunResult Run(string executable, string[] arguments, string workingDirectory,
            int streamLimitBytes, int maximumDurationMilliseconds, int cleanupDurationMilliseconds) {
            ToolChildRunResult result = new ToolChildRunResult();
            List<string> failures = new List<string>();
            Stopwatch watch = Stopwatch.StartNew();
            Process process = null;
            Task<DrainResult> stdoutTask = null;
            Task<DrainResult> stderrTask = null;
            try {
                if (!CurrentProcessInJob()) throw new InvalidOperationException("Parent Job membership was lost before Process.Start");
                ProcessStartInfo start = new ProcessStartInfo();
                start.FileName = executable;
                start.Arguments = JoinArguments(arguments);
                start.WorkingDirectory = workingDirectory;
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.RedirectStandardInput = true;
                start.RedirectStandardOutput = true;
                start.RedirectStandardError = true;
                process = new Process();
                process.StartInfo = start;
                if (watch.ElapsedMilliseconds >= maximumDurationMilliseconds)
                    throw new TimeoutException("Inner deadline expired before Process.Start");
                if (!process.Start()) throw new InvalidOperationException("Process.Start returned false");
                result.ChildProcessId = process.Id;
                process.StandardInput.Close();
                stdoutTask = DrainAsync(process.StandardOutput.BaseStream, streamLimitBytes);
                stderrTask = DrainAsync(process.StandardError.BaseStream, streamLimitBytes);
                result.ChildJobMembershipProven = ProcessInJob(process);
                if (!result.ChildJobMembershipProven) AddFailure(failures, "child-job-membership-unproved");

                while (!process.HasExited) {
                    if (!result.ChildJobMembershipProven || watch.ElapsedMilliseconds >= maximumDurationMilliseconds) {
                        result.TimedOut = watch.ElapsedMilliseconds >= maximumDurationMilliseconds;
                        break;
                    }
                    if ((stdoutTask.IsCompleted && stdoutTask.Result.LimitExceeded) ||
                        (stderrTask.IsCompleted && stderrTask.Result.LimitExceeded) ||
                        (stdoutTask.IsCompleted && stdoutTask.Result.Failure != null) ||
                        (stderrTask.IsCompleted && stderrTask.Result.Failure != null)) break;
                    process.WaitForExit(WaitSliceMilliseconds);
                }
                Stopwatch cleanupWatch = Stopwatch.StartNew();
                if (!process.HasExited) {
                    try { process.Kill(); } catch (Exception error) { AddFailure(failures, "child-termination-failed: " + error.Message); }
                }
                result.ChildExitProven = process.WaitForExit(cleanupDurationMilliseconds);
                if (!result.ChildExitProven) AddFailure(failures, "child-cleanup-unproved");
                if (result.ChildExitProven) {
                    result.ExitCode = unchecked((uint)process.ExitCode);
                    result.HasExitCode = true;
                }
                int remaining = Math.Max(0, cleanupDurationMilliseconds -
                    (int)Math.Min(cleanupDurationMilliseconds, cleanupWatch.ElapsedMilliseconds));
                if (stdoutTask != null && stderrTask != null) Task.WaitAll(new Task[] { stdoutTask, stderrTask }, remaining);
                if (stdoutTask != null && stdoutTask.IsCompleted) result.Stdout = stdoutTask.Result.Bytes;
                if (stderrTask != null && stderrTask.IsCompleted) result.Stderr = stderrTask.Result.Bytes;
                if (stdoutTask != null && stdoutTask.IsCompleted) {
                    if (stdoutTask.Result.LimitExceeded) AddFailure(failures, "stdout-limit-exceeded");
                    AddFailure(failures, stdoutTask.Result.Failure == null ? null : "stdout-read-failed: " + stdoutTask.Result.Failure);
                } else AddFailure(failures, "stdout-drain-unproved");
                if (stderrTask != null && stderrTask.IsCompleted) {
                    if (stderrTask.Result.LimitExceeded) AddFailure(failures, "stderr-limit-exceeded");
                    AddFailure(failures, stderrTask.Result.Failure == null ? null : "stderr-read-failed: " + stderrTask.Result.Failure);
                } else AddFailure(failures, "stderr-drain-unproved");
                result.OutputDrainProven = stdoutTask != null && stderrTask != null && stdoutTask.IsCompleted && stderrTask.IsCompleted &&
                    !stdoutTask.Result.LimitExceeded && !stderrTask.Result.LimitExceeded &&
                    stdoutTask.Result.Failure == null && stderrTask.Result.Failure == null;
                if (result.TimedOut) AddFailure(failures, "deadline-exceeded");
            } catch (Exception error) {
                AddFailure(failures, "child-operation-failed: " + error.GetType().Name + ": " + error.Message);
                if (process != null && result.ChildProcessId > 0) {
                    try { if (!process.HasExited) process.Kill(); } catch (Exception cleanup) { AddFailure(failures, "child-termination-failed: " + cleanup.Message); }
                    try { result.ChildExitProven = process.WaitForExit(cleanupDurationMilliseconds); }
                    catch (Exception cleanup) { AddFailure(failures, "child-cleanup-failed: " + cleanup.Message); }
                }
            } finally {
                result.DurationMilliseconds = watch.ElapsedMilliseconds;
                if (process != null) {
                    bool handlesClosed = true;
                    if (stdoutTask != null) try { process.StandardOutput.BaseStream.Close(); }
                        catch (Exception error) { handlesClosed = false; AddFailure(failures, "stdout-handle-close-failed: " + error.Message); }
                    if (stderrTask != null) try { process.StandardError.BaseStream.Close(); }
                        catch (Exception error) { handlesClosed = false; AddFailure(failures, "stderr-handle-close-failed: " + error.Message); }
                    try { process.Dispose(); }
                    catch (Exception error) { handlesClosed = false; AddFailure(failures, "process-handle-close-failed: " + error.Message); }
                    result.HandlesClosedProven = handlesClosed;
                } else {
                    result.HandlesClosedProven = true;
                }
                result.Failures = failures.ToArray();
            }
            return result;
        }
    }
}
'@
}

function Get-MyspeedDefaultToolChildOperations {
    Initialize-MyspeedToolChildNativeType
    $cleanupDuration = $script:CleanupDurationMilliseconds
    $runChild = {
        param([object]$request)
        $native = [MySpeed.Qualification.ToolChildNative]::Run($request.toolPath, [string[]]$request.arguments,
            $request.workingDirectory, $request.streamLimitBytes, $request.maximumDurationMilliseconds,
            $cleanupDuration)
        return [pscustomobject]@{
            childProcessId=[int64]$native.ChildProcessId
            exitCode=if ($native.HasExitCode) { [int64]$native.ExitCode } else { $null }
            timedOut=[bool]$native.TimedOut
            durationMilliseconds=[int64]$native.DurationMilliseconds
            stdout=[byte[]]$native.Stdout
            stderr=[byte[]]$native.Stderr
            outputDrainProven=[bool]$native.OutputDrainProven
            childJobMembershipProven=[bool]$native.ChildJobMembershipProven
            childExitProven=[bool]$native.ChildExitProven
            handlesClosedProven=[bool]$native.HandlesClosedProven
            failures=[string[]]$native.Failures
        }
    }.GetNewClosure()
    return @{
        ParentInJob = { [MySpeed.Qualification.ToolChildNative]::CurrentProcessInJob() }
        SetErrorMode = {
            param([int]$flags)
            $before = [MySpeed.Qualification.ToolChildNative]::GetErrorMode()
            $target = $before -bor [uint32]$flags
            [void][MySpeed.Qualification.ToolChildNative]::SetErrorMode($target)
            $during = [MySpeed.Qualification.ToolChildNative]::GetErrorMode()
            [pscustomobject]@{ before=[int64]$before; during=[int64]$during; applied=($during -eq $target) }
        }
        RestoreErrorMode = {
            param([int64]$before)
            [void][MySpeed.Qualification.ToolChildNative]::SetErrorMode([uint32]$before)
            $after = [MySpeed.Qualification.ToolChildNative]::GetErrorMode()
            [pscustomobject]@{ after=[int64]$after; restored=([int64]$after -eq $before) }
        }
        RunChild = $runChild
    }
}

function Invoke-MyspeedToolChildOperation {
    param([hashtable]$Operations, [string]$Name, [object[]]$Arguments = @())
    if (-not $Operations.ContainsKey($Name) -or $Operations[$Name] -isnot [scriptblock]) {
        throw "Tool child operation $Name is missing"
    }
    return & $Operations[$Name] @Arguments
}

function Test-MyspeedPrimitiveInteger {
    param([object]$Value)
    return $Value -is [int] -or $Value -is [long]
}

function New-MyspeedFailureWrapper {
    return [pscustomobject]([ordered]@{
        schemaVersion=$script:SchemaVersion; status='failed'; childProcessId=0; exitCode=$null
        timedOut=$false; durationMilliseconds=0; stdoutBytes=0; stderrBytes=0
        outputDrainProven=$false; childJobMembershipProven=$false; errorModeRestored=$true
    })
}

function Invoke-MyspeedToolChildCore {
    param([object]$Request, [hashtable]$Operations)
    $failures = New-Object 'System.Collections.Generic.List[string]'
    $wrapper = New-MyspeedFailureWrapper
    $stdout = [byte[]]@()
    $stderr = [byte[]]@()
    $child = $null
    $childExitProven = $false
    $handlesClosedProven = $false
    $parentMembership = $false
    $errorMode = [pscustomobject]([ordered]@{
        required=[bool]$Request.isProbe; requiredFlags=if ($Request.isProbe) { $script:RequiredErrorModeFlags } else { 0 }
        before=$null; during=$null; after=$null; restored=(-not [bool]$Request.isProbe)
    })
    $modeApplied = $false
    try {
        if ((Get-MyspeedSha256 $Request.toolPath) -cne $Request.toolSha256) {
            throw 'Tool hash differed immediately before child creation'
        }
        $parentObservation = Invoke-MyspeedToolChildOperation $Operations 'ParentInJob'
        $parentMembership = $parentObservation -is [bool] -and $parentObservation
        if (-not $parentMembership) { throw 'Parent Job membership could not be proven before child creation' }
        if ($Request.isProbe) {
            $applied = Invoke-MyspeedToolChildOperation $Operations 'SetErrorMode' @($script:RequiredErrorModeFlags)
            Assert-MyspeedExactKeys $applied @('before','during','applied') 'Error-mode application'
            if (-not (Test-MyspeedPrimitiveInteger $applied.before)) { throw 'Probe prior error mode is invalid' }
            $errorMode.before = [int64]$applied.before
            $modeApplied = $true
            if (-not (Test-MyspeedPrimitiveInteger $applied.during) -or
                $applied.applied -isnot [bool] -or -not $applied.applied) { throw 'Probe error mode could not be applied' }
            $errorMode.during = [int64]$applied.during
        }
        $child = Invoke-MyspeedToolChildOperation $Operations 'RunChild' @($Request)
        $childKeys = @('childProcessId','exitCode','timedOut','durationMilliseconds','stdout','stderr',
            'outputDrainProven','childJobMembershipProven','childExitProven','handlesClosedProven','failures')
        Assert-MyspeedExactKeys $child $childKeys 'Tool child observation'
        if (-not (Test-MyspeedPrimitiveInteger $child.childProcessId) -or [int64]$child.childProcessId -le 0 -or
            [int64]$child.childProcessId -gt [uint32]::MaxValue) { [void]$failures.Add('child-process-id-invalid') }
        if ($null -ne $child.exitCode -and (-not (Test-MyspeedPrimitiveInteger $child.exitCode) -or
            [int64]$child.exitCode -lt 0 -or [int64]$child.exitCode -gt [uint32]::MaxValue)) {
            [void]$failures.Add('child-exit-code-invalid')
        }
        if ($null -eq $child.exitCode) { [void]$failures.Add('child-exit-code-unproved') }
        if ($child.timedOut -isnot [bool] -or $child.outputDrainProven -isnot [bool] -or
            $child.childJobMembershipProven -isnot [bool] -or $child.childExitProven -isnot [bool] -or
            $child.handlesClosedProven -isnot [bool]) {
            throw 'Tool child proof types are invalid'
        }
        $childExitProven = [bool]$child.childExitProven
        $handlesClosedProven = [bool]$child.handlesClosedProven
        if (-not (Test-MyspeedPrimitiveInteger $child.durationMilliseconds) -or [int64]$child.durationMilliseconds -lt 0) {
            throw 'Tool child duration is invalid'
        }
        if ($child.stdout -isnot [Array] -or $child.stderr -isnot [Array]) { throw 'Tool child streams are invalid' }
        $stdout = [byte[]]$child.stdout
        $stderr = [byte[]]$child.stderr
        if ($stdout.Length -gt $Request.streamLimitBytes -or $stderr.Length -gt $Request.streamLimitBytes) {
            [void]$failures.Add('retained-stream-limit-exceeded')
        }
        if ($child.failures -isnot [Array]) { throw 'Tool child failures are invalid' }
        foreach ($failure in $child.failures) {
            if ($failure -isnot [string] -or [string]::IsNullOrWhiteSpace($failure)) { throw 'Tool child failures are invalid' }
            [void]$failures.Add($failure)
        }
        if ($child.timedOut) { [void]$failures.Add('tool-child-timed-out') }
        if (-not $child.outputDrainProven) { [void]$failures.Add('output-drain-unproved') }
        if (-not $child.childJobMembershipProven) { [void]$failures.Add('child-job-membership-unproved') }
        if (-not $childExitProven) { [void]$failures.Add('child-cleanup-unproved') }
        if (-not $handlesClosedProven) { [void]$failures.Add('owned-handle-close-unproved') }
        if ([int64]$child.durationMilliseconds -gt $Request.maximumDurationMilliseconds) {
            [void]$failures.Add('child-duration-limit-exceeded')
        }
        $wrapper.childProcessId = [int64]$child.childProcessId
        $wrapper.exitCode = if ($null -eq $child.exitCode) { $null } else { [int64]$child.exitCode }
        $wrapper.timedOut = [bool]$child.timedOut
        $wrapper.durationMilliseconds = [int64]$child.durationMilliseconds
        $wrapper.stdoutBytes = $stdout.Length
        $wrapper.stderrBytes = $stderr.Length
        $wrapper.outputDrainProven = [bool]$child.outputDrainProven
        $wrapper.childJobMembershipProven = [bool]$child.childJobMembershipProven
    } catch {
        [void]$failures.Add($_.Exception.Message)
    } finally {
        if ($modeApplied) {
            try {
                $restored = Invoke-MyspeedToolChildOperation $Operations 'RestoreErrorMode' @($errorMode.before)
                Assert-MyspeedExactKeys $restored @('after','restored') 'Error-mode restoration'
                if (-not (Test-MyspeedPrimitiveInteger $restored.after) -or $restored.restored -isnot [bool]) {
                    throw 'Error-mode restoration proof is invalid'
                }
                $errorMode.after = [int64]$restored.after
                $errorMode.restored = [bool]$restored.restored -and $errorMode.after -eq $errorMode.before
                if (-not $errorMode.restored) { [void]$failures.Add('error-mode restoration was not proven') }
            } catch {
                $errorMode.restored = $false
                [void]$failures.Add('error-mode restoration failed: ' + $_.Exception.Message)
            }
        }
    }
    $wrapper.errorModeRestored = [bool]$errorMode.restored
    if ($failures.Count -eq 0) { $wrapper.status = 'completed' }
    $status = if ($failures.Count -eq 0) { 'completed' } else { 'failed' }
    return [pscustomobject]([ordered]@{
        schemaVersion=$script:SchemaVersion; status=$status; classification='windows-native-host-observation-nonqualifying'
        bindings=[pscustomobject]([ordered]@{
            requestPath=$Request.requestPath; requestSha256=$Request.requestSha256
            expectedRunId=$Request.expectedRunId; expectedRunAttempt=$Request.expectedRunAttempt
            expectedEventSha=$Request.expectedEventSha; expectedSourceSha=$Request.expectedSourceSha
            nonce=$Request.nonce; operationId=$Request.operationId; toolPath=$Request.toolPath
            toolSha256=$Request.toolSha256; toolSha256Before=$Request.toolSha256; toolSha256After=$null
            arguments=@($Request.arguments); workingDirectory=$Request.workingDirectory
            streamLimitBytes=$Request.streamLimitBytes; maximumDurationMilliseconds=$Request.maximumDurationMilliseconds
            isProbe=$Request.isProbe; resultPath=$Request.resultPath
        })
        parentJobMembershipProven=$parentMembership
        childExitProven=$childExitProven; handlesClosedProven=$handlesClosedProven
        errorMode=$errorMode; wrapper=$wrapper
        stdoutBase64=[Convert]::ToBase64String($stdout); stderrBase64=[Convert]::ToBase64String($stderr)
        failures=@($failures)
    })
}

function Write-MyspeedToolChildResult {
    param([string]$Path, [object]$Value)
    $json = $Value | ConvertTo-Json -Compress -Depth 12
    $encoding = New-Object Text.UTF8Encoding($false)
    $bytes = $encoding.GetBytes($json)
    if ($bytes.Length -le 0 -or $bytes.Length -gt $script:ResultLimitBytes) { throw 'Result exceeds the bounded create-new limit' }
    $stream = $null
    try {
        $stream = New-Object IO.FileStream($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } catch {
        throw ('Create-new result write failed: ' + $_.Exception.Message)
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Invoke-MyspeedHostedToolChild {
    param([string]$Path, [string]$ExpectedSha256)
    $request = Read-MyspeedToolChildRequest $Path $ExpectedSha256
    Assert-MyspeedHostedToolChildContext $request | Out-Null
    $operations = Get-MyspeedDefaultToolChildOperations
    $result = Invoke-MyspeedToolChildCore $request $operations
    try { $afterHash = Get-MyspeedSha256 $request.toolPath } catch { $afterHash = $null }
    $result.bindings.toolSha256After = $afterHash
    if ($afterHash -cne $request.toolSha256) {
        $result.status = 'failed'; $result.wrapper.status = 'failed'
        $result.failures = @($result.failures) + @('tool post-execution hash was unavailable or differed')
    }
    Write-MyspeedToolChildResult $request.resultPath $result
    $result | ConvertTo-Json -Compress -Depth 12
    if ($result.status -cne 'completed') { exit $script:FailureExitCode }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        switch ($Mode) {
            'Library' { }
            'ValidateRequest' {
                Read-MyspeedToolChildRequest $RequestPath $ExpectedRequestSha256 | ConvertTo-Json -Compress -Depth 8
            }
            'InvokeHostedToolChild' { Invoke-MyspeedHostedToolChild $RequestPath $ExpectedRequestSha256 }
        }
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit $script:FailureExitCode
    }
}
