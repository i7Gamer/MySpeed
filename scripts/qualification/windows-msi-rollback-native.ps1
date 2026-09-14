[CmdletBinding()]
param(
    [ValidateSet('Library','GetContract','InvokeHostedCalibration')]
    [string]$Mode = 'Library',
    [string]$InputJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:SchemaVersion = 1
$script:Repository = 'i7Gamer/MySpeed'
$script:ImageOs = 'win25-vs2026'
$script:ExpectedPowerShellVersion = '5.1'
$script:RequiredCallbackFilter = [uint32]0x0C000303
$script:ExpectedInstallUserExit = 1602
$script:MaximumManifestBytes = 65536
$script:MaximumEvidenceBytes = 262144
$script:MaximumSourceBytes = 1048576
$script:MaximumMsiBytes = 8388608
$script:PredecessorProductCode = '{1716C600-7C5B-45CB-89F1-584214207169}'
$script:CandidateProductCode = '{FF93E978-E119-4D48-B37B-248457E950A2}'
$script:PredecessorPayloadSha256 = 'd3007b3e85e42d36018e4a1231a6eff90fa4b7fbb898d215fadf2fdd809081de'
$script:CandidatePayloadBytes = 10
$script:NativeInputNames = @('windows-msi-rollback-calibration.ps1','windows-msi-rollback-native.ps1',
    'windows-msi-rollback-state.ps1','predecessor.msi','candidate.msi')

function Get-MyspeedRollbackNativeContract {
    [pscustomobject]@{
        schemaVersion = $script:SchemaVersion
        kind = 'myspeed-msi-sacrificial-native-contract'
        qualifying = $false
        nativeExecutionAuthorized = $false
        requiredInstallReturn = $script:ExpectedInstallUserExit
        requiredCallbackMessages = @('FATALEXIT','ERROR','ACTIONSTART','ACTIONDATA','INSTALLSTART','INSTALLEND')
        requiredCallbackFilter = [long]$script:RequiredCallbackFilter
        prerequisites = @('exact-hosted-context','same-run-closure','fresh-dedicated-process',
            'empty-product-registration','owned-noninheriting-target','same-handle-security-restoration')
        releaseGatesCleared = @()
    }
}
function Assert-MyspeedRollbackNativeExactObject {
    param($Value,[string[]]$Keys,[string]$Label)
    if ($null -eq $Value -or $Value -is [array] -or $Value -is [string] -or $Value -is [ValueType]) {
        throw "$Label must be an exact object"
    }
    $actual=@($Value.PSObject.Properties.Name|Sort-Object);$expected=@($Keys|Sort-Object)
    if($actual.Count -ne $expected.Count){throw "$Label must have exact keys"}
    for($index=0;$index -lt $expected.Count;$index++){
        if(-not [string]::Equals($actual[$index],$expected[$index],[StringComparison]::Ordinal)){
            throw "$Label must have exact keys"
        }
    }
}

function Get-MyspeedRollbackNativeSha256 {
    param([string]$Path)
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{$hasher=[Security.Cryptography.SHA256]::Create();try{
        ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-','').ToLowerInvariant()
    }finally{$hasher.Dispose()}}finally{$stream.Dispose()}
}

function Assert-MyspeedRollbackNativeHostedContext {
    param($Expected)
    Assert-MyspeedRollbackNativeExactObject $Expected @('runId','runAttempt','eventSha','sourceSha','nonce',
        'imageVersion','closureRoot','manifestPath','predecessorMsiPath','candidateMsiPath','evidencePath') 'Hosted expectation'
    $patterns=[ordered]@{runId='\A[1-9][0-9]*\z';runAttempt='\A[1-9][0-9]*\z';
        eventSha='\A[a-f0-9]{40}\z';sourceSha='\A[a-f0-9]{40}\z';nonce='\A[a-f0-9]{32}\z';
        imageVersion='\A[0-9A-Za-z._-]{1,128}\z'}
    foreach($entry in $patterns.GetEnumerator()){
        if($Expected.($entry.Key) -isnot [string] -or $Expected.($entry.Key) -cnotmatch $entry.Value){
            throw 'Native MSI calibration is restricted to its exact fresh hosted context'
        }
    }
    $required=[ordered]@{GITHUB_ACTIONS='true';CI='true';GITHUB_REPOSITORY=$script:Repository;
        RUNNER_OS='Windows';RUNNER_ARCH='X64';RUNNER_ENVIRONMENT='github-hosted';ImageOS=$script:ImageOs;
        GITHUB_RUN_ID=$Expected.runId;GITHUB_RUN_ATTEMPT=$Expected.runAttempt;GITHUB_SHA=$Expected.eventSha;
        ImageVersion=$Expected.imageVersion}
    foreach($entry in $required.GetEnumerator()){
        if([Environment]::GetEnvironmentVariable($entry.Key) -cne $entry.Value){
            throw 'Native MSI calibration is restricted to its exact fresh hosted context'
        }
    }
    $expectedShell=[IO.Path]::Combine($env:SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe')
    $actualShell=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    if($PSVersionTable.PSEdition -cne 'Desktop' -or
        "$($PSVersionTable.PSVersion.Major).$($PSVersionTable.PSVersion.Minor)" -cne $script:ExpectedPowerShellVersion -or
        -not [string]::Equals($actualShell,$expectedShell,[StringComparison]::OrdinalIgnoreCase)){
        throw 'Native MSI calibration requires canonical inbox Windows PowerShell 5.1'
    }
    foreach($pathName in @('closureRoot','manifestPath','predecessorMsiPath','candidateMsiPath','evidencePath')){
        if($Expected.$pathName -isnot [string] -or [string]::IsNullOrWhiteSpace($Expected.$pathName)){
            throw 'Native MSI calibration path identity differs'
        }
    }
    $closureRoot=[IO.Path]::GetFullPath($Expected.closureRoot)
    $manifestPath=[IO.Path]::GetFullPath($Expected.manifestPath)
    $expectedClosureRoot=[IO.Path]::Combine([IO.Path]::GetFullPath($env:RUNNER_TEMP),'msi-rollback-calibration-closure')
    $ownedRoot=[IO.Path]::Combine([IO.Path]::GetFullPath($env:RUNNER_TEMP),('msi-rollback-calibration-'+$Expected.nonce))
    $evidencePath=[IO.Path]::GetFullPath($Expected.evidencePath)
    if(-not [string]::Equals($closureRoot,$expectedClosureRoot,[StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($evidencePath,(Join-Path $ownedRoot 'result.json'),[StringComparison]::OrdinalIgnoreCase) -or
        (Test-Path -LiteralPath $evidencePath)){
        throw 'Native MSI calibration owned path binding differs'
    }
    $owned=Get-Item -LiteralPath $ownedRoot -Force -ErrorAction Stop
    $ownerMarker=Join-Path $ownedRoot 'owner.marker'
    if($owned -isnot [IO.DirectoryInfo] -or ($owned.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        -not (Test-Path -LiteralPath $ownerMarker -PathType Leaf) -or
        -not [string]::Equals((Get-Content -LiteralPath $ownerMarker -Raw -ErrorAction Stop),$Expected.nonce,
            [StringComparison]::Ordinal)){
        throw 'Native MSI calibration owned root differs'
    }
    if(-not [string]::Equals($manifestPath,(Join-Path $closureRoot 'closure.json'),[StringComparison]::OrdinalIgnoreCase)){
        throw 'Native MSI calibration manifest path differs'
    }
    $manifestInfo=Get-Item -LiteralPath $manifestPath -Force -ErrorAction Stop
    if($manifestInfo.PSIsContainer -or ($manifestInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $manifestInfo.LinkType -or $manifestInfo.Length -le 0 -or $manifestInfo.Length -gt $script:MaximumManifestBytes){
        throw 'Native MSI calibration manifest is invalid'
    }
    $manifest=Get-Content -LiteralPath $manifestPath -Raw -ErrorAction Stop|ConvertFrom-Json
    Assert-MyspeedRollbackNativeExactObject $manifest @('schemaVersion','kind','expectedRunId','expectedRunAttempt',
        'expectedSourceSha','expectedEventSha','nonce','files') 'Transport manifest'
    if(($manifest.schemaVersion -isnot [int] -and $manifest.schemaVersion -isnot [long]) -or
        $manifest.schemaVersion -ne $script:SchemaVersion -or $manifest.kind -isnot [string] -or
        $manifest.kind -cne 'myspeed-msi-sacrificial-calibration-transport-closure' -or
        $manifest.expectedRunId -isnot [string] -or $manifest.expectedRunId -cne $Expected.runId -or
        $manifest.expectedRunAttempt -isnot [string] -or $manifest.expectedRunAttempt -cne $Expected.runAttempt -or
        $manifest.expectedSourceSha -isnot [string] -or $manifest.expectedSourceSha -cne $Expected.sourceSha -or
        $manifest.expectedEventSha -isnot [string] -or $manifest.expectedEventSha -cne $Expected.eventSha -or
        $manifest.nonce -isnot [string] -or $manifest.nonce -cne $Expected.nonce -or $manifest.files -isnot [array]){
        throw 'Native MSI calibration manifest binding differs'
    }
    foreach($name in $script:NativeInputNames){
        $records=@($manifest.files|Where-Object {$_.name -is [string] -and $_.name -ceq $name})
        if($records.Count -ne 1){throw "Native MSI calibration source record $name differs"}
        $record=$records[0];Assert-MyspeedRollbackNativeExactObject $record @('name','bytes','sha256') 'Source record'
        $path=Join-Path $closureRoot $name;$item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
        $maximumBytes=if($name.EndsWith('.msi',[StringComparison]::Ordinal)){$script:MaximumMsiBytes}else{$script:MaximumSourceBytes}
        if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType -or
            $item.Length -le 0 -or $item.Length -gt $maximumBytes -or
            ($record.bytes -isnot [int] -and $record.bytes -isnot [long]) -or $record.bytes -ne $item.Length -or
            $record.sha256 -isnot [string] -or $record.sha256 -cnotmatch '\A[a-f0-9]{64}\z' -or
            $record.sha256 -cne (Get-MyspeedRollbackNativeSha256 $path)){
            throw "Native MSI calibration source identity $name differs"
        }
    }
    foreach($binding in @(@('predecessorMsiPath','predecessor.msi'),@('candidateMsiPath','candidate.msi'))){
        $actual=[IO.Path]::GetFullPath($Expected.($binding[0]));$wanted=Join-Path $closureRoot $binding[1]
        if(-not [string]::Equals($actual,$wanted,[StringComparison]::OrdinalIgnoreCase)){
            throw 'Native MSI calibration MSI path differs'
        }
    }
}

function New-MyspeedRollbackNativeOperations {
    param($Expected)
    Assert-MyspeedRollbackNativeHostedContext $Expected
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class MyspeedMsiRollbackNative
{
    internal const uint ErrorSuccess=0,ErrorMoreData=234,ErrorInsufficientBuffer=122;
    internal const uint ReadControl=0x00020000,WriteDac=0x00040000;
    internal const uint OwnerSecurityInformation=1,GroupSecurityInformation=2,DaclSecurityInformation=4,ProtectedDaclSecurityInformation=0x80000000u;
    internal const int SeFileObject=1;
    internal const uint FileShareRead=1,FileShareWrite=2,FileShareDelete=4,OpenExisting=3;
    internal const uint FileFlagBackupSemantics=0x02000000,FileFlagOpenReparsePoint=0x00200000;
    internal const int FileAddFile=0x00000002,MaximumSecurityDescriptorBytes=65536,MaximumFinalPathCharacters=32768;
    internal const int SecurityDescriptorRelativeHeaderBytes=20,DaclOffsetFieldByteOffset=16;
    internal const int MaximumRecords=256,MaximumFields=16,MaximumFieldCharacters=4096;
    internal const int InstallStateUnknown=-1,InstallStateDefault=5,InstallLevelDefault=0,InstallStateAbsent=2,ErrorWritingToFile=1304;
    internal const uint InstallUiLevelNone=2,InstallLogModeVerbose=1u<<12,InstallLogModeExtraDebug=1u<<13;
    internal const uint InstallLogAttributesFlushEachLine=1u<<1;
    internal const uint RequiredMessageFilter=(1u<<0)|(1u<<1)|(1u<<8)|(1u<<9)|(1u<<26)|(1u<<27);
    internal const uint MessageClassMask=0xFF000000,MessageStyleMask=0x0000000F;
    internal const uint MessageError=0x01000000,MessageActionStart=0x08000000,MessageActionData=0x09000000;
    internal const uint MessageInstallStart=0x1A000000,MessageInstallEnd=0x1B000000;
    internal const uint ErrorRetryCancelStyle=5,ErrorAbortRetryIgnoreStyle=2;
    internal const int ResponseOk=1,ResponseCancel=2,ResponseAbort=3,CallbackFailureReturn=-1;

    [StructLayout(LayoutKind.Sequential)] struct FILETIME{public uint low,high;}
    [StructLayout(LayoutKind.Sequential)] struct BY_HANDLE_FILE_INFORMATION{
        public uint attributes;public FILETIME creation,lastAccess,lastWrite;public uint volumeSerial,fileSizeHigh,fileSizeLow;
        public uint links,fileIndexHigh,fileIndexLow;
    }
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    public delegate int InstallUiHandlerRecord(IntPtr context,uint messageType,uint recordHandle);

    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string name,uint access,uint sharing,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out BY_HANDLE_FILE_INFORMATION info);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,StringBuilder path,uint characters,uint flags);
    [DllImport("advapi32.dll",SetLastError=true)]
    static extern bool GetKernelObjectSecurity(SafeFileHandle handle,uint information,byte[] descriptor,uint length,out uint needed);
    [DllImport("advapi32.dll",ExactSpelling=true)]
    static extern uint SetSecurityInfo(SafeFileHandle handle,int objectType,uint information,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
    [DllImport("msi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)]
    static extern uint MsiSetExternalUIRecord(InstallUiHandlerRecord handler,uint messageFilter,IntPtr context,out IntPtr previousHandler);
    [DllImport("msi.dll",ExactSpelling=true)] static extern uint MsiSetInternalUI(uint level,ref IntPtr owner);
    [DllImport("msi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern uint MsiEnableLogW(uint mode,string path,uint attributes);
    [DllImport("msi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern uint MsiInstallProductW(string packagePath,string commandLine);
    [DllImport("msi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern uint MsiConfigureProductExW(string productCode,int level,int state,string commandLine);
    [DllImport("msi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern int MsiQueryProductStateW(string productCode);
    [DllImport("msi.dll",ExactSpelling=true)] static extern uint MsiRecordGetFieldCount(uint recordHandle);
    [DllImport("msi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern uint MsiRecordGetStringW(uint recordHandle,uint field,StringBuilder value,ref uint characters);
    [DllImport("msi.dll",ExactSpelling=true)] static extern int MsiRecordGetInteger(uint recordHandle,uint field);

    static Exception Error(string operation){return new Win32Exception(Marshal.GetLastWin32Error(),operation);}
    static string FinalPath(SafeFileHandle handle){StringBuilder b=new StringBuilder(MaximumFinalPathCharacters);uint n=GetFinalPathNameByHandleW(handle,b,(uint)b.Capacity,0);if(n==0)throw Error("GetFinalPathNameByHandleW");if(n>=b.Capacity)throw new InvalidDataException("Directory final path exceeded bound");string value=b.ToString();return value.StartsWith("\\\\?\\",StringComparison.Ordinal)?value.Substring(4):value;}
    static string Identity(SafeFileHandle handle){BY_HANDLE_FILE_INFORMATION i;if(!GetFileInformationByHandle(handle,out i))throw Error("GetFileInformationByHandle");return i.volumeSerial.ToString("x8")+":"+(((ulong)i.fileIndexHigh<<32)|i.fileIndexLow).ToString("x16");}
    static byte[] Security(SafeFileHandle handle){uint information=OwnerSecurityInformation|GroupSecurityInformation|DaclSecurityInformation;uint needed;GetKernelObjectSecurity(handle,information,null,0,out needed);if(Marshal.GetLastWin32Error()!=ErrorInsufficientBuffer||needed==0||needed>MaximumSecurityDescriptorBytes)throw Error("GetKernelObjectSecurity length");byte[] b=new byte[needed];if(!GetKernelObjectSecurity(handle,information,b,(uint)b.Length,out needed)||needed!=b.Length)throw Error("GetKernelObjectSecurity");return b;}
    static string Sha256Bytes(byte[] value){using(SHA256 hash=SHA256.Create()){return BitConverter.ToString(hash.ComputeHash(value)).Replace("-",String.Empty).ToLowerInvariant();}}
    static bool Equal(byte[] a,byte[] b){if(a==null||b==null||a.Length!=b.Length)return false;for(int i=0;i<a.Length;i++)if(a[i]!=b[i])return false;return true;}
    static void SetFileDacl(SafeFileHandle handle,byte[] descriptor){if(descriptor==null||descriptor.Length<SecurityDescriptorRelativeHeaderBytes)throw new InvalidDataException("Directory descriptor differs");int offset=BitConverter.ToInt32(descriptor,DaclOffsetFieldByteOffset);if(offset<=0||offset>=descriptor.Length)throw new InvalidDataException("Directory DACL offset differs");GCHandle pinned=GCHandle.Alloc(descriptor,GCHandleType.Pinned);try{IntPtr dacl=IntPtr.Add(pinned.AddrOfPinnedObject(),offset);uint result=SetSecurityInfo(handle,SeFileObject,DaclSecurityInformation|ProtectedDaclSecurityInformation,IntPtr.Zero,IntPtr.Zero,dacl,IntPtr.Zero);if(result!=ErrorSuccess)throw new Win32Exception((int)result,"SetSecurityInfo file DACL");}finally{pinned.Free();}}
    static int? NativeErrorCode(Exception error){Win32Exception native=error as Win32Exception;return native==null?(int?)null:native.NativeErrorCode;}
    static string NormalizeDirectory(string value){string full=Path.GetFullPath(value);string root=Path.GetPathRoot(full);while(full.Length>root.Length&&(full.EndsWith("\\",StringComparison.Ordinal)||full.EndsWith("/",StringComparison.Ordinal)))full=full.Substring(0,full.Length-1);return full;}

    public sealed class DirectorySecurityLease:IDisposable{
        readonly SafeFileHandle handle;readonly string expectedPath;readonly string identity;readonly byte[] original;
        public bool DenyAttempted{get;private set;}public bool DenyActive{get;private set;}public bool Restored{get;private set;}public string DiagnosticStage{get;private set;}
        public string IdentityValue{get{return identity;}}public string FinalPathValue{get{return FinalPath(handle);}}public string OriginalSecuritySha256{get{return Sha256Bytes(original);}}public string CurrentSecuritySha256{get{return Sha256Bytes(Security(handle));}}
        public DirectorySecurityLease(string path){expectedPath=Path.GetFullPath(path);handle=CreateFileW(expectedPath,ReadControl|WriteDac,FileShareRead|FileShareWrite|FileShareDelete,IntPtr.Zero,OpenExisting,FileFlagBackupSemantics|FileFlagOpenReparsePoint,IntPtr.Zero);if(handle.IsInvalid)throw Error("CreateFileW directory");try{if(!String.Equals(FinalPath(handle),expectedPath,StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Directory final path differs");identity=Identity(handle);original=Security(handle);RawSecurityDescriptor raw=new RawSecurityDescriptor(original,0);if((raw.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0)throw new InvalidDataException("Directory DACL is inheriting");}catch{handle.Dispose();throw;}}
        void AssertIdentity(){if(!String.Equals(FinalPath(handle),expectedPath,StringComparison.OrdinalIgnoreCase)||Identity(handle)!=identity)throw new InvalidDataException("Directory handle identity changed");}
        public void ApplyDeny(){DiagnosticStage="deny-identity-before";AssertIdentity();DenyAttempted=true;RawSecurityDescriptor raw=new RawSecurityDescriptor(original,0);RawAcl old=raw.DiscretionaryAcl;if(old==null)throw new InvalidDataException("Directory DACL is absent");SecurityIdentifier everyone=new SecurityIdentifier(WellKnownSidType.WorldSid,null);RawAcl next=new RawAcl(old.Revision,old.Count+1);next.InsertAce(0,new CommonAce(AceFlags.None,AceQualifier.AccessDenied,FileAddFile,everyone,false,null));for(int i=0;i<old.Count;i++)next.InsertAce(i+1,old[i]);RawSecurityDescriptor changed=new RawSecurityDescriptor(raw.ControlFlags,raw.Owner,raw.Group,raw.SystemAcl,next);byte[] bytes=new byte[changed.BinaryLength];changed.GetBinaryForm(bytes,0);DiagnosticStage="deny-set-dacl";SetFileDacl(handle,bytes);DiagnosticStage="deny-identity-after";AssertIdentity();DiagnosticStage="deny-readback";RawSecurityDescriptor observed=new RawSecurityDescriptor(Security(handle),0);DiagnosticStage="deny-ace-proof";CommonAce first=observed.DiscretionaryAcl[0] as CommonAce;if((observed.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0||first==null||first.AceQualifier!=AceQualifier.AccessDenied||first.AccessMask!=FileAddFile||first.AceFlags!=AceFlags.None||!everyone.Equals(first.SecurityIdentifier))throw new InvalidDataException("Directory deny ACE differs");DenyActive=true;DiagnosticStage=null;}
        public void ProveCreateDenied(string target){DiagnosticStage="create-denied-identity";AssertIdentity();DiagnosticStage="create-denied-target";if(!String.Equals(Path.GetDirectoryName(Path.GetFullPath(target)),expectedPath,StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Denied target is outside directory");DiagnosticStage="create-denied-attempt";try{using(FileStream stream=new FileStream(target,FileMode.CreateNew,FileAccess.Write,FileShare.None)){}File.Delete(target);throw new InvalidDataException("Directory create was not denied");}catch(UnauthorizedAccessException){}DiagnosticStage=null;}
        public void RestoreOriginalSecurity(){if(!DenyAttempted){DiagnosticStage="restore-identity-without-deny";AssertIdentity();DiagnosticStage="restore-readback-without-deny";if(!Equal(Security(handle),original))throw new InvalidDataException("Directory security changed without deny");Restored=true;DiagnosticStage=null;return;}DiagnosticStage="restore-set-dacl";SetFileDacl(handle,original);DiagnosticStage="restore-identity";AssertIdentity();DiagnosticStage="restore-readback";if(!Equal(Security(handle),original))throw new InvalidDataException("Directory security did not restore exactly");DenyActive=false;Restored=true;DiagnosticStage=null;}
        public void Dispose(){handle.Dispose();}
    }

    public sealed class RecordSnapshot{public uint MessageTypeCode;public string[] Fields;public int? Field1Integer;}
    static RecordSnapshot SnapshotRecord(uint messageType,uint record){uint count=MsiRecordGetFieldCount(record);if(count>MaximumFields)throw new InvalidDataException("MSI record field count exceeded");string[] fields=new string[count];for(uint field=1;field<=count;field++){uint needed=0;StringBuilder probe=new StringBuilder(1);uint result=MsiRecordGetStringW(record,field,probe,ref needed);if(result==ErrorSuccess&&needed==0){fields[field-1]=String.Empty;continue;}if(result!=ErrorMoreData||needed>MaximumFieldCharacters)throw new InvalidDataException("MSI record field length differs");StringBuilder value=new StringBuilder(checked((int)needed+1));uint capacity=needed+1;result=MsiRecordGetStringW(record,field,value,ref capacity);if(result!=ErrorSuccess||capacity!=needed||value.Length!=needed)throw new InvalidDataException("MSI record changed while reading");fields[field-1]=value.ToString();}int first=count==0?unchecked((int)0x80000000):MsiRecordGetInteger(record,1);return new RecordSnapshot{MessageTypeCode=messageType,Fields=fields,Field1Integer=first==unchecked((int)0x80000000)?(int?)null:first};}

    public sealed class InstallContextTracker{
        readonly string candidateCode,predecessorCode;readonly Stack<string> contexts=new Stack<string>();
        bool candidateStarted,candidateEnded,predecessorStarted,predecessorEnded;
        public InstallContextTracker(string candidate,string predecessor){candidateCode=candidate;predecessorCode=predecessor;}
        public bool InCandidate{get{return contexts.Count==1&&String.Equals(contexts.Peek(),candidateCode,StringComparison.Ordinal);}}
        public bool Balanced{get{return contexts.Count==0&&candidateStarted&&candidateEnded&&predecessorStarted&&predecessorEnded;}}
        public void Start(string productCode){if(String.Equals(productCode,candidateCode,StringComparison.Ordinal)){
                if(candidateStarted||contexts.Count!=0)throw new InvalidDataException("Candidate install context is duplicated or nested");candidateStarted=true;contexts.Push(productCode);return;}
            if(String.Equals(productCode,predecessorCode,StringComparison.Ordinal)){
                if(predecessorStarted||!InCandidate)throw new InvalidDataException("Predecessor install context is duplicated or misplaced");predecessorStarted=true;contexts.Push(productCode);return;}
            throw new InvalidDataException("Unexpected install context");}
        public void End(string productCode){if(contexts.Count==0||!String.Equals(contexts.Peek(),productCode,StringComparison.Ordinal))throw new InvalidDataException("Install context end is unbalanced");
            contexts.Pop();if(String.Equals(productCode,predecessorCode,StringComparison.Ordinal)){if(predecessorEnded)throw new InvalidDataException("Predecessor install context ended twice");predecessorEnded=true;return;}
            if(!String.Equals(productCode,candidateCode,StringComparison.Ordinal)||candidateEnded||!predecessorEnded)throw new InvalidDataException("Candidate install context ended before predecessor context");candidateEnded=true;}
    }

    public sealed class CallbackState{
        readonly string predecessorCode,targetPath,fileName,targetDirectory;readonly long payloadBytes;readonly DirectorySecurityLease lease;readonly InstallContextTracker installContext;
        readonly List<RecordSnapshot> records=new List<RecordSnapshot>();string currentAction,currentStage;
        public string Failure{get;private set;}public string FailureStage{get;private set;}public int? FailureNativeErrorCode{get;private set;}public string CleanupFailure{get;private set;}public string CleanupFailureStage{get;private set;}public int? CleanupFailureNativeErrorCode{get;private set;}public bool RemovalStartSeen{get;private set;}public bool RemovalProductSeen{get;private set;}
        public bool InstallFilesSeen{get;private set;}public bool DenyInjectionAttempted{get;private set;}public bool InstallDataSeen{get;private set;}public bool ErrorSeen{get;private set;}
        public bool SecurityRestoredBeforeCancel{get;private set;}public int ErrorResponse{get;private set;}public bool InstallContextBalanced{get{return installContext.Balanced;}}public RecordSnapshot[] Records{get{return records.ToArray();}}
        public CallbackState(string predecessor,string candidate,string target,long expectedBytes,DirectorySecurityLease security){predecessorCode=predecessor;targetPath=Path.GetFullPath(target);fileName=Path.GetFileName(targetPath);targetDirectory=NormalizeDirectory(Path.GetDirectoryName(targetPath));payloadBytes=expectedBytes;lease=security;installContext=new InstallContextTracker(candidate,predecessor);}
        bool MatchesTarget(string value){try{return String.Equals(Path.GetFullPath(value),targetPath,StringComparison.OrdinalIgnoreCase);}catch{return false;}}
        int Observe(RecordSnapshot record){currentStage="record-bound";if(records.Count>=MaximumRecords)throw new InvalidDataException("Callback record count exceeded");records.Add(record);uint messageClass=record.MessageTypeCode&MessageClassMask;
            if(messageClass==MessageInstallStart||messageClass==MessageInstallEnd){currentStage="install-context";if(record.Fields.Length<2||String.IsNullOrEmpty(record.Fields[1]))throw new InvalidDataException("Install context record differs");if(messageClass==MessageInstallStart)installContext.Start(record.Fields[1]);else installContext.End(record.Fields[1]);return ResponseOk;}
            if(SecurityRestoredBeforeCancel)return ResponseOk;if(messageClass==MessageActionStart){currentStage="action-start";if(record.Fields.Length<1)throw new InvalidDataException("ACTIONSTART record is empty");if(!installContext.InCandidate)return ResponseOk;currentAction=record.Fields[0];if(currentAction=="RemoveExistingProducts")RemovalStartSeen=true;if(currentAction=="InstallFiles"){if(DenyInjectionAttempted)throw new InvalidDataException("Deny injection was already attempted");DenyInjectionAttempted=true;if(!RemovalProductSeen||File.Exists(targetPath))throw new InvalidDataException("InstallFiles began before predecessor removal proof");currentStage="apply-deny";lease.ApplyDeny();currentStage="prove-create-denied";lease.ProveCreateDenied(targetPath);InstallFilesSeen=true;}return ResponseOk;}if(messageClass==MessageActionData){currentStage="action-data";if(!installContext.InCandidate)return ResponseOk;if(currentAction=="RemoveExistingProducts"&&record.Fields.Length>=1&&record.Fields[0]==predecessorCode)RemovalProductSeen=true;if(currentAction=="InstallFiles"&&record.Fields.Length>=9&&String.Equals(record.Fields[0],fileName,StringComparison.Ordinal)&&record.Fields[5]==payloadBytes.ToString(System.Globalization.CultureInfo.InvariantCulture)&&String.Equals(NormalizeDirectory(record.Fields[8]),targetDirectory,StringComparison.OrdinalIgnoreCase))InstallDataSeen=true;return ResponseOk;}if(messageClass==MessageError){currentStage="error-binding";if(!installContext.InCandidate)throw new InvalidDataException("ERROR occurred outside the candidate install context");int targetMatches=0;for(int index=1;index<record.Fields.Length;index++)if(MatchesTarget(record.Fields[index]))targetMatches++;if(!InstallFilesSeen||!InstallDataSeen||!lease.DenyActive||record.Field1Integer!=ErrorWritingToFile||targetMatches!=1)throw new InvalidDataException("ERROR record is not bound to the denied target");currentStage="restore-before-cancel";lease.RestoreOriginalSecurity();SecurityRestoredBeforeCancel=true;ErrorSeen=true;currentStage="error-response-style";uint style=record.MessageTypeCode&MessageStyleMask;if(style==ErrorRetryCancelStyle)ErrorResponse=ResponseCancel;else if(style==ErrorAbortRetryIgnoreStyle)ErrorResponse=ResponseAbort;else throw new InvalidDataException("ERROR response style is unsupported");return ErrorResponse;}return ResponseOk;}
        string DiagnosticFailureStage(){return (currentStage=="apply-deny"||currentStage=="prove-create-denied"||currentStage=="restore-before-cancel")&&lease.DiagnosticStage!=null?lease.DiagnosticStage:currentStage;}
        public int Invoke(IntPtr context,uint messageType,uint recordHandle){try{currentStage="snapshot-record";return Observe(SnapshotRecord(messageType,recordHandle));}catch(Exception error){if(Failure==null){Failure="callback-record-or-observer-failure";FailureStage=DiagnosticFailureStage();FailureNativeErrorCode=NativeErrorCode(error);}try{lease.RestoreOriginalSecurity();}catch(Exception cleanup){if(CleanupFailure==null){CleanupFailure="callback-security-restore-failure";CleanupFailureStage=lease.DiagnosticStage??"callback-security-restore";CleanupFailureNativeErrorCode=NativeErrorCode(cleanup);}}return CallbackFailureReturn;}}
    }

    public sealed class CalibrationResult{public uint PredecessorInstallReturn,CandidateInstallReturn,PredecessorUninstallReturn,CandidateUninstallReturn;public int PredecessorAfterRollback,CandidateAfterRollback,PredecessorAfterCleanup,CandidateAfterCleanup;public bool predecessorPayloadRestored,candidateAbsent,sentinelPreserved,sentinelBytesPreserved,securityRestored,accepted;public string predecessorPayloadSha256,directoryIdentity,directoryFinalPath,securityDescriptorBeforeSha256,securityDescriptorAfterSha256,primaryFailure;public string[] cleanupFailures;public CallbackState Callback;}
    static string Sha256File(string path){using(FileStream stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)){using(SHA256 hash=SHA256.Create()){return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-",String.Empty).ToLowerInvariant();}}}
    static void Attempt(List<string> failures,string category,Action action){try{action();}catch{failures.Add(category);}}
    public static CalibrationResult RunCalibration(string predecessorMsi,string candidateMsi,string predecessorCode,string candidateCode,string targetDirectory,string targetFile,string marker,string markerValue,string predecessorHash,long payloadBytes,string logPath){
        CalibrationResult output=new CalibrationResult();List<string> cleanupFailures=new List<string>();DirectorySecurityLease lease=null;IntPtr owner=IntPtr.Zero,previousHandler=IntPtr.Zero,ignored=IntPtr.Zero;InstallUiHandlerRecord callback=null;uint priorUi=0;bool uiChanged=false,handlerSet=false,logSet=false,ownedDirectoryCreated=false,predecessorInstallAttempted=false,candidateInstallAttempted=false;
        try{
            if(MsiQueryProductStateW(predecessorCode)!=InstallStateUnknown||MsiQueryProductStateW(candidateCode)!=InstallStateUnknown)throw new InvalidOperationException("Sacrificial product collision");if(Directory.Exists(targetDirectory))throw new InvalidOperationException("Owned target collision");Directory.CreateDirectory(targetDirectory);ownedDirectoryCreated=true;DirectorySecurity initial=Directory.GetAccessControl(targetDirectory);initial.SetAccessRuleProtection(true,true);Directory.SetAccessControl(targetDirectory,initial);using(FileStream markerStream=new FileStream(marker,FileMode.CreateNew,FileAccess.Write,FileShare.None)){byte[] markerBytes=Encoding.ASCII.GetBytes(markerValue+"\n");markerStream.Write(markerBytes,0,markerBytes.Length);markerStream.Flush(true);}
            priorUi=MsiSetInternalUI(InstallUiLevelNone,ref owner);uiChanged=true;predecessorInstallAttempted=true;output.PredecessorInstallReturn=MsiInstallProductW(predecessorMsi,"REBOOT=ReallySuppress");if(output.PredecessorInstallReturn!=ErrorSuccess)throw new InvalidOperationException("Predecessor install failed");if(MsiQueryProductStateW(predecessorCode)!=InstallStateDefault)throw new InvalidOperationException("Predecessor product state differs");if(!File.Exists(targetFile)||Sha256File(targetFile)!=predecessorHash)throw new InvalidOperationException("Predecessor payload differs");
            lease=new DirectorySecurityLease(targetDirectory);output.directoryIdentity=lease.IdentityValue;output.directoryFinalPath=lease.FinalPathValue;output.securityDescriptorBeforeSha256=lease.OriginalSecuritySha256;CallbackState state=new CallbackState(predecessorCode,candidateCode,targetFile,payloadBytes,lease);output.Callback=state;callback=delegate(IntPtr context,uint messageType,uint recordHandle){return state.Invoke(context,messageType,recordHandle);};uint set=MsiSetExternalUIRecord(callback,RequiredMessageFilter,IntPtr.Zero,out previousHandler);if(set!=ErrorSuccess)throw new Win32Exception((int)set,"MsiSetExternalUIRecord");handlerSet=true;if(previousHandler!=IntPtr.Zero)throw new InvalidOperationException("Previous external UI handler collision");uint log=MsiEnableLogW(InstallLogModeVerbose|InstallLogModeExtraDebug,logPath,InstallLogAttributesFlushEachLine);if(log!=ErrorSuccess)throw new Win32Exception((int)log,"MsiEnableLogW");logSet=true;
            candidateInstallAttempted=true;try{output.CandidateInstallReturn=MsiInstallProductW(candidateMsi,"REBOOT=ReallySuppress");}finally{GC.KeepAlive(callback);}if(output.CandidateInstallReturn!=1602)throw new InvalidOperationException("Candidate did not return controller cancellation");if(state.Failure!=null||state.CleanupFailure!=null||!state.InstallContextBalanced||!state.RemovalStartSeen||!state.RemovalProductSeen||!state.InstallFilesSeen||!state.InstallDataSeen||!state.ErrorSeen||!state.SecurityRestoredBeforeCancel)throw new InvalidOperationException("Callback calibration proof is incomplete");
            output.PredecessorAfterRollback=MsiQueryProductStateW(predecessorCode);output.CandidateAfterRollback=MsiQueryProductStateW(candidateCode);output.predecessorPayloadRestored=File.Exists(targetFile);output.predecessorPayloadSha256=output.predecessorPayloadRestored?Sha256File(targetFile):null;output.candidateAbsent=output.CandidateAfterRollback==InstallStateUnknown;output.sentinelPreserved=File.Exists(marker);output.sentinelBytesPreserved=output.sentinelPreserved&&Encoding.ASCII.GetString(File.ReadAllBytes(marker))==markerValue+"\n";if(output.PredecessorAfterRollback!=InstallStateDefault||!output.predecessorPayloadRestored||output.predecessorPayloadSha256!=predecessorHash||!output.candidateAbsent||!output.sentinelBytesPreserved)throw new InvalidOperationException("Rollback state differs");
        }catch{output.primaryFailure="native-calibration-failed";}
        finally{
            if(lease!=null&&lease.DenyAttempted&&!lease.Restored)Attempt(cleanupFailures,"security-restore",delegate{lease.RestoreOriginalSecurity();});
            if(logSet)Attempt(cleanupFailures,"log-disable",delegate{uint value=MsiEnableLogW(0,null,0);if(value!=ErrorSuccess)throw new Win32Exception((int)value,"Disable MSI log");});
            if(handlerSet)Attempt(cleanupFailures,"handler-disable",delegate{uint value=MsiSetExternalUIRecord(null,0,IntPtr.Zero,out ignored);if(value!=ErrorSuccess)throw new Win32Exception((int)value,"Disable external UI");});
            if(lease!=null){Attempt(cleanupFailures,"security-post-proof",delegate{if(!lease.Restored)lease.RestoreOriginalSecurity();if(lease.IdentityValue!=output.directoryIdentity||!String.Equals(lease.FinalPathValue,output.directoryFinalPath,StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Directory identity changed");output.securityDescriptorAfterSha256=lease.CurrentSecuritySha256;if(output.securityDescriptorAfterSha256!=output.securityDescriptorBeforeSha256)throw new InvalidDataException("Directory descriptor hash changed");output.securityRestored=true;});Attempt(cleanupFailures,"security-handle-close",delegate{lease.Dispose();});}
            if(candidateInstallAttempted)Attempt(cleanupFailures,"candidate-uninstall",delegate{if(MsiQueryProductStateW(candidateCode)!=InstallStateUnknown){output.CandidateUninstallReturn=MsiConfigureProductExW(candidateCode,InstallLevelDefault,InstallStateAbsent,"REBOOT=ReallySuppress");if(output.CandidateUninstallReturn!=ErrorSuccess)throw new InvalidOperationException("Candidate cleanup failed");}});
            if(predecessorInstallAttempted)Attempt(cleanupFailures,"predecessor-uninstall",delegate{if(MsiQueryProductStateW(predecessorCode)!=InstallStateUnknown){output.PredecessorUninstallReturn=MsiConfigureProductExW(predecessorCode,InstallLevelDefault,InstallStateAbsent,"REBOOT=ReallySuppress");if(output.PredecessorUninstallReturn!=ErrorSuccess)throw new InvalidOperationException("Predecessor cleanup failed");}});
            Attempt(cleanupFailures,"product-state-proof",delegate{output.PredecessorAfterCleanup=MsiQueryProductStateW(predecessorCode);output.CandidateAfterCleanup=MsiQueryProductStateW(candidateCode);if(output.PredecessorAfterCleanup!=InstallStateUnknown||output.CandidateAfterCleanup!=InstallStateUnknown)throw new InvalidOperationException("Product cleanup proof failed");});
            if(ownedDirectoryCreated)Attempt(cleanupFailures,"owned-path-cleanup",delegate{if(File.Exists(marker)){if(Encoding.ASCII.GetString(File.ReadAllBytes(marker))!=markerValue+"\n")throw new InvalidOperationException("Owned marker identity changed");File.Delete(marker);}if(Directory.Exists(targetDirectory)){if(Directory.GetFileSystemEntries(targetDirectory).Length!=0)throw new InvalidOperationException("Owned target is not empty");Directory.Delete(targetDirectory);}if(File.Exists(marker)||Directory.Exists(targetDirectory))throw new InvalidOperationException("Owned path cleanup proof failed");});
            if(uiChanged)Attempt(cleanupFailures,"internal-ui-restore",delegate{uint observed=MsiSetInternalUI(priorUi,ref owner);if(observed!=InstallUiLevelNone)throw new InvalidOperationException("Internal UI restoration state differed");});
            output.cleanupFailures=cleanupFailures.ToArray();output.accepted=output.primaryFailure==null&&output.cleanupFailures.Length==0&&output.securityRestored;
        }
        return output;
    }
    public static uint InstallPredecessor(string path){return MsiInstallProductW(path,"REBOOT=ReallySuppress");}
    public static uint InstallCandidate(string path){return MsiInstallProductW(path,"REBOOT=ReallySuppress");}
    public static uint UninstallProduct(string code){return MsiConfigureProductExW(code,InstallLevelDefault,InstallStateAbsent,"REBOOT=ReallySuppress");}
    public static int QueryProductState(string code){return MsiQueryProductStateW(code);}
}
'@ -Language CSharp -ErrorAction Stop
    [pscustomobject]@{nativeType=[MyspeedMsiRollbackNative]}
}

function Invoke-MyspeedRollbackHostedCalibration {
    param($Expected)
    Assert-MyspeedRollbackNativeHostedContext $Expected
    $factory=New-MyspeedRollbackNativeOperations $Expected
    $nativeExecutionAttempted = $true
    $failure = $null
    $result = $null
    try {
        $targetDirectory=Join-Path $env:ProgramData ('MyspeedRollback-'+$Expected.nonce)
        $targetFile=Join-Path $targetDirectory 'rollback-payload.txt'
        $marker=Join-Path $targetDirectory ('owner-'+$Expected.nonce+'.marker')
        $logPath=Join-Path ([IO.Path]::GetDirectoryName($Expected.evidencePath)) 'installer.log'
        $result=$factory.nativeType::RunCalibration($Expected.predecessorMsiPath,$Expected.candidateMsiPath,
            $script:PredecessorProductCode,$script:CandidateProductCode,$targetDirectory,$targetFile,$marker,
            $Expected.nonce,$script:PredecessorPayloadSha256,$script:CandidatePayloadBytes,$logPath)
        if ($result.accepted -ne $true) { $failure = 'native-calibration-rejected' }
    } catch {
        $failure = 'native-calibration-failed'
    }
    $record=[ordered]@{schemaVersion=1;kind='myspeed-msi-sacrificial-native-calibration';
        status=if($null -eq $failure){'observed'}else{'failed'};qualifying=$false;nativeExecutionAttempted=$nativeExecutionAttempted;
        failureCategory=$failure;sourceSha=$Expected.sourceSha;eventSha=$Expected.eventSha;
        runId=$Expected.runId;runAttempt=$Expected.runAttempt;nonce=$Expected.nonce;result=$result;releaseGatesCleared=@()}
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($record|ConvertTo-Json -Compress -Depth 20))
    if($bytes.Length -le 0 -or $bytes.Length -gt $script:MaximumEvidenceBytes){throw 'Native evidence exceeds its bound'}
    $stream=[IO.File]::Open($Expected.evidencePath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
    if($null -ne $failure){throw $failure}
    $record
}

if($MyInvocation.InvocationName -ne '.'){
    switch($Mode){
        'Library'{return}
        'GetContract'{Get-MyspeedRollbackNativeContract|ConvertTo-Json -Compress -Depth 8;return}
        'InvokeHostedCalibration'{
            if([string]::IsNullOrWhiteSpace($InputJson)){throw 'InputJson is required'}
            Invoke-MyspeedRollbackHostedCalibration (ConvertFrom-Json -InputObject $InputJson)|ConvertTo-Json -Compress -Depth 20
            return
        }
    }
}
