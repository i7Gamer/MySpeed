[CmdletBinding()]
param()

# Process-ownership primitive only. The child inherits the caller environment;
# a separate reviewed controller must constrain that environment and authorize any transfer.
# Path checks below prove lexical normalization and the final leaf only. Ancestor reparse-point,
# ACL, and file-identity binding remain requirements for that separate controller.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:LauncherSchemaVersion = 1
$script:MaximumArgumentCount = 256
$script:MaximumArgumentLength = 32767
$script:MaximumCommandLineLength = 32766
$script:MaximumDurationMilliseconds = 86400000
$script:CleanupWaitMilliseconds = 2000
$script:MaximumWaitSliceMilliseconds = 50
$script:CreateSuspended = 0x00000004
$script:CreateNoWindow = 0x08000000
$script:JobObjectBasicAccountingInformation = 1
$script:JobObjectExtendedLimitInformation = 9
$script:JobObjectLimitKillOnJobClose = 0x00002000
$script:WaitObject0 = 0x00000000
$script:WaitTimeout = 0x00000102
$script:StartupInfoUseShowWindow = 0x00000001
$script:ShowWindowHidden = 0
$script:CleanupPollMilliseconds = 10
$script:FailureExitCode = 1

function Initialize-MediaJobNativeType {
    if ('MySpeed.Qualification.JobNative' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace MySpeed.Qualification {
    public static class JobNative {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct STARTUPINFO {
            public uint cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public ushort wShowWindow;
            public ushort cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct IO_COUNTERS {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
            public long TotalUserTime;
            public long TotalKernelTime;
            public long ThisPeriodTotalUserTime;
            public long ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount;
            public uint TotalProcesses;
            public uint ActiveProcesses;
            public uint TotalTerminatedProcesses;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr job, int infoClass,
            ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool QueryInformationJobObject(IntPtr job, int infoClass,
            ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length, IntPtr returnLength);

        [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)]
        public static extern bool QueryBasicAccountingInformation(IntPtr job, int infoClass,
            ref JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint length, IntPtr returnLength);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CreateProcess(string applicationName, StringBuilder commandLine,
            IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags,
            IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);
    }
}
'@
}

function Get-Win32Message {
    param([string]$Operation)
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    return "$Operation failed with Win32 error $code"
}

function ConvertTo-WindowsCommandLineArgument {
    param([object]$Value)
    if ($Value -isnot [string] -or $Value.IndexOf([char]0) -ge 0) {
        throw 'Arguments must be strings and contain no NUL'
    }
    if ($Value.Length -gt $script:MaximumArgumentLength) { throw 'Argument exceeds the length limit' }
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $builder = New-Object Text.StringBuilder
    [void]$builder.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') { $backslashes++; continue }
        if ($character -eq '"') {
            [void]$builder.Append(('\' * (($backslashes * 2) + 1)))
            [void]$builder.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) { [void]$builder.Append(('\' * $backslashes)); $backslashes = 0 }
        [void]$builder.Append($character)
    }
    if ($backslashes -gt 0) { [void]$builder.Append(('\' * ($backslashes * 2))) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function ConvertTo-ExactCommandLine {
    param([string]$Executable, [object[]]$ArgumentList)
    $parts = New-Object 'System.Collections.Generic.List[string]'
    [void]$parts.Add((ConvertTo-WindowsCommandLineArgument $Executable))
    foreach ($argument in $ArgumentList) { [void]$parts.Add((ConvertTo-WindowsCommandLineArgument $argument)) }
    $commandLine = $parts -join ' '
    if ($commandLine.Length -gt $script:MaximumCommandLineLength) { throw 'Command line exceeds the Windows limit' }
    return $commandLine
}

function Assert-AbsoluteOrdinaryLeafFile {
    param([string]$Path, [string]$Label)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
        throw "$Label must be an absolute ordinary leaf file with lexical normalization"
    }
    $canonical = [IO.Path]::GetFullPath($Path)
    if (-not [string]::Equals($canonical, $Path, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must be an absolute ordinary leaf file with lexical normalization"
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label must be an absolute ordinary leaf file with lexical normalization"
    }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "$Label must be an absolute ordinary leaf file with lexical normalization"
    }
}

function Assert-AbsoluteOrdinaryLeafDirectory {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
        throw 'Working directory must be an absolute ordinary leaf directory with lexical normalization'
    }
    $canonical = [IO.Path]::GetFullPath($Path)
    if (-not [string]::Equals($canonical.TrimEnd('\'), $Path.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Working directory must be an absolute ordinary leaf directory with lexical normalization'
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw 'Working directory must be an absolute ordinary leaf directory with lexical normalization'
    }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Working directory must be an absolute ordinary leaf directory with lexical normalization'
    }
}

function Get-DefaultClock {
    $frequency = [Diagnostics.Stopwatch]::Frequency
    return {
        $ticks = [Diagnostics.Stopwatch]::GetTimestamp()
        @{
            WallUnixMilliseconds = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            MonotonicMilliseconds = [Math]::Floor(($ticks * 1000.0) / $frequency)
        }
    }.GetNewClosure()
}

function Get-DefaultNativeMethods {
    Initialize-MediaJobNativeType
    return @{
        CreateJob = {
            $handle = [MySpeed.Qualification.JobNative]::CreateJobObject([IntPtr]::Zero, $null)
            if ($handle -eq [IntPtr]::Zero) { throw (Get-Win32Message 'CreateJobObject') }
            return $handle
        }
        ConfigureKillOnClose = {
            param([IntPtr]$job)
            $info = New-Object MySpeed.Qualification.JobNative+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
            $basic = New-Object MySpeed.Qualification.JobNative+JOBOBJECT_BASIC_LIMIT_INFORMATION
            $basic.LimitFlags = $script:JobObjectLimitKillOnJobClose
            $info.BasicLimitInformation = $basic
            $length = [Runtime.InteropServices.Marshal]::SizeOf($info)
            if (-not [MySpeed.Qualification.JobNative]::SetInformationJobObject(
                $job, $script:JobObjectExtendedLimitInformation, [ref]$info, $length)) {
                throw (Get-Win32Message 'SetInformationJobObject')
            }
            $observed = New-Object MySpeed.Qualification.JobNative+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
            if (-not [MySpeed.Qualification.JobNative]::QueryInformationJobObject(
                $job, $script:JobObjectExtendedLimitInformation, [ref]$observed, $length, [IntPtr]::Zero)) {
                throw (Get-Win32Message 'QueryInformationJobObject')
            }
            if ($observed.BasicLimitInformation.LimitFlags -ne $script:JobObjectLimitKillOnJobClose) {
                throw 'Job Object kill-on-close configuration did not round-trip exactly'
            }
        }
        CreateSuspended = {
            param([string]$executable, [string]$commandLine, [string]$workingDirectory)
            $startup = New-Object MySpeed.Qualification.JobNative+STARTUPINFO
            $startup.cb = [Runtime.InteropServices.Marshal]::SizeOf($startup)
            $startup.dwFlags = $script:StartupInfoUseShowWindow
            $startup.wShowWindow = $script:ShowWindowHidden
            $process = New-Object MySpeed.Qualification.JobNative+PROCESS_INFORMATION
            $flags = $script:CreateSuspended -bor $script:CreateNoWindow
            $mutableCommandLine = New-Object Text.StringBuilder($commandLine)
            if (-not [MySpeed.Qualification.JobNative]::CreateProcess(
                $executable, $mutableCommandLine, [IntPtr]::Zero, [IntPtr]::Zero, $false, $flags,
                [IntPtr]::Zero, $workingDirectory, [ref]$startup, [ref]$process)) {
                throw (Get-Win32Message 'CreateProcessW')
            }
            return @{ ProcessHandle=$process.hProcess; ThreadHandle=$process.hThread; ProcessId=[int64]$process.dwProcessId }
        }
        Assign = {
            param([IntPtr]$job, [IntPtr]$process)
            if (-not [MySpeed.Qualification.JobNative]::AssignProcessToJobObject($job, $process)) {
                throw (Get-Win32Message 'AssignProcessToJobObject')
            }
        }
        Resume = {
            param([IntPtr]$thread)
            if ([MySpeed.Qualification.JobNative]::ResumeThread($thread) -eq [uint32]::MaxValue) {
                throw (Get-Win32Message 'ResumeThread')
            }
        }
        Wait = {
            param([IntPtr]$process, [int]$milliseconds)
            $result = [MySpeed.Qualification.JobNative]::WaitForSingleObject($process, [uint32]$milliseconds)
            if ($result -eq $script:WaitObject0) { return 'Exited' }
            if ($result -eq $script:WaitTimeout) { return 'Timeout' }
            throw (Get-Win32Message 'WaitForSingleObject')
        }
        ExitCode = {
            param([IntPtr]$process)
            $code = [uint32]0
            if (-not [MySpeed.Qualification.JobNative]::GetExitCodeProcess($process, [ref]$code)) {
                throw (Get-Win32Message 'GetExitCodeProcess')
            }
            return [int64]$code
        }
        Terminate = {
            param([IntPtr]$process)
            if (-not [MySpeed.Qualification.JobNative]::TerminateProcess($process, $script:FailureExitCode)) {
                throw (Get-Win32Message 'TerminateProcess')
            }
        }
        ActiveProcesses = {
            param([IntPtr]$job)
            $info = New-Object MySpeed.Qualification.JobNative+JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
            $length = [Runtime.InteropServices.Marshal]::SizeOf($info)
            if (-not [MySpeed.Qualification.JobNative]::QueryBasicAccountingInformation(
                $job, $script:JobObjectBasicAccountingInformation, [ref]$info, $length, [IntPtr]::Zero)) {
                throw (Get-Win32Message 'QueryInformationJobObject accounting')
            }
            return [int64]$info.ActiveProcesses
        }
        TerminateJob = {
            param([IntPtr]$job)
            if (-not [MySpeed.Qualification.JobNative]::TerminateJobObject($job, $script:FailureExitCode)) {
                throw (Get-Win32Message 'TerminateJobObject')
            }
        }
        Sleep = {
            param([int]$milliseconds)
            [Threading.Thread]::Sleep($milliseconds)
        }
        Close = {
            param([IntPtr]$handle)
            if ($handle -ne [IntPtr]::Zero -and -not [MySpeed.Qualification.JobNative]::CloseHandle($handle)) {
                throw (Get-Win32Message 'CloseHandle')
            }
        }
    }
}

function Get-ClockReading {
    param([scriptblock]$Clock)
    $reading = & $Clock
    if ($null -eq $reading -or $reading.WallUnixMilliseconds -isnot [ValueType] -or
        $reading.MonotonicMilliseconds -isnot [ValueType]) { throw 'Clock returned an invalid reading' }
    $wall = [double]$reading.WallUnixMilliseconds
    $monotonic = [double]$reading.MonotonicMilliseconds
    if ([double]::IsNaN($wall) -or [double]::IsInfinity($wall) -or
        [double]::IsNaN($monotonic) -or [double]::IsInfinity($monotonic)) {
        throw 'Clock returned a non-finite reading'
    }
    return @{ WallUnixMilliseconds=$wall; MonotonicMilliseconds=$monotonic }
}

function Invoke-NativeMethod {
    param([hashtable]$Methods, [string]$Name, [object[]]$Arguments = @())
    if (-not $Methods.ContainsKey($Name) -or $Methods[$Name] -isnot [scriptblock]) {
        throw "Native method $Name is missing"
    }
    return & $Methods[$Name] @Arguments
}

function Close-OwnedHandle {
    param([hashtable]$Methods, [object]$Handle)
    if ($null -ne $Handle) { Invoke-NativeMethod $Methods 'Close' @($Handle) | Out-Null }
}

function Stop-OwnedJobTree {
    param([hashtable]$Methods, [object]$Job)
    $active = Invoke-NativeMethod $Methods 'ActiveProcesses' @($Job)
    if ($active -isnot [ValueType] -or [int64]$active -lt 0) {
        throw 'Job accounting returned an invalid active-process count'
    }
    if ([int64]$active -gt 0) {
        Invoke-NativeMethod $Methods 'TerminateJob' @($Job) | Out-Null
    }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        $active = Invoke-NativeMethod $Methods 'ActiveProcesses' @($Job)
        if ($active -isnot [ValueType] -or [int64]$active -lt 0) {
            throw 'Job accounting returned an invalid active-process count'
        }
        if ([int64]$active -eq 0) { return }
        if ($watch.ElapsedMilliseconds -ge $script:CleanupWaitMilliseconds) {
            throw 'Job process-tree exit could not be proven'
        }
        $remaining = $script:CleanupWaitMilliseconds - $watch.ElapsedMilliseconds
        $slice = [Math]::Max(1, [Math]::Min($script:CleanupPollMilliseconds, $remaining))
        Invoke-NativeMethod $Methods 'Sleep' @([int]$slice) | Out-Null
    }
}

function Invoke-OwnedJobProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$Executable,
        [object[]]$ArgumentList = @(),
        [Parameter(Mandatory=$true)][string]$WorkingDirectory,
        [Parameter(Mandatory=$true)][int64]$WallDeadlineUnixMilliseconds,
        [Parameter(Mandatory=$true)][int64]$MaximumDurationMilliseconds,
        [hashtable]$NativeMethods,
        [scriptblock]$Clock
    )

    Assert-AbsoluteOrdinaryLeafFile $Executable 'Executable'
    Assert-AbsoluteOrdinaryLeafDirectory $WorkingDirectory
    if ($ArgumentList.Count -gt $script:MaximumArgumentCount) { throw 'Argument count exceeds the limit' }
    if ($WallDeadlineUnixMilliseconds -le 0) { throw 'Wall deadline must be positive' }
    if ($MaximumDurationMilliseconds -le 0 -or
        $MaximumDurationMilliseconds -gt $script:MaximumDurationMilliseconds) {
        throw 'Maximum duration is outside the allowed range'
    }
    $commandLine = ConvertTo-ExactCommandLine $Executable $ArgumentList
    if ($null -eq $NativeMethods) { $NativeMethods = Get-DefaultNativeMethods }
    if ($null -eq $Clock) { $Clock = Get-DefaultClock }

    $initial = Get-ClockReading $Clock
    if ($initial.WallUnixMilliseconds -ge $WallDeadlineUnixMilliseconds) { throw 'Wall deadline has already expired' }
    $monotonicDeadline = $initial.MonotonicMilliseconds + $MaximumDurationMilliseconds
    if ([double]::IsInfinity($monotonicDeadline)) { throw 'Monotonic deadline overflowed' }

    $job = $null
    $process = $null
    $thread = $null
    $processId = $null
    $assigned = $false
    $resumed = $false
    $jobClosed = $false
    $timedOut = $false
    try {
        $job = Invoke-NativeMethod $NativeMethods 'CreateJob'
        Invoke-NativeMethod $NativeMethods 'ConfigureKillOnClose' @($job) | Out-Null
        $created = Invoke-NativeMethod $NativeMethods 'CreateSuspended' @($Executable, $commandLine, $WorkingDirectory)
        if ($null -eq $created -or $null -eq $created.ProcessHandle -or $null -eq $created.ThreadHandle -or
            [int64]$created.ProcessId -le 0) { throw 'CreateSuspended returned an invalid owned process' }
        $process = $created.ProcessHandle
        $thread = $created.ThreadHandle
        $processId = [int64]$created.ProcessId
        Invoke-NativeMethod $NativeMethods 'Assign' @($job, $process) | Out-Null
        $assigned = $true

        # Native setup may consume the remaining window. Never execute the
        # suspended child until a fresh reading still permits both deadlines.
        $beforeResume = Get-ClockReading $Clock
        if ($beforeResume.WallUnixMilliseconds -lt $initial.WallUnixMilliseconds) {
            throw 'Wall clock moved backward'
        }
        if ($beforeResume.MonotonicMilliseconds -lt $initial.MonotonicMilliseconds) {
            throw 'Monotonic clock moved backward'
        }
        $timedOut = $beforeResume.WallUnixMilliseconds -ge $WallDeadlineUnixMilliseconds -or
            $beforeResume.MonotonicMilliseconds -ge $monotonicDeadline
        if (-not $timedOut) {
            Invoke-NativeMethod $NativeMethods 'Resume' @($thread) | Out-Null
            $resumed = $true
        }

        $previousWall = $beforeResume.WallUnixMilliseconds
        $previousMonotonic = $beforeResume.MonotonicMilliseconds
        while (-not $timedOut) {
            $reading = Get-ClockReading $Clock
            if ($reading.WallUnixMilliseconds -lt $previousWall) { throw 'Wall clock moved backward' }
            if ($reading.MonotonicMilliseconds -lt $previousMonotonic) { throw 'Monotonic clock moved backward' }
            $previousWall = $reading.WallUnixMilliseconds
            $previousMonotonic = $reading.MonotonicMilliseconds
            $remainingWall = $WallDeadlineUnixMilliseconds - $reading.WallUnixMilliseconds
            $remainingMonotonic = $monotonicDeadline - $reading.MonotonicMilliseconds
            if ($remainingWall -le 0 -or $remainingMonotonic -le 0) { $timedOut = $true; break }
            $slice = [Math]::Max(1, [Math]::Floor([Math]::Min(
                $script:MaximumWaitSliceMilliseconds, [Math]::Min($remainingWall, $remainingMonotonic))))
            $wait = Invoke-NativeMethod $NativeMethods 'Wait' @($process, [int]$slice)
            if ($wait -eq 'Exited') { break }
            if ($wait -ne 'Timeout') { throw 'Native wait returned an invalid state' }
        }

        if ($timedOut) {
            Stop-OwnedJobTree $NativeMethods $job
            Close-OwnedHandle $NativeMethods $job
            $jobClosed = $true
            $job = $null
            if ((Invoke-NativeMethod $NativeMethods 'Wait' @($process, $script:CleanupWaitMilliseconds)) -ne 'Exited') {
                throw 'Timed-out process tree exit could not be proven'
            }
            Close-OwnedHandle $NativeMethods $thread
            $thread = $null
            Close-OwnedHandle $NativeMethods $process
            $process = $null
            return [pscustomobject]@{
                schemaVersion = $script:LauncherSchemaVersion
                authorizesTransfer = $false
                processId = $processId
                exitCode = $null
                timedOut = $true
                processTreeExitProven = $true
            }
        }

        $exitCode = Invoke-NativeMethod $NativeMethods 'ExitCode' @($process)
        Stop-OwnedJobTree $NativeMethods $job
        Close-OwnedHandle $NativeMethods $job
        $jobClosed = $true
        $job = $null
        Close-OwnedHandle $NativeMethods $thread
        $thread = $null
        Close-OwnedHandle $NativeMethods $process
        $process = $null
        return [pscustomobject]@{
            schemaVersion = $script:LauncherSchemaVersion
            authorizesTransfer = $false
            processId = $processId
            exitCode = [int64]$exitCode
            timedOut = $false
            processTreeExitProven = $true
        }
    } catch {
        $original = $_
        $exitProven = $false
        try {
            if ($null -ne $process -and -not $assigned) {
                Invoke-NativeMethod $NativeMethods 'Terminate' @($process) | Out-Null
                $exitProven = (Invoke-NativeMethod $NativeMethods 'Wait' @(
                    $process, $script:CleanupWaitMilliseconds)) -eq 'Exited'
            } elseif ($null -ne $process -and $assigned) {
                if (-not $jobClosed -and $null -ne $job) {
                    Stop-OwnedJobTree $NativeMethods $job
                    Close-OwnedHandle $NativeMethods $job
                    $jobClosed = $true
                    $job = $null
                }
                $exitProven = (Invoke-NativeMethod $NativeMethods 'Wait' @(
                    $process, $script:CleanupWaitMilliseconds)) -eq 'Exited'
            } elseif ($null -eq $process) {
                $exitProven = $true
            }
        } catch {
            $exitProven = $false
        }
        $original.Exception.Data['ProcessTreeExitProven'] = $exitProven
        throw $original
    } finally {
        try { Close-OwnedHandle $NativeMethods $thread } catch {}
        try { Close-OwnedHandle $NativeMethods $process } catch {}
        if (-not $jobClosed) { try { Close-OwnedHandle $NativeMethods $job } catch {} }
    }
}
