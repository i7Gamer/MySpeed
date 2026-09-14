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
    public static BaselineJobResult Run(string executable,string[] arguments,string cwd,string stdoutPath,string stderrPath,uint timeout,uint cleanupTimeout){
      IntPtr job=IntPtr.Zero,input=IntPtr.Zero,output=IntPtr.Zero,error=IntPtr.Zero,list=IntPtr.Zero,values=IntPtr.Zero;PROCESS_INFORMATION pi=new PROCESS_INFORMATION();bool listInitialized=false,created=false,assigned=false,resumed=false,forced=false;Exception primary=null;int exitCode=0;bool timedOut=false,tree=false;
      try{
        SECURITY_ATTRIBUTES sa=new SECURITY_ATTRIBUTES();sa.nLength=(uint)Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));sa.bInheritHandle=true;
        input=CreateFile("NUL",GENERIC_READ,FILE_SHARE_READ,ref sa,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,IntPtr.Zero);output=CreateFile(stdoutPath,GENERIC_WRITE,FILE_SHARE_READ,ref sa,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,IntPtr.Zero);error=CreateFile(stderrPath,GENERIC_WRITE,FILE_SHARE_READ,ref sa,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,IntPtr.Zero);if(input.ToInt64()==-1||output.ToInt64()==-1||error.ToInt64()==-1)throw Error("CreateFile standard handle");
        job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw Error("CreateJobObject");EXTENDED_LIMIT limits=new EXTENDED_LIMIT();limits.basic.flags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;if(!SetInformationJobObject(job,JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,ref limits,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))))throw Error("SetInformationJobObject");EXTENDED_LIMIT observed=new EXTENDED_LIMIT();if(!QueryLimits(job,JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,ref observed,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT)),IntPtr.Zero)||observed.basic.flags!=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)throw new InvalidOperationException("Job limits differ");
        UIntPtr bytes=UIntPtr.Zero;bool queried=InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref bytes);int queryError=Marshal.GetLastWin32Error();ulong attributeBytes=bytes.ToUInt64();if(queried||queryError!=(int)ERROR_INSUFFICIENT_BUFFER||attributeBytes==0||attributeBytes>MAX_ATTRIBUTE_LIST_BYTES)throw new InvalidOperationException("Attribute-list size differs");list=Marshal.AllocHGlobal((int)attributeBytes);if(!InitializeProcThreadAttributeList(list,1,0,ref bytes))throw Error("InitializeProcThreadAttributeList");listInitialized=true;IntPtr[] inherited=new[]{input,output,error};values=Marshal.AllocHGlobal(IntPtr.Size*inherited.Length);Marshal.Copy(inherited,0,values,inherited.Length);if(!UpdateProcThreadAttribute(list,0,(UIntPtr)PROC_THREAD_ATTRIBUTE_HANDLE_LIST,values,(UIntPtr)(IntPtr.Size*inherited.Length),IntPtr.Zero,IntPtr.Zero))throw Error("UpdateProcThreadAttribute");
        STARTUPINFOEX startup=new STARTUPINFOEX();startup.StartupInfo.cb=(uint)Marshal.SizeOf(typeof(STARTUPINFOEX));startup.StartupInfo.dwFlags=STARTF_USESHOWWINDOW|STARTF_USESTDHANDLES;startup.StartupInfo.hStdInput=input;startup.StartupInfo.hStdOutput=output;startup.StartupInfo.hStdError=error;startup.lpAttributeList=list;StringBuilder command=new StringBuilder(Quote(executable));foreach(string argument in arguments)command.Append(' ').Append(Quote(argument));
        if(!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_NO_WINDOW|EXTENDED_STARTUPINFO_PRESENT,IntPtr.Zero,cwd,ref startup,out pi))throw Error("CreateProcessW");created=true;if(!AssignProcessToJobObject(job,pi.hProcess))throw Error("AssignProcessToJobObject");assigned=true;bool member;if(!IsProcessInJob(pi.hProcess,job,out member)||!member)throw Error("IsProcessInJob");if(ResumeThread(pi.hThread)==UInt32.MaxValue)throw Error("ResumeThread");resumed=true;
        List<Exception> launchCleanup=new List<Exception>();Close(ref pi.hThread,launchCleanup);Close(ref input,launchCleanup);Close(ref output,launchCleanup);Close(ref error,launchCleanup);if(listInitialized){DeleteProcThreadAttributeList(list);listInitialized=false;}if(list!=IntPtr.Zero){Marshal.FreeHGlobal(list);list=IntPtr.Zero;}if(values!=IntPtr.Zero){Marshal.FreeHGlobal(values);values=IntPtr.Zero;}if(launchCleanup.Count>0)throw new AggregateException("Launch handle cleanup failed",launchCleanup);
        uint wait=WaitForSingleObject(pi.hProcess,timeout);if(wait!=WAIT_OBJECT_0&&wait!=WAIT_TIMEOUT)throw Error("WaitForSingleObject");timedOut=wait==WAIT_TIMEOUT;if(timedOut||Active(job)!=0){forced=true;if(!TerminateJobObject(job,FAILURE_EXIT_CODE))throw Error("TerminateJobObject");}if(WaitForSingleObject(pi.hProcess,cleanupTimeout)!=WAIT_OBJECT_0||!WaitForZero(job,cleanupTimeout))throw new InvalidOperationException("Owned executor process tree cleanup is unproven");tree=true;if(!timedOut){uint code;if(!GetExitCodeProcess(pi.hProcess,out code))throw Error("GetExitCodeProcess");exitCode=unchecked((int)code);}else exitCode=(int)FAILURE_EXIT_CODE;
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
        `$offset+=$count};if($stream.Length-ne$length){throw 'Baseline diagnostic changed while reading'};return $bytes}` +
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
        `[uint32]$BASELINE_EXECUTOR_TIMEOUT,[uint32]$BASELINE_EXECUTOR_CLEANUP_TIMEOUT)}){` +
        `$taskRoot=& $ResolveTaskRoot;if($taskRoot-isnot[string]-or-not[IO.Path]::IsPathRooted($taskRoot)-or` +
        `[IO.Path]::GetFullPath($taskRoot)-cne$taskRoot){throw 'Baseline executor root path differs'};` +
        `if([IO.Directory]::Exists($taskRoot)-or[IO.File]::Exists($taskRoot)){throw 'Baseline executor root is not fresh'};` +
        `$null=[IO.Directory]::CreateDirectory($taskRoot);$rootItem=Get-Item -LiteralPath $taskRoot -Force;` +
        `if(-not$rootItem.PSIsContainer-or($rootItem.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){` +
        `throw 'Baseline executor root differs'};$result=Join-Path $taskRoot 'result.json';` +
        `$stdout=Join-Path $taskRoot 'stdout';$stderr=Join-Path $taskRoot 'stderr';` +
        `$executor=Join-Path $RuntimeRoot 'scripts\\qualification\\windows-baseline-guest-executor.mjs';` +
        `$arguments=@($executor,'--request',(Join-Path $Seed '${REQUEST_NAME}'),'--request-sha256',` +
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
        `($null-ne$stderrBytes-and$stderrBytes.Length-ne 0)){Throw-MyspeedBaselineExecutorFailure ` +
        `'Baseline executor streams differ' $diagnostics (Get-MyspeedBaselineDiagnosticText $stderrBytes)};` +
        `try{$semantic=([Text.UTF8Encoding]::new($false,$true).GetString($bytes)|ConvertFrom-Json)}catch{` +
        `Throw-MyspeedBaselineExecutorFailure 'Baseline executor result is invalid' $diagnostics $null};` +
        `if($semantic.schemaVersion-ne 1-or$semantic.profile-cne$BASELINE_PROFILE-or` +
        `$semantic.status-notin@('observed','failed')-or$semantic.cleanupProven-isnot[bool]-or` +
        `($semantic.status-ceq'observed'-and($launchResult.ExitCode-ne${SUCCESS_EXIT_CODE}-or-not$semantic.cleanupProven))-or` +
        `($semantic.status-ceq'failed'-and$launchResult.ExitCode-ne${FAILURE_EXIT_CODE})){` +
        `Throw-MyspeedBaselineExecutorFailure 'Baseline executor result identity differs' $diagnostics $null};` +
        `return [pscustomobject]@{bytes=$bytes;status=[string]$semantic.status;diagnostics=@()}}catch{` +
        `if(-not$_.Exception.Data.Contains('MyspeedDiagnostics')){$_.Exception.Data['MyspeedDiagnostics']=$diagnostics.ToArray()};throw}}\r\n` +
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
        `[scriptblock]$Shutdown={Stop-Computer -Force}){` +
        `$failure=$null;$failureStage='guest-bootstrap';$boundary=$null;$publicationOutput=$null;` +
        `$cpuOperations=$null;$cpu=$null;$baselineBytes=$null;$baselineStatus='unavailable';` +
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
        `& $Publish (Join-Path $publicationOutput '${CPU_RESULT_NAME}') $cpuBytes}catch{$failure=$_;$failureStage='publication'}};` +
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
        `finally{try{& $Shutdown}catch{if($null-eq$failure){$failure=$_;$failureStage='shutdown'}}}}}};` +
        `if($null -ne $failure){throw $failure}}\r\n` +
        `if(-not $LibraryMode){Invoke-MyspeedBaselineBootstrap}\r\n`;
    return Buffer.from(script, "utf8");
}

export const WINDOWS_BASELINE_BOOTSTRAP_CONSTANTS = Object.freeze({CPU_RESULT_NAME, EXECUTOR_CLEANUP_TIMEOUT_MILLISECONDS,
    EXECUTOR_TIMEOUT_MILLISECONDS, MAX_CANDIDATE_BYTES, MAX_FAILURE_CHARACTERS, MAX_FIXTURE_BYTES, MAX_RESULT_BYTES,
    MAX_STREAM_BYTES, PROFILE, RESULT_NAME});
