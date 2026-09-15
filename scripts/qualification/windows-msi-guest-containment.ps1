[CmdletBinding()]
param(
    [ValidateSet('Library','GetContract','TestInjected','TestInventory','Install','Remove','ContainmentStub')]
    [string]$Mode='Library',
    [string]$ProductCode,
    [string]$MsiPath,
    [string]$MsiSha256,
    [string]$EvidenceRoot,
    [string]$Nonce,
    [string]$ExpectedSerial,
    [string]$HelperSha256,
    [string]$StatePath,
    [string]$InputJson,
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$IgnoredArguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$script:SchemaVersion=1
$script:ServiceName='MySpeed'
$script:ImageName='MySpeed.exe'
$script:InstallStateUnknown=-1
$script:InstallStateDefault=5
$script:MaximumJsonBytes=262144
$script:MaximumMsiBytes=1073741824
$script:MaximumHelperBytes=1048576
$script:MaximumLaunchRecords=64
$script:InterceptExitCode=113
$script:IfeoSubkey='SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\MySpeed.exe'
$script:ProductPattern='\A\{[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\}\z'
$script:HashPattern='\A[a-f0-9]{64}\z'
$script:NoncePattern='\A[a-f0-9]{32}\z'

function Assert-MyspeedGuestContainmentExactObject {
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

function Get-MyspeedGuestContainmentSha256 {
    param([string]$Path)
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{$hash=[Security.Cryptography.SHA256]::Create();try{
        ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant()
    }finally{$hash.Dispose()}}finally{$stream.Dispose()}
}

function Write-MyspeedGuestContainmentJson {
    param([string]$Path,$Value)
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Compress -Depth 12))
    if($bytes.Length -lt 1 -or $bytes.Length -gt $script:MaximumJsonBytes){throw 'Containment JSON exceeds its bound'}
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
    ([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash($bytes))).Replace('-','').ToLowerInvariant()
}

function Read-MyspeedGuestContainmentJson {
    param([string]$Path,[string]$Label)
    $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType -or
        $item.Length -lt 1 -or $item.Length -gt $script:MaximumJsonBytes){throw "$Label identity differs"}
    Get-Content -LiteralPath $Path -Raw -ErrorAction Stop|ConvertFrom-Json
}

function Assert-MyspeedGuestContainmentScalar {
    param($Value,[string]$Pattern,[string]$Label)
    if($Value -isnot [string] -or $Value -cnotmatch $Pattern){throw "$Label differs"}
    $Value
}

function Assert-MyspeedGuestContainmentRequest {
    param($Value)
    Assert-MyspeedGuestContainmentExactObject $Value @('schemaVersion','kind','productCode','msiPath','msiSha256',
        'evidenceRoot','nonce','expectedSerial','helperPath','helperSha256','debugger') 'Containment request'
    if(($Value.schemaVersion -isnot [int] -and $Value.schemaVersion -isnot [long]) -or
        $Value.schemaVersion -ne $script:SchemaVersion -or $Value.kind -isnot [string] -or
        $Value.kind -cne 'myspeed-windows-msi-guest-containment-request'){
        throw 'Containment request header differs'
    }
    [void](Assert-MyspeedGuestContainmentScalar $Value.productCode $script:ProductPattern 'Containment ProductCode')
    foreach($name in @('msiSha256','helperSha256')){
        [void](Assert-MyspeedGuestContainmentScalar $Value.$name $script:HashPattern "Containment $name")
    }
    foreach($name in @('nonce','expectedSerial')){
        [void](Assert-MyspeedGuestContainmentScalar $Value.$name $script:NoncePattern "Containment $name")
    }
    foreach($name in @('msiPath','evidenceRoot','helperPath','debugger')){
        if($Value.$name -isnot [string] -or [string]::IsNullOrWhiteSpace($Value.$name)){
            throw "Containment $name differs"
        }
    }
    $Value
}

