[CmdletBinding()]
param(
    [ValidateSet('Library','GetContract','ValidateRequest','ValidateRecoveryRequest','ValidateRecoveryCancel','ValidateProofResult','ValidateCandidateIdentity','TestLifecycle','TestRecoveryCancellation','TestBinaryIdentity','TestObservationCore','TestEntryDiagnostic','ObserveOffline','ObserveListener','ObserveCandidateIdentity','InvokeHostedProof','InvokeRestoration')]
    [string]$Mode='Library',
    [string]$InputJson='',
    [string]$RequestPath='',
    [string]$ExpectedRequestSha256='',
    [string]$ExpectedRunId='',
    [string]$ExpectedRunAttempt='',
    [string]$ExpectedEventSha='',
    [string]$ExpectedSourceSha='',
    [string]$ExpectedImageVersion='',
    [string]$Nonce=''
)

Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$script:Repository='i7Gamer/MySpeed'
$script:ImageOS='win25-vs2026'
$script:ExpectedSystemSid='S-1-5-18'
$script:InjectedKind='myspeed-windows-native-standalone-host-injected'
$script:RequestKind='myspeed-windows-native-standalone-host-request'
$script:ResultKind='myspeed-windows-native-standalone-host-result'
$script:MaximumJsonBytes=262144
$script:MaximumFailureCharacters=512
$script:MaximumSourceBytes=2097152
$script:MaximumCoordinatorBytes=134217728
$script:MaximumCandidateBytes=268435456
$script:NormalDeadlineMilliseconds=600000
$script:HardDeadlineMilliseconds=610000
$script:RecoveryPollMilliseconds=50
$script:RecoveryOperationTimeoutMilliseconds=10000
$script:ExpectedPhases=@('arm-recovery','disable-adapters','launch-coordinator','wait-coordinator','prove-job-zero',
    'restore-adapters','disarm-recovery','cleanup')

function Assert-MyspeedStandaloneKeys {
    param([object]$Value,[string[]]$Names,[string]$Label)
    if($null -eq $Value -or $Value -isnot [psobject]){throw "$Label must be an object"}
    $actual=[string[]]@($Value.PSObject.Properties.Name)
    if($actual.Count -ne $Names.Count){throw "$Label keys differ"}
    foreach($name in $Names){if($actual -cnotcontains $name){throw "$Label keys differ"}}
}

function Assert-MyspeedStandaloneString {
    param([object]$Value,[string]$Label,[string]$Pattern='\A[^\x00-\x1f\x7f]{1,512}\z')
    if($Value -isnot [string]){throw "$Label must be a string"}
    $match=[regex]::Match($Value,$Pattern,[Text.RegularExpressions.RegexOptions]::CultureInvariant)
    if(-not $match.Success -or $match.Index -ne 0 -or $match.Length -ne $Value.Length){throw "$Label differs"}
    return [string]$Value
}

function Assert-MyspeedStandaloneInteger {
    param([object]$Value,[string]$Label,[int64]$Minimum,[int64]$Maximum)
    if(($null -ne $Value -and $Value.GetType().IsArray) -or $Value -isnot [ValueType] -or $Value -is [bool] -or
        $Value -is [single] -or $Value -is [double] -or $Value -is [decimal]){throw "$Label must be an integer"}
    try{$number=[int64]$Value}catch{throw "$Label must be an integer"}
    if($number -lt $Minimum -or $number -gt $Maximum){throw "$Label is outside its bound"}
    return $number
}

function ConvertFrom-MyspeedStandaloneJson {
    param([string]$Json,[string]$Label)
    if([Text.Encoding]::UTF8.GetByteCount($Json) -gt $script:MaximumJsonBytes){throw "$Label exceeds its byte bound"}
    try{return $Json|ConvertFrom-Json}catch{throw "$Label is not valid JSON"}
}

