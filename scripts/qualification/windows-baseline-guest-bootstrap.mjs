const PROFILE = "baseline-cpu";
const RESULT_NAME = "baseline-result.json";
const CPU_RESULT_NAME = "result.json";
const RUNTIME_BUNDLE_NAME = "guest-runtime.json";
const RUNTIME_INSTALLER_NAME = "runtime-installer.ps1";
const REQUEST_NAME = "request.json";
const EXECUTION_NAME = "execution.json";
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 512 * 1024 * 1024;
const MAX_FIXTURE_BYTES = 64 * 1024 * 1024;
const MAX_FAILURE_CHARACTERS = 512;
const BASELINE_SCENARIO_COUNT = 3;
const CONTROLLER_HARD_DEADLINE_MILLISECONDS = 310_000;
const GUARD_TIMEOUT_MILLISECONDS = 30_000;
const OPEN_GRAPH_DEADLINE_MILLISECONDS = 120_000;
const EXECUTOR_TIMEOUT_MILLISECONDS = (BASELINE_SCENARIO_COUNT * CONTROLLER_HARD_DEADLINE_MILLISECONDS) +
    GUARD_TIMEOUT_MILLISECONDS + OPEN_GRAPH_DEADLINE_MILLISECONDS;
const EXECUTOR_CLEANUP_TIMEOUT_MILLISECONDS = 30_000;
/*
 * How long the Job may keep draining after the executor's own process handle has signaled before a
 * remaining member counts as a leaked descendant. The executor's hidden console host and any child
 * it terminated on its way out leave the Job asynchronously, milliseconds after the executor
 * itself; judging the Job at the very instant the executor exits reported a plain `node -e 0` as
 * "left an owned descendant" (run 35273132053). A member that outlives the whole window is still
 * forced and still fails the run.
 */
const EXECUTOR_DESCENDANT_DRAIN_MILLISECONDS = 5_000;
const SHUTDOWN_OUTCOME_NAME = "baseline-shutdown-outcome.json";
const SHUTDOWN_STAGE = "guest-shutdown";
/*
 * Bumped when the record grew its `completionEmission` member. Nothing on the host parses this file
 * - it is published to the output volume purely so the retained image says what the guest did - so
 * the version is here to name the shape for whoever reads the image, not to gate anything.
 */
const SHUTDOWN_OUTCOME_SCHEMA_VERSION = 2;
/* Deep enough for the record, its emission report, the attempt array and each attempt's members. */
const SHUTDOWN_OUTCOME_JSON_DEPTH = 6;
/*
 * The publication-complete serial record. It is not shutdown evidence: it says only that both
 * exclusive publications returned and the guest is about to request a power-off, which is the one
 * moment the host can observe live over the already-wired COM1 file chardev. Run 35358547382
 * published a valid receipt at 15:39:52 and Windows then stayed up until the host's 16:10:52
 * deadline, so the host needs a signal that does not depend on the power-off ever completing.
 * The record only ever buys permission to stop waiting; the receipts it names are still extracted
 * and strictly parsed after cleanup, so a forged or premature line cannot create a success.
 */
export const COMPLETION_RECORD_PREFIX = "MYSPEED-STAGE3-COMPLETE-V1";
const COMPLETION_RECORD_KIND = "myspeed-stage3-publication-complete";
const COMPLETION_RECORD_SCHEMA_VERSION = 1;
export const MAX_COMPLETION_RECORD_BYTES = 768;
const COMPLETION_SERIAL_DEVICE = "\\\\.\\COM1";
/*
 * Run 35390872740 reached the emission - both receipts were published, `Stop-Computer` returned, and
 * the shutdown record said so - yet the host's serial log stayed at the 1196 bytes the firmware had
 * written. The write failed and `catch{}` destroyed the reason, so an eighty-minute window bought no
 * diagnosis at all. Two things follow from that, and both are here rather than on the host: the
 * emission reports what happened instead of swallowing it, and it has a second mechanism to report
 * about. The managed port negotiates its own line settings and hands the driver an explicit DCB with
 * no flow control, where the raw handle inherits whatever state the port was left in; they fail in
 * different ways, so trying both and naming each failure is what makes the next run decisive.
 */
const COMPLETION_SERIAL_PORT_NAME = "COM1";
const COMPLETION_SERIAL_BAUD_RATE = 115_200;
const COMPLETION_SERIAL_DATA_BITS = 8;
const COMPLETION_SERIAL_WRITE_TIMEOUT_MILLISECONDS = 5_000;
const COMPLETION_EMISSION_FUNCTION = "Write-MyspeedBaselineCompletion";
const COMPLETION_EMISSION_METHOD_PORT = "serial-port";
const COMPLETION_EMISSION_METHOD_HANDLE = "raw-handle";
/* The emitter itself throwing is a third outcome, and one a stub can still produce. */
const COMPLETION_EMISSION_METHOD_INVOCATION = "invocation";
const MAX_COMPLETION_EMISSION_FAILURE_CHARACTERS = 160;
const MAX_COMPLETION_EMISSION_PORT_NAMES = 8;
const SUCCESS_EXIT_CODE = 0;
const FAILURE_EXIT_CODE = 1;

