[CmdletBinding()]
param(
    [ValidateSet('Library','GetContract','TestInjected','InvokeGuestCandidateRollback')]
    [string]$Mode='Library',
    [string]$CandidateMsiPath,
    [string]$CandidateMsiSha256,
    [string]$CandidateProductCode,
    [int64]$CandidatePayloadBytes,
    [string]$PredecessorProductCode,
    [string]$PredecessorPayloadSha256,
    [string]$EvidenceRoot,
    [string]$Nonce,
    [string]$ExpectedSerial,
    [string]$HelperSha256,
    [string]$InputJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$script:MaximumMsiBytes=1073741824
$script:MaximumHelperBytes=1048576
$script:MaximumEvidenceBytes=1048576
$script:ProductPattern='\A\{[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\}\z'
$script:HashPattern='\A[a-f0-9]{64}\z'
$script:NoncePattern='\A[a-f0-9]{32}\z'
$script:TargetDirectory='C:\Program Files\MySpeed'
$script:TargetFile='C:\Program Files\MySpeed\MySpeed.exe'
$script:ErrorCreatingDestinationFile=1310

function Assert-MyspeedGuestRollbackExactObject {
    param($Value,[string[]]$Keys,[string]$Label)
    if($null -eq $Value -or $Value -is [array] -or $Value -is [string] -or $Value -is [ValueType]){
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

function Get-MyspeedGuestRollbackSha256 {
    param([string]$Path)
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{$hash=[Security.Cryptography.SHA256]::Create();try{
        ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant()
    }finally{$hash.Dispose()}}finally{$stream.Dispose()}
}

function Assert-MyspeedGuestRollbackFile {
    param([string]$Path,[string]$ExpectedSha,[int64]$MaximumBytes,[string]$Label)
    $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType -or
        $item.Length -lt 1 -or $item.Length -gt $MaximumBytes -or
        (Get-MyspeedGuestRollbackSha256 $Path) -cne $ExpectedSha){throw "$Label identity differs"}
}

function Assert-MyspeedGuestRollbackScalar {
    param($Value,[string]$Pattern,[string]$Label)
    if($Value -isnot [string] -or $Value -cnotmatch $Pattern){throw "$Label differs"}
    $Value
}

function Assert-MyspeedGuestRollbackContext {
    if($PSVersionTable.PSEdition -cne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or
        $PSVersionTable.PSVersion.Minor -ne 1){throw 'Guest rollback requires inbox Windows PowerShell 5.1'}
    $actualShell=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    $expectedShell=[IO.Path]::Combine($env:SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe')
    if(-not [string]::Equals($actualShell,$expectedShell,[StringComparison]::OrdinalIgnoreCase)){
        throw 'Guest rollback shell identity differs'
    }
    foreach($value in @($Nonce,$ExpectedSerial)){
        [void](Assert-MyspeedGuestRollbackScalar $value $script:NoncePattern 'Guest rollback nonce')
    }
    if(-not [string]::Equals($Nonce,$ExpectedSerial,[StringComparison]::Ordinal)){
        throw 'Guest rollback serial and nonce differ'
    }
    $bios=@(Get-CimInstance Win32_BIOS -ErrorAction Stop)
    $computer=@(Get-CimInstance Win32_ComputerSystem -ErrorAction Stop)
    $adapters=@(Get-NetAdapter -IncludeHidden -ErrorAction Stop|Where-Object HardwareInterface)
    if($bios.Count -ne 1 -or $computer.Count -ne 1 -or
        -not [string]::Equals([string]$bios[0].SerialNumber,$ExpectedSerial,[StringComparison]::Ordinal) -or
        [string]$computer[0].Manufacturer -notmatch '\AQEMU(?: |$)' -or $adapters.Count -ne 0){
        throw 'Guest rollback requires the exact NIC-free QEMU guest'
    }
    $root=Get-Item -LiteralPath $EvidenceRoot -Force -ErrorAction Stop
    if($root -isnot [IO.DirectoryInfo] -or ($root.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $root.LinkType){throw 'Guest rollback evidence root identity differs'}
}

function Assert-MyspeedGuestRollbackInput {
    foreach($value in @($CandidateMsiSha256,$PredecessorPayloadSha256,$HelperSha256)){
        [void](Assert-MyspeedGuestRollbackScalar $value $script:HashPattern 'Guest rollback SHA-256')
    }
    foreach($value in @($CandidateProductCode,$PredecessorProductCode)){
        [void](Assert-MyspeedGuestRollbackScalar $value $script:ProductPattern 'Guest rollback ProductCode')
    }
    if($CandidateProductCode -ceq $PredecessorProductCode -or $CandidatePayloadBytes -lt 1 -or
        $CandidatePayloadBytes -gt 1073741824){throw 'Guest rollback candidate binding differs'}
    $helper=$MyInvocation.MyCommand.Path
    Assert-MyspeedGuestRollbackFile $helper $HelperSha256 $script:MaximumHelperBytes 'Guest rollback helper'
    Assert-MyspeedGuestRollbackFile ([IO.Path]::GetFullPath($CandidateMsiPath)) $CandidateMsiSha256 `
        $script:MaximumMsiBytes 'Guest rollback candidate MSI'
}

function New-MyspeedGuestRollbackNativeType {
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

public static class MyspeedMsiGuestRollback {
  const uint ErrorSuccess=0,ErrorMoreData=234,ErrorInsufficientBuffer=122;
  const uint ReadControl=0x00020000,WriteDac=0x00040000;
  const uint OwnerSecurityInformation=1,GroupSecurityInformation=2,DaclSecurityInformation=4;
  const uint ProtectedDaclSecurityInformation=0x80000000u,UnprotectedDaclSecurityInformation=0x20000000u;
  const int SeFileObject=1,FileAddFile=2,MaximumSecurityDescriptorBytes=65536,MaximumFinalPathCharacters=32768;
  const int SecurityDescriptorRelativeHeaderBytes=20,DaclOffsetFieldByteOffset=16,MaximumRecords=256;
  const int MaximumFields=16,MaximumFieldCharacters=4096,InstallStateUnknown=-1,InstallStateDefault=5;
  const int InstallLevelDefault=0,InstallStateAbsent=2,ErrorCreatingDestinationFile=1310,ExpectedSystemError=0;
  const uint ErrorInstallUserExit=1602,ErrorInstallFailure=1603;
  const int ExpectedErrorFieldCount=3,ExpectedErrorCodeFieldIndex=0,ExpectedSystemErrorFieldIndex=1,ExpectedTargetFieldIndex=2;
  const uint FileShareRead=1,FileShareWrite=2,FileShareDelete=4,OpenExisting=3;
  const uint FileFlagBackupSemantics=0x02000000,FileFlagOpenReparsePoint=0x00200000;
  const uint InstallUiLevelNone=2,InstallLogModeVerbose=1u<<12,InstallLogModeExtraDebug=1u<<13;
  const uint InstallLogAttributesFlushEachLine=1u<<1;
  const uint RequiredMessageFilter=(1u<<0)|(1u<<1)|(1u<<8)|(1u<<9)|(1u<<26)|(1u<<27);
  const uint MessageClassMask=0xFF000000,MessageStyleMask=0x0000000F;
  const uint MessageError=0x01000000,MessageActionStart=0x08000000,MessageActionData=0x09000000;
  const uint MessageInstallStart=0x1A000000,MessageInstallEnd=0x1B000000;
  const uint ErrorRetryCancelStyle=5;
  const int ResponseOk=1,ResponseCancel=2,CallbackFailureReturn=-1;

  [StructLayout(LayoutKind.Sequential)] struct FILETIME{public uint low,high;}
  [StructLayout(LayoutKind.Sequential)] struct BY_HANDLE_FILE_INFORMATION{public uint attributes;public FILETIME creation,lastAccess,lastWrite;public uint volumeSerial,fileSizeHigh,fileSizeLow;public uint links,fileIndexHigh,fileIndexLow;}
  [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int InstallUiHandlerRecord(IntPtr context,uint messageType,uint recordHandle);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string name,uint access,uint sharing,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out BY_HANDLE_FILE_INFORMATION info);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,StringBuilder path,uint characters,uint flags);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetKernelObjectSecurity(SafeFileHandle handle,uint information,byte[] descriptor,uint length,out uint needed);
  [DllImport("advapi32.dll",ExactSpelling=true)] static extern uint SetSecurityInfo(SafeFileHandle handle,int objectType,uint information,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("msi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern uint MsiSetExternalUIRecord(InstallUiHandlerRecord handler,uint filter,IntPtr context,out IntPtr previous);
  [DllImport("msi.dll",ExactSpelling=true)] static extern uint MsiSetInternalUI(uint level,ref IntPtr owner);
  [DllImport("msi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern uint MsiEnableLogW(uint mode,string path,uint attributes);
  [DllImport("msi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern uint MsiInstallProductW(string path,string commandLine);
  [DllImport("msi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern uint MsiConfigureProductExW(string code,int level,int state,string commandLine);
  [DllImport("msi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern int MsiQueryProductStateW(string code);
  [DllImport("msi.dll",ExactSpelling=true)] static extern uint MsiRecordGetFieldCount(uint record);
  [DllImport("msi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern uint MsiRecordGetStringW(uint record,uint field,StringBuilder value,ref uint characters);
  [DllImport("msi.dll",ExactSpelling=true)] static extern int MsiRecordGetInteger(uint record,uint field);

  static Exception Error(string operation){return new Win32Exception(Marshal.GetLastWin32Error(),operation);}
  static string Sha256Bytes(byte[] value){using(SHA256 hash=SHA256.Create()){return BitConverter.ToString(hash.ComputeHash(value)).Replace("-",String.Empty).ToLowerInvariant();}}
  static string Sha256File(string path){using(FileStream stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)){using(SHA256 hash=SHA256.Create()){return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-",String.Empty).ToLowerInvariant();}}}
  static bool Equal(byte[] a,byte[] b){if(a==null||b==null||a.Length!=b.Length)return false;for(int i=0;i<a.Length;i++)if(a[i]!=b[i])return false;return true;}
  static string FinalPath(SafeFileHandle handle){StringBuilder b=new StringBuilder(MaximumFinalPathCharacters);uint n=GetFinalPathNameByHandleW(handle,b,(uint)b.Capacity,0);if(n==0)throw Error("GetFinalPathNameByHandleW");if(n>=b.Capacity)throw new InvalidDataException("Directory final path exceeded bound");string value=b.ToString();return value.StartsWith("\\\\?\\",StringComparison.Ordinal)?value.Substring(4):value;}
  static string Identity(SafeFileHandle handle){BY_HANDLE_FILE_INFORMATION i;if(!GetFileInformationByHandle(handle,out i))throw Error("GetFileInformationByHandle");return i.volumeSerial.ToString("x8")+":"+(((ulong)i.fileIndexHigh<<32)|i.fileIndexLow).ToString("x16");}
  static byte[] Security(SafeFileHandle handle){uint info=OwnerSecurityInformation|GroupSecurityInformation|DaclSecurityInformation;uint needed;GetKernelObjectSecurity(handle,info,null,0,out needed);if(Marshal.GetLastWin32Error()!=ErrorInsufficientBuffer||needed==0||needed>MaximumSecurityDescriptorBytes)throw Error("GetKernelObjectSecurity length");byte[] b=new byte[needed];if(!GetKernelObjectSecurity(handle,info,b,(uint)b.Length,out needed)||needed!=b.Length)throw Error("GetKernelObjectSecurity");return b;}
  static void SetDacl(SafeFileHandle handle,byte[] descriptor,bool protect){if(descriptor==null||descriptor.Length<SecurityDescriptorRelativeHeaderBytes)throw new InvalidDataException("Directory descriptor differs");int offset=BitConverter.ToInt32(descriptor,DaclOffsetFieldByteOffset);if(offset<=0||offset>=descriptor.Length)throw new InvalidDataException("Directory DACL offset differs");GCHandle pinned=GCHandle.Alloc(descriptor,GCHandleType.Pinned);try{uint flags=DaclSecurityInformation|(protect?ProtectedDaclSecurityInformation:UnprotectedDaclSecurityInformation);uint result=SetSecurityInfo(handle,SeFileObject,flags,IntPtr.Zero,IntPtr.Zero,IntPtr.Add(pinned.AddrOfPinnedObject(),offset),IntPtr.Zero);if(result!=ErrorSuccess)throw new Win32Exception((int)result,"SetSecurityInfo file DACL");}finally{pinned.Free();}}
  static string NormalizeDirectory(string value){string full=Path.GetFullPath(value);string root=Path.GetPathRoot(full);while(full.Length>root.Length&&full.EndsWith("\\",StringComparison.Ordinal))full=full.Substring(0,full.Length-1);return full;}

  sealed class DirectoryLease:IDisposable{
    readonly SafeFileHandle handle;readonly string expectedPath,identity;readonly byte[] original;readonly bool originallyProtected;
    public bool DenyAttempted{get;private set;}public bool DenyActive{get;private set;}public bool Restored{get;private set;}
    public string BeforeSha{get{return Sha256Bytes(original);}}public string AfterSha{get{return Sha256Bytes(Security(handle));}}
    public DirectoryLease(string path){expectedPath=Path.GetFullPath(path);handle=CreateFileW(expectedPath,ReadControl|WriteDac,FileShareRead|FileShareWrite|FileShareDelete,IntPtr.Zero,OpenExisting,FileFlagBackupSemantics|FileFlagOpenReparsePoint,IntPtr.Zero);if(handle.IsInvalid)throw Error("CreateFileW directory");try{if(!String.Equals(FinalPath(handle),expectedPath,StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Directory final path differs");identity=Identity(handle);original=Security(handle);RawSecurityDescriptor raw=new RawSecurityDescriptor(original,0);originallyProtected=(raw.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0;}catch{handle.Dispose();throw;}}
    void AssertIdentity(){if(!String.Equals(FinalPath(handle),expectedPath,StringComparison.OrdinalIgnoreCase)||Identity(handle)!=identity)throw new InvalidDataException("Directory identity changed");}
    public void ApplyDeny(){AssertIdentity();DenyAttempted=true;RawSecurityDescriptor raw=new RawSecurityDescriptor(original,0);RawAcl old=raw.DiscretionaryAcl;if(old==null)throw new InvalidDataException("Directory DACL absent");SecurityIdentifier everyone=new SecurityIdentifier(WellKnownSidType.WorldSid,null);RawAcl next=new RawAcl(old.Revision,old.Count+1);next.InsertAce(0,new CommonAce(AceFlags.None,AceQualifier.AccessDenied,FileAddFile,everyone,false,null));for(int i=0;i<old.Count;i++)next.InsertAce(i+1,old[i]);RawSecurityDescriptor changed=new RawSecurityDescriptor(raw.ControlFlags,raw.Owner,raw.Group,raw.SystemAcl,next);byte[] bytes=new byte[changed.BinaryLength];changed.GetBinaryForm(bytes,0);SetDacl(handle,bytes,true);AssertIdentity();RawSecurityDescriptor observed=new RawSecurityDescriptor(Security(handle),0);CommonAce first=observed.DiscretionaryAcl[0] as CommonAce;if((observed.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0||first==null||first.AceQualifier!=AceQualifier.AccessDenied||first.AccessMask!=FileAddFile||first.AceFlags!=AceFlags.None||!everyone.Equals(first.SecurityIdentifier))throw new InvalidDataException("Directory deny differs");DenyActive=true;}
    public void ProveCreateDenied(string target){AssertIdentity();if(!String.Equals(Path.GetDirectoryName(Path.GetFullPath(target)),expectedPath,StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Denied target outside directory");try{using(FileStream stream=new FileStream(target,FileMode.CreateNew,FileAccess.Write,FileShare.None)){}}catch(UnauthorizedAccessException){return;}try{File.Delete(target);}catch{}throw new InvalidDataException("Directory create was not denied");}
    public void Restore(){if(DenyAttempted)SetDacl(handle,original,originallyProtected);AssertIdentity();if(!Equal(Security(handle),original))throw new InvalidDataException("Directory security did not restore");DenyActive=false;Restored=true;}
    public void Dispose(){handle.Dispose();}
  }

  sealed class Record{public uint Type;public string[] Fields;public int? FirstInteger;}
  static Record Snapshot(uint type,uint record){uint count=MsiRecordGetFieldCount(record);if(count>MaximumFields)throw new InvalidDataException("MSI record field count exceeded");string[] fields=new string[count];for(uint field=1;field<=count;field++){uint needed=0;StringBuilder probe=new StringBuilder(1);uint result=MsiRecordGetStringW(record,field,probe,ref needed);if(result==ErrorSuccess&&needed==0){fields[field-1]=String.Empty;continue;}if(result!=ErrorMoreData||needed>MaximumFieldCharacters)throw new InvalidDataException("MSI record length differs");StringBuilder value=new StringBuilder(checked((int)needed+1));uint capacity=needed+1;result=MsiRecordGetStringW(record,field,value,ref capacity);if(result!=ErrorSuccess||capacity!=needed||value.Length!=needed)throw new InvalidDataException("MSI record changed");fields[field-1]=value.ToString();}int first=count==0?unchecked((int)0x80000000):MsiRecordGetInteger(record,1);return new Record{Type=type,Fields=fields,FirstInteger=first==unchecked((int)0x80000000)?(int?)null:first};}
  sealed class Contexts{readonly string candidate,predecessor;readonly Stack<string> stack=new Stack<string>();bool cs,ce,ps,pe;public Contexts(string c,string p){candidate=c;predecessor=p;}public bool InCandidate{get{return stack.Count==1&&stack.Peek()==candidate;}}public bool Balanced{get{return stack.Count==0&&cs&&ce&&ps&&pe;}}public void Start(string code){if(code==candidate){if(cs||stack.Count!=0)throw new InvalidDataException("Candidate context differs");cs=true;stack.Push(code);}else if(code==predecessor){if(ps||!InCandidate)throw new InvalidDataException("Predecessor context differs");ps=true;stack.Push(code);}else throw new InvalidDataException("Unknown install context");}public void End(string code){if(stack.Count==0||stack.Peek()!=code)throw new InvalidDataException("Install context unbalanced");stack.Pop();if(code==predecessor){if(pe)throw new InvalidDataException("Predecessor ended twice");pe=true;}else{if(code!=candidate||ce||!pe)throw new InvalidDataException("Candidate end differs");ce=true;}}}
  sealed class CallbackState{
    readonly string predecessor,target,fileName,directory;readonly long bytes;readonly DirectoryLease lease;readonly Contexts contexts;readonly List<Record> records=new List<Record>();string action;
    public string Failure{get;private set;}public bool RemovalStart,RemovalProduct,InstallFiles,InstallData,ErrorSeen,RestoredBeforeCancel;public int ErrorCode;
    public bool Balanced{get{return contexts.Balanced;}}public Record[] Records{get{return records.ToArray();}}
    public CallbackState(string predecessorCode,string candidateCode,string targetPath,long payloadBytes,DirectoryLease value){predecessor=predecessorCode;target=Path.GetFullPath(targetPath);fileName=Path.GetFileName(target);directory=NormalizeDirectory(Path.GetDirectoryName(target));bytes=payloadBytes;lease=value;contexts=new Contexts(candidateCode,predecessorCode);}
    bool Target(string value){try{return String.Equals(Path.GetFullPath(value),target,StringComparison.OrdinalIgnoreCase);}catch{return false;}}
    int Observe(Record record){if(records.Count>=MaximumRecords)throw new InvalidDataException("MSI record count exceeded");records.Add(record);uint kind=record.Type&MessageClassMask;if(kind==MessageInstallStart||kind==MessageInstallEnd){if(record.Fields.Length<2||String.IsNullOrEmpty(record.Fields[1]))throw new InvalidDataException("Install context record differs");if(kind==MessageInstallStart)contexts.Start(record.Fields[1]);else contexts.End(record.Fields[1]);return ResponseOk;}if(RestoredBeforeCancel)return ResponseOk;if(kind==MessageActionStart){if(record.Fields.Length<1)throw new InvalidDataException("ACTIONSTART empty");if(!contexts.InCandidate)return ResponseOk;action=record.Fields[0];if(action=="RemoveExistingProducts")RemovalStart=true;if(action=="InstallFiles"){if(!lease.DenyAttempted){if(!RemovalProduct||File.Exists(target))throw new InvalidDataException("InstallFiles before removal proof");lease.ApplyDeny();lease.ProveCreateDenied(target);InstallFiles=true;}else{if(!lease.DenyActive)throw new InvalidDataException("Deny inactive");lease.ProveCreateDenied(target);}}return ResponseOk;}if(kind==MessageActionData){if(!contexts.InCandidate)return ResponseOk;if(action=="RemoveExistingProducts"&&record.Fields.Length>=1&&record.Fields[0]==predecessor)RemovalProduct=true;if(action=="InstallFiles"&&record.Fields.Length>=9&&record.Fields[0]==fileName&&record.Fields[5]==bytes.ToString(System.Globalization.CultureInfo.InvariantCulture)&&String.Equals(NormalizeDirectory(record.Fields[8]),directory,StringComparison.OrdinalIgnoreCase))InstallData=true;return ResponseOk;}if(kind==MessageError){if(!contexts.InCandidate)throw new InvalidDataException("ERROR outside candidate");uint style=record.Type&MessageStyleMask;if(!InstallFiles||!InstallData||!lease.DenyActive||record.FirstInteger!=ErrorCreatingDestinationFile||record.Fields.Length!=ExpectedErrorFieldCount||record.Fields[ExpectedErrorCodeFieldIndex]!=ErrorCreatingDestinationFile.ToString(System.Globalization.CultureInfo.InvariantCulture)||record.Fields[ExpectedSystemErrorFieldIndex]!=ExpectedSystemError.ToString(System.Globalization.CultureInfo.InvariantCulture)||!Target(record.Fields[ExpectedTargetFieldIndex])||style!=ErrorRetryCancelStyle)throw new InvalidDataException("ERROR binding differs");lease.Restore();RestoredBeforeCancel=true;ErrorSeen=true;ErrorCode=ErrorCreatingDestinationFile;return ResponseCancel;}return ResponseOk;}
    public int Invoke(IntPtr context,uint type,uint record){try{return Observe(Snapshot(type,record));}catch{Failure="callback-failed";try{lease.Restore();}catch{}return CallbackFailureReturn;}}
  }
  public sealed class Result{public uint CandidateInstallReturn;public bool accepted,installContextBalanced,securityRestored,predecessorRestored,candidateAbsent;public int errorCode;public string recordsSha256;}
  static string RecordsSha(Record[] records){StringBuilder b=new StringBuilder();foreach(Record record in records){b.Append(record.Type.ToString("x8")).Append(':').Append(record.Fields.Length).Append(';');foreach(string field in record.Fields)b.Append(field.Length).Append(':').Append(field).Append(';');}return Sha256Bytes(Encoding.UTF8.GetBytes(b.ToString()));}
  static void Attempt(List<string> failures,Action action){try{action();}catch{failures.Add("cleanup-failed");}}
  public static Result Run(string candidateMsi,string candidateCode,string predecessorCode,string targetDirectory,string targetFile,string predecessorHash,long payloadBytes,string logPath){
    Result output=new Result();List<string> failures=new List<string>();DirectoryLease lease=null;CallbackState state=null;
    InstallUiHandlerRecord callback=null;IntPtr owner=IntPtr.Zero,previous=IntPtr.Zero,ignored=IntPtr.Zero;uint priorUi=0;
    bool ui=false,handler=false,log=false,attempted=false,callbackComplete=false;
    try{
      if(MsiQueryProductStateW(predecessorCode)!=InstallStateDefault||MsiQueryProductStateW(candidateCode)!=InstallStateUnknown)throw new InvalidOperationException("Product state differs");
      if(!File.Exists(targetFile)||Sha256File(targetFile)!=predecessorHash)throw new InvalidOperationException("Predecessor payload differs");
      lease=new DirectoryLease(targetDirectory);state=new CallbackState(predecessorCode,candidateCode,targetFile,payloadBytes,lease);
      callback=delegate(IntPtr context,uint type,uint record){return state.Invoke(context,type,record);};
      priorUi=MsiSetInternalUI(InstallUiLevelNone,ref owner);ui=true;
      uint set=MsiSetExternalUIRecord(callback,RequiredMessageFilter,IntPtr.Zero,out previous);
      if(set!=ErrorSuccess)throw new InvalidOperationException("External UI registration failed");handler=true;
      if(previous!=IntPtr.Zero)throw new InvalidOperationException("External UI collision");
      uint enabled=MsiEnableLogW(InstallLogModeVerbose|InstallLogModeExtraDebug,logPath,InstallLogAttributesFlushEachLine);
      if(enabled!=ErrorSuccess)throw new Win32Exception((int)enabled,"MsiEnableLogW");log=true;attempted=true;
      try{output.CandidateInstallReturn=MsiInstallProductW(candidateMsi,"REBOOT=ReallySuppress");}finally{GC.KeepAlive(callback);}
      output.installContextBalanced=state.Balanced;output.errorCode=state.ErrorCode;output.recordsSha256=RecordsSha(state.Records);
      callbackComplete=state.Failure==null&&state.Balanced&&state.RemovalStart&&state.RemovalProduct&&state.InstallFiles&&state.InstallData&&state.ErrorSeen&&state.RestoredBeforeCancel;
      output.predecessorRestored=MsiQueryProductStateW(predecessorCode)==InstallStateDefault&&File.Exists(targetFile)&&Sha256File(targetFile)==predecessorHash;
      output.candidateAbsent=MsiQueryProductStateW(candidateCode)==InstallStateUnknown;
    }finally{
      if(lease!=null&&!lease.Restored)Attempt(failures,delegate{lease.Restore();});
      if(log)Attempt(failures,delegate{if(MsiEnableLogW(0,null,0)!=ErrorSuccess)throw new InvalidOperationException();});
      if(handler)Attempt(failures,delegate{if(MsiSetExternalUIRecord(null,0,IntPtr.Zero,out ignored)!=ErrorSuccess)throw new InvalidOperationException();});
      if(attempted&&MsiQueryProductStateW(candidateCode)!=InstallStateUnknown)Attempt(failures,delegate{if(MsiConfigureProductExW(candidateCode,InstallLevelDefault,InstallStateAbsent,"REBOOT=ReallySuppress")!=ErrorSuccess)throw new InvalidOperationException();});
      if(lease!=null){Attempt(failures,delegate{output.securityRestored=lease.Restored&&lease.AfterSha==lease.BeforeSha;});lease.Dispose();}
      if(ui)Attempt(failures,delegate{if(MsiSetInternalUI(priorUi,ref owner)!=InstallUiLevelNone)throw new InvalidOperationException();});
      output.accepted=failures.Count==0&&callbackComplete&&output.securityRestored&&output.predecessorRestored&&output.candidateAbsent&&output.errorCode==ErrorCreatingDestinationFile&&(output.CandidateInstallReturn==ErrorInstallUserExit||output.CandidateInstallReturn==ErrorInstallFailure);
    }
    return output;
  }
}
'@ -Language CSharp -ErrorAction Stop
}

function Invoke-MyspeedGuestCandidateRollback {
    Assert-MyspeedGuestRollbackContext
    Assert-MyspeedGuestRollbackInput
    New-MyspeedGuestRollbackNativeType
    $log=Join-Path $EvidenceRoot ('rollback-'+$Nonce+'.log')
    if(Test-Path -LiteralPath $log){throw 'Guest rollback log collision'}
    $result=[MyspeedMsiGuestRollback]::Run([IO.Path]::GetFullPath($CandidateMsiPath),$CandidateProductCode,
        $PredecessorProductCode,$script:TargetDirectory,$script:TargetFile,$PredecessorPayloadSha256,
        $CandidatePayloadBytes,$log)
    if($result.accepted -ne $true){throw 'Guest rollback calibration rejected'}
    [pscustomobject]@{accepted=$true;errorCode=[int]$result.errorCode;
        installContextBalanced=[bool]$result.installContextBalanced;securityRestored=[bool]$result.securityRestored;
        predecessorRestored=[bool]$result.predecessorRestored;candidateAbsent=[bool]$result.candidateAbsent;
        recordsSha256=[string]$result.recordsSha256}
}

function Test-MyspeedGuestRollbackInjected {
    param($Value)
    Assert-MyspeedGuestRollbackExactObject $Value @('accepted','errorCode','installContextBalanced','securityRestored',
        'predecessorRestored','candidateAbsent','recordsSha256') 'Injected guest rollback'
    if($Value.accepted -isnot [bool] -or $Value.errorCode -ne $script:ErrorCreatingDestinationFile -or
        $Value.installContextBalanced -ne $true -or $Value.securityRestored -ne $true -or
        $Value.predecessorRestored -ne $true -or $Value.candidateAbsent -ne $true){
        throw 'Injected guest rollback proof differs'
    }
    [void](Assert-MyspeedGuestRollbackScalar $Value.recordsSha256 $script:HashPattern 'Guest rollback records SHA-256')
    $Value
}

function Get-MyspeedGuestRollbackContract {
    [pscustomobject]@{schemaVersion=1;kind='myspeed-windows-msi-guest-rollback-contract';qualifying=$false;
        targetDirectory=$script:TargetDirectory;targetFile=$script:TargetFile;requiredErrorCode=$script:ErrorCreatingDestinationFile;
        requiredInstallReturns=@(1602,1603);releaseGatesCleared=@()}
}

if($MyInvocation.InvocationName -ne '.'){
    switch($Mode){
        'Library'{return}
        'GetContract'{Get-MyspeedGuestRollbackContract|ConvertTo-Json -Compress -Depth 8;return}
        'TestInjected'{if([string]::IsNullOrWhiteSpace($InputJson)){throw 'InputJson is required'};
            Test-MyspeedGuestRollbackInjected (ConvertFrom-Json -InputObject $InputJson)|ConvertTo-Json -Compress -Depth 8;return}
        'InvokeGuestCandidateRollback'{Invoke-MyspeedGuestCandidateRollback|ConvertTo-Json -Compress -Depth 8;return}
    }
}