function Get-MyspeedStandaloneSha256 {
    param([byte[]]$Bytes)
    $algorithm=[Security.Cryptography.SHA256]::Create()
    try{return [BitConverter]::ToString($algorithm.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant()}
    finally{$algorithm.Dispose()}
}

function Read-MyspeedStandaloneBytes {
    param([string]$Path,[int64]$Maximum,[string]$ExpectedSha256='')
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{
        if($stream.Length -lt 2 -or $stream.Length -gt $Maximum){throw 'Standalone input size differs'}
        $bytes=New-Object byte[] ([int]$stream.Length);$offset=0
        while($offset -lt $bytes.Length){$read=$stream.Read($bytes,$offset,$bytes.Length-$offset)
            if($read -eq 0){throw 'Standalone input read was short'};$offset+=$read}
    }finally{$stream.Dispose()}
    $sha=Get-MyspeedStandaloneSha256 $bytes
    if($ExpectedSha256 -and $sha -cne $ExpectedSha256){throw 'Standalone input SHA differs'}
    return [pscustomobject]@{bytes=$bytes;sha256=$sha}
}

function Get-MyspeedStandaloneFileIdentity {
    param([string]$Path,[int64]$Maximum,[string]$ExpectedSha256='')
    $canonical=Assert-MyspeedStandalonePath $Path 'Standalone identity path'
    $stream=[IO.File]::Open($canonical,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $algorithm=[Security.Cryptography.SHA256]::Create()
    try{
        $before=$stream.Length
        if($before -lt 1 -or $before -gt $Maximum){throw 'Standalone identity size differs'}
        $hash=[BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant()
        if($stream.Length -ne $before -or $stream.Position -ne $before){throw 'Standalone identity changed while hashing'}
    }finally{$algorithm.Dispose();$stream.Dispose()}
    if($ExpectedSha256 -and $hash -cne $ExpectedSha256){throw 'Standalone identity SHA differs'}
    return [pscustomobject][ordered]@{path=$canonical;bytes=$before.ToString();sha256=$hash}
}

function Read-MyspeedStandaloneJsonFile {
    param([string]$Path,[string]$ExpectedSha256='')
    $loaded=Read-MyspeedStandaloneBytes $Path $script:MaximumJsonBytes $ExpectedSha256
    $json=[Text.UTF8Encoding]::new($false,$true).GetString($loaded.bytes)
    return [pscustomobject]@{value=ConvertFrom-MyspeedStandaloneJson $json 'Standalone JSON';sha256=$loaded.sha256
        bytesBase64=[Convert]::ToBase64String($loaded.bytes)}
}

function Invoke-MyspeedStandaloneModuleCommand {
    param([object]$Module,[string]$Command,[object[]]$Arguments=@())
    $call=[pscustomobject]@{name=$Command;arguments=$Arguments}
    return & $Module {param($request)$moduleArguments=[object[]]$request.arguments;& $request.name @moduleArguments} $call
}

function Assert-MyspeedStandalonePath {
    param([object]$Value,[string]$Label)
    $path=Assert-MyspeedStandaloneString $Value $Label '\A[A-Za-z]:\\[^\x00-\x1f\x7f]{1,1020}\z'
    try{$full=[IO.Path]::GetFullPath($path)}catch{throw "$Label is not an absolute canonical path"}
    if($full -cne $path){throw "$Label is not an absolute canonical path"}
    return $full
}

function Assert-MyspeedStandaloneCandidateIdentityRequest {
    param([object]$Request)
    Assert-MyspeedStandaloneKeys $Request @('path','allowedRoot','expectedSha256') 'Candidate identity request'
    $path=Assert-MyspeedStandalonePath $Request.path 'Candidate identity path'
    $root=Assert-MyspeedStandalonePath $Request.allowedRoot 'Candidate identity root'
    $prefix=$root.TrimEnd('\')+'\'
    if(-not $path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Candidate identity path is outside its root'}
    [void](Assert-MyspeedStandaloneString $Request.expectedSha256 'Candidate identity expected SHA' '\A[0-9a-f]{64}\z')
    return $Request
}

function Assert-MyspeedStandaloneCandidateIdentity {
    param([object]$Observation,[object]$Request)
    $checked=Assert-MyspeedStandaloneCandidateIdentityRequest $Request
    Assert-MyspeedStandaloneKeys $Observation @('path','bytes','sha256','volumeSerial','fileId','linkCount','reparsePoint') `
        'Candidate identity observation'
    if((Assert-MyspeedStandalonePath $Observation.path 'Candidate identity observed path') -cne $checked.path -or
        (Assert-MyspeedStandaloneString $Observation.sha256 'Candidate identity observed SHA' '\A[0-9a-f]{64}\z') -cne $checked.expectedSha256){
        throw 'Candidate identity observation differs'}
    [void](Assert-MyspeedStandaloneInteger $Observation.bytes 'Candidate identity bytes' 1 $script:MaximumCandidateBytes)
    [void](Assert-MyspeedStandaloneString $Observation.volumeSerial 'Candidate identity volume' '\A[0-9a-f]{8}\z')
    [void](Assert-MyspeedStandaloneString $Observation.fileId 'Candidate identity file ID' '\A[0-9a-f]{16}\z')
    if((Assert-MyspeedStandaloneInteger $Observation.linkCount 'Candidate identity link count' 1 4294967295) -ne 1 -or
        $Observation.reparsePoint -isnot [bool] -or $Observation.reparsePoint){throw 'Candidate identity is not an ordinary owned file'}
    return $Observation
}

function Assert-MyspeedStandaloneHostRequest {
    param([object]$Request)
    $names=@('schemaVersion','kind','expectedRunId','expectedRunAttempt','expectedEventSha','expectedSourceSha',
        'expectedImageVersion','nonce','manifestSha256','taskRoot','hostPath','hostSha256','canaryPath','canarySha256',
        'coordinatorExecutablePath','coordinatorExecutableSha256','coordinatorModuleSha256','proofRequestSha256','proofResultPath','coordinatorArguments','workingDirectory','resultPath','entryDiagnosticPath',
        'recoveryRequestPath','recoveryReadyPath','recoveryResultPath','cancelPath','lockPath','jobName','taskName',
        'normalDeadlineMs','hardDeadlineMs')
    Assert-MyspeedStandaloneKeys $Request $names 'Hosted proof request'
    [void](Assert-MyspeedStandaloneInteger $Request.schemaVersion 'Hosted proof schema' 1 1)
    if((Assert-MyspeedStandaloneString $Request.kind 'Hosted proof kind') -cne $script:RequestKind){throw 'Hosted proof kind differs'}
    [void](Assert-MyspeedStandaloneString $Request.expectedRunId 'Hosted proof run ID' '\A[1-9][0-9]{0,19}\z')
    [void](Assert-MyspeedStandaloneString $Request.expectedRunAttempt 'Hosted proof run attempt' '\A[1-9][0-9]{0,9}\z')
    [void](Assert-MyspeedStandaloneString $Request.expectedEventSha 'Hosted proof event SHA' '\A[0-9a-f]{40}\z')
    [void](Assert-MyspeedStandaloneString $Request.expectedSourceSha 'Hosted proof source SHA' '\A[0-9a-f]{40}\z')
    [void](Assert-MyspeedStandaloneString $Request.expectedImageVersion 'Hosted proof image version' '\A[0-9A-Za-z._-]{1,64}\z')
    $nonce=Assert-MyspeedStandaloneString $Request.nonce 'Hosted proof nonce' '\A[0-9a-f]{32}\z'
    foreach($name in @('manifestSha256','hostSha256','canarySha256','coordinatorExecutableSha256','coordinatorModuleSha256','proofRequestSha256')){
        [void](Assert-MyspeedStandaloneString $Request.$name "Hosted proof $name" '\A[0-9a-f]{64}\z')}
    $taskRoot=Assert-MyspeedStandalonePath $Request.taskRoot 'Hosted proof task root'
    foreach($name in @('hostPath','canaryPath','coordinatorExecutablePath','proofResultPath','workingDirectory','resultPath','entryDiagnosticPath',
        'recoveryRequestPath','recoveryReadyPath','recoveryResultPath','cancelPath','lockPath')){
        [void](Assert-MyspeedStandalonePath $Request.$name "Hosted proof $name")}
    if($Request.workingDirectory -cne $taskRoot){throw 'Hosted proof working directory differs'}
    if($Request.proofResultPath -cne [IO.Path]::GetFullPath((Join-Path $taskRoot 'proof.result.json'))){throw 'Hosted proof coordinator result differs'}
    $owned=[ordered]@{resultPath='host.result.json';entryDiagnosticPath='host.entry-failure.json';recoveryRequestPath='recovery.request.json';
        recoveryReadyPath='recovery.ready.json';recoveryResultPath='recovery.result.json';
        cancelPath='recovery.cancel';lockPath='recovery.lock'}
    foreach($entry in $owned.GetEnumerator()){
        $expected=[IO.Path]::GetFullPath((Join-Path $taskRoot $entry.Value))
        if($Request.($entry.Key) -cne $expected){throw "Hosted proof $($entry.Key) differs"}}
    $ownedPaths=[string[]]@($owned.Keys|ForEach-Object{$Request.$_})
    if(@($ownedPaths|Sort-Object -Unique).Count -ne $ownedPaths.Count){throw 'Hosted proof owned paths collide'}
    if($Request.coordinatorArguments -isnot [object[]] -or $Request.coordinatorArguments.Count -ne 5){throw 'Hosted proof coordinator arguments differ'}
    $proofModule=Assert-MyspeedStandalonePath $Request.coordinatorArguments[0] 'Hosted proof coordinator module'
    if((Assert-MyspeedStandaloneString $Request.coordinatorArguments[1] 'Hosted proof request switch') -cne '--request'){throw 'Hosted proof request switch differs'}
    $proofRequest=Assert-MyspeedStandalonePath $Request.coordinatorArguments[2] 'Hosted proof coordinator request'
    if($proofRequest -cne [IO.Path]::GetFullPath((Join-Path $taskRoot 'proof.request.json'))){throw 'Hosted proof coordinator request differs'}
    if((Assert-MyspeedStandaloneString $Request.coordinatorArguments[3] 'Hosted proof SHA switch') -cne '--sha256' -or
        (Assert-MyspeedStandaloneString $Request.coordinatorArguments[4] 'Hosted proof request SHA' '\A[0-9a-f]{64}\z') -cne $Request.proofRequestSha256){
        throw 'Hosted proof request SHA binding differs'}
    if([IO.Path]::GetExtension($proofModule) -cne '.mjs'){throw 'Hosted proof coordinator module differs'}
    if($Request.jobName -cne "Global\MySpeedStandaloneJob-$nonce"){throw 'Hosted proof Job name differs'}
    if($Request.taskName -cne "MySpeedStandaloneRecovery-$nonce"){throw 'Hosted proof recovery task name differs'}
    [void](Assert-MyspeedStandaloneInteger $Request.normalDeadlineMs 'Hosted proof normal deadline' $script:NormalDeadlineMilliseconds $script:NormalDeadlineMilliseconds)
    [void](Assert-MyspeedStandaloneInteger $Request.hardDeadlineMs 'Hosted proof hard deadline' $script:HardDeadlineMilliseconds $script:HardDeadlineMilliseconds)
    return $Request
}

function Invoke-MyspeedStandaloneLifecycleCore {
    param([object]$Request,[object]$Operations)
    Assert-MyspeedStandaloneKeys $Request @('schemaVersion','kind','phases','failAt','jobActiveAfterCoordinator','coordinatorExitCode') 'Injected host request'
    [void](Assert-MyspeedStandaloneInteger $Request.schemaVersion 'Injected host schema' 1 1)
    if((Assert-MyspeedStandaloneString $Request.kind 'Injected host kind') -cne $script:InjectedKind){throw 'Injected host kind differs'}
    if($Request.phases -isnot [object[]] -or $Request.phases.Count -ne $script:ExpectedPhases.Count){throw 'Injected host phases differ'}
    for($index=0;$index -lt $script:ExpectedPhases.Count;$index++){
        if((Assert-MyspeedStandaloneString $Request.phases[$index] 'Injected host phase' '\A[a-z][a-z-]{0,31}\z') -cne $script:ExpectedPhases[$index]){throw 'Injected host phase order differs'}}
    if($null -ne $Request.failAt -and (Assert-MyspeedStandaloneString $Request.failAt 'Injected failure phase' '\A[a-z][a-z-]{0,31}\z') -cnotin $script:ExpectedPhases){throw 'Injected failure phase differs'}
    [void](Assert-MyspeedStandaloneInteger $Request.jobActiveAfterCoordinator 'Injected active Job count' 0 4294967295)
    [void](Assert-MyspeedStandaloneInteger $Request.coordinatorExitCode 'Injected coordinator exit' 0 4294967295)
    Assert-MyspeedStandaloneKeys $Operations $script:ExpectedPhases 'Host lifecycle operations'
    foreach($phase in $script:ExpectedPhases){if($Operations.$phase -isnot [scriptblock]){throw "Host lifecycle operation is absent: $phase"}}
    $events=[Collections.Generic.List[string]]::new();$failures=[Collections.Generic.List[string]]::new()
    $jobZero=$false;$restored=$false;$armed=$false;$disabled=$false
    try{
        foreach($phase in $script:ExpectedPhases[0..4]){
            [void]$events.Add($phase);& $Operations.$phase
            if($phase -ceq 'arm-recovery'){$armed=$true}elseif($phase -ceq 'disable-adapters'){$disabled=$true}elseif($phase -ceq 'prove-job-zero'){$jobZero=$true}
        }
        if(-not $jobZero){throw 'Owned Job zero proof is absent before restoration'}
        if([int64]$Request.coordinatorExitCode -ne 0){throw 'Standalone coordinator exit differs'}
        if([int64]$Request.coordinatorExitCode -ne 0){throw 'Standalone coordinator failed'}
        [void]$events.Add('restore-adapters');& $Operations.'restore-adapters';$restored=$true;$disabled=$false
        [void]$events.Add('disarm-recovery');& $Operations.'disarm-recovery';$armed=$false
    }catch{[void]$failures.Add('host-lifecycle-failed')}
    finally{
        if($disabled -and $jobZero){try{if(-not $restored){[void]$events.Add('restore-adapters');& $Operations.'restore-adapters';$restored=$true;$disabled=$false}}catch{[void]$failures.Add('adapter-restoration-failed')}}
        try{[void]$events.Add('cleanup');& $Operations.cleanup}catch{[void]$failures.Add('host-cleanup-failed')}
    }
    $passed=$failures.Count -eq 0 -and $jobZero -and $restored -and -not $armed
    return [pscustomobject][ordered]@{schemaVersion=1;kind=$script:ResultKind;status=if($passed){'completed'}else{'failed'}
        qualifying=$false;releaseGatesCleared=@();jobZeroBeforeRestore=$jobZero;adaptersRestored=$restored
        events=@($events);failures=@($failures)}
}

function Invoke-MyspeedStandaloneInjectedLifecycle {
    param([object]$Request)
    $value=$Request
    $operations=[ordered]@{}
    foreach($phase in $script:ExpectedPhases){
        $phaseName=$phase
        $operations[$phase]={
            if($value.failAt -ceq $phaseName){throw "Injected failure: $phaseName"}
            if($phaseName -ceq 'wait-coordinator' -and [int64]$value.coordinatorExitCode -ne 0){throw 'Injected coordinator failed'}
            if($phaseName -ceq 'prove-job-zero' -and [int64]$value.jobActiveAfterCoordinator -ne 0){throw 'Injected owned Job retained processes'}
        }.GetNewClosure()
    }
    return Invoke-MyspeedStandaloneLifecycleCore $Request ([pscustomobject]$operations)
}

function Assert-MyspeedStandaloneInboxPowerShell {
    $expectedHost=[IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
    $actualHost=[IO.Path]::GetFullPath([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
    if(-not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -cne 'Desktop' -or
        $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or
        $actualHost -ine $expectedHost){throw 'Hosted context requires x64 inbox Windows PowerShell 5.1'}
}

function Assert-MyspeedStandaloneHostedContext {
    param([string]$RunId,[string]$RunAttempt,[string]$EventSha,[string]$SourceSha,[string]$ImageVersion,[string]$ExpectedNonce)
    $expected=@{GITHUB_ACTIONS='true';CI='true';GITHUB_REPOSITORY=$script:Repository;RUNNER_OS='Windows';RUNNER_ARCH='X64'
        RUNNER_ENVIRONMENT='github-hosted';ImageOS=$script:ImageOS;GITHUB_RUN_ID=$RunId;GITHUB_RUN_ATTEMPT=$RunAttempt
        GITHUB_SHA=$EventSha;ImageVersion=$ImageVersion}
    foreach($entry in $expected.GetEnumerator()){if([Environment]::GetEnvironmentVariable($entry.Key) -cne $entry.Value){throw "Hosted context $($entry.Key) differs"}}
    [void](Assert-MyspeedStandaloneString $SourceSha 'Hosted source SHA' '\A[0-9a-f]{40}\z')
    [void](Assert-MyspeedStandaloneString $ExpectedNonce 'Hosted nonce' '\A[0-9a-f]{32}\z')
    Assert-MyspeedStandaloneInboxPowerShell
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if($sid -ceq $script:ExpectedSystemSid){throw 'Hosted controller must not run as LocalSystem'}
}

function Assert-MyspeedStandaloneRestorationContext {
    param([string]$RunId,[string]$RunAttempt,[string]$EventSha,[string]$SourceSha,[string]$ImageVersion,[string]$ExpectedNonce)
    [void](Assert-MyspeedStandaloneString $RunId 'Restoration run ID' '\A[1-9][0-9]{0,19}\z')
    [void](Assert-MyspeedStandaloneString $RunAttempt 'Restoration run attempt' '\A[1-9][0-9]{0,9}\z')
    [void](Assert-MyspeedStandaloneString $EventSha 'Restoration event SHA' '\A[0-9a-f]{40}\z')
    [void](Assert-MyspeedStandaloneString $SourceSha 'Restoration source SHA' '\A[0-9a-f]{40}\z')
    [void](Assert-MyspeedStandaloneString $ImageVersion 'Restoration image version' '\A[0-9A-Za-z._-]{1,64}\z')
    [void](Assert-MyspeedStandaloneString $ExpectedNonce 'Restoration nonce' '\A[0-9a-f]{32}\z')
    Assert-MyspeedStandaloneInboxPowerShell
    if([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $script:ExpectedSystemSid){
        throw 'Restoration entry requires LocalSystem'}
}

function Get-MyspeedStandaloneNativeSource {
    return @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
public sealed class MySpeedStandaloneLaunchResult { public int ProcessId; public string CreationFileTime; public string ImagePath; public bool AssignedBeforeResume; public bool Resumed; }
public sealed class MySpeedStandaloneJobResult { public int ProcessId; public uint ExitCode; public uint ActiveProcesses; }
public sealed class MySpeedStandaloneAbi { public int SecurityAttributesSize,StartupInfoSize,ProcessInformationSize,FileTimeSize,BasicLimitSize,ExtendedLimitSize,AccountingSize,StartupInfoFlagsOffset,StartupInfoOutputOffset,SecurityDescriptorOffset; }
public sealed class MySpeedStandaloneFileIdentity { public string Path,Sha256,VolumeSerial,FileId; public long Bytes; public uint LinkCount; public bool ReparsePoint; }
public sealed class MySpeedStandaloneNamedJob : IDisposable {
  const uint CREATE_SUSPENDED=0x4,CREATE_NO_WINDOW=0x08000000,WAIT_OBJECT_0=0,WAIT_TIMEOUT=0x102;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x2000,JOB_OBJECT_QUERY=0x4,JOB_OBJECT_TERMINATE=0x8,SYNCHRONIZE=0x00100000;
  const int ERROR_ALREADY_EXISTS=183,JobObjectBasicAccountingInformation=1,JobObjectExtendedLimitInformation=9;
  const uint DEFAULT_CLEANUP_MILLISECONDS=10000;
  const int EXPECTED_SECURITY_ATTRIBUTES_SIZE=24,EXPECTED_STARTUPINFO_SIZE=104,EXPECTED_PROCESS_INFORMATION_SIZE=24,EXPECTED_FILETIME_SIZE=8;
  const int EXPECTED_BASIC_LIMIT_SIZE=64,EXPECTED_EXTENDED_LIMIT_SIZE=144,EXPECTED_ACCOUNTING_SIZE=48;
  const int EXPECTED_STARTUPINFO_FLAGS_OFFSET=60,EXPECTED_STARTUPINFO_OUTPUT_OFFSET=88,EXPECTED_SECURITY_DESCRIPTOR_OFFSET=8;
  const string JOB_SDDL="D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;OW)";
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public uint length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUPINFO { public uint cb; public string lpReserved,lpDesktop,lpTitle; public uint dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags; public ushort wShowWindow,cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint processId,threadId; }
  [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint low,high; }
  [StructLayout(LayoutKind.Sequential)] struct BY_HANDLE_FILE_INFORMATION { public uint attributes; public FILETIME creation,access,write; public uint volumeSerial,sizeHigh,sizeLow,linkCount,indexHigh,indexLow; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint flags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass,SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long TotalUserTime,TotalKernelTime,ThisPeriodTotalUserTime,ThisPeriodTotalKernelTime; public uint TotalPageFaultCount,TotalProcesses,ActiveProcesses,TotalTerminatedProcesses; }
  [DllImport("kernel32.dll",EntryPoint="CreateJobObjectW",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern IntPtr CreateJobObject(ref SECURITY_ATTRIBUTES attributes,string name);
  [DllImport("advapi32.dll",EntryPoint="ConvertStringSecurityDescriptorToSecurityDescriptorW",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern bool ConvertSddl(string sddl,uint revision,out IntPtr descriptor,out uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryUnbiasedInterruptTime(out ulong value);
  [DllImport("kernel32.dll",EntryPoint="OpenJobObjectW",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref EXTENDED_LIMIT info,uint length);
  [DllImport("kernel32.dll",EntryPoint="QueryInformationJobObject",SetLastError=true)] static extern bool QueryExtended(IntPtr job,int type,ref EXTENDED_LIMIT info,uint length,IntPtr returned);
  [DllImport("kernel32.dll",EntryPoint="QueryInformationJobObject",SetLastError=true)] static extern bool QueryAccounting(IntPtr job,int type,ref ACCOUNTING info,uint length,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out FILETIME creation,out FILETIME exit,out FILETIME kernel,out FILETIME user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file,out BY_HANDLE_FILE_INFORMATION info);
  [DllImport("kernel32.dll",EntryPoint="GetFinalPathNameByHandleW",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr file,StringBuilder path,uint size,uint flags);
  [DllImport("kernel32.dll",EntryPoint="QueryFullProcessImageNameW",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder path,ref uint size);
  [DllImport("kernel32.dll",EntryPoint="CreateProcessW",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint exitCode);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint exitCode);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint exitCode);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  IntPtr job=IntPtr.Zero,process=IntPtr.Zero,thread=IntPtr.Zero; bool assigned=false,resumed=false;uint processId=0;
  static Exception Error(string name){return new Win32Exception(Marshal.GetLastWin32Error(),name);}
  static int Size(Type value){return Marshal.SizeOf(value);} static int Offset(Type value,string field){return checked((int)Marshal.OffsetOf(value,field));}
  public static MySpeedStandaloneAbi ObserveAbi(){var value=new MySpeedStandaloneAbi{SecurityAttributesSize=Size(typeof(SECURITY_ATTRIBUTES)),StartupInfoSize=Size(typeof(STARTUPINFO)),ProcessInformationSize=Size(typeof(PROCESS_INFORMATION)),FileTimeSize=Size(typeof(FILETIME)),BasicLimitSize=Size(typeof(BASIC_LIMIT)),ExtendedLimitSize=Size(typeof(EXTENDED_LIMIT)),AccountingSize=Size(typeof(ACCOUNTING)),StartupInfoFlagsOffset=Offset(typeof(STARTUPINFO),"dwFlags"),StartupInfoOutputOffset=Offset(typeof(STARTUPINFO),"hStdOutput"),SecurityDescriptorOffset=Offset(typeof(SECURITY_ATTRIBUTES),"descriptor")};if(IntPtr.Size!=8||value.SecurityAttributesSize!=EXPECTED_SECURITY_ATTRIBUTES_SIZE||value.StartupInfoSize!=EXPECTED_STARTUPINFO_SIZE||value.ProcessInformationSize!=EXPECTED_PROCESS_INFORMATION_SIZE||value.FileTimeSize!=EXPECTED_FILETIME_SIZE||value.BasicLimitSize!=EXPECTED_BASIC_LIMIT_SIZE||value.ExtendedLimitSize!=EXPECTED_EXTENDED_LIMIT_SIZE||value.AccountingSize!=EXPECTED_ACCOUNTING_SIZE||value.StartupInfoFlagsOffset!=EXPECTED_STARTUPINFO_FLAGS_OFFSET||value.StartupInfoOutputOffset!=EXPECTED_STARTUPINFO_OUTPUT_OFFSET||value.SecurityDescriptorOffset!=EXPECTED_SECURITY_DESCRIPTOR_OFFSET)throw new InvalidOperationException("Standalone native ABI differs");return value;}
  public static MySpeedStandaloneFileIdentity InspectFile(string path,long maximumBytes){string canonical=Path.GetFullPath(path);using(var stream=new FileStream(canonical,FileMode.Open,FileAccess.Read,FileShare.Read)){long before=stream.Length;if(before<1||before>maximumBytes)throw new InvalidDataException("Candidate identity size differs");BY_HANDLE_FILE_INFORMATION info;if(!GetFileInformationByHandle(stream.SafeFileHandle.DangerousGetHandle(),out info))throw Error("GetFileInformationByHandle");const uint FILE_ATTRIBUTE_REPARSE_POINT=0x400,FILE_ATTRIBUTE_DIRECTORY=0x10;if((info.attributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY))!=0||info.linkCount!=1)throw new InvalidDataException("Candidate identity file kind differs");var finalBuffer=new StringBuilder(32768);uint finalLength=GetFinalPathNameByHandle(stream.SafeFileHandle.DangerousGetHandle(),finalBuffer,(uint)finalBuffer.Capacity,0);if(finalLength==0||finalLength>=finalBuffer.Capacity)throw Error("GetFinalPathNameByHandleW");string final=finalBuffer.ToString();if(final.StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase))final=@"\\"+final.Substring(8);else if(final.StartsWith(@"\\?\",StringComparison.OrdinalIgnoreCase))final=final.Substring(4);final=Path.GetFullPath(final);if(!String.Equals(canonical,final,StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Candidate identity final path differs");string digest;using(var algorithm=SHA256.Create())digest=BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-",String.Empty).ToLowerInvariant();if(stream.Length!=before||stream.Position!=before)throw new InvalidDataException("Candidate identity changed while hashing");return new MySpeedStandaloneFileIdentity{Path=canonical,Bytes=before,Sha256=digest,VolumeSerial=info.volumeSerial.ToString("x8"),FileId=info.indexHigh.ToString("x8")+info.indexLow.ToString("x8"),LinkCount=info.linkCount,ReparsePoint=false};}}
  static string Quote(string value){if(value.IndexOf('\0')>=0)throw new ArgumentException("NUL argument");var b=new StringBuilder("\"");int slash=0;foreach(char ch in value){if(ch=='\\'){slash++;continue;}if(ch=='\"'){b.Append('\\',slash*2+1).Append(ch);slash=0;continue;}if(slash>0){b.Append('\\',slash);slash=0;}b.Append(ch);}if(slash>0)b.Append('\\',slash*2);return b.Append('\"').ToString();}
  uint Active(){ACCOUNTING a=new ACCOUNTING();if(!QueryAccounting(job,JobObjectBasicAccountingInformation,ref a,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero))throw Error("QueryInformationJobObject");return a.ActiveProcesses;}
  private MySpeedStandaloneNamedJob(IntPtr existing){job=existing;EXTENDED_LIMIT observed=new EXTENDED_LIMIT();if(!QueryExtended(job,JobObjectExtendedLimitInformation,ref observed,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT)),IntPtr.Zero)||observed.basic.flags!=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)throw new InvalidOperationException("Opened Job limits differ");}
  public static MySpeedStandaloneNamedJob OpenExisting(string name){IntPtr handle=OpenJobObject(JOB_OBJECT_QUERY|JOB_OBJECT_TERMINATE|SYNCHRONIZE,false,name);if(handle==IntPtr.Zero)throw Error("OpenJobObjectW");try{return new MySpeedStandaloneNamedJob(handle);}catch{CloseHandle(handle);throw;}}
  public MySpeedStandaloneNamedJob(string name){IntPtr descriptor=IntPtr.Zero;Exception failure=null;try{uint size;if(!ConvertSddl(JOB_SDDL,1,out descriptor,out size))throw Error("ConvertStringSecurityDescriptorToSecurityDescriptorW");SECURITY_ATTRIBUTES attributes=new SECURITY_ATTRIBUTES{length=(uint)Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),descriptor=descriptor,inherit=false};job=CreateJobObject(ref attributes,name);int code=Marshal.GetLastWin32Error();if(job==IntPtr.Zero)throw Error("CreateJobObjectW");if(code==ERROR_ALREADY_EXISTS)throw new InvalidOperationException("Owned Job name already exists");EXTENDED_LIMIT limit=new EXTENDED_LIMIT();limit.basic.flags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,ref limit,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))))throw Error("SetInformationJobObject");EXTENDED_LIMIT observed=new EXTENDED_LIMIT();if(!QueryExtended(job,JobObjectExtendedLimitInformation,ref observed,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT)),IntPtr.Zero)||observed.basic.flags!=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)throw new InvalidOperationException("Created Job limits differ");}catch(Exception e){failure=e;}finally{if(descriptor!=IntPtr.Zero&&LocalFree(descriptor)!=IntPtr.Zero){Exception freeFailure=Error("LocalFree security descriptor");failure=failure==null?freeFailure:new AggregateException(failure,freeFailure);}}if(failure!=null){if(job!=IntPtr.Zero&&!CloseHandle(job))failure=new AggregateException(failure,Error("CloseHandle Job after construction failure"));job=IntPtr.Zero;throw failure;}}
  public MySpeedStandaloneLaunchResult Launch(string executable,string[] args,string cwd){var command=new StringBuilder(Quote(executable));foreach(string arg in args)command.Append(' ').Append(Quote(arg));STARTUPINFO si=new STARTUPINFO();si.cb=(uint)Marshal.SizeOf(typeof(STARTUPINFO));PROCESS_INFORMATION pi;if(!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,false,CREATE_SUSPENDED|CREATE_NO_WINDOW,IntPtr.Zero,cwd,ref si,out pi))throw Error("CreateProcessW");process=pi.process;thread=pi.thread;processId=pi.processId;Exception failure=null;try{if(!AssignProcessToJobObject(job,process))throw Error("AssignProcessToJobObject");assigned=true;FILETIME creation,exit,kernel,user;if(!GetProcessTimes(process,out creation,out exit,out kernel,out user))throw Error("GetProcessTimes");uint capacity=32768;var image=new StringBuilder((int)capacity);if(!QueryFullProcessImageName(process,0,image,ref capacity))throw Error("QueryFullProcessImageNameW");if(!String.Equals(image.ToString(),executable,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Coordinator image path differs");string creationText=(((ulong)creation.high<<32)|creation.low).ToString("x16");if(ResumeThread(thread)==UInt32.MaxValue)throw Error("ResumeThread");resumed=true;return new MySpeedStandaloneLaunchResult{ProcessId=(int)pi.processId,CreationFileTime=creationText,ImagePath=image.ToString(),AssignedBeforeResume=true,Resumed=true};}catch(Exception e){failure=e;if(!assigned){if(!TerminateProcess(process,1))failure=new AggregateException(failure,Error("TerminateProcess unassigned"));if(WaitForSingleObject(process,DEFAULT_CLEANUP_MILLISECONDS)!=WAIT_OBJECT_0)failure=new AggregateException(failure,new InvalidOperationException("Unassigned coordinator exit is unproven"));}throw failure;}finally{if(thread!=IntPtr.Zero){if(!CloseHandle(thread)&&failure==null)throw Error("CloseHandle thread");thread=IntPtr.Zero;}}}
  public MySpeedStandaloneJobResult Wait(uint timeout,uint cleanup){uint wait=WaitForSingleObject(process,timeout);if(wait==WAIT_TIMEOUT){if(!TerminateJobObject(job,1))throw Error("TerminateJobObject timeout");if(WaitForSingleObject(process,cleanup)!=WAIT_OBJECT_0)throw new InvalidOperationException("Coordinator exit after timeout is unproven");TerminateAndDrain(cleanup);}else if(wait!=WAIT_OBJECT_0)throw Error("WaitForSingleObject");uint exit;if(!GetExitCodeProcess(process,out exit))throw Error("GetExitCodeProcess");return new MySpeedStandaloneJobResult{ProcessId=(int)processId,ExitCode=exit,ActiveProcesses=Active()};}
  public uint ActiveProcesses { get { return Active(); } }
  public static ulong Clock100ns(){ulong value;if(!QueryUnbiasedInterruptTime(out value))throw Error("QueryUnbiasedInterruptTime");return value;}
  public void TerminateAndDrain(uint cleanup){if(Active()!=0&&!TerminateJobObject(job,1))throw Error("TerminateJobObject cleanup");var watch=System.Diagnostics.Stopwatch.StartNew();while(Active()!=0&&watch.ElapsedMilliseconds<cleanup)System.Threading.Thread.Sleep(10);if(Active()!=0)throw new InvalidOperationException("Owned Job tree exit is unproven");}
  public void Dispose(){Exception failure=null;try{if(job!=IntPtr.Zero&&Active()!=0)TerminateAndDrain(DEFAULT_CLEANUP_MILLISECONDS);}catch(Exception e){failure=e;}if(process!=IntPtr.Zero&&!assigned){if(!TerminateProcess(process,1)&&failure==null)failure=Error("TerminateProcess unassigned");if(WaitForSingleObject(process,DEFAULT_CLEANUP_MILLISECONDS)!=WAIT_OBJECT_0&&failure==null)failure=new InvalidOperationException("Unassigned coordinator exit is unproven");}if(thread!=IntPtr.Zero&&!CloseHandle(thread)&&failure==null)failure=Error("CloseHandle thread");if(process!=IntPtr.Zero&&!CloseHandle(process)&&failure==null)failure=Error("CloseHandle process");if(job!=IntPtr.Zero&&!CloseHandle(job)&&failure==null)failure=Error("CloseHandle job");job=process=thread=IntPtr.Zero;if(failure!=null)throw failure;}
}
'@
}

function Import-MyspeedStandaloneCanaryModule {
    param([string]$Path,[string]$Sha256)
    $loaded=Read-MyspeedStandaloneBytes (Assert-MyspeedStandalonePath $Path 'Standalone canary path') `
        $script:MaximumSourceBytes $Sha256
    $source=[Text.UTF8Encoding]::new($false,$true).GetString($loaded.bytes)
    $trusted=[scriptblock]::Create($source)
    return New-Module -ScriptBlock {
        param($scriptBlock)
        . $scriptBlock -Mode Library
        Export-ModuleMember -Function Get-MyspeedCanaryAdapterProviderSnapshot,New-MyspeedCanaryProviderProjectionOperations
    } -ArgumentList $trusted
}

function Invoke-MyspeedStandaloneOfflineObservationCore {
    param([object]$Request,[object]$Snapshot,[object[]]$IpState)
    Assert-MyspeedStandaloneKeys $Request @('schemaVersion','alias','scenario','phase','canaryPath','canarySha256') 'Offline observer request'
    [void](Assert-MyspeedStandaloneInteger $Request.schemaVersion 'Offline observer schema' 1 1)
    [void](Assert-MyspeedStandaloneString $Request.alias 'Offline observer alias' '\A(?:default|baseline)\z')
    if($null -ne $Request.scenario){[void](Assert-MyspeedStandaloneString $Request.scenario 'Offline observer scenario' '\A(?:populated-first-boot|populated-restart|fresh-no-config-reset)\z')}
    [void](Assert-MyspeedStandaloneString $Request.phase 'Offline observer phase' '\A(?:before-fixture|before-launch|after-stop)\z')
    [void](Assert-MyspeedStandalonePath $Request.canaryPath 'Offline observer canary path')
    [void](Assert-MyspeedStandaloneString $Request.canarySha256 'Offline observer canary SHA' '\A[0-9a-f]{64}\z')
    if($null -eq $Snapshot -or $Snapshot -isnot [psobject] -or $Snapshot.inventory -isnot [object[]]){
        throw 'Standalone offline adapter snapshot differs'}
        foreach($adapter in $Snapshot.inventory){
            if($adapter.loopback -isnot [bool] -or $adapter.enabled -isnot [bool]){
                throw 'Standalone offline adapter projection differs'}}
        foreach($entry in $IpState){
            [void](Assert-MyspeedStandaloneString $entry.kind 'Standalone offline IP kind' '\A(?:address|interface|route)\z')
            if($entry.loopback -isnot [bool] -or $entry.routable -isnot [bool]){
                throw 'Standalone offline IP projection differs'}}
        $kinds=[string[]]@($ipState.kind|Sort-Object -Unique)
        if(($kinds -join "`n") -cne (@('address','interface','route') -join "`n")){throw 'Standalone offline IP projection is incomplete'}
        $passed=@($Snapshot.inventory|Where-Object {-not $_.loopback -and $_.enabled}).Count -eq 0 -and
            @($ipState|Where-Object {-not $_.loopback -and $_.routable}).Count -eq 0
        $evidence=[pscustomobject][ordered]@{schemaVersion=1;providers=[pscustomobject][ordered]@{adapters=$true
                ipInterfaces=$true;ipAddresses=$true;routes=$true};adapters=[object[]]$Snapshot.inventory;ipState=$ipState}
        $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($evidence|ConvertTo-Json -Depth 20 -Compress))
        return [pscustomobject][ordered]@{boundarySha256=Get-MyspeedStandaloneSha256 $bytes
            boundaryBase64=[Convert]::ToBase64String($bytes);offlineBoundaryPassed=$passed}
}

function Get-MyspeedStandaloneOfflineObservation {
    param([object]$Request)
    Assert-MyspeedStandaloneHostedContext $ExpectedRunId $ExpectedRunAttempt $ExpectedEventSha $ExpectedSourceSha $ExpectedImageVersion $Nonce
    Import-Module NetAdapter -ErrorAction Stop;Import-Module NetTCPIP -ErrorAction Stop
    $module=Import-MyspeedStandaloneCanaryModule $Request.canaryPath $Request.canarySha256
    try{
        $rawAdapters=@(Get-NetAdapter -IncludeHidden -ErrorAction Stop)
        $snapshotArguments=New-Object object[] 1;$snapshotArguments[0]=$rawAdapters
        $snapshot=Invoke-MyspeedStandaloneModuleCommand $module 'Get-MyspeedCanaryAdapterProviderSnapshot' $snapshotArguments
        $provider=Invoke-MyspeedStandaloneModuleCommand $module 'New-MyspeedCanaryProviderProjectionOperations'
        [object[]]$ipState=& $provider.projectIpState ([object[]]$snapshot.inventory) `
            @(Get-NetIPInterface -IncludeAllCompartments -ErrorAction Stop) `
            @(Get-NetIPAddress -IncludeAllCompartments -ErrorAction Stop) `
            @(Get-NetRoute -IncludeAllCompartments -ErrorAction Stop)
        return Invoke-MyspeedStandaloneOfflineObservationCore $Request $snapshot $ipState
    }finally{Remove-Module $module -Force}
}

function Invoke-MyspeedStandaloneListenerObservationCore {
    param([object]$Request,[object[]]$Connections,[scriptblock]$ReadProcessIdentity)
    Assert-MyspeedStandaloneKeys $Request @('schemaVersion','mode','address','port','candidatePid','candidateCreationTime') 'Listener observer request'
    [void](Assert-MyspeedStandaloneInteger $Request.schemaVersion 'Listener observer schema' 1 1)
    $mode=Assert-MyspeedStandaloneString $Request.mode 'Listener observer mode' '\A(?:owned|absent)\z'
    if((Assert-MyspeedStandaloneString $Request.address 'Listener observer address') -cne '127.0.0.1'){throw 'Listener observer address differs'}
    $port=Assert-MyspeedStandaloneInteger $Request.port 'Listener observer port' 1 65535
    $pidValue=Assert-MyspeedStandaloneInteger $Request.candidatePid 'Listener observer PID' 1 4294967295
    $creation=Assert-MyspeedStandaloneString $Request.candidateCreationTime 'Listener observer creation time' '\A[0-9a-f]{16}\z'
    $listeners=[Collections.Generic.List[object]]::new()
    foreach($connection in $Connections){
        $connectionPort=Assert-MyspeedStandaloneInteger $connection.LocalPort 'Listener provider local port' 0 65535
        $owner=Assert-MyspeedStandaloneInteger $connection.OwningProcess 'Listener provider owner PID' 0 4294967295
        $address=Assert-MyspeedStandaloneString ([string]$connection.LocalAddress) 'Listener provider local address'
        $state=Assert-MyspeedStandaloneString ([string]$connection.State) 'Listener provider state' '\A[A-Za-z][A-Za-z0-9]{0,31}\z'
        if($state -ceq 'Listen' -and $connectionPort -eq $port -and $address -ceq $Request.address){
            [void]$listeners.Add([pscustomobject]@{OwningProcess=$owner})}
    }
    if($mode -ceq 'absent'){return [pscustomobject][ordered]@{listenerGone=($listeners.Count -eq 0)}}
    if($listeners.Count -ne 1 -or [int64]$listeners[0].OwningProcess -ne $pidValue){return [pscustomobject][ordered]@{listenerOwned=$false}}
    $processIdentity=& $ReadProcessIdentity $pidValue
    Assert-MyspeedStandaloneKeys $processIdentity @('exists','creationFileTime') 'Listener process identity'
    if($processIdentity.exists -isnot [bool]){throw 'Listener process existence proof differs'}
    if($processIdentity.exists){[void](Assert-MyspeedStandaloneString $processIdentity.creationFileTime `
            'Listener process creation time' '\A[0-9a-f]{16}\z')}
    elseif($null -ne $processIdentity.creationFileTime){throw 'Listener absent process identity differs'}
    $owned=$processIdentity.exists -eq $true -and $processIdentity.creationFileTime -ceq $creation
    return [pscustomobject][ordered]@{listenerOwned=$owned}
}

function Get-MyspeedStandaloneListenerObservation {
    param([object]$Request)
    Assert-MyspeedStandaloneHostedContext $ExpectedRunId $ExpectedRunAttempt $ExpectedEventSha $ExpectedSourceSha $ExpectedImageVersion $Nonce
    Import-Module NetTCPIP -ErrorAction Stop
    $connections=@(Get-NetTCPConnection -ErrorAction Stop)
    $readProcessIdentity={param([int64]$ProcessId)
        $process=Get-Process -Id ([int]$ProcessId) -ErrorAction SilentlyContinue
        return [pscustomobject][ordered]@{exists=($null -ne $process);creationFileTime=if($null -eq $process){$null}else{
            $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString('x16')}}
    }
    return Invoke-MyspeedStandaloneListenerObservationCore $Request $connections $readProcessIdentity
}

function Get-MyspeedStandaloneCandidateIdentityObservation {
    # The real hosted guard must precede JSON parsing and Add-Type so callers
    # cannot use a forged input object to reach native file handles locally.
    Assert-MyspeedStandaloneHostedContext $ExpectedRunId $ExpectedRunAttempt $ExpectedEventSha $ExpectedSourceSha $ExpectedImageVersion $Nonce
    $inputValue=ConvertFrom-MyspeedStandaloneJson $InputJson 'Candidate identity observation request'
    Assert-MyspeedStandaloneKeys $inputValue @('request') 'Candidate identity observation request'
    $request=Assert-MyspeedStandaloneCandidateIdentityRequest $inputValue.request
    Add-Type -TypeDefinition (Get-MyspeedStandaloneNativeSource) -Language CSharp
    $observed=[MySpeedStandaloneNamedJob]::InspectFile($request.path,$script:MaximumCandidateBytes)
    $value=[pscustomobject][ordered]@{path=$observed.Path;bytes=[int64]$observed.Bytes;sha256=$observed.Sha256
        volumeSerial=$observed.VolumeSerial;fileId=$observed.FileId;linkCount=[int64]$observed.LinkCount
        reparsePoint=[bool]$observed.ReparsePoint}
    return Assert-MyspeedStandaloneCandidateIdentity $value $request
}

function Write-MyspeedStandaloneCreateNewJson {
    param([string]$Path,[object]$Value)
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 20 -Compress))
    if($bytes.Length -lt 2 -or $bytes.Length -gt $script:MaximumJsonBytes){throw 'Standalone owned JSON size differs'}
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
    return Get-MyspeedStandaloneSha256 $bytes
}

function Enter-MyspeedStandaloneRecoveryLock {
    param([string]$Path)
    return [IO.File]::Open($Path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
}

function Get-MyspeedStandaloneAdapterSnapshot {
    param([object]$Module)
    $raw=@(Get-NetAdapter -IncludeHidden -ErrorAction Stop)
    $arguments=New-Object object[] 1;$arguments[0]=$raw
    return Invoke-MyspeedStandaloneModuleCommand $Module 'Get-MyspeedCanaryAdapterProviderSnapshot' $arguments
}

function Get-MyspeedStandaloneMatchedRawAdapters {
    param([object]$Snapshot,[object[]]$Targets,[bool]$RequireEnabled)
    $matched=[Collections.Generic.List[object]]::new()
    foreach($target in $Targets){
        $indexes=@(for($index=0;$index -lt $Snapshot.inventory.Count;$index++){
            $candidate=$Snapshot.inventory[$index]
            if($candidate.interfaceGuid -ieq $target.interfaceGuid -and
                [string]::Equals($candidate.netLuid,$target.netLuid,[StringComparison]::Ordinal) -and
                (-not $RequireEnabled -or $candidate.enabled)){$index}
        })
        if($indexes.Count -ne 1){throw 'Standalone adapter identity drifted'}
        [void]$matched.Add($Snapshot.raw[$indexes[0]])
    }
    return $matched
}

function Get-MyspeedStandaloneTargetProjection {
    param([object]$Snapshot,[object[]]$Targets,[bool]$ExpectedEnabled)
    $projected=[Collections.Generic.List[object]]::new()
    foreach($target in $Targets){
        $matches=@($Snapshot.inventory|Where-Object {$_.interfaceGuid -ieq $target.interfaceGuid -and
            [string]::Equals($_.netLuid,$target.netLuid,[StringComparison]::Ordinal)})
        if($matches.Count -ne 1 -or $matches[0].enabled -isnot [bool] -or $matches[0].enabled -ne $ExpectedEnabled){
            throw 'Standalone target adapter state differs'}
        [void]$projected.Add([pscustomobject][ordered]@{interfaceGuid=$target.interfaceGuid;netLuid=$target.netLuid
            enabled=$ExpectedEnabled})
    }
    return $projected
}

function Assert-MyspeedStandaloneRecoveryRequest {
    param([object]$Value)
    $names=@('schemaVersion','kind','expectedRunId','expectedRunAttempt','expectedEventSha','expectedSourceSha',
        'expectedImageVersion','nonce','hostPath','hostSha256','canaryPath','canarySha256','requestSha256','taskRoot',
        'jobName','taskName','recoveryRequestPath','recoveryReadyPath','recoveryResultPath','cancelPath','lockPath','watchdogDeadline100ns','adapters')
    Assert-MyspeedStandaloneKeys $Value $names 'Standalone recovery request'
    [void](Assert-MyspeedStandaloneInteger $Value.schemaVersion 'Standalone recovery schema' 1 1)
    if((Assert-MyspeedStandaloneString $Value.kind 'Standalone recovery kind') -cne 'myspeed-windows-native-standalone-recovery-request'){
        throw 'Standalone recovery kind differs'}
    [void](Assert-MyspeedStandaloneString $Value.expectedRunId 'Standalone recovery run ID' '\A[1-9][0-9]{0,19}\z')
    [void](Assert-MyspeedStandaloneString $Value.expectedRunAttempt 'Standalone recovery run attempt' '\A[1-9][0-9]{0,9}\z')
    [void](Assert-MyspeedStandaloneString $Value.expectedEventSha 'Standalone recovery event SHA' '\A[0-9a-f]{40}\z')
    [void](Assert-MyspeedStandaloneString $Value.expectedSourceSha 'Standalone recovery source SHA' '\A[0-9a-f]{40}\z')
    [void](Assert-MyspeedStandaloneString $Value.expectedImageVersion 'Standalone recovery image version' '\A[0-9A-Za-z._-]{1,64}\z')
    $nonce=Assert-MyspeedStandaloneString $Value.nonce 'Standalone recovery nonce' '\A[0-9a-f]{32}\z'
    foreach($name in @('hostSha256','canarySha256','requestSha256')){
        [void](Assert-MyspeedStandaloneString $Value.$name "Standalone recovery $name" '\A[0-9a-f]{64}\z')}
    foreach($name in @('hostPath','canaryPath','taskRoot','recoveryRequestPath','recoveryReadyPath','recoveryResultPath','cancelPath','lockPath')){
        [void](Assert-MyspeedStandalonePath $Value.$name "Standalone recovery $name")}
    if([IO.Path]::GetFileName($Value.taskRoot) -cne "myspeed-native-standalone-$nonce"){
        throw 'Standalone recovery task root differs'}
    $owned=[ordered]@{recoveryRequestPath='recovery.request.json';recoveryReadyPath='recovery.ready.json'
        recoveryResultPath='recovery.result.json';cancelPath='recovery.cancel';lockPath='recovery.lock'}
    foreach($entry in $owned.GetEnumerator()){
        $expected=[IO.Path]::GetFullPath((Join-Path $Value.taskRoot $entry.Value))
        if($Value.($entry.Key) -cne $expected){throw "Standalone recovery $($entry.Key) differs"}}
    if($Value.jobName -cne "Global\MySpeedStandaloneJob-$nonce"){throw 'Standalone recovery Job name differs'}
    if($Value.taskName -cne "MySpeedStandaloneRecovery-$nonce"){throw 'Standalone recovery task name differs'}
    [void](Assert-MyspeedStandaloneString $Value.watchdogDeadline100ns 'Standalone recovery deadline' '\A[1-9][0-9]{0,19}\z')
    if($Value.adapters -isnot [object[]] -or $Value.adapters.Count -lt 1 -or $Value.adapters.Count -gt 64){throw 'Standalone recovery adapters differ'}
    $guids=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $luids=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach($adapter in $Value.adapters){Assert-MyspeedStandaloneKeys $adapter @('interfaceGuid','netLuid') 'Standalone recovery adapter'
        $guid=Assert-MyspeedStandaloneString $adapter.interfaceGuid 'Standalone recovery adapter GUID' `
            '\A\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}\z'
        try{$canonical=([guid]$guid).ToString('B')}catch{throw 'Standalone recovery adapter GUID differs'}
        if($guid -cne $canonical){throw 'Standalone recovery adapter GUID is not canonical'}
        $luid=Assert-MyspeedStandaloneString $adapter.netLuid 'Standalone recovery adapter LUID' '\A[0-9a-f]{16}\z'
        if(-not $guids.Add($guid) -or -not $luids.Add($luid)){throw 'Standalone recovery adapter identity is duplicated'}}
    return $Value
}

function Assert-MyspeedStandaloneRecoveryCancel {
    param([object]$Value,[string]$ExpectedRequestSha256)
    Assert-MyspeedStandaloneKeys $Value @('schemaVersion','kind','requestSha256') 'Standalone recovery cancel'
    [void](Assert-MyspeedStandaloneInteger $Value.schemaVersion 'Standalone recovery cancel schema' 1 1)
    if((Assert-MyspeedStandaloneString $Value.kind 'Standalone recovery cancel kind') -cne
        'myspeed-windows-native-standalone-recovery-cancel'){throw 'Standalone recovery cancel kind differs'}
    $sha=Assert-MyspeedStandaloneString $Value.requestSha256 'Standalone recovery cancel request SHA' '\A[0-9a-f]{64}\z'
    if($sha -cne $ExpectedRequestSha256){throw 'Standalone recovery cancel request SHA differs'}
    return $Value
}

function Assert-MyspeedStandaloneProofResult {
    param([object]$Value,[object]$Request,[object]$ProofRequest)
    Assert-MyspeedStandaloneKeys $Value @('schemaVersion','kind','status','qualifying','manifestSha256','sourceSha',
        'eventSha','runId','runAttempt','imageVersion','nonce','qualificationSourceSha','qualificationRunId',
        'qualificationRunAttempt','qualificationManifestArtifactId','qualificationManifestArtifactDigest',
        'candidates','adapter','releaseGatesCleared') 'Standalone proof result'
    [void](Assert-MyspeedStandaloneInteger $Value.schemaVersion 'Standalone proof result schema' 1 1)
    if((Assert-MyspeedStandaloneString $Value.kind 'Standalone proof result kind') -cne
        'myspeed-windows-native-standalone-proof-result' -or $Value.status -cne 'completed' -or
        $Value.qualifying -ne $false -or $Value.adapter -isnot [psobject] -or $Value.candidates -isnot [object[]] -or
        $Value.releaseGatesCleared -isnot [object[]] -or $Value.releaseGatesCleared.Count -ne 0){
        throw 'Standalone proof result did not pass'}
    $bindings=[ordered]@{manifestSha256=$Request.manifestSha256;sourceSha=$Request.expectedSourceSha
        eventSha=$Request.expectedEventSha;runId=$Request.expectedRunId;runAttempt=$Request.expectedRunAttempt
        imageVersion=$Request.expectedImageVersion;nonce=$Request.nonce}
    foreach($entry in $bindings.GetEnumerator()){
        if($Value.($entry.Key) -cne $entry.Value){throw "Standalone proof result $($entry.Key) differs"}}
    foreach($name in @('qualificationSourceSha','qualificationRunId','qualificationRunAttempt')){
        if($ProofRequest.$name -isnot [string] -or $Value.$name -cne $ProofRequest.$name){
            throw "Standalone proof result $name differs"}}
    foreach($name in @('qualificationManifestArtifactId','qualificationManifestArtifactDigest')){
        if($ProofRequest.$name -isnot [string] -or $Value.$name -cne $ProofRequest.$name){
            throw "Standalone proof result $name differs"}}
    return $Value
}

function Write-MyspeedStandaloneEntryDiagnostic {
    param([string]$Path,[string]$Stage,[object]$Failure)
    $checkedPath=Assert-MyspeedStandalonePath $Path 'Standalone entry diagnostic path'
    $checkedStage=Assert-MyspeedStandaloneString $Stage 'Standalone entry diagnostic stage' '\A[a-z][a-z-]{0,31}\z'
    $message=if($Failure -is [Management.Automation.ErrorRecord]){[string]$Failure.Exception.Message}
        elseif($Failure -is [Exception]){[string]$Failure.Message}else{[string]$Failure}
    $message=[regex]::Replace($message,'[\x00-\x1f\x7f]+',' ')
    if($message.Length -gt $script:MaximumFailureCharacters){$message=$message.Substring(0,$script:MaximumFailureCharacters)}
    if(-not $message){$message='unspecified failure'}
    $record=[pscustomobject][ordered]@{schemaVersion=1;kind='myspeed-windows-native-standalone-entry-failure'
        status='failed';stage=$checkedStage;failure=$message}
    [void](Write-MyspeedStandaloneCreateNewJson $checkedPath $record)
    return $record
}

function Test-MyspeedStandaloneStableReadable {
    param([string]$Path)
    $win32CodeMask=65535
    $sharingViolationWin32Code=32
    $stream=$null
    try{$stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);return $true}
    catch [IO.IOException]{if(($_.Exception.HResult -band $win32CodeMask) -eq $sharingViolationWin32Code){return $false};throw}
    finally{if($null -ne $stream){$stream.Dispose()}}
}

function Read-MyspeedStandaloneRecoveryCancel {
    param([object]$Request,[string]$RecoveryRequestSha256)
    if(-not [IO.File]::Exists($Request.cancelPath)){return $null}
    if(-not (Test-MyspeedStandaloneStableReadable $Request.cancelPath)){return $null}
    return Assert-MyspeedStandaloneRecoveryCancel `
        (Read-MyspeedStandaloneJsonFile $Request.cancelPath).value $RecoveryRequestSha256
}

function Invoke-MyspeedStandaloneRecoveryCancellationCore {
    param([hashtable]$State,[object]$Operations)
    if($State.disableAttempted -and -not $State.adapterRestoreProven){throw 'Standalone recovery cancellation is unsafe'}
    Assert-MyspeedStandaloneKeys $Operations @('enterLock','recoveryResultExists','readCancel','writeCancel') `
        'Standalone recovery cancellation operations'
    foreach($name in @('enterLock','recoveryResultExists','readCancel','writeCancel')){
        if($Operations.$name -isnot [scriptblock]){throw "Standalone recovery cancellation operation is absent: $name"}}
    $lock=& $Operations.enterLock
    if($null -eq $lock){throw 'Standalone recovery cancellation lock is absent'}
    try{
        $recoveryResultPresent=& $Operations.recoveryResultExists
        if($recoveryResultPresent -isnot [bool]){throw 'Standalone emergency recovery presence must be Boolean'}
        if($recoveryResultPresent){
            throw 'Standalone emergency recovery already ran'}
        $loaded=& $Operations.readCancel
        if($null -eq $loaded){& $Operations.writeCancel;$loaded=& $Operations.readCancel}
        if($null -eq $loaded){throw 'Standalone recovery cancellation is absent after publication'}
        Assert-MyspeedStandaloneKeys $loaded @('value','sha256','bytesBase64') 'Standalone retained recovery cancellation'
        $cancel=Assert-MyspeedStandaloneRecoveryCancel $loaded.value $State.recoverySha256
        $cancelSha=Assert-MyspeedStandaloneString $loaded.sha256 'Standalone retained recovery cancellation SHA' '\A[0-9a-f]{64}\z'
        $cancelBytes=Assert-MyspeedStandaloneString $loaded.bytesBase64 'Standalone retained recovery cancellation bytes' `
            '\A(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?\z'
        $State.cancel=$cancel;$State.cancelSha256=$cancelSha;$State.cancelBase64=$cancelBytes
        return $true
    }finally{$lock.Dispose()}
}

function Invoke-MyspeedStandaloneInjectedRecoveryCancellation {
    param([object]$Value)
    Assert-MyspeedStandaloneKeys $Value @('disableAttempted','adapterRestoreProven','recoveryResultPresent','cancelPresent','writeFails') `
        'Injected recovery cancellation'
    foreach($name in @('disableAttempted','adapterRestoreProven','recoveryResultPresent','cancelPresent','writeFails')){
        if($Value.$name -isnot [bool]){throw "Injected recovery cancellation $name must be Boolean"}}
    $state=@{disableAttempted=$Value.disableAttempted;adapterRestoreProven=$Value.adapterRestoreProven
        recoverySha256=('6'*64);events=[Collections.Generic.List[string]]::new();cancelPresent=$Value.cancelPresent}
    $cancel=[pscustomobject][ordered]@{schemaVersion=1;kind='myspeed-windows-native-standalone-recovery-cancel';requestSha256=$state.recoverySha256}
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($cancel|ConvertTo-Json -Compress))
    $retained=[pscustomobject][ordered]@{value=$cancel;sha256=[BitConverter]::ToString(
            [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-','').ToLowerInvariant()
        bytesBase64=[Convert]::ToBase64String($bytes)}
    $inputValue=$Value
    $operations=[pscustomobject]@{
        enterLock={
            [void]$state.events.Add('lock');$lock=[pscustomobject]@{events=$state.events}
            Add-Member -InputObject $lock -MemberType ScriptMethod -Name Dispose -Value {[void]$this.events.Add('dispose')}
            return $lock}.GetNewClosure()
        recoveryResultExists={[void]$state.events.Add('result');return [bool]$inputValue.recoveryResultPresent}.GetNewClosure()
        readCancel={[void]$state.events.Add('read');if($state.cancelPresent){return $retained};return $null}.GetNewClosure()
        writeCancel={[void]$state.events.Add('write');if($inputValue.writeFails){throw 'Injected recovery cancellation write failed'};$state.cancelPresent=$true}.GetNewClosure()}
    $committed=Invoke-MyspeedStandaloneRecoveryCancellationCore $state $operations
    return [pscustomobject][ordered]@{cancelCommitted=$committed;events=@($state.events)}
}

function Get-MyspeedStandaloneRecoveryArguments {
    param([object]$Request,[string]$RecoveryRequestSha256)
    return "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$($Request.hostPath)`" -Mode InvokeRestoration " +
        "-RequestPath `"$($Request.recoveryRequestPath)`" -ExpectedRequestSha256 $RecoveryRequestSha256 " +
        "-ExpectedRunId $($Request.expectedRunId) -ExpectedRunAttempt $($Request.expectedRunAttempt) " +
        "-ExpectedEventSha $($Request.expectedEventSha) -ExpectedSourceSha $($Request.expectedSourceSha) " +
        "-ExpectedImageVersion $($Request.expectedImageVersion) -Nonce $($Request.nonce)"
}

function Wait-MyspeedStandaloneRecoveryReady {
    param([object]$Request,[string]$RecoveryRequestSha256,[int]$TimeoutMilliseconds)
    $watch=[Diagnostics.Stopwatch]::StartNew()
    while($true){
        if([IO.File]::Exists($Request.recoveryReadyPath) -and
            (Test-MyspeedStandaloneStableReadable $Request.recoveryReadyPath)){break}
        if($watch.ElapsedMilliseconds -ge $TimeoutMilliseconds){throw 'Standalone recovery readiness timed out'}
        Start-Sleep -Milliseconds $script:RecoveryPollMilliseconds
    }
    $ready=(Read-MyspeedStandaloneJsonFile $Request.recoveryReadyPath).value
    Assert-MyspeedStandaloneKeys $ready @('schemaVersion','kind','requestSha256','jobName','pid','creationFileTime','jobOpened','limitsProven') 'Standalone recovery readiness'
    if((Assert-MyspeedStandaloneInteger $ready.schemaVersion 'Standalone recovery readiness schema' 1 1) -ne 1 -or
        $ready.kind -cne 'myspeed-windows-native-standalone-recovery-ready' -or
        $ready.requestSha256 -cne $RecoveryRequestSha256 -or $ready.jobName -cne $Request.jobName -or
        $ready.jobOpened -ne $true -or $ready.limitsProven -ne $true){throw 'Standalone recovery readiness binding differs'}
    $pidValue=Assert-MyspeedStandaloneInteger $ready.pid 'Standalone recovery readiness PID' 1 4294967295
    $process=Get-Process -Id $pidValue -ErrorAction Stop
    if($process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString('x16') -cne $ready.creationFileTime){
        throw 'Standalone recovery process identity differs'}
    return $ready
}

function Restore-MyspeedStandaloneAdapters {
    param([object]$Module,[object[]]$Targets,[string]$LockPath)
    $lock=Enter-MyspeedStandaloneRecoveryLock $LockPath
    try{
        $snapshot=Get-MyspeedStandaloneAdapterSnapshot $Module
        $matched=Get-MyspeedStandaloneMatchedRawAdapters $snapshot $Targets $false
        @($matched)|Enable-NetAdapter -Confirm:$false -ErrorAction Stop
        $after=Get-MyspeedStandaloneAdapterSnapshot $Module
        foreach($target in $Targets){if(@($after.inventory|Where-Object {$_.interfaceGuid -ieq $target.interfaceGuid -and
            [string]::Equals($_.netLuid,$target.netLuid,[StringComparison]::Ordinal) -and $_.enabled}).Count -ne 1){
            throw 'Standalone adapter restoration proof failed'}}
    }finally{$lock.Dispose()}
}

function Wait-MyspeedStandaloneTaskExit {
    param([object]$Request,[object]$Ready,[int]$TimeoutMilliseconds)
    $watch=[Diagnostics.Stopwatch]::StartNew()
    do{
        $task=Get-ScheduledTask -TaskName $Request.taskName -ErrorAction Stop
        $process=Get-Process -Id ([int]$Ready.pid) -ErrorAction SilentlyContinue
        $same=$null -ne $process -and $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString('x16') -ceq $Ready.creationFileTime
        if($task.State -cne 'Running' -and -not $same){return}
        Start-Sleep -Milliseconds 50
    }while($watch.ElapsedMilliseconds -lt $TimeoutMilliseconds)
    throw 'Standalone recovery task process exit is unproven'
}

function New-MyspeedStandaloneNativeOperations {
    param([hashtable]$State)
    $arm={
        $State.snapshot=Get-MyspeedStandaloneAdapterSnapshot $State.module
        $targets=@($State.snapshot.inventory|Where-Object {-not $_.loopback -and $_.enabled}|ForEach-Object {
            [pscustomobject][ordered]@{interfaceGuid=$_.interfaceGuid;netLuid=$_.netLuid}})
        if($targets.Count -lt 1){throw 'Standalone recovery has no enabled adapter target'}
        $now=[MySpeedStandaloneNamedJob]::Clock100ns()
        $State.recovery=[pscustomobject][ordered]@{schemaVersion=1;kind='myspeed-windows-native-standalone-recovery-request'
            expectedRunId=$State.request.expectedRunId;expectedRunAttempt=$State.request.expectedRunAttempt
            expectedEventSha=$State.request.expectedEventSha;expectedSourceSha=$State.request.expectedSourceSha
            expectedImageVersion=$State.request.expectedImageVersion;nonce=$State.request.nonce
            hostPath=$State.request.hostPath;hostSha256=$State.request.hostSha256
            canaryPath=$State.request.canaryPath;canarySha256=$State.request.canarySha256
            requestSha256=$State.requestSha256;taskRoot=$State.request.taskRoot;jobName=$State.request.jobName
            taskName=$State.request.taskName;recoveryRequestPath=$State.request.recoveryRequestPath
            recoveryReadyPath=$State.request.recoveryReadyPath;recoveryResultPath=$State.request.recoveryResultPath
            cancelPath=$State.request.cancelPath;lockPath=$State.request.lockPath
            watchdogDeadline100ns=([uint64]$now+[uint64]($State.request.hardDeadlineMs*10000)).ToString();adapters=[object[]]$targets}
        [void](Assert-MyspeedStandaloneRecoveryRequest $State.recovery)
        $State.recoverySha256=Write-MyspeedStandaloneCreateNewJson $State.request.recoveryRequestPath $State.recovery
        $recoveryLoaded=Read-MyspeedStandaloneJsonFile $State.request.recoveryRequestPath $State.recoverySha256
        $State.recoveryBase64=$recoveryLoaded.bytesBase64
        $State.job=[MySpeedStandaloneNamedJob]::new($State.request.jobName)
        if(@(Get-ScheduledTask -ErrorAction Stop|Where-Object {$_.TaskName -ceq $State.request.taskName}).Count -ne 0){throw 'Standalone recovery task collision'}
        $powerShell=[IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
        $arguments=Get-MyspeedStandaloneRecoveryArguments $State.request $State.recoverySha256
        $action=New-ScheduledTaskAction -Execute $powerShell -Argument $arguments
        $principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        Register-ScheduledTask -TaskName $State.request.taskName -Action $action -Principal $principal -ErrorAction Stop|Out-Null
        $State.taskRegistered=$true;$State.recoveryPowerShell=$powerShell;$State.recoveryArguments=$arguments
        $task=Get-ScheduledTask -TaskName $State.request.taskName -ErrorAction Stop;$actions=@($task.Actions)
        if($actions.Count -ne 1 -or $actions[0].Execute -cne $powerShell -or $actions[0].Arguments -cne $arguments -or
            [string]$task.Principal.UserId -cne 'SYSTEM'){throw 'Standalone recovery task identity differs'}
        Start-ScheduledTask -TaskName $State.request.taskName -ErrorAction Stop
        $State.recoveryReady=Wait-MyspeedStandaloneRecoveryReady $State.request $State.recoverySha256 $script:RecoveryOperationTimeoutMilliseconds
        $readyLoaded=Read-MyspeedStandaloneJsonFile $State.request.recoveryReadyPath
        $State.recoveryReadySha256=$readyLoaded.sha256;$State.recoveryReadyBase64=$readyLoaded.bytesBase64
    }.GetNewClosure()
    $disable={
        foreach($entry in @(@($State.request.hostPath,$State.request.hostSha256),@($State.request.canaryPath,$State.request.canarySha256),
            @($State.request.coordinatorArguments[0],$State.request.coordinatorModuleSha256),
            @($State.request.coordinatorArguments[2],$State.request.proofRequestSha256))){
            [void](Read-MyspeedStandaloneBytes $entry[0] $script:MaximumSourceBytes $entry[1])}
        [void](Get-MyspeedStandaloneFileIdentity $State.request.coordinatorExecutablePath `
            $script:MaximumCoordinatorBytes $State.request.coordinatorExecutableSha256)
        [void](Wait-MyspeedStandaloneRecoveryReady $State.request $State.recoverySha256 1)
        $task=Get-ScheduledTask -TaskName $State.request.taskName -ErrorAction Stop;$actions=@($task.Actions)
        if($task.State -cne 'Running' -or $actions.Count -ne 1 -or $actions[0].Execute -cne $State.recoveryPowerShell -or
            $actions[0].Arguments -cne $State.recoveryArguments){throw 'Standalone recovery task changed before adapter disable'}
        $current=Get-MyspeedStandaloneAdapterSnapshot $State.module
        $matched=Get-MyspeedStandaloneMatchedRawAdapters $current $State.recovery.adapters $true
        $State.disableAttempted=$true;$State.restoreRequired=$true
        @($matched)|Disable-NetAdapter -Confirm:$false -ErrorAction Stop
        $offline=Get-MyspeedStandaloneOfflineObservation ([pscustomobject]@{schemaVersion=1;alias='default';scenario=$null
            phase='before-launch';canaryPath=$State.request.canaryPath;canarySha256=$State.request.canarySha256})
        if(-not $offline.offlineBoundaryPassed){throw 'Standalone offline boundary failed after adapter disable'}
        $State.offlineSha256=$offline.boundarySha256;$State.offlineBase64=$offline.boundaryBase64
    }.GetNewClosure()
    $launch={
        $State.coordinatorLaunch=$State.job.Launch($State.request.coordinatorExecutablePath,
            [string[]]$State.request.coordinatorArguments,$State.request.workingDirectory)
        $State.coordinatorPid=$State.coordinatorLaunch.ProcessId
    }.GetNewClosure()
    $wait={
        $remaining=$State.request.normalDeadlineMs-$State.watch.ElapsedMilliseconds
        if($remaining -le 0){throw 'Standalone normal deadline expired before coordinator wait'}
        $cleanup=[Math]::Min(10000,[Math]::Max(0,$State.request.hardDeadlineMs-$State.watch.ElapsedMilliseconds-$remaining))
        $State.coordinator=$State.job.Wait([uint32]$remaining,[uint32]$cleanup)
        $State.lifecycleRequest.coordinatorExitCode=[int64]$State.coordinator.ExitCode
        if($State.coordinator.ExitCode -eq 0){
            $proofResult=Read-MyspeedStandaloneJsonFile $State.request.proofResultPath
            [void](Assert-MyspeedStandaloneProofResult $proofResult.value $State.request $State.proofRequest)
            $State.proofResult=$proofResult.value;$State.proofResultSha256=$proofResult.sha256
            $State.proofResultBase64=$proofResult.bytesBase64
        }
    }.GetNewClosure()
    $prove={
        $State.activeProcessesBeforeRestore=[int64]$State.job.ActiveProcesses
        if($State.activeProcessesBeforeRestore -ne 0){throw 'Standalone owned Job retained processes after coordinator exit'}
        $State.jobZero=$true;$State.lifecycleRequest.jobActiveAfterCoordinator=0
    }.GetNewClosure()
    $restore={
        $lock=Enter-MyspeedStandaloneRecoveryLock $State.request.lockPath
        try{
            if([IO.File]::Exists($State.request.recoveryResultPath)){throw 'Standalone emergency recovery already ran'}
            $State.restoreStarted100ns=[MySpeedStandaloneNamedJob]::Clock100ns()
            if($State.restoreStarted100ns -ge [uint64]$State.recovery.watchdogDeadline100ns){throw 'Standalone normal restoration deadline expired'}
            if($State.job.ActiveProcesses -ne 0){throw 'Standalone Job was not empty before restoration'}
            $snapshot=Get-MyspeedStandaloneAdapterSnapshot $State.module
            $State.restoreBefore=[object[]]@(Get-MyspeedStandaloneTargetProjection $snapshot $State.recovery.adapters $false)
            $matched=Get-MyspeedStandaloneMatchedRawAdapters $snapshot $State.recovery.adapters $false
            @($matched)|Enable-NetAdapter -Confirm:$false -ErrorAction Stop
            $after=Get-MyspeedStandaloneAdapterSnapshot $State.module
            $State.restoreAfter=[object[]]@(Get-MyspeedStandaloneTargetProjection $after $State.recovery.adapters $true)
            $State.adapterRestoreProven=$true
            $State.restoreEnded100ns=[MySpeedStandaloneNamedJob]::Clock100ns()
            if($State.restoreEnded100ns -ge [uint64]$State.recovery.watchdogDeadline100ns){throw 'Standalone adapter restoration exceeded deadline'}
            $cancel=[pscustomobject][ordered]@{schemaVersion=1;kind='myspeed-windows-native-standalone-recovery-cancel';requestSha256=$State.recoverySha256}
            $State.cancelSha256=Write-MyspeedStandaloneCreateNewJson $State.request.cancelPath $cancel
            $cancelLoaded=Read-MyspeedStandaloneJsonFile $State.request.cancelPath $State.cancelSha256
            $State.cancel=$cancelLoaded.value;$State.cancelBase64=$cancelLoaded.bytesBase64
            $State.restoreRequired=$false
            $State.restored=$true
        }finally{$lock.Dispose()}
    }.GetNewClosure()
    $disarm={
        if($null -eq (Read-MyspeedStandaloneRecoveryCancel $State.request $State.recoverySha256)){
            throw 'Standalone recovery cancel was not committed under the restore lock'}
        Wait-MyspeedStandaloneTaskExit $State.request $State.recoveryReady $script:RecoveryOperationTimeoutMilliseconds
        $State.recoveryProcessExitProven=$true
        Unregister-ScheduledTask -TaskName $State.request.taskName -Confirm:$false -ErrorAction Stop
        if(@(Get-ScheduledTask -ErrorAction Stop|Where-Object {$_.TaskName -ceq $State.request.taskName}).Count -ne 0){
            throw 'Standalone recovery task removal is unproven'}
        $State.taskRegistered=$false;$State.taskUnregistered=$true
    }.GetNewClosure()
    $cleanup={
        $cleanupFailure=$null
        try{
            try{if($null -ne $State.job -and $State.job.ActiveProcesses -ne 0){$State.forced=$true;$State.job.TerminateAndDrain(10000);$State.jobZero=$true}}
            catch{$cleanupFailure=$_}
            try{if($State.restoreRequired -and $State.jobZero -and -not [IO.File]::Exists($State.request.recoveryResultPath)){& $restore}}
            catch{if($null -eq $cleanupFailure){$cleanupFailure=$_}}
            try{if($State.taskRegistered -and ($State.adapterRestoreProven -or -not $State.disableAttempted)){
                $req=$State.request;$recoverySha=$State.recoverySha256
                $cancelOperations=[pscustomobject]@{
                    enterLock={return Enter-MyspeedStandaloneRecoveryLock $req.lockPath}.GetNewClosure()
                    recoveryResultExists={return [IO.File]::Exists($req.recoveryResultPath)}.GetNewClosure()
                    readCancel={
                        if(-not [IO.File]::Exists($req.cancelPath) -or -not (Test-MyspeedStandaloneStableReadable $req.cancelPath)){return $null}
                        $loaded=Read-MyspeedStandaloneJsonFile $req.cancelPath
                        [void](Assert-MyspeedStandaloneRecoveryCancel $loaded.value $recoverySha)
                        return [pscustomobject][ordered]@{value=$loaded.value;sha256=$loaded.sha256;bytesBase64=$loaded.bytesBase64}
                    }.GetNewClosure()
                    writeCancel={
                        $cancel=[pscustomobject][ordered]@{schemaVersion=1;kind='myspeed-windows-native-standalone-recovery-cancel';requestSha256=$recoverySha}
                        [void](Write-MyspeedStandaloneCreateNewJson $req.cancelPath $cancel)
                    }.GetNewClosure()}
                [void](Invoke-MyspeedStandaloneRecoveryCancellationCore $State $cancelOperations)
                if($null -ne $State.recoveryReady){Wait-MyspeedStandaloneTaskExit $State.request $State.recoveryReady $script:RecoveryOperationTimeoutMilliseconds
                    Unregister-ScheduledTask -TaskName $State.request.taskName -Confirm:$false -ErrorAction Stop;$State.taskRegistered=$false}
            }}catch{if($null -eq $cleanupFailure){$cleanupFailure=$_}}
        }finally{if($null -ne $State.job){$State.job.Dispose();$State.job=$null;$State.jobHandlesClosed=$true}}
        if($null -ne $cleanupFailure){throw $cleanupFailure}
    }.GetNewClosure()
    return [pscustomobject][ordered]@{'arm-recovery'=$arm;'disable-adapters'=$disable;'launch-coordinator'=$launch
        'wait-coordinator'=$wait;'prove-job-zero'=$prove;'restore-adapters'=$restore;'disarm-recovery'=$disarm;cleanup=$cleanup}
}