const BASELINE_JOB_SOURCE = `using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace MySpeed.Qualification {
  public sealed class BaselineJobResult {
    public int ExitCode; public bool TimedOut,Forced,AssignedBeforeResume,Resumed,ProcessTreeExitProven,HandlesClosed;
  }
  public static class BaselineJob {
    const uint CREATE_SUSPENDED=0x4,CREATE_NO_WINDOW=0x08000000,EXTENDED_STARTUPINFO_PRESENT=0x00080000;
    const uint STARTF_USESHOWWINDOW=1,STARTF_USESTDHANDLES=0x100,JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x2000;
    const uint WAIT_OBJECT_0=0,WAIT_TIMEOUT=258,GENERIC_READ=0x80000000,GENERIC_WRITE=0x40000000;
    const uint FILE_SHARE_READ=1,CREATE_NEW=1,OPEN_EXISTING=3,FILE_ATTRIBUTE_NORMAL=0x80;
    const uint PROC_THREAD_ATTRIBUTE_HANDLE_LIST=0x20002,ERROR_INSUFFICIENT_BUFFER=122,FAILURE_EXIT_CODE=1;
    const int JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION=1,JOB_OBJECT_EXTENDED_LIMIT_INFORMATION=9;
    const int CLEANUP_POLL_MILLISECONDS=10,MAX_ATTRIBUTE_LIST_BYTES=1048576;
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public uint nLength; public IntPtr lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle; }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUPINFO { public uint cb; public IntPtr lpReserved,lpDesktop,lpTitle; public uint dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags; public ushort wShowWindow,cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError; }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess,hThread; public uint dwProcessId,dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long a,b; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long a,b,c,d; public uint faults,total,active,terminated; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint="CreateProcessW")] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFOEX si,out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint="CreateFileW")] static extern IntPtr CreateFile(string name,uint access,uint share,ref SECURITY_ATTRIBUTES sa,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref EXTENDED_LIMIT info,uint length);
    [DllImport("kernel32.dll",SetLastError=true,EntryPoint="QueryInformationJobObject")] static extern bool QueryLimits(IntPtr job,int kind,ref EXTENDED_LIMIT info,uint length,IntPtr returned);
    [DllImport("kernel32.dll",SetLastError=true,EntryPoint="QueryInformationJobObject")] static extern bool QueryAccounting(IntPtr job,int kind,ref ACCOUNTING info,uint length,IntPtr returned);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref UIntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,UIntPtr attribute,IntPtr value,UIntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    static Exception Error(string operation){return new Win32Exception(Marshal.GetLastWin32Error(),operation);}
    static string Quote(string value){if(value.IndexOf((char)0)>=0)throw new ArgumentException("Argument contains NUL");if(value.Length>0&&value.IndexOfAny(new[]{' ','\\t','"'})<0)return value;StringBuilder b=new StringBuilder("\\\"");int slash=0;foreach(char c in value){if(c=='\\\\'){slash++;continue;}if(c=='"'){b.Append('\\\\',slash*2+1).Append(c);slash=0;continue;}if(slash>0){b.Append('\\\\',slash);slash=0;}b.Append(c);}if(slash>0)b.Append('\\\\',slash*2);return b.Append('"').ToString();}
    static uint Active(IntPtr job){ACCOUNTING value=new ACCOUNTING();if(!QueryAccounting(job,JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,ref value,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero))throw Error("QueryInformationJobObject accounting");return value.active;}
    static void Close(ref IntPtr handle,List<Exception> failures){if(handle==IntPtr.Zero||handle.ToInt64()==-1){handle=IntPtr.Zero;return;}if(!CloseHandle(handle))failures.Add(Error("CloseHandle"));else handle=IntPtr.Zero;}
    static bool WaitForZero(IntPtr job,uint timeout){Stopwatch watch=Stopwatch.StartNew();while(true){if(Active(job)==0)return true;long remaining=(long)timeout-watch.ElapsedMilliseconds;if(remaining<=0)return false;System.Threading.Thread.Sleep((int)Math.Max(1,Math.Min(CLEANUP_POLL_MILLISECONDS,remaining)));}}
    public static BaselineJobResult Run(string executable,string[] arguments,string cwd,string stdoutPath,string stderrPath,uint timeout,uint cleanupTimeout,uint drainTimeout){
      IntPtr job=IntPtr.Zero,input=IntPtr.Zero,output=IntPtr.Zero,error=IntPtr.Zero,list=IntPtr.Zero,values=IntPtr.Zero;PROCESS_INFORMATION pi=new PROCESS_INFORMATION();bool listInitialized=false,created=false,assigned=false,resumed=false,forced=false;Exception primary=null;int exitCode=0;bool timedOut=false,tree=false;
      try{
        SECURITY_ATTRIBUTES sa=new SECURITY_ATTRIBUTES();sa.nLength=(uint)Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));sa.bInheritHandle=true;
        input=CreateFile("NUL",GENERIC_READ,FILE_SHARE_READ,ref sa,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,IntPtr.Zero);output=CreateFile(stdoutPath,GENERIC_WRITE,FILE_SHARE_READ,ref sa,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,IntPtr.Zero);error=CreateFile(stderrPath,GENERIC_WRITE,FILE_SHARE_READ,ref sa,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,IntPtr.Zero);if(input.ToInt64()==-1||output.ToInt64()==-1||error.ToInt64()==-1)throw Error("CreateFile standard handle");
        job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw Error("CreateJobObject");EXTENDED_LIMIT limits=new EXTENDED_LIMIT();limits.basic.flags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;if(!SetInformationJobObject(job,JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,ref limits,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))))throw Error("SetInformationJobObject");EXTENDED_LIMIT observed=new EXTENDED_LIMIT();if(!QueryLimits(job,JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,ref observed,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT)),IntPtr.Zero)||observed.basic.flags!=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)throw new InvalidOperationException("Job limits differ");
        UIntPtr bytes=UIntPtr.Zero;bool queried=InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref bytes);int queryError=Marshal.GetLastWin32Error();ulong attributeBytes=bytes.ToUInt64();if(queried||queryError!=(int)ERROR_INSUFFICIENT_BUFFER||attributeBytes==0||attributeBytes>MAX_ATTRIBUTE_LIST_BYTES)throw new InvalidOperationException("Attribute-list size differs");list=Marshal.AllocHGlobal((int)attributeBytes);if(!InitializeProcThreadAttributeList(list,1,0,ref bytes))throw Error("InitializeProcThreadAttributeList");listInitialized=true;IntPtr[] inherited=new[]{input,output,error};values=Marshal.AllocHGlobal(IntPtr.Size*inherited.Length);Marshal.Copy(inherited,0,values,inherited.Length);if(!UpdateProcThreadAttribute(list,0,(UIntPtr)PROC_THREAD_ATTRIBUTE_HANDLE_LIST,values,(UIntPtr)(IntPtr.Size*inherited.Length),IntPtr.Zero,IntPtr.Zero))throw Error("UpdateProcThreadAttribute");
        STARTUPINFOEX startup=new STARTUPINFOEX();startup.StartupInfo.cb=(uint)Marshal.SizeOf(typeof(STARTUPINFOEX));startup.StartupInfo.dwFlags=STARTF_USESHOWWINDOW|STARTF_USESTDHANDLES;startup.StartupInfo.hStdInput=input;startup.StartupInfo.hStdOutput=output;startup.StartupInfo.hStdError=error;startup.lpAttributeList=list;StringBuilder command=new StringBuilder(Quote(executable));foreach(string argument in arguments)command.Append(' ').Append(Quote(argument));
        if(!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_NO_WINDOW|EXTENDED_STARTUPINFO_PRESENT,IntPtr.Zero,cwd,ref startup,out pi))throw Error("CreateProcessW");created=true;if(!AssignProcessToJobObject(job,pi.hProcess))throw Error("AssignProcessToJobObject");assigned=true;bool member;if(!IsProcessInJob(pi.hProcess,job,out member)||!member)throw Error("IsProcessInJob");if(ResumeThread(pi.hThread)==UInt32.MaxValue)throw Error("ResumeThread");resumed=true;
        List<Exception> launchCleanup=new List<Exception>();Close(ref pi.hThread,launchCleanup);Close(ref input,launchCleanup);Close(ref output,launchCleanup);Close(ref error,launchCleanup);if(listInitialized){DeleteProcThreadAttributeList(list);listInitialized=false;}if(list!=IntPtr.Zero){Marshal.FreeHGlobal(list);list=IntPtr.Zero;}if(values!=IntPtr.Zero){Marshal.FreeHGlobal(values);values=IntPtr.Zero;}if(launchCleanup.Count>0)throw new AggregateException("Launch handle cleanup failed",launchCleanup);
        uint wait=WaitForSingleObject(pi.hProcess,timeout);if(wait!=WAIT_OBJECT_0&&wait!=WAIT_TIMEOUT)throw Error("WaitForSingleObject");timedOut=wait==WAIT_TIMEOUT;if(timedOut||!WaitForZero(job,drainTimeout)){forced=true;if(!TerminateJobObject(job,FAILURE_EXIT_CODE))throw Error("TerminateJobObject");}if(WaitForSingleObject(pi.hProcess,cleanupTimeout)!=WAIT_OBJECT_0||!WaitForZero(job,cleanupTimeout))throw new InvalidOperationException("Owned executor process tree cleanup is unproven");tree=true;if(!timedOut){uint code;if(!GetExitCodeProcess(pi.hProcess,out code))throw Error("GetExitCodeProcess");exitCode=unchecked((int)code);}else exitCode=(int)FAILURE_EXIT_CODE;
      }catch(Exception failure){primary=failure;}
      List<Exception> cleanupFailures=new List<Exception>();if(primary!=null&&created){try{if(assigned){if(!TerminateJobObject(job,FAILURE_EXIT_CODE))throw Error("TerminateJobObject failure cleanup");}else if(!TerminateProcess(pi.hProcess,FAILURE_EXIT_CODE))throw Error("TerminateProcess unassigned failure cleanup");if(WaitForSingleObject(pi.hProcess,cleanupTimeout)!=WAIT_OBJECT_0)throw new InvalidOperationException("Executor failure cleanup deadline expired");if(assigned&&!WaitForZero(job,cleanupTimeout))throw new InvalidOperationException("Executor failure Job did not become empty");tree=true;}catch(Exception cleanup){cleanupFailures.Add(cleanup);}}
      Close(ref pi.hThread,cleanupFailures);Close(ref pi.hProcess,cleanupFailures);Close(ref input,cleanupFailures);Close(ref output,cleanupFailures);Close(ref error,cleanupFailures);if(listInitialized){try{DeleteProcThreadAttributeList(list);}catch(Exception cleanup){cleanupFailures.Add(cleanup);}listInitialized=false;}if(list!=IntPtr.Zero){Marshal.FreeHGlobal(list);list=IntPtr.Zero;}if(values!=IntPtr.Zero){Marshal.FreeHGlobal(values);values=IntPtr.Zero;}Close(ref job,cleanupFailures);
      if(primary!=null){if(cleanupFailures.Count>0){cleanupFailures.Insert(0,primary);throw new AggregateException("Baseline executor launch failed and cleanup also failed",cleanupFailures);}throw primary;}if(cleanupFailures.Count>0)throw new AggregateException("Baseline executor handle cleanup failed",cleanupFailures);
      return new BaselineJobResult{ExitCode=exitCode,TimedOut=timedOut,Forced=forced,AssignedBeforeResume=assigned,Resumed=resumed,ProcessTreeExitProven=tree,HandlesClosed=true};
    }
  }
}`;

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactString = (value, pattern, label) => {
    const match = typeof value === "string" ? pattern.exec(value) : null;
    if (match === null || match.index !== 0 || match[0].length !== value.length)
        throw new TypeError(`${label} differs`);
    return value;
};