function Assert-MyspeedGuestContainmentOwnedPath {
    param([string]$Root,[string]$Path,[string]$Label,[switch]$AllowRoot)
    $fullRoot=[IO.Path]::GetFullPath($Root).TrimEnd('\')
    $fullPath=[IO.Path]::GetFullPath($Path)
    $prefix=$fullRoot+'\'
    if((!$AllowRoot -and [string]::Equals($fullPath,$fullRoot,[StringComparison]::OrdinalIgnoreCase)) -or
        (!$fullPath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -and
        !($AllowRoot -and [string]::Equals($fullPath,$fullRoot,[StringComparison]::OrdinalIgnoreCase)))){
        throw "$Label escapes its owned root"
    }
    $fullPath
}

function Assert-MyspeedGuestContainmentFile {
    param([string]$Path,[string]$ExpectedSha,[int64]$MaximumBytes,[string]$Label)
    $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType -or
        $item.Length -lt 1 -or $item.Length -gt $MaximumBytes -or
        (Get-MyspeedGuestContainmentSha256 $Path) -cne $ExpectedSha){throw "$Label identity differs"}
    $item
}

function Assert-MyspeedGuestContainmentContext {
    param([string]$Evidence,[string]$Serial,[string]$NonceValue)
    if($PSVersionTable.PSEdition -cne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or
        $PSVersionTable.PSVersion.Minor -ne 1){throw 'Containment requires inbox Windows PowerShell 5.1'}
    $shell=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    $expectedShell=[IO.Path]::Combine($env:SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe')
    if(-not [string]::Equals($shell,$expectedShell,[StringComparison]::OrdinalIgnoreCase)){
        throw 'Containment shell identity differs'
    }
    [void](Assert-MyspeedGuestContainmentScalar $Serial $script:NoncePattern 'Containment serial')
    [void](Assert-MyspeedGuestContainmentScalar $NonceValue $script:NoncePattern 'Containment nonce')
    if(-not [string]::Equals($Serial,$NonceValue,[StringComparison]::Ordinal)){
        throw 'Containment serial and nonce differ'
    }
    $bios=@(Get-CimInstance Win32_BIOS -ErrorAction Stop)
    $computer=@(Get-CimInstance Win32_ComputerSystem -ErrorAction Stop)
    $adapters=@(Get-NetAdapter -IncludeHidden -ErrorAction Stop|Where-Object HardwareInterface)
    if($bios.Count -ne 1 -or $computer.Count -ne 1 -or
        -not [string]::Equals([string]$bios[0].SerialNumber,$Serial,[StringComparison]::Ordinal) -or
        [string]$computer[0].Manufacturer -notmatch '\AQEMU(?: |$)' -or $adapters.Count -ne 0){
        throw 'Containment requires the exact NIC-free QEMU guest'
    }
    $rootItem=Get-Item -LiteralPath $Evidence -Force -ErrorAction Stop
    if($rootItem -isnot [IO.DirectoryInfo] -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $rootItem.LinkType){throw 'Containment evidence root identity differs'}
}

function Get-MyspeedGuestContainmentDebugger {
    param([string]$HelperPath,[string]$RequestPath,[string]$NonceValue)
    $shell=[IO.Path]::Combine($env:SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe')
    '"'+$shell+'" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$HelperPath+
        '" -Mode ContainmentStub -StatePath "'+$RequestPath+'" -Nonce '+$NonceValue
}

function Get-MyspeedGuestContainmentInventory {
    param([string]$Root,[string]$NonceValue)
    $records=@(Get-ChildItem -LiteralPath $Root -Filter ('containment-launch-'+$NonceValue+'-*.json') -File -Force -ErrorAction Stop|
        Sort-Object Name)
    if($records.Count -gt $script:MaximumLaunchRecords){throw 'Containment launch inventory exceeds its bound'}
    $items=@();foreach($record in $records){
        $value=Read-MyspeedGuestContainmentJson $record.FullName 'Containment launch record'
        Assert-MyspeedGuestContainmentExactObject $value @('schemaVersion','kind','nonce','processId','intercepted') 'Containment launch record'
        if($value.schemaVersion -ne 1 -or $value.kind -cne 'myspeed-windows-msi-guest-containment-launch' -or
            $value.nonce -cne $NonceValue -or $value.intercepted -ne $true -or
            ($value.processId -isnot [int] -and $value.processId -isnot [long]) -or $value.processId -lt 1){
            throw 'Containment launch record differs'
        }
        $items+=@([ordered]@{name=$record.Name;bytes=[long]$record.Length;sha256=Get-MyspeedGuestContainmentSha256 $record.FullName})
    }
    Get-MyspeedGuestContainmentInventoryDigest $items
}

# The digest a consumer rehashes the retained launch history against, so its exact form is part of
# the contract. Piping the list into ConvertTo-Json unrolls it: an empty listing produced no output
# at all and threw on the way into GetBytes, and a single record serialized as a bare object rather
# than a one-element list. A cleanly contained guest has an empty history, which was exactly the
# case that could never complete, so the form is taken over the array itself.
function Get-MyspeedGuestContainmentInventoryDigest {
    param($Items)
    $list=[object[]]@($Items)
    $canonical=ConvertTo-Json -InputObject $list -Compress -Depth 5
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes($canonical)
    if($bytes.Length -lt 1 -or $bytes.Length -gt $script:MaximumJsonBytes){
        throw 'Containment launch inventory exceeds its bound'
    }
    $hasher=[Security.Cryptography.SHA256]::Create();try{
        $digest=([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()
    }finally{$hasher.Dispose()}
    [pscustomobject]@{count=$list.Count;sha256=$digest;canonical=$canonical}
}

function Test-MyspeedGuestContainmentInventory {
    param($Value)
    Assert-MyspeedGuestContainmentExactObject $Value @('items') 'Injected inventory'
    if($Value.items -isnot [array] -or $Value.items.Count -gt $script:MaximumLaunchRecords){
        throw 'Injected inventory differs'
    }
    $items=@();foreach($item in $Value.items){
        Assert-MyspeedGuestContainmentExactObject $item @('name','bytes','sha256') 'Injected inventory record'
        $items+=@([ordered]@{name=[string]$item.name;bytes=[long]$item.bytes;sha256=[string]$item.sha256})
    }
    $inventory=Get-MyspeedGuestContainmentInventoryDigest $items
    [pscustomobject]@{accepted=$true;count=$inventory.count;canonical=$inventory.canonical;
        sha256=$inventory.sha256}
}

function Get-MyspeedGuestContainmentResult {
    param([string]$Action,[string]$Code,[bool]$Active,[bool]$Restored,[string]$Root,[string]$NonceValue)
    $inventory=Get-MyspeedGuestContainmentInventory $Root $NonceValue
    [pscustomobject]@{status='completed';mode=$Action;productCode=$Code;ifeoActive=$Active;
        oldPayloadExecutionCount=0;registryRestored=$Restored;launchInventorySha256=$inventory.sha256}
}

function Invoke-MyspeedGuestContainmentStub {
    $request=Assert-MyspeedGuestContainmentRequest (Read-MyspeedGuestContainmentJson $StatePath 'Containment request')
    $expectedState=Join-Path $request.evidenceRoot ('containment-request-'+$Nonce+'.json')
    if($request.nonce -cne $Nonce -or
        -not [string]::Equals([IO.Path]::GetFullPath($StatePath),[IO.Path]::GetFullPath($expectedState),
            [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([IO.Path]::GetFullPath($MyInvocation.MyCommand.Path),
            [IO.Path]::GetFullPath($request.helperPath),[StringComparison]::OrdinalIgnoreCase) -or
        (Get-MyspeedGuestContainmentSha256 $MyInvocation.MyCommand.Path) -cne $request.helperSha256){
        throw 'Containment stub binding differs'
    }
    $target=Join-Path $request.evidenceRoot ('containment-launch-'+$Nonce+'-'+[string]$PID+'.json')
    [void](Write-MyspeedGuestContainmentJson $target ([ordered]@{schemaVersion=1;
        kind='myspeed-windows-msi-guest-containment-launch';nonce=$Nonce;processId=[long]$PID;intercepted=$true}))
    exit $script:InterceptExitCode
}

function Invoke-MyspeedGuestContainmentNative {
    param([ValidateSet('Install','Remove')][string]$Action)
    Assert-MyspeedGuestContainmentContext $EvidenceRoot $ExpectedSerial $Nonce
    [void](Assert-MyspeedGuestContainmentScalar $ProductCode $script:ProductPattern 'Containment ProductCode')
    [void](Assert-MyspeedGuestContainmentScalar $MsiSha256 $script:HashPattern 'Containment MSI SHA-256')
    [void](Assert-MyspeedGuestContainmentScalar $HelperSha256 $script:HashPattern 'Containment helper SHA-256')
    $helperPath=$MyInvocation.MyCommand.Path
    [void](Assert-MyspeedGuestContainmentFile $helperPath $HelperSha256 $script:MaximumHelperBytes 'Containment helper')
    $fullMsi=[IO.Path]::GetFullPath($MsiPath)
    [void](Assert-MyspeedGuestContainmentFile $fullMsi $MsiSha256 $script:MaximumMsiBytes 'Containment MSI')
    $requestPath=Join-Path $EvidenceRoot ('containment-request-'+$Nonce+'.json')
    $debugger=Get-MyspeedGuestContainmentDebugger $helperPath $requestPath $Nonce
    $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,
        [Microsoft.Win32.RegistryView]::Registry64)
    $ifeo=$null;$ownedKey=$false;$installAttempted=$false;$nativeTypeLoaded=$false
    try{
        if($Action -ceq 'Install'){
            if(Test-Path -LiteralPath $requestPath){throw 'Containment request collision'}
            $collision=$base.OpenSubKey($script:IfeoSubkey,$false)
            if($null -ne $collision){$collision.Dispose();throw 'Containment IFEO collision'}
            Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class MyspeedGuestMsiState {
  [DllImport("msi.dll",CharSet=CharSet.Unicode)] public static extern int MsiQueryProductState(string productCode);
}
'@ -Language CSharp -ErrorAction Stop
            $nativeTypeLoaded=$true
            if([MyspeedGuestMsiState]::MsiQueryProductState($ProductCode) -ne $script:InstallStateUnknown){
                throw 'Containment product collision'
            }
            if(@(Get-CimInstance Win32_Process -Filter "Name='MySpeed.exe'" -ErrorAction Stop).Count -ne 0){
                throw 'Containment payload process collision'
            }
            $request=[ordered]@{schemaVersion=1;kind='myspeed-windows-msi-guest-containment-request';
                productCode=$ProductCode;msiPath=$fullMsi;msiSha256=$MsiSha256;evidenceRoot=[IO.Path]::GetFullPath($EvidenceRoot);
                nonce=$Nonce;expectedSerial=$ExpectedSerial;helperPath=$helperPath;helperSha256=$HelperSha256;debugger=$debugger}
            [void](Write-MyspeedGuestContainmentJson $requestPath $request)
            $ifeo=$base.CreateSubKey($script:IfeoSubkey,$true);$ownedKey=$true
            $ifeo.SetValue('Debugger',$debugger,[Microsoft.Win32.RegistryValueKind]::String);$ifeo.Flush()
            if(-not [string]::Equals([string]$ifeo.GetValue('Debugger',$null,
                [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames),$debugger,[StringComparison]::Ordinal)){
                throw 'Containment IFEO write differs'
            }
            $installAttempted=$true
            & ([IO.Path]::Combine($env:SystemRoot,'System32','msiexec.exe')) /i $fullMsi /qn /norestart REBOOT=ReallySuppress
            if($LASTEXITCODE -ne 0){throw 'Contained predecessor installation failed'}
            if([MyspeedGuestMsiState]::MsiQueryProductState($ProductCode) -ne $script:InstallStateDefault){
                throw 'Contained predecessor product state differs'
            }
            if(@(Get-CimInstance Win32_Process -Filter "Name='MySpeed.exe'" -ErrorAction Stop).Count -ne 0){
                throw 'Contained predecessor payload executed'
            }
            Get-MyspeedGuestContainmentResult 'Install' $ProductCode $true $false $EvidenceRoot $Nonce
            return
        }
        $request=Assert-MyspeedGuestContainmentRequest (Read-MyspeedGuestContainmentJson $requestPath 'Containment request')
        foreach($name in @('productCode','msiPath','msiSha256','nonce','expectedSerial','helperSha256')){
            if(-not [string]::Equals([string]$request.$name,[string](Get-Variable -Name $name -ValueOnly),
                [StringComparison]::Ordinal)){throw "Containment removal $name differs"}
        }
        if(-not [string]::Equals($request.helperPath,$helperPath,[StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals($request.debugger,$debugger,[StringComparison]::Ordinal)){
            throw 'Containment removal helper binding differs'
        }
        if(@(Get-CimInstance Win32_Process -Filter "Name='MySpeed.exe'" -ErrorAction Stop).Count -ne 0){
            throw 'Containment payload process is still active'
        }
        $ifeo=$base.OpenSubKey($script:IfeoSubkey,$true)
        if($null -eq $ifeo -or -not [string]::Equals([string]$ifeo.GetValue('Debugger',$null,
            [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames),$debugger,[StringComparison]::Ordinal)){
            throw 'Containment owned IFEO state differs'
        }
        $ifeo.Dispose();$ifeo=$null
        $base.DeleteSubKeyTree($script:IfeoSubkey,$false)
        $check=$base.OpenSubKey($script:IfeoSubkey,$false)
        if($null -ne $check){$check.Dispose();throw 'Containment IFEO cleanup failed'}
        Get-MyspeedGuestContainmentResult 'Remove' $ProductCode $false $true $EvidenceRoot $Nonce
    }catch{
        if($Action -ceq 'Install'){
            if($installAttempted -and $nativeTypeLoaded){
                try{if([MyspeedGuestMsiState]::MsiQueryProductState($ProductCode) -ne $script:InstallStateUnknown){
                    & ([IO.Path]::Combine($env:SystemRoot,'System32','msiexec.exe')) /x $ProductCode /qn /norestart REBOOT=ReallySuppress
                }}catch{}
            }
            if($ownedKey){
                try{if($null -ne $ifeo){$ifeo.Dispose();$ifeo=$null};$base.DeleteSubKeyTree($script:IfeoSubkey,$false)}catch{}
            }
        }
        throw
    }finally{
        if($null -ne $ifeo){$ifeo.Dispose()}
        if($null -ne $base){$base.Dispose()}
    }
}

function Test-MyspeedGuestContainmentInjected {
    param($Value)
    Assert-MyspeedGuestContainmentExactObject $Value @('mode','request','launches','registryExact','productInstalled') 'Injected containment'
    $request=Assert-MyspeedGuestContainmentRequest $Value.request
    if($Value.mode -isnot [string] -or @('Install','Remove') -cnotcontains $Value.mode -or
        $Value.launches -isnot [array] -or $Value.launches.Count -gt $script:MaximumLaunchRecords -or
        $Value.registryExact -isnot [bool] -or $Value.productInstalled -isnot [bool]){
        throw 'Injected containment facts differ'
    }
    if($Value.mode -ceq 'Install' -and (!$Value.registryExact -or !$Value.productInstalled)){
        throw 'Injected containment install differs'
    }
    if($Value.mode -ceq 'Remove' -and ($Value.registryExact -or !$Value.productInstalled)){
        throw 'Injected containment removal differs'
    }
    [pscustomobject]@{accepted=$true;mode=$Value.mode;nonce=$request.nonce;launchCount=$Value.launches.Count}
}

function Get-MyspeedGuestContainmentContract {
    [pscustomobject]@{schemaVersion=1;kind='myspeed-windows-msi-guest-containment-contract';
        qualifying=$false;modes=@('Install','Remove','ContainmentStub');imageName=$script:ImageName;
        serviceName=$script:ServiceName;interceptExitCode=$script:InterceptExitCode;releaseGatesCleared=@()}
}

if($MyInvocation.InvocationName -ne '.'){
    switch($Mode){
        'Library'{return}
        'GetContract'{Get-MyspeedGuestContainmentContract|ConvertTo-Json -Compress -Depth 8;return}
        'TestInjected'{if([string]::IsNullOrWhiteSpace($InputJson)){throw 'InputJson is required'};
            Test-MyspeedGuestContainmentInjected (ConvertFrom-Json -InputObject $InputJson)|ConvertTo-Json -Compress -Depth 8;return}
        'TestInventory'{if([string]::IsNullOrWhiteSpace($InputJson)){throw 'InputJson is required'};
            Test-MyspeedGuestContainmentInventory (ConvertFrom-Json -InputObject $InputJson)|ConvertTo-Json -Compress -Depth 8;return}
        'ContainmentStub'{Invoke-MyspeedGuestContainmentStub;return}
        'Install'{Invoke-MyspeedGuestContainmentNative 'Install'|ConvertTo-Json -Compress -Depth 8;return}
        'Remove'{Invoke-MyspeedGuestContainmentNative 'Remove'|ConvertTo-Json -Compress -Depth 8;return}
    }
}