function New-MyspeedStandaloneCombinedResult {
    param([hashtable]$State,[object]$Lifecycle)
    if($Lifecycle.status -cne 'completed' -or -not $State.jobZero -or -not $State.restored -or
        -not $State.jobHandlesClosed -or -not $State.recoveryProcessExitProven -or -not $State.taskUnregistered -or
        [IO.File]::Exists($State.request.recoveryResultPath)){throw 'Standalone combined native proof is incomplete'}
    return [pscustomobject][ordered]@{schemaVersion=1;kind=$script:ResultKind;status='completed';qualifying=$false
        manifestSha256=$State.request.manifestSha256;sourceSha=$State.request.expectedSourceSha
        eventSha=$State.request.expectedEventSha;runId=$State.request.expectedRunId;runAttempt=$State.request.expectedRunAttempt
        imageVersion=$State.request.expectedImageVersion;nonce=$State.request.nonce;requestSha256=$State.requestSha256
        requestBase64=$State.requestBase64
        abi=$State.abi
        coordinator=[pscustomobject][ordered]@{executablePath=$State.request.coordinatorExecutablePath
            executableSha256=$State.request.coordinatorExecutableSha256;moduleSha256=$State.request.coordinatorModuleSha256
            proofRequestSha256=$State.request.proofRequestSha256;proofRequestBase64=$State.proofRequestBase64
            processId=[int64]$State.coordinatorLaunch.ProcessId
            creationFileTime=$State.coordinatorLaunch.CreationFileTime;imagePath=$State.coordinatorLaunch.ImagePath
            assignedBeforeResume=$State.coordinatorLaunch.AssignedBeforeResume;resumed=$State.coordinatorLaunch.Resumed
            exitCode=[int64]$State.coordinator.ExitCode;activeProcessesAfterWait=[int64]$State.coordinator.ActiveProcesses
            proofResultSha256=$State.proofResultSha256;proofResultBase64=$State.proofResultBase64}
        job=[pscustomobject][ordered]@{name=$State.request.jobName;activeProcessesBeforeRestore=$State.activeProcessesBeforeRestore
            treeExitProven=$State.jobZero;handlesClosed=$State.jobHandlesClosed}
        recovery=[pscustomobject][ordered]@{request=$State.recovery;requestSha256=$State.recoverySha256
            requestBase64=$State.recoveryBase64;ready=$State.recoveryReady;readySha256=$State.recoveryReadySha256
            readyBase64=$State.recoveryReadyBase64;cancel=$State.cancel;cancelSha256=$State.cancelSha256
            cancelBase64=$State.cancelBase64;emergencyResultPresent=$false
            processExitProven=$State.recoveryProcessExitProven;taskUnregistered=$State.taskUnregistered}
        restoration=[pscustomobject][ordered]@{mode='normal';watchdogDeadline100ns=$State.recovery.watchdogDeadline100ns
            started100ns=([uint64]$State.restoreStarted100ns).ToString();ended100ns=([uint64]$State.restoreEnded100ns).ToString()
            offlineBoundarySha256=$State.offlineSha256;offlineBoundaryBase64=$State.offlineBase64
            targets=[object[]]$State.recovery.adapters
            before=[object[]]$State.restoreBefore;after=[object[]]$State.restoreAfter}
        lifecycle=$Lifecycle;proof=$State.proofResult;releaseGatesCleared=@()}
}