function validateBindings(value) {
    const names = ["executionSha256", "nonce", "requestSha256", "runtimeBundleSha256", "sourceSha"];
    if (!isObject(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(names))
        throw new TypeError("baseline bootstrap binding schema differs");
    exactString(value.nonce, /^[0-9a-f]{32}$/u, "baseline bootstrap nonce");
    exactString(value.sourceSha, /^[0-9a-f]{40}$/u, "baseline bootstrap source SHA");
    for (const name of ["executionSha256", "requestSha256", "runtimeBundleSha256"])
        exactString(value[name], /^[0-9a-f]{64}$/u, `baseline bootstrap ${name}`);
    return value;
}

export function renderWindowsBaselineGuestBootstrap(bindings) {
    const value = validateBindings(bindings);
    const script = `param([switch]$LibraryMode)\r\n$ErrorActionPreference='Stop'\r\nSet-StrictMode -Version Latest\r\n` +
        `$EXPECTED_NONCE='${value.nonce}'\r\n$EXPECTED_SOURCE_SHA='${value.sourceSha}'\r\n` +
        `$EXPECTED_REQUEST_SHA='${value.requestSha256}'\r\n$EXPECTED_EXECUTION_SHA='${value.executionSha256}'\r\n` +
        `$EXPECTED_RUNTIME_SHA='${value.runtimeBundleSha256}'\r\n$BASELINE_PROFILE='${PROFILE}'\r\n` +
        `$BASELINE_MAX_RESULT_BYTES=${MAX_RESULT_BYTES}\r\n$BASELINE_MAX_STREAM_BYTES=${MAX_STREAM_BYTES}\r\n` +
        `$BASELINE_MAX_CANDIDATE_BYTES=${MAX_CANDIDATE_BYTES}\r\n` +
        `$BASELINE_MAX_FIXTURE_BYTES=${MAX_FIXTURE_BYTES}\r\n` +
        `$BASELINE_MAX_FAILURE_CHARACTERS=${MAX_FAILURE_CHARACTERS}\r\n` +
        `$BASELINE_EXECUTOR_TIMEOUT=${EXECUTOR_TIMEOUT_MILLISECONDS}\r\n` +
        `$BASELINE_EXECUTOR_CLEANUP_TIMEOUT=${EXECUTOR_CLEANUP_TIMEOUT_MILLISECONDS}\r\n` +
        `$BASELINE_EXECUTOR_DRAIN_TIMEOUT=${EXECUTOR_DESCENDANT_DRAIN_MILLISECONDS}\r\n` +
        `$BASELINE_JOB_SOURCE=@'\r\n${BASELINE_JOB_SOURCE}\r\n'@\r\n` +
        `function Get-MyspeedBaselineOutputAuthority{` +
        `$output=@(Get-Volume -FileSystemLabel MYSPEEDOUT -ErrorAction Stop);if($output.Count -ne 1 -or ` +
        `[string]$output[0].DriveType -cne 'Fixed'){throw 'Baseline output authority differs'};` +
        `$root=[string]$output[0].DriveLetter+':\\';$item=Get-Item -LiteralPath $root -Force -ErrorAction Stop;` +
        `if(-not $item.PSIsContainer -or ($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){` +
        `throw 'Baseline output authority path differs'};return $root}\r\n` +
        `function Get-MyspeedActualBaselineGuard{` +
        `$seed=@(Get-Volume -FileSystemLabel MYSPEEDSEED -ErrorAction Stop);` +
        `$output=Get-MyspeedBaselineOutputAuthority;` +
        `$physical=@(Get-CimInstance Win32_NetworkAdapter -ErrorAction Stop|Where-Object{$_.PhysicalAdapter -eq $true});` +
        `$enabled=@(Get-NetAdapter -IncludeHidden -ErrorAction Stop|Where-Object{$_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Loopback'});` +
        `$routes=@(Get-NetRoute -ErrorAction Stop|Where-Object{$_.InterfaceAlias -notmatch 'Loopback'});` +
        `if([Environment]::OSVersion.Platform.ToString() -cne 'Win32NT' -or -not [Environment]::Is64BitProcess -or ` +
        `$PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or ` +
        `$seed.Count -ne 1 -or [string]$seed[0].DriveType -cne 'CD-ROM' -or ` +
        `$physical.Count -ne 0 -or $enabled.Count -ne 0 -or ` +
        `$routes.Count -ne 0){throw 'Baseline guest boundary differs'};` +
        `return [pscustomobject]@{seed=([string]$seed[0].DriveLetter+':\\');output=$output}}\r\n` +
        `function Write-MyspeedExclusive([string]$Path,[byte[]]$Bytes){` +
        `$temporary=$Path+'.tmp';$stream=$null;try{$stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,` +
        `[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true);` +
        `$stream.Position=0;$observed=[byte[]]::new($Bytes.Length);$offset=0;while($offset -lt $observed.Length){` +
        `$count=$stream.Read($observed,$offset,$observed.Length-$offset);if($count -lt 1){throw 'Guest publication was truncated'};` +
        `$offset+=$count};if($stream.Length -ne $Bytes.Length -or -not ` +
        `[Collections.StructuralComparisons]::StructuralEqualityComparer.Equals($observed,$Bytes)){` +
        `throw 'Guest publication verification failed'};$stream.Dispose();$stream=$null;[IO.File]::Move($temporary,$Path)}` +
        `finally{if($null -ne $stream){$stream.Dispose()};if([IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)}}}\r\n` +
        `function Get-MyspeedBaselineSha([IO.Stream]$Stream){$sha=[Security.Cryptography.SHA256]::Create();try{` +
        `$hash=$sha.ComputeHash($Stream);return ([BitConverter]::ToString($hash)).Replace('-','').ToLowerInvariant()}` +
        `finally{$sha.Dispose()}}\r\n` +
        `function Read-MyspeedBaselineExecution([string]$Seed,[string]$InputRoot){` +
        `$path=Join-Path $Seed '${EXECUTION_NAME}';$bytes=[IO.File]::ReadAllBytes($path);` +
        `if($bytes.Length -lt 2 -or $bytes.Length -gt $BASELINE_MAX_RESULT_BYTES){throw 'Baseline execution bytes differ'};` +
        `$stream=[IO.MemoryStream]::new($bytes,$false);try{$digest=Get-MyspeedBaselineSha $stream}finally{$stream.Dispose()};` +
        `if($digest -cne $EXPECTED_EXECUTION_SHA){throw 'Baseline execution SHA differs'};try{` +
        `$value=([Text.UTF8Encoding]::new($false,$true).GetString($bytes)|ConvertFrom-Json)}catch{` +
        `throw 'Baseline execution JSON differs'};$expected=@(` +
        `[pscustomobject]@{label='candidate';record=$value.candidateSource;path=(Join-Path $InputRoot 'MySpeed.exe');` +
        `maximum=$BASELINE_MAX_CANDIDATE_BYTES},[pscustomobject]@{label='fixture';record=$value.fixtureBundle;` +
        `path=(Join-Path $InputRoot 'fixture-bundle.json');maximum=$BASELINE_MAX_FIXTURE_BYTES});` +
        `foreach($entry in $expected){$record=$entry.record;$expectedPath=$entry.path;$maximum=[int64]$entry.maximum;` +
        `if($record.path -isnot [string] -or $record.path -cne $expectedPath){` +
        `throw ('Baseline '+$entry.label+' staged input path differs')};if($record.bytes -isnot [string] -or ` +
        `$record.bytes -cnotmatch '\\A[1-9][0-9]*\\z'){throw ('Baseline '+$entry.label+' staged input bytes differ')};` +
        `if($record.sha256 -isnot [string] -or $record.sha256 -cnotmatch '\\A[0-9a-f]{64}\\z'){` +
        `throw ('Baseline '+$entry.label+' staged input SHA differs')};` +
        `try{$size=[Convert]::ToInt64($record.bytes,[Globalization.CultureInfo]::InvariantCulture)}catch{` +
        `throw 'Baseline staged input size differs'};if($size -lt 1 -or $size -gt $maximum){` +
        `throw 'Baseline staged input size differs'}};return $value}\r\n` +
        `function Copy-MyspeedBaselineInput([string]$Source,[string]$Target,[object]$Identity){` +
        `$sourceStream=$null;$targetStream=$null;$created=$false;$completed=$false;try{` +
        `$sourceStream=[IO.File]::Open($Source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);` +
        `$expected=[Convert]::ToInt64($Identity.bytes,[Globalization.CultureInfo]::InvariantCulture);` +
        `if($sourceStream.Length -ne $expected -or (Get-MyspeedBaselineSha $sourceStream) -cne $Identity.sha256){` +
        `throw 'Baseline seed input differs'};$sourceStream.Position=0;` +
        `$targetStream=[IO.File]::Open($Target,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);` +
        `$created=$true;$sourceStream.CopyTo($targetStream,1048576);$targetStream.Flush($true);` +
        `if($sourceStream.Length -ne $expected -or $targetStream.Length -ne $expected){` +
        `throw 'Baseline staged input length differs'};$targetStream.Position=0;` +
        `if((Get-MyspeedBaselineSha $targetStream) -cne $Identity.sha256){throw 'Baseline staged input SHA differs'};` +
        `$completed=$true}` +
        `finally{if($null -ne $targetStream){$targetStream.Dispose()};if($null -ne $sourceStream){$sourceStream.Dispose()};` +
        `if($created -and -not $completed -and [IO.File]::Exists($Target)){[IO.File]::Delete($Target)}}}\r\n` +
        `function Install-MyspeedBaselineInputs([string]$Seed,[string]$Root){` +
        `if([IO.Directory]::Exists($Root)-or[IO.File]::Exists($Root)){throw 'Baseline input root is not fresh'};` +
        `$execution=Read-MyspeedBaselineExecution $Seed $Root;$created=$false;try{` +
        `$null=[IO.Directory]::CreateDirectory($Root);$created=$true;` +
        `Copy-MyspeedBaselineInput (Join-Path $Seed 'MySpeed.exe') (Join-Path $Root 'MySpeed.exe') ` +
        `$execution.candidateSource;Copy-MyspeedBaselineInput (Join-Path $Seed 'fixture-bundle.json') ` +
        `(Join-Path $Root 'fixture-bundle.json') $execution.fixtureBundle;` +
        `return [pscustomobject]@{installed=$true;root=$Root}}catch{if($created){` +
        `foreach($name in @('MySpeed.exe','fixture-bundle.json')){$target=Join-Path $Root $name;` +
        `if([IO.File]::Exists($target)){[IO.File]::Delete($target)}};if([IO.Directory]::Exists($Root)){` +
        `[IO.Directory]::Delete($Root,$false)}};throw}}\r\n` +
        `function Remove-MyspeedBaselineInputs([string]$Seed,[string]$Root){` +
        `if(-not [IO.Directory]::Exists($Root)){return [pscustomobject]@{cleanupProven=$true}};` +
        `$execution=Read-MyspeedBaselineExecution $Seed $Root;$entries=@([IO.Directory]::GetFileSystemEntries($Root));` +
        `if($entries.Count -ne 2){throw 'Baseline input cleanup inventory differs'};` +
        `$names=@($entries|ForEach-Object{[IO.Path]::GetFileName($_)}|Sort-Object -CaseSensitive);` +
        `if($names[0] -cne 'fixture-bundle.json' -or $names[1] -cne 'MySpeed.exe'){` +
        `throw 'Baseline input cleanup inventory differs'};foreach($pair in @(` +
        `[pscustomobject]@{name='MySpeed.exe';identity=$execution.candidateSource},` +
        `[pscustomobject]@{name='fixture-bundle.json';identity=$execution.fixtureBundle})){` +
        `$target=Join-Path $Root $pair.name;if(([IO.File]::GetAttributes($target)-band[IO.FileAttributes]::ReparsePoint)-ne 0){` +
        `throw 'Baseline input cleanup encountered a reparse point'};$stream=[IO.File]::Open($target,[IO.FileMode]::Open,` +
        `[IO.FileAccess]::Read,[IO.FileShare]::None);try{if($stream.Length -ne [Convert]::ToInt64($pair.identity.bytes,` +
        `[Globalization.CultureInfo]::InvariantCulture)-or(Get-MyspeedBaselineSha $stream)-cne $pair.identity.sha256){` +
        `throw 'Baseline input cleanup identity differs'}}finally{$stream.Dispose()}};` +
        `foreach($name in @('MySpeed.exe','fixture-bundle.json')){[IO.File]::Delete((Join-Path $Root $name))};` +
        `[IO.Directory]::Delete($Root,$false);return [pscustomobject]@{cleanupProven=(-not[IO.Directory]::Exists($Root))}}\r\n` +
        `function Initialize-MyspeedBaselineJobType{if(-not('MySpeed.Qualification.BaselineJob'-as[type])){` +
        `Add-Type -TypeDefinition $BASELINE_JOB_SOURCE -Language CSharp}}\r\n` +
        `function Read-MyspeedBaselineDiagnostic([string]$Path,[int64]$Maximum,[switch]$AllowEmpty){` +
        `if(-not[IO.File]::Exists($Path)){return $null};if(([IO.File]::GetAttributes($Path)-band` +
        `[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'Baseline diagnostic is a reparse point'};` +
        `$stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{` +
        `$length=$stream.Length;if($length -gt $Maximum -or (-not $AllowEmpty -and $length -lt 2)){` +
        `throw 'Baseline diagnostic size differs'};$bytes=[byte[]]::new([int]$length);$offset=0;while($offset-lt$bytes.Length){` +
        `$count=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($count-lt 1){throw 'Baseline diagnostic read was short'};` +
        /*
         * `,$bytes`, not `$bytes`: a bare byte[] is unrolled by the pipeline and reaches the caller as
         * Object[] (or a lone Byte, or nothing), which every later `-is [byte[]]` check then refuses.
         */
        `$offset+=$count};if($stream.Length-ne$length){throw 'Baseline diagnostic changed while reading'};return ,$bytes}` +
        `finally{$stream.Dispose()}}\r\n` +
        `function Get-MyspeedBaselineDiagnosticText([byte[]]$Bytes){if($null-eq$Bytes-or$Bytes.Length-eq 0){return $null};` +
        `try{$text=[Text.UTF8Encoding]::new($false,$true).GetString($Bytes)}catch{return $null};` +
        `$text=[regex]::Replace($text,'[\\x00-\\x1f\\x7f]+',' ').Trim();if($text.Length-gt` +
        `$BASELINE_MAX_FAILURE_CHARACTERS){$text=$text.Substring(0,$BASELINE_MAX_FAILURE_CHARACTERS)};` +
        `if($text.Length-eq 0){return $null};return $text}\r\n` +
        `function Throw-MyspeedBaselineExecutorFailure([string]$Message,[object[]]$Diagnostics,[string]$Context){` +
        `if($Context){$remaining=$BASELINE_MAX_FAILURE_CHARACTERS-[Math]::Min($Message.Length,$BASELINE_MAX_FAILURE_CHARACTERS);` +
        `if($remaining-gt 3){$Message=$Message+'; '+$Context.Substring(0,[Math]::Min($Context.Length,$remaining-2))}};` +
        `$exception=[InvalidOperationException]::new($Message);$exception.Data['MyspeedDiagnostics']=$Diagnostics;throw $exception}\r\n` +
        `function Invoke-MyspeedBaselineExecutor([string]$RuntimeRoot,[string]$Seed,` +
        `[scriptblock]$ResolveTaskRoot={Join-Path $env:SystemRoot ('Temp\\myspeed-baseline-executor-'+$EXPECTED_NONCE)},` +
        `[scriptblock]$Launch={param($Node,$Arguments,$Working,$Stdout,$Stderr)Initialize-MyspeedBaselineJobType;` +
        `[MySpeed.Qualification.BaselineJob]::Run($Node,[string[]]$Arguments,$Working,$Stdout,$Stderr,` +
        `[uint32]$BASELINE_EXECUTOR_TIMEOUT,[uint32]$BASELINE_EXECUTOR_CLEANUP_TIMEOUT,[uint32]$BASELINE_EXECUTOR_DRAIN_TIMEOUT)}){` +
        `$taskRoot=& $ResolveTaskRoot;if($taskRoot-isnot[string]-or-not[IO.Path]::IsPathRooted($taskRoot)-or` +
        `[IO.Path]::GetFullPath($taskRoot)-cne$taskRoot){throw 'Baseline executor root path differs'};` +
        `if([IO.Directory]::Exists($taskRoot)-or[IO.File]::Exists($taskRoot)){throw 'Baseline executor root is not fresh'};` +
        `$null=[IO.Directory]::CreateDirectory($taskRoot);$rootItem=Get-Item -LiteralPath $taskRoot -Force;` +
        `if(-not$rootItem.PSIsContainer-or($rootItem.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){` +
        `throw 'Baseline executor root differs'};$result=Join-Path $taskRoot 'result.json';` +
        `$stdout=Join-Path $taskRoot 'stdout';$stderr=Join-Path $taskRoot 'stderr';` +
        `$executor=Join-Path $RuntimeRoot 'scripts\\qualification\\windows-baseline-guest-executor.mjs';` +
        // The executor reads the seeded SQLite database through sqlite-check.mjs' node:sqlite import,
        // which prints a one-line ExperimentalWarning to stderr on the pinned runtime. The launch is
        // held to exactly empty stdout and stderr below, so that benign runtime warning would read as
        // a leak ('Baseline executor streams differ'). Suppress only that warning class here - a node
        // option before the script - and leave the empty-stream containment proof unchanged.
        `$arguments=@('--disable-warning=ExperimentalWarning',$executor,'--request',(Join-Path $Seed '${REQUEST_NAME}'),'--request-sha256',` +
        `$EXPECTED_REQUEST_SHA,'--execution',(Join-Path $Seed '${EXECUTION_NAME}'),'--execution-sha256',` +
        `$EXPECTED_EXECUTION_SHA,'--result',$result);$launchResult=$null;$primary=$null;` +
        `$diagnostics=[Collections.Generic.List[object]]::new();try{` +
        `try{$launchResult=& $Launch (Join-Path $Seed 'node.exe') $arguments $RuntimeRoot $stdout $stderr}catch{` +
        `$primary=[string]$_.Exception.Message};if($null-ne$launchResult){` +
        `if($launchResult.AssignedBeforeResume-ne$true-or$launchResult.Resumed-ne$true-or` +
        `$launchResult.ProcessTreeExitProven-ne$true-or$launchResult.HandlesClosed-ne$true){` +
        `$primary='Baseline executor containment proof differs'}elseif($launchResult.TimedOut-eq$true){` +
        `$primary='Baseline executor exceeded its deadline'}elseif($launchResult.Forced-eq$true){` +
        `$primary='Baseline executor left an owned descendant'}elseif($launchResult.ExitCode-isnot[int]-or` +
        `$launchResult.ExitCode-notin@(${SUCCESS_EXIT_CODE},${FAILURE_EXIT_CODE})){` +
        `$primary='Baseline executor exit differs'}};` +
        `$stdoutBytes=$null;$stderrBytes=$null;$bytes=$null;try{` +
        `$stdoutBytes=Read-MyspeedBaselineDiagnostic $stdout $BASELINE_MAX_STREAM_BYTES -AllowEmpty}catch{` +
        `if($null-eq$primary){$primary='Baseline executor stdout diagnostic differs'}};try{` +
        `$stderrBytes=Read-MyspeedBaselineDiagnostic $stderr $BASELINE_MAX_STREAM_BYTES -AllowEmpty}catch{` +
        `if($null-eq$primary){$primary='Baseline executor stderr diagnostic differs'}};try{` +
        `$bytes=Read-MyspeedBaselineDiagnostic $result $BASELINE_MAX_RESULT_BYTES}catch{` +
        `if($null-eq$primary){$primary='Baseline executor result diagnostic differs'}};` +
        `if($null-ne$stdoutBytes-and$stdoutBytes.Length-gt 0){$diagnostics.Add([pscustomobject]@{` +
        `name='baseline-executor.stdout';bytes=$stdoutBytes})};if($null-ne$stderrBytes-and$stderrBytes.Length-gt 0){` +
        `$diagnostics.Add([pscustomobject]@{name='baseline-executor.stderr';bytes=$stderrBytes})};` +
        `if($null-ne$bytes){$diagnostics.Add([pscustomobject]@{name='baseline-result.raw.json';bytes=$bytes})};` +
        `if($null-ne$primary){Throw-MyspeedBaselineExecutorFailure $primary $diagnostics ` +
        `(Get-MyspeedBaselineDiagnosticText $stderrBytes)};if(($null-ne$stdoutBytes-and$stdoutBytes.Length-ne 0)-or` +
        `($null-ne$stderrBytes-and$stderrBytes.Length-ne 0)){$streamContext=Get-MyspeedBaselineDiagnosticText $stderrBytes;` +
        // A benign Node runtime warning on stderr (an experimental feature, a deprecation) still trips
        // the empty-stream containment gate. Name that case explicitly so a future recurrence from a
        // new warning source is self-describing instead of hiding behind the generic "streams differ".
        `$streamMessage='Baseline executor streams differ';` +
        `if($streamContext-and$streamContext-match '^\\(node:\\d+\\)\\s+\\w+Warning:'){` +
        `$streamMessage='Baseline executor emitted a Node runtime warning on stderr'};` +
        `Throw-MyspeedBaselineExecutorFailure $streamMessage $diagnostics $streamContext};` +
        `try{$semantic=([Text.UTF8Encoding]::new($false,$true).GetString($bytes)|ConvertFrom-Json)}catch{` +
        `Throw-MyspeedBaselineExecutorFailure 'Baseline executor result is invalid' $diagnostics $null};` +
        `if($semantic.schemaVersion-ne 1-or$semantic.profile-cne$BASELINE_PROFILE-or` +
        `$semantic.status-notin@('observed','failed')-or$semantic.cleanupProven-isnot[bool]-or` +
        `($semantic.status-ceq'observed'-and($launchResult.ExitCode-ne${SUCCESS_EXIT_CODE}-or-not$semantic.cleanupProven))-or` +
        `($semantic.status-ceq'failed'-and$launchResult.ExitCode-ne${FAILURE_EXIT_CODE})){` +
        `Throw-MyspeedBaselineExecutorFailure 'Baseline executor result identity differs' $diagnostics $null};` +
        `return [pscustomobject]@{bytes=$bytes;status=[string]$semantic.status;diagnostics=@()}}catch{` +
        `if(-not$_.Exception.Data.Contains('MyspeedDiagnostics')){$_.Exception.Data['MyspeedDiagnostics']=$diagnostics.ToArray()};throw}}\r\n` +
        /*
         * Trimmed on both sides of the truncation. Sanitizing a message made only of control
         * characters collapses it to a single space, which is not empty, so the check below never
         * fired and a blank reason reached the record - the swallow by other means. Cutting at the
         * bound strands trailing spaces the same way.
         *
         * The guarantee this buys is bounded, and worth stating rather than implying: ASCII control
         * characters and whatever .NET counts as whitespace, which includes NBSP. A message made
         * only of zero-width format characters (U+200B, U+FEFF) would still pass, and nothing this
         * is called with - `Exception.Message` from the framework's own IO types - is made of those.
         */
        `function Get-MyspeedBoundedFailureText([string]$Text,[int]$Maximum){` +
        `$bounded=[regex]::Replace([string]$Text,'[\\x00-\\x1f\\x7f]+',' ').Trim();` +
        `if($bounded.Length-gt$Maximum){$bounded=$bounded.Substring(0,$Maximum).Trim()};` +
        `if($bounded.Length-eq 0){$bounded='unspecified failure'};return $bounded}\r\n` +
        /*
         * No mechanism can throw out of here: each one is wrapped, and its bounded reason becomes an
         * attempt record, because a thrown emitter would be the swallow all over again. Encoding the
         * payload is the one statement outside a try, and the call site still turns a throw from it
         * into an `invocation` record, so no path reaches the shutdown record saying nothing.
         *
         * Both mechanisms write the same `$payload`, built once before the loop: whichever transport
         * carries the line, the bytes on the wire are identical.
         *
         * The port names come from the same enumeration the mechanisms use, so an empty list is
         * itself the answer - it says Windows has no serial port to write to at all, and no amount
         * of retrying a write will change that.
         */
        `function ${COMPLETION_EMISSION_FUNCTION}([string]$Line,` +
        `[string]$PortName='${COMPLETION_SERIAL_PORT_NAME}',[string]$DevicePath='${COMPLETION_SERIAL_DEVICE}'){` +
        `$payload=[Text.ASCIIEncoding]::new().GetBytes($Line+"\`r\`n");$ports=@();` +
        `try{$ports=@([IO.Ports.SerialPort]::GetPortNames())}catch{$ports=@()};` +
        `if($ports.Count-gt ${MAX_COMPLETION_EMISSION_PORT_NAMES}){` +
        `$ports=@($ports[0..${MAX_COMPLETION_EMISSION_PORT_NAMES - 1}])};` +
        `$attempts=[Collections.Generic.List[object]]::new();$emitted=$false;` +
        `foreach($method in @('${COMPLETION_EMISSION_METHOD_PORT}','${COMPLETION_EMISSION_METHOD_HANDLE}')){` +
        `if($emitted){continue};$reason=$null;` +
        `try{if($method-ceq'${COMPLETION_EMISSION_METHOD_PORT}'){` +
        `$port=[IO.Ports.SerialPort]::new($PortName,${COMPLETION_SERIAL_BAUD_RATE},[IO.Ports.Parity]::None,` +
        `${COMPLETION_SERIAL_DATA_BITS},[IO.Ports.StopBits]::One);try{$port.Handshake=[IO.Ports.Handshake]::None;` +
        `$port.WriteTimeout=${COMPLETION_SERIAL_WRITE_TIMEOUT_MILLISECONDS};$port.Open();` +
        `$port.Write($payload,0,$payload.Length)}finally{$port.Dispose()}}else{` +
        `$stream=[IO.File]::Open($DevicePath,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::None);` +
        `try{$stream.Write($payload,0,$payload.Length);$stream.Flush()}finally{$stream.Dispose()}};$emitted=$true}catch{` +
        `$reason=Get-MyspeedBoundedFailureText $_.Exception.Message ${MAX_COMPLETION_EMISSION_FAILURE_CHARACTERS}};` +
        `$attempts.Add([ordered]@{method=$method;emitted=($null-eq$reason);failure=$reason})};` +
        `return [ordered]@{attempted=$true;emitted=$emitted;ports=@($ports);attempts=@($attempts.ToArray())}}\r\n` +
        `function Invoke-MyspeedBaselineBootstrap(` +
        `[scriptblock]$ObserveGuard={Get-MyspeedActualBaselineGuard},` +
        `[scriptblock]$ObserveOutputAuthority={Get-MyspeedBaselineOutputAuthority},` +
        `[scriptblock]$ResolveInputRoot={'C:\\Windows\\Temp\\myspeed-baseline-input-'+$EXPECTED_NONCE},` +
        `[scriptblock]$StageInputs={param($Seed,$Root)Install-MyspeedBaselineInputs $Seed $Root},` +
        `[scriptblock]$InstallRuntime={param($Seed,$Root). (Join-Path $Seed '${RUNTIME_INSTALLER_NAME}') -Mode Library;` +
        `Install-MyspeedBaselineRuntimeBundle (Join-Path $Seed '${RUNTIME_BUNDLE_NAME}') $EXPECTED_RUNTIME_SHA ` +
        `$EXPECTED_SOURCE_SHA $EXPECTED_NONCE $Root (Join-Path $env:SystemRoot 'Temp')},` +
        `[scriptblock]$LoadCpu={param($Seed). (Join-Path $Seed 'cpu-calibration.ps1') -LibraryMode;` +
        `New-MyspeedGuestNativeOperations},` +
        `[scriptblock]$StartExecutor={param($Root,$Seed)Invoke-MyspeedBaselineExecutor $Root $Seed},` +
        `[scriptblock]$RemoveRuntime={param($Root,$Seed). (Join-Path $Seed '${RUNTIME_INSTALLER_NAME}') -Mode Library;` +
        `Remove-MyspeedBaselineRuntimeBundle $EXPECTED_SOURCE_SHA ` +
        `$EXPECTED_NONCE $Root (Join-Path $env:SystemRoot 'Temp')},` +
        `[scriptblock]$RemoveInputs={param($Seed,$Root)Remove-MyspeedBaselineInputs $Seed $Root},` +
        `[scriptblock]$Publish={param($Path,$Bytes)Write-MyspeedExclusive $Path $Bytes},` +
        `[scriptblock]$EmitCompletion={param([string]$Line)${COMPLETION_EMISSION_FUNCTION} $Line},` +
        `[scriptblock]$Shutdown={Stop-Computer -Force}){` +
        `$failure=$null;$failureStage='guest-bootstrap';$boundary=$null;$publicationOutput=$null;` +
        `$cpuOperations=$null;$cpu=$null;$baselineBytes=$null;$baselineStatus='unavailable';$completionEmission=$null;` +
        `$diagnostics=@();$runtimeRoot=Join-Path $env:SystemRoot ('Temp\\myspeed-baseline-runtime-'+$EXPECTED_NONCE);` +
        `$inputRoot=$null;` +
        `$runtimeInstalled=$false;$inputCleanupRequired=$false;$modeChanged=$false;$previousMode=[uint32]0;` +
        `try{$failureStage='guard';$boundary=& $ObserveGuard;$publicationOutput=$boundary.output;` +
        `$failureStage='input-staging';$inputRoot=& $ResolveInputRoot;if($inputRoot-isnot[string]-or$inputRoot.Length-lt 1){` +
        `throw 'Baseline input root differs'};$inputs=& $StageInputs $boundary.seed $inputRoot;` +
        `if($inputs.installed -ne $true -or $inputs.root -cne $inputRoot){throw 'Baseline input staging differs'};` +
        `$inputCleanupRequired=$true;` +
        `$failureStage='runtime-installation';$runtime=& $InstallRuntime $boundary.seed $runtimeRoot;` +
        `if($runtime.installed -ne $true -or $runtime.root -cne $runtimeRoot){throw 'Baseline runtime installation differs'};` +
        `$runtimeInstalled=$true;$failureStage='cpu-loading';$cpuOperations=& $LoadCpu $boundary.seed;` +
        `$failureStage='error-mode-change';$previousMode=& $cpuOperations.SetErrorMode 3;` +
        `if($previousMode -isnot [uint32]){throw 'Previous error mode is invalid'};` +
        `$modeChanged=$true;$failureStage='evidence-collection';$cpu=& $cpuOperations.CollectEvidence $boundary.seed;` +
        /*
         * The collector publishes the CPU floor; the host parser additionally requires the two
         * post-setup observations, which only exist because the seed installs the shared activation
         * and the SetupComplete dispatcher ran this bootstrap after Windows finished installing.
         * Either observation failing must fail the run rather than publish a thinner envelope.
         */
        `$failureStage='activation-observation';$cpu.activation=& $cpuOperations.ObserveActivation;` +
        `$failureStage='system-tool-observation';$cpu.systemTools=& $cpuOperations.ObserveSystemTools;` +
        `$failureStage='executor-invocation';$executorResult=& $StartExecutor $runtimeRoot $boundary.seed;` +
        `if($executorResult.bytes-isnot[byte[]]-or$executorResult.status-notin@('observed','failed')-or` +
        `$executorResult.diagnostics-isnot[array]){throw 'Baseline executor return differs'};` +
        `$baselineBytes=$executorResult.bytes;$baselineStatus=[string]$executorResult.status;` +
        `if($baselineStatus-ceq'failed'){try{$baselineSemantic=[Text.UTF8Encoding]::new($false,$true).GetString(` +
        `$baselineBytes)|ConvertFrom-Json;$baselineFailure=[string]$baselineSemantic.failure}catch{` +
        `$baselineFailure='invalid failed result'};throw ('Baseline executor reported failure: '+$baselineFailure)}}` +
        `catch{$failure=$_;if($_.Exception.Data.Contains('MyspeedDiagnostics')){$diagnostics=@($_.Exception.Data['MyspeedDiagnostics'])}}` +
        `finally{try{if($runtimeInstalled){try{$cleanup=& $RemoveRuntime $runtimeRoot $boundary.seed;` +
        `if($cleanup.cleanupProven -ne $true){throw 'Baseline runtime cleanup is incomplete'}}catch{if($null -eq $failure){` +
        `$failure=$_;$failureStage='runtime-cleanup'}}};if($inputCleanupRequired){try{` +
        `$inputCleanup=& $RemoveInputs $boundary.seed $inputRoot;if($inputCleanup.cleanupProven -ne $true){` +
        `throw 'Baseline input cleanup is incomplete'}}catch{if($null -eq $failure){$failure=$_;` +
        `$failureStage='input-cleanup'}}}}finally{try{if($modeChanged){try{` +
        `$null=& $cpuOperations.SetErrorMode $previousMode}catch{if($null -eq $failure){$failure=$_;$failureStage='error-mode-restore'}}}}` +
        `finally{try{if($null-eq$publicationOutput){try{$publicationOutput=& $ObserveOutputAuthority}catch{}};` +
        `if($publicationOutput-is[string]-and$publicationOutput.Length-gt 0){if($null-eq$failure){` +
        `try{& $Publish (Join-Path $publicationOutput '${RESULT_NAME}') $baselineBytes;` +
        `$cpuBytes=[Text.UTF8Encoding]::new($false).GetBytes(($cpu|ConvertTo-Json -Compress -Depth 8));` +
        `& $Publish (Join-Path $publicationOutput '${CPU_RESULT_NAME}') $cpuBytes;` +
        `$completionDigest={param([byte[]]$Value)$completionStream=[IO.MemoryStream]::new($Value,$false);` +
        `try{Get-MyspeedBaselineSha $completionStream}finally{$completionStream.Dispose()}};` +
        `$completion=[ordered]@{schemaVersion=${COMPLETION_RECORD_SCHEMA_VERSION};kind='${COMPLETION_RECORD_KIND}';` +
        `nonce=$EXPECTED_NONCE;baseline=[ordered]@{bytes=[string]$baselineBytes.Length;sha256=(& $completionDigest $baselineBytes)};` +
        `cpu=[ordered]@{bytes=[string]$cpuBytes.Length;sha256=(& $completionDigest $cpuBytes)}};` +
        `$completionLine='${COMPLETION_RECORD_PREFIX} '+($completion|ConvertTo-Json -Compress -Depth 4);` +
        /*
         * An oversized line is still an outcome worth recording: `attempted:false` says the guest
         * never reached a port, which is a different failure from reaching one and being refused.
         */
        `if($completionLine.Length-le ${MAX_COMPLETION_RECORD_BYTES}){` +
        `try{$completionEmission=& $EmitCompletion $completionLine}catch{` +
        `$completionEmission=[ordered]@{attempted=$true;emitted=$false;ports=@();attempts=@([ordered]@{` +
        `method='${COMPLETION_EMISSION_METHOD_INVOCATION}';emitted=$false;` +
        `failure=(Get-MyspeedBoundedFailureText $_.Exception.Message ` +
        `${MAX_COMPLETION_EMISSION_FAILURE_CHARACTERS})})}}}else{` +
        `$completionEmission=[ordered]@{attempted=$false;emitted=$false;ports=@();attempts=@()}}` +
        `}catch{$failure=$_;$failureStage='publication'}};` +
        `if($null-ne$failure){if($baselineStatus-ceq'failed'-and$baselineBytes-is[byte[]]){` +
        `try{& $Publish (Join-Path $publicationOutput '${RESULT_NAME}') $baselineBytes}catch{}};` +
        `$retained=[Collections.Generic.List[string]]::new();foreach($diagnostic in @($diagnostics)){` +
        `if($diagnostic.name-notin@('baseline-result.raw.json','baseline-executor.stdout','baseline-executor.stderr')-or` +
        `$diagnostic.bytes-isnot[byte[]]){continue};$maximum=if($diagnostic.name-ceq'baseline-result.raw.json'){` +
        `$BASELINE_MAX_RESULT_BYTES}else{$BASELINE_MAX_STREAM_BYTES};if($diagnostic.bytes.Length-lt 1-or` +
        `$diagnostic.bytes.Length-gt$maximum){continue};try{& $Publish (Join-Path $publicationOutput $diagnostic.name) ` +
        `$diagnostic.bytes;$retained.Add([string]$diagnostic.name)}catch{}};` +
        `$message=[regex]::Replace([string]$failure.Exception.Message,'[\\x00-\\x1f\\x7f]+',' ');` +
        `if($message.Length -gt $BASELINE_MAX_FAILURE_CHARACTERS){` +
        `$message=$message.Substring(0,$BASELINE_MAX_FAILURE_CHARACTERS)};` +
        `if($message.Length -eq 0){$message='unspecified failure'};` +
        `$message=$failureStage+': '+$message;if($message.Length-gt$BASELINE_MAX_FAILURE_CHARACTERS){` +
        `$message=$message.Substring(0,$BASELINE_MAX_FAILURE_CHARACTERS)};` +
        `$record=[ordered]@{schemaVersion=1;status='failed';nonce=$EXPECTED_NONCE;stage='guest-bootstrap';failure=$message};` +
        `$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($record|ConvertTo-Json -Compress -Depth 4));` +
        `try{& $Publish (Join-Path $publicationOutput '${CPU_RESULT_NAME}') $bytes}catch{` +
        `try{& $Publish (Join-Path $publicationOutput 'bootstrap-failure.json') $bytes}catch{}}}}}` +
        /*
         * One marker, written only after the shutdown call has returned or thrown, on the output
         * volume the receipts already went to. A call that never returns leaves no marker; a call
         * that throws records its bounded message. Run 35273132053 stayed up for 41 minutes after
         * publishing its receipt and left nothing that said whether the call was even reached.
         */
        `finally{$shutdownOutcome='failed';$shutdownFailure=$null;try{& $Shutdown;$shutdownOutcome='returned'}catch{` +
        `$shutdownFailure=[string]$_.Exception.Message;if($null-eq$failure){$failure=$_;$failureStage='shutdown'}};` +
        `if($publicationOutput-is[string]-and$publicationOutput.Length-gt 0){try{` +
        `if($null-ne$shutdownFailure){$shutdownFailure=[regex]::Replace($shutdownFailure,'[\\x00-\\x1f\\x7f]+',' ');` +
        `if($shutdownFailure.Length-gt$BASELINE_MAX_FAILURE_CHARACTERS){` +
        `$shutdownFailure=$shutdownFailure.Substring(0,$BASELINE_MAX_FAILURE_CHARACTERS)}};` +
        `$shutdownRecord=[ordered]@{schemaVersion=${SHUTDOWN_OUTCOME_SCHEMA_VERSION};nonce=$EXPECTED_NONCE;` +
        `stage='${SHUTDOWN_STAGE}';outcome=$shutdownOutcome;failure=$shutdownFailure;` +
        `completionEmission=$completionEmission};& $Publish (Join-Path $publicationOutput '${SHUTDOWN_OUTCOME_NAME}') ` +
        `([Text.UTF8Encoding]::new($false).GetBytes((` +
        `$shutdownRecord|ConvertTo-Json -Compress -Depth ${SHUTDOWN_OUTCOME_JSON_DEPTH})))}catch{}}}}}};` +
        `if($null -ne $failure){throw $failure}}\r\n` +
        `if(-not $LibraryMode){Invoke-MyspeedBaselineBootstrap}\r\n`;
    return Buffer.from(script, "utf8");
}

export const WINDOWS_BASELINE_BOOTSTRAP_CONSTANTS = Object.freeze({CPU_RESULT_NAME, EXECUTOR_CLEANUP_TIMEOUT_MILLISECONDS,
    COMPLETION_RECORD_KIND, COMPLETION_RECORD_PREFIX, COMPLETION_RECORD_SCHEMA_VERSION,
    COMPLETION_SERIAL_DEVICE, COMPLETION_SERIAL_PORT_NAME, MAX_COMPLETION_RECORD_BYTES,
    COMPLETION_EMISSION_FUNCTION, COMPLETION_EMISSION_METHOD_HANDLE, COMPLETION_EMISSION_METHOD_INVOCATION,
    COMPLETION_EMISSION_METHOD_PORT, MAX_COMPLETION_EMISSION_FAILURE_CHARACTERS,
    MAX_COMPLETION_EMISSION_PORT_NAMES, SHUTDOWN_OUTCOME_SCHEMA_VERSION,
    EXECUTOR_DESCENDANT_DRAIN_MILLISECONDS, SHUTDOWN_OUTCOME_NAME, SHUTDOWN_STAGE,
    EXECUTOR_TIMEOUT_MILLISECONDS, MAX_CANDIDATE_BYTES, MAX_FAILURE_CHARACTERS, MAX_FIXTURE_BYTES, MAX_RESULT_BYTES,
    MAX_STREAM_BYTES, PROFILE, RESULT_NAME});

export const COMPLETION_RECORD_REJECTIONS = Object.freeze({
    payloadOversized: "payload-oversized",
    payloadMalformed: "payload-malformed",
    schemaDiffers: "schema-differs",
    kindDiffers: "kind-differs",
    nonceDiffers: "nonce-differs",
    keysDiffer: "keys-differ",
    identityDiffers: "identity-differs"
});

const COMPLETION_RECORD_KEYS = Object.freeze(["schemaVersion", "kind", "nonce", "baseline", "cpu"]);
const COMPLETION_IDENTITY_KEYS = Object.freeze(["bytes", "sha256"]);
const CANONICAL_BYTE_COUNT = /^[1-9][0-9]*$/u;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/u;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/u;

const refuse = reason => ({status: "invalid", reason});
const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const identityValued = value => typeof value.bytes === "string" && CANONICAL_BYTE_COUNT.test(value.bytes) &&
    typeof value.sha256 === "string" && LOWERCASE_SHA256.test(value.sha256);

/*
 * The host side of the record the guest emits above. A line that is not prefixed is not a marker
 * at all and is simply not ours (`null`); a prefixed line that fails any clause is a refusal, never
 * something to skip past, so a forged or corrupted marker cannot be mistaken for silence. Nothing
 * here decides whether the run passed: the two identities are claims, checked later against the
 * receipts actually extracted after QEMU is gone and strictly parsed there.
 */
export function parseCompletionRecord(line, nonce) {
    if (typeof line !== "string" || !line.startsWith(`${COMPLETION_RECORD_PREFIX} `)) return null;
    if (line.length > MAX_COMPLETION_RECORD_BYTES) return refuse(COMPLETION_RECORD_REJECTIONS.payloadOversized);
    if (!PRINTABLE_ASCII.test(line)) return refuse(COMPLETION_RECORD_REJECTIONS.payloadMalformed);
    let record = null;
    try { record = JSON.parse(line.slice(COMPLETION_RECORD_PREFIX.length + 1)); }
    catch { return refuse(COMPLETION_RECORD_REJECTIONS.payloadMalformed); }
    if (record === null || typeof record !== "object" || Array.isArray(record))
        return refuse(COMPLETION_RECORD_REJECTIONS.payloadMalformed);
    if (!exactKeys(record, COMPLETION_RECORD_KEYS)) return refuse(COMPLETION_RECORD_REJECTIONS.keysDiffer);
    if (record.schemaVersion !== COMPLETION_RECORD_SCHEMA_VERSION)
        return refuse(COMPLETION_RECORD_REJECTIONS.schemaDiffers);
    if (record.kind !== COMPLETION_RECORD_KIND) return refuse(COMPLETION_RECORD_REJECTIONS.kindDiffers);
    if (record.nonce !== nonce) return refuse(COMPLETION_RECORD_REJECTIONS.nonceDiffers);
    if (!exactKeys(record.baseline, COMPLETION_IDENTITY_KEYS) ||
        !exactKeys(record.cpu, COMPLETION_IDENTITY_KEYS)) return refuse(COMPLETION_RECORD_REJECTIONS.keysDiffer);
    if (!identityValued(record.baseline) || !identityValued(record.cpu))
        return refuse(COMPLETION_RECORD_REJECTIONS.identityDiffers);
    return {status: "valid", record: {nonce: record.nonce,
        baseline: {bytes: record.baseline.bytes, sha256: record.baseline.sha256},
        cpu: {bytes: record.cpu.bytes, sha256: record.cpu.sha256}}};
}