function Invoke-MyspeedStandaloneHostedProof {
    # The process/environment guard is deliberately first. Request reads, module
    # imports, Add-Type and all native providers are forbidden before it passes.
    Assert-MyspeedStandaloneHostedContext $ExpectedRunId $ExpectedRunAttempt $ExpectedEventSha $ExpectedSourceSha $ExpectedImageVersion $Nonce
    $loaded=Read-MyspeedStandaloneJsonFile (Assert-MyspeedStandalonePath $RequestPath 'Hosted proof request path') `
        (Assert-MyspeedStandaloneString $ExpectedRequestSha256 'Hosted proof request SHA' '\A[0-9a-f]{64}\z')
    $request=Assert-MyspeedStandaloneHostRequest $loaded.value
    foreach($binding in ([ordered]@{expectedRunId=$ExpectedRunId;expectedRunAttempt=$ExpectedRunAttempt;expectedEventSha=$ExpectedEventSha
        expectedSourceSha=$ExpectedSourceSha;expectedImageVersion=$ExpectedImageVersion;nonce=$Nonce}).GetEnumerator()){
        if($request.($binding.Key) -cne $binding.Value){throw 'Hosted proof CLI identity differs'}}
    $stage='closure-validation';$module=$null
    try{
        foreach($entry in @(@($request.hostPath,$request.hostSha256),@($request.canaryPath,$request.canarySha256),
            @($request.coordinatorArguments[0],$request.coordinatorModuleSha256))){
            [void](Read-MyspeedStandaloneBytes $entry[0] $script:MaximumSourceBytes $entry[1])}
        $proofRequestLoaded=Read-MyspeedStandaloneJsonFile $request.coordinatorArguments[2] $request.proofRequestSha256
        [void](Get-MyspeedStandaloneFileIdentity $request.coordinatorExecutablePath `
            $script:MaximumCoordinatorBytes $request.coordinatorExecutableSha256)
        $stage='native-initialization'
        Import-Module NetAdapter -ErrorAction Stop;Import-Module NetTCPIP -ErrorAction Stop;Import-Module ScheduledTasks -ErrorAction Stop
        Add-Type -TypeDefinition (Get-MyspeedStandaloneNativeSource) -Language CSharp
        $abi=[MySpeedStandaloneNamedJob]::ObserveAbi()
        $module=Import-MyspeedStandaloneCanaryModule $request.canaryPath $request.canarySha256
        $lifecycle=[pscustomobject][ordered]@{schemaVersion=1;kind=$script:InjectedKind;phases=$script:ExpectedPhases
            failAt=$null;jobActiveAfterCoordinator=0;coordinatorExitCode=0}
        $state=@{request=$request;requestSha256=$loaded.sha256;requestBase64=$loaded.bytesBase64
            proofRequest=$proofRequestLoaded.value;proofRequestBase64=$proofRequestLoaded.bytesBase64;module=$module;abi=$abi
            watch=[Diagnostics.Stopwatch]::StartNew();lifecycleRequest=$lifecycle;job=$null;taskRegistered=$false
            disableAttempted=$false;restoreRequired=$false;adapterRestoreProven=$false;restored=$false;jobZero=$false;forced=$false
            jobHandlesClosed=$false;recoveryProcessExitProven=$false;taskUnregistered=$false}
        $stage='native-lifecycle'
        $lifecycleResult=Invoke-MyspeedStandaloneLifecycleCore $lifecycle (New-MyspeedStandaloneNativeOperations $state)
        if($lifecycleResult.status -cne 'completed'){throw 'Hosted standalone proof failed'}
        $combined=New-MyspeedStandaloneCombinedResult $state $lifecycleResult
        [void](Write-MyspeedStandaloneCreateNewJson $request.resultPath $combined)
        return $combined
    }catch{
        if(-not [IO.File]::Exists($request.entryDiagnosticPath)){
            try{[void](Write-MyspeedStandaloneEntryDiagnostic $request.entryDiagnosticPath $stage $_)}catch{}}
        throw
    }finally{if($null -ne $module){Remove-Module $module -Force -ErrorAction SilentlyContinue}}
}

function Invoke-MyspeedStandaloneRestoration {
    Assert-MyspeedStandaloneRestorationContext $ExpectedRunId $ExpectedRunAttempt $ExpectedEventSha $ExpectedSourceSha $ExpectedImageVersion $Nonce
    $loaded=Read-MyspeedStandaloneJsonFile (Assert-MyspeedStandalonePath $RequestPath 'Standalone recovery request path') `
        (Assert-MyspeedStandaloneString $ExpectedRequestSha256 'Standalone recovery request SHA' '\A[0-9a-f]{64}\z')
    $request=Assert-MyspeedStandaloneRecoveryRequest $loaded.value
    foreach($binding in ([ordered]@{expectedRunId=$ExpectedRunId;expectedRunAttempt=$ExpectedRunAttempt;expectedEventSha=$ExpectedEventSha
        expectedSourceSha=$ExpectedSourceSha;expectedImageVersion=$ExpectedImageVersion;nonce=$Nonce}).GetEnumerator()){
        if($request.($binding.Key) -cne $binding.Value){throw 'Standalone recovery CLI identity differs'}}
    if($request.recoveryRequestPath -cne [IO.Path]::GetFullPath($RequestPath)){throw 'Standalone recovery request path differs'}
    [void](Read-MyspeedStandaloneBytes $request.hostPath $script:MaximumSourceBytes $request.hostSha256)
    [void](Read-MyspeedStandaloneBytes $request.canaryPath $script:MaximumSourceBytes $request.canarySha256)
    Import-Module NetAdapter -ErrorAction Stop
    Add-Type -TypeDefinition (Get-MyspeedStandaloneNativeSource) -Language CSharp
    [void][MySpeedStandaloneNamedJob]::ObserveAbi()
    $module=Import-MyspeedStandaloneCanaryModule $request.canaryPath $request.canarySha256
    $job=$null
    try{
        $job=[MySpeedStandaloneNamedJob]::OpenExisting($request.jobName)
        $process=[Diagnostics.Process]::GetCurrentProcess()
        $ready=[pscustomobject][ordered]@{schemaVersion=1;kind='myspeed-windows-native-standalone-recovery-ready'
            requestSha256=$loaded.sha256;jobName=$request.jobName;pid=[int64]$PID
            creationFileTime=$process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString('x16');jobOpened=$true;limitsProven=$true}
        [void](Write-MyspeedStandaloneCreateNewJson $request.recoveryReadyPath $ready)
        while([MySpeedStandaloneNamedJob]::Clock100ns() -lt [uint64]$request.watchdogDeadline100ns){
            if($null -ne (Read-MyspeedStandaloneRecoveryCancel $request $loaded.sha256)){
                if($job.ActiveProcesses -ne 0){throw 'Standalone recovery cancel observed before Job zero'}
                return [pscustomobject]@{cancelled=$true;emergencyRestore=$false}}
            Start-Sleep -Milliseconds $script:RecoveryPollMilliseconds
        }
        $job.TerminateAndDrain(10000)
        Restore-MyspeedStandaloneAdapters $module ([object[]]$request.adapters) $request.lockPath
        $result=[pscustomobject][ordered]@{schemaVersion=1;kind='myspeed-windows-native-standalone-recovery-result'
            classification='inconclusive';emergencyRestore=$true;jobTreeExitProven=($job.ActiveProcesses -eq 0)
            adapterRestoreProven=$true;requestSha256=$loaded.sha256;failure=$null}
        [void](Write-MyspeedStandaloneCreateNewJson $request.recoveryResultPath $result)
        return $result
    }finally{if($null -ne $job){$job.Dispose()};Remove-Module $module -Force -ErrorAction SilentlyContinue}
}

if($Mode -ceq 'Library'){return}
try{
    $output=switch($Mode){
        'GetContract' {[pscustomobject][ordered]@{schemaVersion=1;kind=$script:ResultKind;qualifying=$false;releaseGatesCleared=@()}}
        'ValidateRequest' {Assert-MyspeedStandaloneHostRequest (ConvertFrom-MyspeedStandaloneJson $InputJson 'Hosted proof request')}
        'ValidateRecoveryRequest' {Assert-MyspeedStandaloneRecoveryRequest (ConvertFrom-MyspeedStandaloneJson $InputJson 'Standalone recovery request')}
        'ValidateRecoveryCancel' {$inputValue=ConvertFrom-MyspeedStandaloneJson $InputJson 'Standalone recovery cancel validation'
            Assert-MyspeedStandaloneKeys $inputValue @('value','expectedRequestSha256') 'Standalone recovery cancel validation'
            $expectedCancelSha=Assert-MyspeedStandaloneString $inputValue.expectedRequestSha256 `
                'Standalone recovery expected request SHA' '\A[0-9a-f]{64}\z'
            Assert-MyspeedStandaloneRecoveryCancel $inputValue.value $expectedCancelSha}
        'ValidateProofResult' {$inputValue=ConvertFrom-MyspeedStandaloneJson $InputJson 'Standalone proof result validation'
            Assert-MyspeedStandaloneKeys $inputValue @('value','request','proofRequest') 'Standalone proof result validation'
            Assert-MyspeedStandaloneProofResult $inputValue.value `
                (Assert-MyspeedStandaloneHostRequest $inputValue.request) $inputValue.proofRequest}
        'ValidateCandidateIdentity' {$inputValue=ConvertFrom-MyspeedStandaloneJson $InputJson 'Candidate identity validation'
            Assert-MyspeedStandaloneKeys $inputValue @('request','observation') 'Candidate identity validation'
            Assert-MyspeedStandaloneCandidateIdentity $inputValue.observation $inputValue.request}
        'TestLifecycle' {Invoke-MyspeedStandaloneInjectedLifecycle (ConvertFrom-MyspeedStandaloneJson $InputJson 'Injected lifecycle')}
        'TestRecoveryCancellation' {Invoke-MyspeedStandaloneInjectedRecoveryCancellation `
            (ConvertFrom-MyspeedStandaloneJson $InputJson 'Injected recovery cancellation')}
        'TestBinaryIdentity' {$inputValue=ConvertFrom-MyspeedStandaloneJson $InputJson 'Standalone binary identity validation'
            Assert-MyspeedStandaloneKeys $inputValue @('path','sha256') 'Standalone binary identity validation'
            Get-MyspeedStandaloneFileIdentity $inputValue.path $script:MaximumCoordinatorBytes `
                (Assert-MyspeedStandaloneString $inputValue.sha256 'Standalone binary expected SHA' '\A[0-9a-f]{64}\z')}
        'TestObservationCore' {$inputValue=ConvertFrom-MyspeedStandaloneJson $InputJson 'Standalone observer projection validation'
            Assert-MyspeedStandaloneKeys $inputValue @('offlineRequest','snapshot','ipState','listenerRequest','connections','processIdentity') `
                'Standalone observer projection validation'
            $processIdentity=$inputValue.processIdentity
            $readProcess={param([int64]$ProcessId) return $processIdentity}.GetNewClosure()
            [pscustomobject][ordered]@{offline=Invoke-MyspeedStandaloneOfflineObservationCore $inputValue.offlineRequest `
                    $inputValue.snapshot ([object[]]$inputValue.ipState)
                listener=Invoke-MyspeedStandaloneListenerObservationCore $inputValue.listenerRequest `
                        ([object[]]$inputValue.connections) $readProcess}}
        'TestEntryDiagnostic' {$inputValue=ConvertFrom-MyspeedStandaloneJson $InputJson 'Standalone entry diagnostic validation'
            Assert-MyspeedStandaloneKeys $inputValue @('path','stage','message') 'Standalone entry diagnostic validation'
            Write-MyspeedStandaloneEntryDiagnostic $inputValue.path $inputValue.stage $inputValue.message}
        'ObserveOffline' {Get-MyspeedStandaloneOfflineObservation (ConvertFrom-MyspeedStandaloneJson $InputJson 'Offline observer request')}
        'ObserveListener' {Get-MyspeedStandaloneListenerObservation (ConvertFrom-MyspeedStandaloneJson $InputJson 'Listener observer request')}
        'ObserveCandidateIdentity' {Get-MyspeedStandaloneCandidateIdentityObservation}
        'InvokeHostedProof' {Invoke-MyspeedStandaloneHostedProof}
        'InvokeRestoration' {Invoke-MyspeedStandaloneRestoration}
    }
    $output|ConvertTo-Json -Depth 20 -Compress
}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}
