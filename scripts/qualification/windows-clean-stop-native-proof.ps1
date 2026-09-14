[CmdletBinding()]
param(
    [ValidateSet('Library','GetContract','ValidateTransport','ValidateInventory','ValidateCompilerOperation','ValidateManifest','ValidateCase','AssessMatrix','TestObserver','TestDetachedObserver','TestLauncherBridge','TestActiveLogReader','TestCollectionGate','TestFailureStreams','InvokeHostedProof')]
    [string] $Mode='Library',
    [string] $InputJson='',
    [string] $ClosureRoot='',
    [string] $ExpectedClosureSha256='',
    [string] $EvidencePath='',
    [string] $ExpectedRunId='',
    [string] $ExpectedRunAttempt='',
    [string] $ExpectedEventSha='',
    [string] $ExpectedSourceSha='',
    [string] $ExpectedImageVersion='',
    [string] $Nonce=''
)

Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$script:ManifestKind='myspeed-windows-clean-stop-native-proof-manifest'
$script:Repository='i7Gamer/MySpeed'
$script:ImageOS='win25-vs2026'
$script:CaseIds=@('handler','ignore','extra-participant','missing-stop')
$script:FileRoles=@('workflow','controller','coordinator','outer-launcher','tool-child','file-identity','fixture-source','inbox-powershell',
    'compiler','mscorlib','system','system-core','fixture-binary')
$script:SingleLinkFileRoles=@('workflow','controller','coordinator','outer-launcher','tool-child','file-identity','fixture-source','fixture-binary')
$script:ReadyKind='myspeed-windows-clean-stop-ready'
$script:FixtureReadyMarker='MYSPEED_CLEAN_STOP_FIXTURE_READY_V1'
$script:MaximumManifestFileBytes=33554432
$script:MaximumObservedMilliseconds=310000
$script:ForcedCleanupExitCode=197
$script:OuterLauncherKind='myspeed-owned-job-observed-launch'
$script:SummaryKind='myspeed-windows-clean-stop-native-proof-summary'
$script:OuterCreationFlags=134217732
$script:ObserverContextKeys=@('schemaVersion','tick','processId','wallUnixMilliseconds','monotonicMilliseconds',
    'wallDeadlineUnixMilliseconds','monotonicDeadlineMilliseconds')
$script:ObserverBody={param($context) Invoke-MyspeedProofObserverTick $state $Operations $context}
$script:TransportKind='myspeed-windows-clean-stop-transport-closure'
$script:TransportNames=@('windows-clean-stop-native-proof.yml','windows-clean-stop-controller.ps1',
    'windows-clean-stop-native-proof.ps1','media-job-launcher.ps1','windows-cpu-tool-child.ps1',
    'windows-cpu-file-identity.ps1','windows-clean-stop-fixture.cs')
$script:ReviewedToolChildSha256='51febe43711a3bcf9f2527493496eafc268abc187393f2512bb48c3fab6a6711'
$script:ReviewedFileIdentitySha256='4e1f39d98f08606ac53f314d105e918e0b1080c5363ce23e16ae50ab3ac5265f'
$script:EvidenceInventoryKind='myspeed-windows-clean-stop-evidence-inventory'
$script:MaximumAggregateEvidenceBytes=33554432
$script:MaximumFailureMessageLength=1024
$script:MaximumFailureFieldBytes=128
$script:MaximumFailureStreamBytes=64
$script:MaximumFailureProofNames=8
$script:NativeMode='InvokeHostedProof'

function Assert-MyspeedProofEarlyHostedContext {
    if($ExpectedRunId -cnotmatch '\A[1-9][0-9]{0,19}\z' -or $ExpectedRunAttempt -cnotmatch '\A[1-9][0-9]{0,9}\z' -or
        $ExpectedEventSha -cnotmatch '\A[0-9a-f]{40}\z' -or $ExpectedSourceSha -cnotmatch '\A[0-9a-f]{40}\z' -or
        $ExpectedImageVersion -cnotmatch '\A[0-9A-Za-z._-]{1,128}\z' -or $Nonce -cnotmatch '\A[0-9a-f]{32}\z' -or
        $ExpectedClosureSha256 -cnotmatch '\A[0-9a-f]{64}\z'){throw 'Hosted proof identity input is invalid'}
    $required=[ordered]@{GITHUB_ACTIONS='true';CI='true';RUNNER_OS='Windows';RUNNER_ARCH='X64';RUNNER_ENVIRONMENT='github-hosted'
        GITHUB_REPOSITORY=$script:Repository;ImageOS=$script:ImageOS;ImageVersion=$ExpectedImageVersion
        GITHUB_RUN_ID=$ExpectedRunId;GITHUB_RUN_ATTEMPT=$ExpectedRunAttempt;GITHUB_SHA=$ExpectedEventSha}
    foreach($entry in $required.GetEnumerator()){
        if([Environment]::GetEnvironmentVariable($entry.Key) -cne $entry.Value){throw "Hosted proof context differs: $($entry.Key)"}
    }
    if(-not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -cne 'Desktop' -or
        $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1){
        throw 'Hosted proof requires x64 Windows PowerShell 5.1 Desktop'
    }
    $expectedPowerShell=[IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
    $actualPowerShell=[IO.Path]::GetFullPath([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
    if(-not [string]::Equals($actualPowerShell,$expectedPowerShell,[StringComparison]::OrdinalIgnoreCase)){
        throw 'Hosted proof PowerShell path differs'
    }
    $expectedRoot=[IO.Path]::GetFullPath((Join-Path $env:RUNNER_TEMP 'windows-clean-stop-native-proof-closure'))
    $expectedEvidence=[IO.Path]::GetFullPath((Join-Path (Join-Path $env:RUNNER_TEMP "myspeed-clean-stop-native-proof-$Nonce") 'result.json'))
    if(-not [string]::Equals([IO.Path]::GetFullPath($ClosureRoot),$expectedRoot,[StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([IO.Path]::GetFullPath($EvidencePath),$expectedEvidence,[StringComparison]::OrdinalIgnoreCase)){
        throw 'Hosted proof owned path differs'
    }
}

if($Mode -ceq $script:NativeMode){Assert-MyspeedProofEarlyHostedContext}

$controllerPath=Join-Path $PSScriptRoot 'windows-clean-stop-controller.ps1'
$script:ControllerModule=New-Module -ScriptBlock {
    param([string]$Path)
    . $Path -Mode Library
    Export-ModuleMember -Function Assert-MyspeedCleanExactKeys,Assert-MyspeedCleanString,
        Assert-MyspeedCleanInteger,Assert-MyspeedCleanBoolean,Assert-MyspeedCleanArray,
        Assert-MyspeedCleanPath,Assert-MyspeedCleanLaunchRequest,Assert-MyspeedCleanStdoutReadiness,
        Assert-MyspeedCleanStopRequest,Assert-MyspeedCleanResult,Assert-MyspeedCleanAbiObservation,
        Get-MyspeedCleanExpectedAbiMeasurements
} -ArgumentList $controllerPath
Import-Module $script:ControllerModule -Force

function ConvertFrom-MyspeedProofJson {
    param([string]$Json,[string]$Label)
    if([string]::IsNullOrEmpty($Json)){throw "$Label JSON is absent"}
    try{return $Json|ConvertFrom-Json -ErrorAction Stop}catch{throw "$Label JSON is invalid"}
}

function Assert-MyspeedProofClockNumber {
    param([object]$Value,[string]$Label,[double]$Minimum,[double]$Maximum)
    if($null -eq $Value -or $Value.GetType().IsArray -or $Value -is [bool] -or $Value -is [char] -or
        $Value -isnot [ValueType]){throw "$Label must be a finite number"}
    $typeCode=[Type]::GetTypeCode($Value.GetType())
    if($typeCode -notin @([TypeCode]::Byte,[TypeCode]::SByte,[TypeCode]::Int16,[TypeCode]::UInt16,
        [TypeCode]::Int32,[TypeCode]::UInt32,[TypeCode]::Int64,[TypeCode]::UInt64,[TypeCode]::Single,
        [TypeCode]::Double,[TypeCode]::Decimal)){throw "$Label must be a finite number"}
    $number=[double]$Value
    if([double]::IsNaN($number) -or [double]::IsInfinity($number) -or $number -lt $Minimum -or $number -gt $Maximum){
        throw "$Label must be a bounded finite number"
    }
    return $number
}

function Invoke-MyspeedProofModuleCommand {
    param([object]$Module,[string]$Command,[object[]]$Arguments=@())
    $request=[pscustomobject]@{name=$Command;arguments=[object[]]$Arguments}
    return & $Module {param($call)
        $moduleArguments=[object[]]$call.arguments
        & $call.name @moduleArguments
    } $request
}

function New-MyspeedProofModule {
    param([string]$Path,[string]$Name)
    return New-Module -Name $Name -ScriptBlock {param($sourcePath) . $sourcePath} -ArgumentList $Path
}

function Assert-MyspeedProofTransportManifest {
    param([object]$Value)
    Assert-MyspeedCleanExactKeys $Value @('schemaVersion','kind','qualifying','repository','runId','runAttempt',
        'eventSha','sourceSha','imageOS','imageVersion','architecture','nonce','files') 'Transport manifest'
    [void](Assert-MyspeedCleanInteger $Value.schemaVersion 'Transport schema' 1 1)
    if((Assert-MyspeedCleanString $Value.kind 'Transport kind') -cne $script:TransportKind -or
        (Assert-MyspeedCleanBoolean $Value.qualifying 'Transport qualifying') -or
        (Assert-MyspeedCleanString $Value.repository 'Transport repository') -cne $script:Repository -or
        (Assert-MyspeedCleanString $Value.imageOS 'Transport ImageOS') -cne $script:ImageOS -or
        (Assert-MyspeedCleanString $Value.architecture 'Transport architecture') -cne 'X64'){
        throw 'Transport manifest identity differs'
    }
    [void](Assert-MyspeedCleanString $Value.runId 'Transport run ID' '^[1-9][0-9]{0,19}$')
    [void](Assert-MyspeedCleanString $Value.runAttempt 'Transport run attempt' '^[1-9][0-9]{0,9}$')
    [void](Assert-MyspeedCleanString $Value.eventSha 'Transport event SHA' '^[0-9a-f]{40}$')
    [void](Assert-MyspeedCleanString $Value.sourceSha 'Transport source SHA' '^[0-9a-f]{40}$')
    [void](Assert-MyspeedCleanString $Value.imageVersion 'Transport image version' '^[0-9A-Za-z._-]{1,128}$')
    [void](Assert-MyspeedCleanString $Value.nonce 'Transport nonce' '^[0-9a-f]{32}$')
    $files=Assert-MyspeedCleanArray $Value.files 'Transport files'
    if($files.Count -ne $script:TransportNames.Count){throw 'Transport file count differs'}
    for($index=0;$index -lt $files.Count;$index++){
        Assert-MyspeedCleanExactKeys $files[$index] @('name','bytes','sha256') 'Transport file'
        if((Assert-MyspeedCleanString $files[$index].name 'Transport file name') -cne $script:TransportNames[$index]){
            throw 'Transport file order differs'
        }
        [void](Assert-MyspeedCleanInteger $files[$index].bytes 'Transport file bytes' 1 $script:MaximumManifestFileBytes)
        [void](Assert-MyspeedCleanString $files[$index].sha256 'Transport file SHA' '^[0-9a-f]{64}$')
    }
    if($files[4].sha256 -cne $script:ReviewedToolChildSha256 -or
        $files[5].sha256 -cne $script:ReviewedFileIdentitySha256){throw 'Transport reviewed helper hash differs'}
    return [pscustomobject]@{accepted=$true}
}

function Get-MyspeedProofExpectedInventoryNames {
    $names=[Collections.Generic.List[string]]::new()
    foreach($name in @($script:TransportNames+'closure.json')){[void]$names.Add("closure/$name")}
    foreach($name in @('compile-clean-stop-fixture.request.json','compile-clean-stop-fixture.result.json',
        'windows-clean-stop-fixture.exe','compile-launcher.json','compiler.stdout','compiler.stderr')){
        [void]$names.Add("compiler/$name")
    }
    foreach($name in @('execution-manifest.json','summary.json')){[void]$names.Add("evidence/$name")}
    foreach($caseId in $script:CaseIds){
        $leaves=@('fixture.exe','launch.request.json','abi.json','ready.json','stdout-readiness.json','result.json',
            'outer-launcher.json','stdout.log','stderr.log')
        if($caseId -cne 'missing-stop'){$leaves+=@('stop.request.json')}
        foreach($leaf in $leaves){[void]$names.Add("$caseId/$leaf")}
    }
    return ,([string[]]$names)
}

function Assert-MyspeedProofEvidenceInventory {
    param([object]$Value)
    Assert-MyspeedCleanExactKeys $Value @('schemaVersion','kind','qualifying','releaseGatesCleared','files') 'Evidence inventory'
    [void](Assert-MyspeedCleanInteger $Value.schemaVersion 'Evidence inventory schema' 1 1)
    if((Assert-MyspeedCleanString $Value.kind 'Evidence inventory kind') -cne $script:EvidenceInventoryKind -or
        (Assert-MyspeedCleanBoolean $Value.qualifying 'Evidence inventory qualifying')){throw 'Evidence inventory header differs'}
    $gates=Assert-MyspeedCleanArray $Value.releaseGatesCleared 'Evidence inventory release gates'
    if($gates.Count -ne 0){throw 'Evidence inventory release gates differ'}
    $expected=Get-MyspeedProofExpectedInventoryNames
    $files=Assert-MyspeedCleanArray $Value.files 'Evidence inventory files'
    if($files.Count -ne $expected.Count){throw 'Evidence inventory file count differs'}
    $paths=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    [int64]$total=0
    for($index=0;$index -lt $files.Count;$index++){
        $file=$files[$index]
        Assert-MyspeedCleanExactKeys $file @('name','path','bytes','sha256') 'Evidence inventory file'
        if((Assert-MyspeedCleanString $file.name 'Evidence inventory file name') -cne $expected[$index]){
            throw 'Evidence inventory file order differs'
        }
        $path=Assert-MyspeedCleanPath $file.path 'Evidence inventory file path'
        if(-not $paths.Add($path)){throw 'Evidence inventory file path is duplicated'}
        $bytes=Assert-MyspeedCleanInteger $file.bytes 'Evidence inventory file bytes' 0 $script:MaximumManifestFileBytes
        [void](Assert-MyspeedCleanString $file.sha256 'Evidence inventory file SHA' '^[0-9a-f]{64}$')
        $total+=$bytes
        if($total -gt $script:MaximumAggregateEvidenceBytes){throw 'Evidence inventory aggregate exceeds its bound'}
    }
    return [pscustomobject][ordered]@{accepted=$true;fileCount=$files.Count;aggregateBytes=$total}
}

function Get-MyspeedProofFileByRole {
    param([object[]]$Files,[string]$Role)
    $matches=@($Files|Where-Object {$_.role -ceq $Role})
    if($matches.Count -ne 1){throw 'Manifest file roles differ'}
    return $matches[0]
}

function Assert-MyspeedProofManifest {
    param([object]$Value)
    Assert-MyspeedCleanExactKeys $Value @('schemaVersion','kind','qualifying','repository','runId','runAttempt',
        'eventSha','sourceSha','imageOS','imageVersion','architecture','nonce','transportSha256','observerSha256','caseIds','limits','files','compilerArguments') 'Proof manifest'
    [void](Assert-MyspeedCleanInteger $Value.schemaVersion 'Proof manifest schema' 1 1)
    if((Assert-MyspeedCleanString $Value.kind 'Proof manifest kind') -cne $script:ManifestKind){throw 'Proof manifest kind differs'}
    if(Assert-MyspeedCleanBoolean $Value.qualifying 'Proof manifest qualifying'){throw 'Proof manifest must remain nonqualifying'}
    if((Assert-MyspeedCleanString $Value.repository 'Proof manifest repository') -cne $script:Repository -or
        (Assert-MyspeedCleanString $Value.imageOS 'Proof manifest image OS') -cne $script:ImageOS -or
        (Assert-MyspeedCleanString $Value.architecture 'Proof manifest architecture') -cne 'X64'){throw 'Proof manifest runner identity differs'}
    [void](Assert-MyspeedCleanString $Value.runId 'Proof manifest run ID' '^[1-9][0-9]{0,19}$')
    [void](Assert-MyspeedCleanString $Value.runAttempt 'Proof manifest run attempt' '^[1-9][0-9]{0,9}$')
    [void](Assert-MyspeedCleanString $Value.eventSha 'Proof manifest event SHA' '^[0-9a-f]{40}$')
    [void](Assert-MyspeedCleanString $Value.sourceSha 'Proof manifest source SHA' '^[0-9a-f]{40}$')
    [void](Assert-MyspeedCleanString $Value.imageVersion 'Proof manifest image version' '^[0-9A-Za-z._-]{1,128}$')
    [void](Assert-MyspeedCleanString $Value.nonce 'Proof manifest nonce' '^[0-9a-f]{32}$')
    [void](Assert-MyspeedCleanString $Value.transportSha256 'Proof transport SHA' '^[0-9a-f]{64}$')
    if((Assert-MyspeedCleanString $Value.observerSha256 'Proof manifest observer SHA' '^[0-9a-f]{64}$') -cne
        (Get-MyspeedProofObserverSha256)){throw 'Proof manifest observer SHA differs'}
    $caseIds=Assert-MyspeedCleanArray $Value.caseIds 'Proof manifest case IDs'
    if($caseIds.Count -ne $script:CaseIds.Count){throw 'Proof manifest case IDs differ'}
    for($index=0;$index -lt $script:CaseIds.Count;$index++){
        if($caseIds[$index] -isnot [string] -or $caseIds[$index] -cne $script:CaseIds[$index]){throw 'Proof manifest case order differs'}
    }
    Assert-MyspeedCleanExactKeys $Value.limits @('controllerNormalDeadlineMs','controllerHardDeadlineMs',
        'stopRequestTimeoutMs','stopRequestPollMs','gracefulExitTimeoutMs','forcedCleanupTimeoutMs') 'Proof manifest limits'
    $expectedLimits=[ordered]@{controllerNormalDeadlineMs=300000;controllerHardDeadlineMs=310000
        stopRequestTimeoutMs=240000;stopRequestPollMs=50;gracefulExitTimeoutMs=30000
        forcedCleanupTimeoutMs=10000}
    foreach($entry in $expectedLimits.GetEnumerator()){
        [void](Assert-MyspeedCleanInteger $Value.limits.($entry.Key) "Proof manifest $($entry.Key)" $entry.Value $entry.Value)
    }
    $files=Assert-MyspeedCleanArray $Value.files 'Proof manifest files'
    if($files.Count -ne $script:FileRoles.Count){throw 'Proof manifest file count differs'}
    $paths=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $identities=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    for($index=0;$index -lt $files.Count;$index++){
        $file=$files[$index]
        Assert-MyspeedCleanExactKeys $file @('role','path','bytes','sha256','volumeSerial','fileId','linkCount','fileVersion') 'Proof manifest file'
        if((Assert-MyspeedCleanString $file.role 'Proof manifest file role') -cne $script:FileRoles[$index]){throw 'Proof manifest file order differs'}
        $path=Assert-MyspeedCleanPath $file.path 'Proof manifest file path'
        if(-not $paths.Add($path)){throw 'Proof manifest file path collides'}
        [void](Assert-MyspeedCleanInteger $file.bytes 'Proof manifest file bytes' 1 $script:MaximumManifestFileBytes)
        [void](Assert-MyspeedCleanString $file.sha256 'Proof manifest file SHA' '^[0-9a-f]{64}$')
        [void](Assert-MyspeedCleanString $file.volumeSerial 'Proof manifest file volume serial' '^[0-9a-f]{8}$')
        [void](Assert-MyspeedCleanString $file.fileId 'Proof manifest file ID' '^[0-9a-f]{16}$')
        if(-not $identities.Add($file.volumeSerial+':'+$file.fileId)){throw 'Proof manifest file identity collides'}
        $maximumLinkCount=if($file.role -in $script:SingleLinkFileRoles){1}else{4294967295}
        [void](Assert-MyspeedCleanInteger $file.linkCount 'Proof manifest file link count' 1 $maximumLinkCount)
        if($null -eq $file.fileVersion){
            if($file.role -in @('inbox-powershell','compiler')){throw 'Proof manifest required file version is absent'}
        }else{[void](Assert-MyspeedCleanString $file.fileVersion 'Proof manifest file version' '^[^\x00-\x1f]{1,128}$')}
    }
    $arguments=Assert-MyspeedCleanArray $Value.compilerArguments 'Proof manifest compiler arguments'
    $source=(Get-MyspeedProofFileByRole $files 'fixture-source').path
    $output=(Get-MyspeedProofFileByRole $files 'fixture-binary').path
    $expected=@('/noconfig','/nostdlib','/target:exe','/platform:x64','/optimize+','/debug-','/utf8output',
        "/out:$output", "/reference:$((Get-MyspeedProofFileByRole $files 'mscorlib').path)",
        "/reference:$((Get-MyspeedProofFileByRole $files 'system').path)",
        "/reference:$((Get-MyspeedProofFileByRole $files 'system-core').path)",$source)
    if($arguments.Count -ne $expected.Count){throw 'Proof manifest compiler arguments differ'}
    for($index=0;$index -lt $expected.Count;$index++){
        if($arguments[$index] -isnot [string] -or $arguments[$index] -cne $expected[$index]){throw 'Proof manifest compiler arguments differ'}
    }
    return [pscustomobject]@{accepted=$true}
}

function Assert-MyspeedProofReady {
    param([object]$Launch,[string]$LaunchSha,[string]$AbiSha,[object]$Ready)
    Assert-MyspeedCleanExactKeys $Ready @('schemaVersion','kind','manifestSha256','caseId','requestSha256','abiSha256',
        'candidatePid','candidateCreationTime','candidateImagePath','candidateSha256','candidateVolumeSerial','candidateFileId',
        'controllerInitiallyConsoleFree','candidateCreatedSuspended','privateConsoleRequested','handleListConfigured',
        'jobAssignedBeforeResume','initialJobMembership','candidateIdentityCaptured','candidateResumed',
        'threadHandleClosedBeforeReady','qualifying') 'Ready evidence'
    [void](Assert-MyspeedCleanInteger $Ready.schemaVersion 'Ready evidence schema' 1 1)
    if((Assert-MyspeedCleanString $Ready.kind 'Ready evidence kind') -cne $script:ReadyKind){throw 'Ready evidence kind differs'}
    foreach($binding in @{manifestSha256='manifestSha256';caseId='caseId';candidateImagePath='candidatePath';
        candidateSha256='candidateSha256';candidateVolumeSerial='candidateVolumeSerial';candidateFileId='candidateFileId'}.GetEnumerator()){
        if((Assert-MyspeedCleanString $Ready.($binding.Key) "Ready evidence $($binding.Key)") -cne $Launch.($binding.Value)){throw 'Ready evidence identity binding differs'}
    }
    if((Assert-MyspeedCleanString $Ready.requestSha256 'Ready evidence request SHA' '^[0-9a-f]{64}$') -cne $LaunchSha -or
        (Assert-MyspeedCleanString $Ready.abiSha256 'Ready evidence ABI SHA' '^[0-9a-f]{64}$') -cne $AbiSha){throw 'Ready evidence hash binding differs'}
    [void](Assert-MyspeedCleanInteger $Ready.candidatePid 'Ready evidence PID' 1 4294967295)
    [void](Assert-MyspeedCleanString $Ready.candidateCreationTime 'Ready evidence creation time' '^[0-9a-f]{16}$')
    foreach($name in @('controllerInitiallyConsoleFree','candidateCreatedSuspended','privateConsoleRequested',
        'handleListConfigured','jobAssignedBeforeResume','initialJobMembership','candidateIdentityCaptured',
        'candidateResumed','threadHandleClosedBeforeReady')){
        if(-not (Assert-MyspeedCleanBoolean $Ready.$name "Ready evidence $name")){throw 'Ready evidence lifecycle proof differs'}
    }
    if(Assert-MyspeedCleanBoolean $Ready.qualifying 'Ready evidence qualifying'){throw 'Ready evidence must remain nonqualifying'}
}

function Get-MyspeedProofSha256 {
    param([byte[]]$Bytes)
    $algorithm=[Security.Cryptography.SHA256]::Create();try{return [BitConverter]::ToString($algorithm.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant()}finally{$algorithm.Dispose()}
}

function Get-MyspeedProofObserverSha256 {
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes($script:ObserverBody.ToString())
    return Get-MyspeedProofSha256 $bytes
}

function Read-MyspeedProofJsonDocument {
    param([object]$Document,[string]$Label)
    Assert-MyspeedCleanExactKeys $Document @('bytesBase64','sha256') "$Label document"
    $base64=Assert-MyspeedCleanString $Document.bytesBase64 "$Label bytes" '^[A-Za-z0-9+/]*={0,2}$'
    $expectedSha=Assert-MyspeedCleanString $Document.sha256 "$Label SHA" '^[0-9a-f]{64}$'
    try{$bytes=[Convert]::FromBase64String($base64)}catch{throw "$Label base64 is invalid"}
    if([Convert]::ToBase64String($bytes) -cne $base64 -or $bytes.Length -lt 2 -or $bytes.Length -gt 262144){throw "$Label bytes differ"}
    if((Get-MyspeedProofSha256 $bytes) -cne $expectedSha){throw "$Label hash differs"}
    try{$json=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)}catch{throw "$Label UTF-8 is invalid"}
    return [pscustomobject]@{value=ConvertFrom-MyspeedProofJson $json $Label;sha256=$expectedSha}
}

function Get-MyspeedProofOuterArguments {
    param([object]$Manifest,[object]$Launch,[string]$LaunchSha256)
    $controller=(Get-MyspeedProofFileByRole ([object[]]$Manifest.files) 'controller').path
    $launchPath=[IO.Path]::Combine($Launch.taskRoot,'launch.request.json')
    return [string[]]@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$controller,
        '-Mode','InvokeHostedController','-LaunchRequestPath',$launchPath,'-ExpectedLaunchRequestSha256',$LaunchSha256,
        '-ExpectedRunId',$Launch.expectedRunId,'-ExpectedRunAttempt',$Launch.expectedRunAttempt,
        '-ExpectedEventSha',$Launch.expectedEventSha,'-ExpectedSourceSha',$Launch.expectedSourceSha,
        '-ExpectedImageVersion',$Launch.expectedImageVersion,'-Nonce',$Launch.nonce)
}

function Get-MyspeedProofFailedProcessStreams {
    param([object]$Launch)
    $reads=[ordered]@{}
    foreach($entry in ([ordered]@{result=$Launch.resultPath;entryDiagnostic=($Launch.resultPath+'.entry-failure.json')
        stdout=$Launch.stdoutPath;stderr=$Launch.stderrPath}).GetEnumerator()){
        if(-not [IO.File]::Exists($entry.Value)){$reads[$entry.Key]=$null;continue}
        try{$reads[$entry.Key]=Read-MyspeedProofBoundedFile $entry.Value 2097152 -AllowEmpty}catch{$reads[$entry.Key]='unreadable'}
    }
    $parts=[Collections.Generic.List[string]]::new()
    $resultFailure='unavailable'
    $resultProof='unavailable'
    if($null -ne $reads.result -and $reads.result -isnot [string]){
        try{
            $parsed=(ConvertFrom-MyspeedProofJson ([Text.UTF8Encoding]::new($false,$true).GetString($reads.result.bytes)) 'Failed controller result')
            $failuresProperty=$parsed.PSObject.Properties['failures']
            if($null -ne $failuresProperty -and $failuresProperty.Value -is [object[]] -and
                $failuresProperty.Value.Count -gt 0 -and $failuresProperty.Value[0] -is [string]){
                $failureBytes=[Text.UTF8Encoding]::new($false).GetBytes($failuresProperty.Value[0])
                $take=[Math]::Min($script:MaximumFailureFieldBytes,$failureBytes.Length);$prefix=New-Object byte[] $take
                if($take -gt 0){[Array]::Copy($failureBytes,$prefix,$take)};$resultFailure=[Convert]::ToBase64String($prefix)
            }
            $requiredProofs=@('controllerInitiallyConsoleFree','candidateCreatedSuspended','privateConsoleRequested',
                'handleListConfigured','jobAssignedBeforeResume','initialJobMembership','candidateIdentityCaptured',
                'candidateResumed','threadHandleClosedBeforeReady','preAttachIdentityMatch','postAttachHandleUnsignaled',
                'postAttachIdentityMatch','postAttachJobMembership','consoleProcessIdsExact','ctrlEventGenerated',
                'candidateExited','consoleFreeAfter','handlesClosed')
            $falseProofs=[Collections.Generic.List[string]]::new()
            foreach($name in $requiredProofs){$property=$parsed.PSObject.Properties[$name]
                if($null -eq $property -or $property.Value -isnot [bool] -or -not $property.Value){
                    if($falseProofs.Count -lt $script:MaximumFailureProofNames){[void]$falseProofs.Add($name)}}}
            $normalizeBoolean={param($name)$property=$parsed.PSObject.Properties[$name]
                if($null -eq $property -or $property.Value -isnot [bool]){return 'x'};if($property.Value){return '1'};return '0'}
            $normalizeInteger={param($name)$property=$parsed.PSObject.Properties[$name]
                if($null -eq $property -or $null -eq $property.Value){return 'null'}
                if($property.Value -isnot [ValueType] -or $property.Value -is [bool] -or $property.Value -is [double] -or
                    $property.Value -is [single] -or $property.Value -is [decimal]){return 'invalid'}
                try{return ([int64]$property.Value).ToString([Globalization.CultureInfo]::InvariantCulture)}catch{return 'invalid'}}
            $resultProof="pass:$(& $normalizeBoolean 'controllerLifecyclePassed'),forced:$(& $normalizeBoolean 'forced'),grace:$(& $normalizeBoolean 'graceExpired')," +
                "false:$($falseProofs -join ','),exit:$(& $normalizeInteger 'exitCode'),job:$(& $normalizeInteger 'jobActiveProcesses')," +
                "elapsed:$(& $normalizeInteger 'elapsedMs')"
        }catch{}
    }
    [void]$parts.Add("resultFailurePrefixBase64=$resultFailure")
    [void]$parts.Add("resultProof=$resultProof")
    $entryFailure='unavailable'
    if($null -ne $reads.entryDiagnostic -and $reads.entryDiagnostic -isnot [string]){
        try{
            $parsed=(ConvertFrom-MyspeedProofJson ([Text.UTF8Encoding]::new($false,$true).GetString($reads.entryDiagnostic.bytes)) 'Controller entry diagnostic')
            if($parsed.kind -ceq 'myspeed-windows-clean-stop-controller-entry-failure' -and $parsed.messagePrefixBase64 -is [string]){
                $failureBytes=[Convert]::FromBase64String($parsed.messagePrefixBase64)
                if([Convert]::ToBase64String($failureBytes) -cne $parsed.messagePrefixBase64){throw 'Entry diagnostic base64 differs'}
                $take=[Math]::Min($script:MaximumFailureFieldBytes,$failureBytes.Length);$prefix=New-Object byte[] $take
                if($take -gt 0){[Array]::Copy($failureBytes,$prefix,$take)};$entryFailure=[Convert]::ToBase64String($prefix)
            }
        }catch{}
    }
    [void]$parts.Add("entryFailurePrefixBase64=$entryFailure")
    foreach($entry in ([ordered]@{result=$reads.result;entryDiagnostic=$reads.entryDiagnostic;stdout=$reads.stdout;stderr=$reads.stderr}).GetEnumerator()){
        if($null -eq $entry.Value){[void]$parts.Add("$($entry.Key)=absent");continue}
        if($entry.Value -is [string]){[void]$parts.Add("$($entry.Key)=unreadable");continue}
        $read=$entry.Value;$summary="$($entry.Key)Bytes=$($read.bytes.Length),$($entry.Key)Sha256=$(Get-MyspeedProofSha256 $read.bytes)"
        if($entry.Key -in @('stdout','stderr')){
            $take=[Math]::Min($script:MaximumFailureStreamBytes,$read.bytes.Length);$prefix=New-Object byte[] $take
            if($take -gt 0){[Array]::Copy($read.bytes,$prefix,$take)};$summary+=",$($entry.Key)PrefixBase64=$([Convert]::ToBase64String($prefix))"
        }
        [void]$parts.Add($summary)
    }
    return ($parts -join ';')
}

function Assert-MyspeedProofOuterLauncher {
    param([object]$Manifest,[object]$Launch,[string]$LaunchSha256,[object]$Result)
    Assert-MyspeedCleanExactKeys $Result @('schemaVersion','kind','status','authorizesTransfer','executable','arguments',
        'workingDirectory','creationFlags','process','timing','timedOut','forced','exitCode','processTreeExitProven',
        'handles','observer','failure') 'Outer launcher'
    [void](Assert-MyspeedCleanInteger $Result.schemaVersion 'Outer launcher schema' 1 1)
    if((Assert-MyspeedCleanString $Result.kind 'Outer launcher kind') -cne $script:OuterLauncherKind -or
        (Assert-MyspeedCleanString $Result.status 'Outer launcher status') -cne 'completed'){
        throw 'Outer launcher completion differs'
    }
    if((Assert-MyspeedCleanBoolean $Result.authorizesTransfer 'Outer launcher transfer') -or
        (Assert-MyspeedCleanBoolean $Result.timedOut 'Outer launcher timeout') -or
        (Assert-MyspeedCleanBoolean $Result.forced 'Outer launcher forced cleanup') -or
        -not (Assert-MyspeedCleanBoolean $Result.processTreeExitProven 'Outer launcher tree exit') -or $null -ne $Result.failure){
        throw 'Outer launcher proof differs'
    }
    Assert-MyspeedCleanExactKeys $Result.executable @('path','expectedSha256','beforeSha256','afterSha256') 'Outer executable'
    $powershell=Get-MyspeedProofFileByRole ([object[]]$Manifest.files) 'inbox-powershell'
    foreach($name in @('expectedSha256','beforeSha256','afterSha256')){
        if((Assert-MyspeedCleanString $Result.executable.$name "Outer executable $name" '^[0-9a-f]{64}$') -cne $powershell.sha256){
            throw 'Outer executable hash binding differs'
        }
    }
    if((Assert-MyspeedCleanPath $Result.executable.path 'Outer executable path') -cne $powershell.path -or
        (Assert-MyspeedCleanPath $Result.workingDirectory 'Outer working directory') -cne $Launch.taskRoot){
        throw 'Outer executable path binding differs'
    }
    [void](Assert-MyspeedCleanInteger $Result.creationFlags 'Outer creation flags' $script:OuterCreationFlags $script:OuterCreationFlags)
    $arguments=Assert-MyspeedCleanArray $Result.arguments 'Outer arguments'
    $expected=Get-MyspeedProofOuterArguments $Manifest $Launch $LaunchSha256
    if($arguments.Count -ne $expected.Count){throw 'Outer arguments differ'}
    for($index=0;$index -lt $expected.Count;$index++){
        if($arguments[$index] -isnot [string] -or $arguments[$index] -cne $expected[$index]){throw 'Outer arguments differ'}
    }
    Assert-MyspeedCleanExactKeys $Result.process @('processId','assignedBeforeResume','resumed','retainedHandleThroughExit') 'Outer process'
    [void](Assert-MyspeedCleanInteger $Result.process.processId 'Outer process ID' 1 4294967295)
    if(-not (Assert-MyspeedCleanBoolean $Result.process.assignedBeforeResume 'Outer assignment') -or
        -not (Assert-MyspeedCleanBoolean $Result.process.resumed 'Outer resume') -or
        -not (Assert-MyspeedCleanBoolean $Result.process.retainedHandleThroughExit 'Outer retained handle')){
        throw 'Outer process proof differs'
    }
    Assert-MyspeedCleanExactKeys $Result.handles @('job','process','thread') 'Outer handles'
    foreach($name in @('job','process','thread')){if((Assert-MyspeedCleanString $Result.handles.$name "Outer $name handle") -cne 'closed'){
        throw 'Outer handle proof differs'}}
    $expectedExit=if($Launch.caseId -ceq 'handler'){0}else{1}
    $actualExit=Assert-MyspeedCleanInteger $Result.exitCode 'Outer exit code' -2147483648 2147483647
    if($actualExit -ne $expectedExit){throw "Outer exit code differs: actual=$actualExit; expected=$expectedExit"}
    Assert-MyspeedCleanExactKeys $Result.timing @('initialWallUnixMilliseconds','initialMonotonicMilliseconds',
        'wallDeadlineUnixMilliseconds','monotonicDeadlineMilliseconds','lastWallUnixMilliseconds',
        'lastMonotonicMilliseconds','postReturnWallUnixMilliseconds','postReturnMonotonicMilliseconds') 'Outer timing'
    $timing=[ordered]@{};foreach($name in @($Result.timing.PSObject.Properties.Name)){
        $timing[$name]=Assert-MyspeedProofClockNumber $Result.timing.$name "Outer timing $name" 0 9223372036854775807
    }
    $wallAllowance=$timing.wallDeadlineUnixMilliseconds-$timing.initialWallUnixMilliseconds
    if($wallAllowance -le 0 -or $wallAllowance -gt $script:MaximumObservedMilliseconds -or
        $timing.monotonicDeadlineMilliseconds-$timing.initialMonotonicMilliseconds -ne $script:MaximumObservedMilliseconds -or
        $timing.lastWallUnixMilliseconds -lt $timing.initialWallUnixMilliseconds -or
        $timing.lastMonotonicMilliseconds -lt $timing.initialMonotonicMilliseconds -or
        $timing.lastWallUnixMilliseconds -ge $timing.wallDeadlineUnixMilliseconds -or
        $timing.lastMonotonicMilliseconds -ge $timing.monotonicDeadlineMilliseconds -or
        $timing.postReturnWallUnixMilliseconds -lt $timing.lastWallUnixMilliseconds -or
        $timing.postReturnMonotonicMilliseconds -lt $timing.lastMonotonicMilliseconds -or
        $timing.postReturnWallUnixMilliseconds -ge $timing.wallDeadlineUnixMilliseconds -or
        $timing.postReturnMonotonicMilliseconds -ge $timing.monotonicDeadlineMilliseconds){throw 'Outer timing proof differs'}
    Assert-MyspeedCleanExactKeys $Result.observer @('sha256','tickCount','firstMonotonicMilliseconds',
        'lastMonotonicMilliseconds','maximumDurationMilliseconds','contextKeys','lastAction','lastObservation',
        'synchronousCancellationProven') 'Outer observer'
    if((Assert-MyspeedCleanString $Result.observer.sha256 'Outer observer SHA' '^[0-9a-f]{64}$') -cne $Manifest.observerSha256 -or
        (Assert-MyspeedCleanInteger $Result.observer.tickCount 'Outer observer ticks' 1 1000000) -lt 1 -or
        (Assert-MyspeedCleanBoolean $Result.observer.synchronousCancellationProven 'Outer observer cancellation')){
        throw 'Outer observer proof differs'
    }
    $observerFirst=Assert-MyspeedProofClockNumber $Result.observer.firstMonotonicMilliseconds 'Outer observer first monotonic' 0 9223372036854775807
    $observerLast=Assert-MyspeedProofClockNumber $Result.observer.lastMonotonicMilliseconds 'Outer observer last monotonic' 0 9223372036854775807
    [void](Assert-MyspeedProofClockNumber $Result.observer.maximumDurationMilliseconds 'Outer observer maximum duration' 0 $script:MaximumObservedMilliseconds)
    if($observerFirst -lt $timing.initialMonotonicMilliseconds -or $observerLast -lt $observerFirst -or
        $observerLast -gt $timing.lastMonotonicMilliseconds){throw 'Outer observer timing differs'}
    $contextKeys=Assert-MyspeedCleanArray $Result.observer.contextKeys 'Outer observer context keys'
    if($contextKeys.Count -ne $script:ObserverContextKeys.Count){throw 'Outer observer context differs'}
    for($index=0;$index -lt $script:ObserverContextKeys.Count;$index++){
        if($contextKeys[$index] -isnot [string] -or $contextKeys[$index] -cne $script:ObserverContextKeys[$index]){throw 'Outer observer context differs'}
    }
    foreach($name in @('lastAction','lastObservation')){[void](Assert-MyspeedCleanString $Result.observer.$name "Outer observer $name" '^[a-z][a-z0-9-]{0,63}$')}
    return $Result
}

function Assert-MyspeedProofCaseCollectionGate {
    param([object]$Value)
    Assert-MyspeedCleanExactKeys $Value @('status','failure','files') 'Case collection gate'
    $status=Assert-MyspeedCleanString $Value.status 'Case collection outer status' '^(completed|failed)$'
    if($status -ceq 'failed'){
        Assert-MyspeedCleanExactKeys $Value.failure @('stage','message') 'Case collection outer failure'
        $stage=Assert-MyspeedCleanString $Value.failure.stage 'Case collection outer failure stage' '^[a-z][a-z0-9-]{0,63}$'
        $message=Assert-MyspeedCleanString $Value.failure.message 'Case collection outer failure message'
        if($message.Length -gt $script:MaximumFailureMessageLength -or $message -match '[\x00-\x1f]'){
            throw 'Case collection outer failure message differs'
        }
        throw "Outer launcher failed at $stage`: $message"
    }
    if($null -ne $Value.failure){throw 'Completed outer launcher retained a failure'}
    $names=@('abi','ready','readiness','result','stdout','stderr')
    Assert-MyspeedCleanExactKeys $Value.files $names 'Case collection files'
    foreach($name in $names){
        if(-not (Assert-MyspeedCleanBoolean $Value.files.$name "Case collection $name file")){
            throw "Case evidence is incomplete: $name"
        }
    }
    return [pscustomobject]@{ready=$true}
}

function Invoke-MyspeedProofObserverTick {
    param([hashtable]$State,[object]$Operations,[object]$Context)
    Assert-MyspeedCleanExactKeys $Context $script:ObserverContextKeys 'Observer context'
    [void](Assert-MyspeedCleanInteger $Context.schemaVersion 'Observer context schema' 1 1)
    [void](Assert-MyspeedCleanInteger $Context.tick 'Observer tick' 0 1000000)
    [void](Assert-MyspeedCleanInteger $Context.processId 'Observer process ID' 1 4294967295)
    $wall=Assert-MyspeedProofClockNumber $Context.wallUnixMilliseconds 'Observer wall time' 0 9223372036854775807
    $mono=Assert-MyspeedProofClockNumber $Context.monotonicMilliseconds 'Observer monotonic time' 0 9223372036854775807
    $wallDeadline=Assert-MyspeedProofClockNumber $Context.wallDeadlineUnixMilliseconds 'Observer wall deadline' 1 9223372036854775807
    $monoDeadline=Assert-MyspeedProofClockNumber $Context.monotonicDeadlineMilliseconds 'Observer monotonic deadline' 1 9223372036854775807
    if($wall -ge $wallDeadline -or $mono -ge $monoDeadline){throw 'Observer deadline expired'}
    if($null -eq $State.initialMonotonic){$State.initialMonotonic=$mono;$State.processId=$Context.processId}
    if($Context.processId -ne $State.processId -or $mono -lt $State.initialMonotonic){throw 'Observer context identity differs'}
    if($State.protocolPrepared){
        if(& $Operations.Exists $State.Launch.resultPath){
            return [pscustomobject]@{schemaVersion=1;status='observed';action='observe';observation='result-present'}
        }
        return [pscustomobject]@{schemaVersion=1;status='observed';action='await';observation='result-absent'}
    }
    if($null -eq $State.abiSha){
        if(-not (& $Operations.Exists $State.Launch.abiPath)){
            return [pscustomobject]@{schemaVersion=1;status='observed';action='await';observation='abi-absent'}
        }
        if(-not (& $Operations.CanReadStable $State.Launch.abiPath)){
            return [pscustomobject]@{schemaVersion=1;status='observed';action='await';observation='abi-in-progress'}
        }
        $abiLoaded=& $Operations.ReadDocument $State.Launch.abiPath 'ABI observation'
        $abiAssessment=Assert-MyspeedCleanAbiObservation $abiLoaded.value
        if(-not $abiAssessment.matched){throw 'Observer ABI observation differs'}
        $State.abi=$abiLoaded.value;$State.abiSha=$abiLoaded.sha256
    }
    if(-not (& $Operations.Exists $State.Launch.readyPath)){
        return [pscustomobject]@{schemaVersion=1;status='observed';action='await';observation='ready-absent'}
    }
    if(-not (& $Operations.CanReadStable $State.Launch.readyPath)){
        return [pscustomobject]@{schemaVersion=1;status='observed';action='await';observation='ready-in-progress'}
    }
    $readyLoaded=& $Operations.ReadDocument $State.Launch.readyPath 'Ready evidence'
    Assert-MyspeedProofReady $State.Launch $State.LaunchSha $State.AbiSha $readyLoaded.value
    $stdout=[byte[]](& $Operations.ReadBytes $State.Launch.stdoutPath)
    $expected=[Text.UTF8Encoding]::new($false).GetBytes($script:FixtureReadyMarker+"`r`n")
    if($stdout.Length -gt $expected.Length){throw 'Observer stdout marker differs'}
    for($index=0;$index -lt $stdout.Length;$index++){if($stdout[$index] -ne $expected[$index]){throw 'Observer stdout marker differs'}}
    if($stdout.Length -lt $expected.Length){
        return [pscustomobject]@{schemaVersion=1;status='observed';action='await';observation='stdout-incomplete'}
    }
    $stdoutSha=Get-MyspeedProofSha256 $stdout
    $readiness=[pscustomobject][ordered]@{schemaVersion=1;kind='myspeed-windows-clean-stop-stdout-readiness'
        manifestSha256=$State.Launch.manifestSha256;caseId=$State.Launch.caseId;launchRequestSha256=$State.LaunchSha
        abiSha256=$State.AbiSha;readySha256=$readyLoaded.sha256;stdoutSha256=$stdoutSha
        marker=$script:FixtureReadyMarker;observedMonotonicMs=($mono-$State.initialMonotonic)}
    $readinessSha=& $Operations.WriteDocument $State.Launch.stdoutReadinessPath $readiness 'Stdout readiness'
    $State.readiness=$readiness;$State.readinessSha=$readinessSha;$State.ready=$readyLoaded.value;$State.readySha=$readyLoaded.sha256
    if($State.Launch.caseId -ceq 'missing-stop'){
        $State.protocolPrepared=$true
        return [pscustomobject]@{schemaVersion=1;status='observed';action='withhold-stop';observation='missing-stop'}
    }
    $stop=[pscustomobject][ordered]@{schemaVersion=1;kind='myspeed-windows-clean-stop-request'
        expectedRunId=$State.Launch.expectedRunId;expectedRunAttempt=$State.Launch.expectedRunAttempt
        expectedEventSha=$State.Launch.expectedEventSha;nonce=$State.Launch.nonce;manifestSha256=$State.Launch.manifestSha256
        launchRequestSha256=$State.LaunchSha;abiSha256=$State.AbiSha;readySha256=$readyLoaded.sha256
        stdoutReadinessSha256=$readinessSha;caseId=$State.Launch.caseId;candidatePid=$readyLoaded.value.candidatePid
        candidateCreationTime=$readyLoaded.value.candidateCreationTime;candidateImagePath=$readyLoaded.value.candidateImagePath
        candidateSha256=$readyLoaded.value.candidateSha256;candidateVolumeSerial=$readyLoaded.value.candidateVolumeSerial
        candidateFileId=$readyLoaded.value.candidateFileId}
    [void](Assert-MyspeedCleanStopRequest $State.Launch $State.LaunchSha $State.AbiSha $readyLoaded.sha256 $stop)
    [void](& $Operations.WriteDocument $State.Launch.stopRequestPath $stop 'Stop request')
    $State.stop=$stop;$State.protocolPrepared=$true
    return [pscustomobject]@{schemaVersion=1;status='observed';action='write-stop';observation='stop-created'}
}

function New-MyspeedCleanStopProofObserver {
    param([object]$Launch,[string]$LaunchSha,[object]$Operations)
    foreach($name in @('Exists','CanReadStable','ReadDocument','ReadBytes','WriteDocument')){if($Operations.$name -isnot [scriptblock]){throw "Observer $name operation is absent"}}
    $state=@{Launch=$Launch;LaunchSha=$LaunchSha;abi=$null;abiSha=$null;initialMonotonic=$null;processId=$null
        protocolPrepared=$false;readiness=$null;readinessSha=$null;ready=$null;readySha=$null;stop=$null}
    return $script:ObserverBody.GetNewClosure()
}

function Assert-MyspeedProofCase {
    param([object]$Value,[object]$Manifest=$null)
    Assert-MyspeedCleanExactKeys $Value @('manifestSha256','launchDocument','abiDocument','readyDocument',
        'stdoutReadinessDocument','stdoutBase64','stdoutSha256','stopDocument','resultDocument','outerLauncherDocument') 'Proof case'
    $manifestSha=Assert-MyspeedCleanString $Value.manifestSha256 'Proof case manifest SHA' '^[0-9a-f]{64}$'
    $launchLoaded=Read-MyspeedProofJsonDocument $Value.launchDocument 'Launch request'
    $abiLoaded=Read-MyspeedProofJsonDocument $Value.abiDocument 'ABI observation'
    $readyLoaded=Read-MyspeedProofJsonDocument $Value.readyDocument 'Ready evidence'
    $readinessLoaded=Read-MyspeedProofJsonDocument $Value.stdoutReadinessDocument 'Stdout readiness'
    $stopLoaded=if($null -eq $Value.stopDocument){$null}else{Read-MyspeedProofJsonDocument $Value.stopDocument 'Stop request'}
    $resultLoaded=Read-MyspeedProofJsonDocument $Value.resultDocument 'Controller result'
    $outerLoaded=Read-MyspeedProofJsonDocument $Value.outerLauncherDocument 'Outer launcher'
    $Value=[pscustomobject]@{manifestSha256=$manifestSha;launch=$launchLoaded.value;launchRequestSha256=$launchLoaded.sha256
        abi=$abiLoaded.value;abiSha256=$abiLoaded.sha256;ready=$readyLoaded.value;readySha256=$readyLoaded.sha256
        stdoutReadiness=$readinessLoaded.value;stdoutReadinessSha256=$readinessLoaded.sha256
        stdoutBase64=$Value.stdoutBase64;stdoutSha256=$Value.stdoutSha256;stop=if($null -eq $stopLoaded){$null}else{$stopLoaded.value}
        stopRequestSha256=if($null -eq $stopLoaded){$null}else{$stopLoaded.sha256};result=$resultLoaded.value;resultSha256=$resultLoaded.sha256
        outerLauncher=$outerLoaded.value;outerLauncherSha256=$outerLoaded.sha256}
    [void](Assert-MyspeedCleanString $Value.stdoutSha256 'Proof case stdout SHA' '^[0-9a-f]{64}$')
    [void](Assert-MyspeedCleanLaunchRequest $Value.launch)
    if($Value.manifestSha256 -cne $Value.launch.manifestSha256){throw 'Proof case manifest binding differs'}
    $abiResult=Assert-MyspeedCleanAbiObservation $Value.abi
    if(-not $abiResult.matched){throw 'Proof case ABI did not match'}
    Assert-MyspeedProofReady $Value.launch $Value.launchRequestSha256 $Value.abiSha256 $Value.ready
    [void](Assert-MyspeedCleanStdoutReadiness $Value.launch $Value.launchRequestSha256 $Value.abiSha256 $Value.readySha256 $Value.stdoutReadiness)
    if($Value.stdoutReadinessSha256 -cne $Value.result.stdoutReadinessSha256 -or
        $Value.stdoutReadiness.stdoutSha256 -cne $Value.stdoutSha256){throw 'Proof case stdout binding differs'}
    $base64=Assert-MyspeedCleanString $Value.stdoutBase64 'Proof case stdout base64' '^[A-Za-z0-9+/]*={0,2}$'
    try{$bytes=[Convert]::FromBase64String($base64)}catch{throw 'Proof case stdout base64 is invalid'}
    if([Convert]::ToBase64String($bytes) -cne $base64){throw 'Proof case stdout base64 is not canonical'}
    $expected=[Text.UTF8Encoding]::new($false).GetBytes($script:FixtureReadyMarker+"`r`n")
    if($bytes.Length -ne $expected.Length -or (Get-MyspeedProofSha256 $bytes) -cne $Value.stdoutSha256){throw 'Proof case stdout hash differs'}
    for($index=0;$index -lt $bytes.Length;$index++){if($bytes[$index] -ne $expected[$index]){throw 'Proof case stdout marker differs'}}
    $caseId=$Value.launch.caseId
    if($caseId -ceq 'missing-stop'){
        if($null -ne $Value.stop -or $null -ne $Value.stopRequestSha256){throw 'Missing-stop case contains a stop request'}
    }else{
        [void](Assert-MyspeedCleanString $Value.stopRequestSha256 'Proof case stop request SHA' '^[0-9a-f]{64}$')
        [void](Assert-MyspeedCleanStopRequest $Value.launch $Value.launchRequestSha256 $Value.abiSha256 $Value.readySha256 $Value.stop)
        if($Value.stop.stdoutReadinessSha256 -cne $Value.stdoutReadinessSha256){throw 'Proof case stop stdout binding differs'}
        if($Value.stop.candidatePid -ne $Value.ready.candidatePid -or
            $Value.stop.candidateCreationTime -cne $Value.ready.candidateCreationTime){
            throw 'Proof case stop/ready candidate identity differs'
        }
    }
    [void](Assert-MyspeedCleanResult $Value.result)
    if($Value.result.caseId -cne $Value.launch.caseId){throw 'Proof case result case identity differs'}
    foreach($binding in @{manifestSha256='manifestSha256';requestSha256='launchRequestSha256';abiSha256='abiSha256';
        readySha256='readySha256';stdoutReadinessSha256='stdoutReadinessSha256';stopRequestSha256='stopRequestSha256'}.GetEnumerator()){
        if($Value.result.($binding.Key) -cne $Value.($binding.Value)){throw 'Proof case result binding differs'}
    }
    foreach($binding in @{runId='expectedRunId';runAttempt='expectedRunAttempt';eventSha='expectedEventSha';sourceSha='expectedSourceSha';
        imageVersion='expectedImageVersion';nonce='nonce';candidateImagePath='candidatePath';candidateSha256='candidateSha256';
        candidateVolumeSerial='candidateVolumeSerial';candidateFileId='candidateFileId'}.GetEnumerator()){
        if($Value.result.($binding.Key) -cne $Value.launch.($binding.Value)){throw 'Proof case result identity differs'}
    }
    foreach($name in @('candidatePid','candidateCreationTime','candidateImagePath','candidateSha256','candidateVolumeSerial','candidateFileId')){
        if($Value.result.$name -cne $Value.ready.$name){throw 'Proof case ready/result candidate identity differs'}
    }
    if($null -ne $Manifest){
        [void](Assert-MyspeedProofOuterLauncher $Manifest $Value.launch $Value.launchRequestSha256 $Value.outerLauncher)
        if($Value.outerLauncher.process.processId -ne $Value.result.controllerPid){throw 'Outer launcher/controller PID binding differs'}
    }
    $result=$Value.result
    $events=@($result.lifecycleEvents)
    $negativeCleanup=$result.jobActiveProcesses -eq 0 -and $result.consoleFreeAfter -and $result.handlesClosed -and
        $result.candidateExited -and $result.exitCode -eq $script:ForcedCleanupExitCode -and $events -ccontains 'closeResources'
    $exactConsolePair=$null -ne $result.observedConsoleProcessIds -and $result.observedConsoleProcessIds.Count -eq 2 -and
        $result.observedConsoleProcessIds -ccontains $result.controllerPid -and $result.observedConsoleProcessIds -ccontains $result.candidatePid
    $ignoreDiagnostic='status={0},pass={1},forced={2},grace={3},ctrl={4},pair={5},job={6},consoleFree={7},handles={8},exited={9},exit={10},close={11}' -f `
        $result.status,[int][bool]$result.controllerLifecyclePassed,[int][bool]$result.forced,[int][bool]$result.graceExpired,
        [int][bool]$result.ctrlEventGenerated,[int][bool]$exactConsolePair,$result.jobActiveProcesses,[int][bool]$result.consoleFreeAfter,
        [int][bool]$result.handlesClosed,[int][bool]$result.candidateExited,$result.exitCode,[int][bool]($events -ccontains 'closeResources')
    $classification=switch($caseId){
        'handler' {if($result.status -cne 'completed' -or -not $result.controllerLifecyclePassed -or $result.forced -or
                $result.graceExpired -or $result.exitCode -ne 0 -or -not $exactConsolePair){throw 'Handler case result differs'};'handler-natural-exit-observed'}
        'ignore' {if($result.status -cne 'failed' -or $result.controllerLifecyclePassed -or -not $result.forced -or
                -not $result.graceExpired -or -not $result.ctrlEventGenerated -or -not $exactConsolePair -or -not $negativeCleanup){throw "Ignore case result differs: $ignoreDiagnostic"};'ignore-forced-cleanup-observed'}
        'extra-participant' {if($result.status -cne 'failed' -or $result.controllerLifecyclePassed -or -not $result.forced -or
                $result.consoleProcessIdsExact -or $null -eq $result.observedConsoleProcessIds -or $result.observedConsoleProcessIds.Count -le 2 -or
                $result.observedConsoleProcessIds -cnotcontains $result.controllerPid -or $result.observedConsoleProcessIds -cnotcontains $result.candidatePid -or
                $result.ctrlEventGenerated -or $events -ccontains 'generateCtrlC' -or -not $negativeCleanup){throw 'Extra-participant case result differs'};'extra-participant-refusal-observed'}
        'missing-stop' {if($result.status -cne 'failed' -or $result.controllerLifecyclePassed -or -not $result.forced -or
                -not $result.stdoutReadinessObserved -or $result.stopRequestObserved -or $result.ctrlEventGenerated -or
                $result.stopRequestSha256 -ne $null -or $null -eq $result.stopRequestDeadlineMs -or
                $result.elapsedMs -lt $result.stopRequestDeadlineMs -or $events -ccontains 'attachConsole' -or
                $events -ccontains 'generateCtrlC' -or -not $negativeCleanup){throw 'Missing-stop case result differs'};'missing-stop-timeout-observed'}
    }
    return [pscustomobject][ordered]@{accepted=$true;caseId=$caseId;classification=$classification
        runId=$Value.launch.expectedRunId;runAttempt=$Value.launch.expectedRunAttempt;eventSha=$Value.launch.expectedEventSha
        sourceSha=$Value.launch.expectedSourceSha;imageVersion=$Value.launch.expectedImageVersion;nonce=$Value.launch.nonce
        candidateSha256=$Value.launch.candidateSha256;omittedHandleUnusable=$true
        launchSha256=$Value.launchRequestSha256;abiSha256=$Value.abiSha256;readySha256=$Value.readySha256
        stdoutReadinessSha256=$Value.stdoutReadinessSha256;stopSha256=$Value.stopRequestSha256
        resultSha256=$Value.resultSha256;outerLauncherSha256=$Value.outerLauncherSha256
        qualifying=$false;releaseGatesCleared=@()}
}

function Assert-MyspeedProofBoundCase {
    param([object]$Value)
    Assert-MyspeedCleanExactKeys $Value @('manifestDocument','case') 'Bound proof case'
    $manifestLoaded=Read-MyspeedProofJsonDocument $Value.manifestDocument 'Proof manifest'
    [void](Assert-MyspeedProofManifest $manifestLoaded.value)
    if($Value.case.manifestSha256 -cne $manifestLoaded.sha256){throw 'Bound proof case manifest binding differs'}
    return Assert-MyspeedProofCase $Value.case $manifestLoaded.value
}

function Get-MyspeedProofContract {
    [pscustomobject][ordered]@{schemaVersion=1;kind='myspeed-windows-clean-stop-native-proof';qualifying=$false
        caseIds=@($script:CaseIds);observerSha256=Get-MyspeedProofObserverSha256
        abiExpected=Get-MyspeedCleanExpectedAbiMeasurements;releaseGatesCleared=@()}
}

function Assert-MyspeedProofMatrix {
    param([object]$Value)
    Assert-MyspeedCleanExactKeys $Value @('manifestDocument','cases','summaryDocument') 'Proof matrix'
    $manifestLoaded=Read-MyspeedProofJsonDocument $Value.manifestDocument 'Proof manifest'
    [void](Assert-MyspeedProofManifest $manifestLoaded.value)
    $manifestSha=$manifestLoaded.sha256
    $cases=Assert-MyspeedCleanArray $Value.cases 'Proof matrix cases'
    if($cases.Count -ne $script:CaseIds.Count){throw 'Proof matrix case count differs'}
    $classifications=[Collections.Generic.List[string]]::new()
    $assessments=[Collections.Generic.List[object]]::new()
    $fixtureSha=(Get-MyspeedProofFileByRole ([object[]]$manifestLoaded.value.files) 'fixture-binary').sha256
    for($index=0;$index -lt $cases.Count;$index++){
        if($cases[$index].manifestSha256 -cne $manifestSha){throw 'Proof matrix manifest binding differs'}
        $assessment=Assert-MyspeedProofCase $cases[$index] $manifestLoaded.value
        if($assessment.caseId -cne $script:CaseIds[$index]){throw 'Proof matrix case order differs'}
        $nonceBytes=[Text.UTF8Encoding]::new($false).GetBytes($manifestLoaded.value.nonce+':'+$assessment.caseId)
        $expectedCaseNonce=(Get-MyspeedProofSha256 $nonceBytes).Substring(0,32)
        if($assessment.runId -cne $manifestLoaded.value.runId -or $assessment.runAttempt -cne $manifestLoaded.value.runAttempt -or
            $assessment.eventSha -cne $manifestLoaded.value.eventSha -or $assessment.sourceSha -cne $manifestLoaded.value.sourceSha -or
            $assessment.imageVersion -cne $manifestLoaded.value.imageVersion -or $assessment.nonce -cne $expectedCaseNonce -or
            $assessment.candidateSha256 -cne $fixtureSha){throw 'Proof matrix manifest and case identity differ'}
        [void]$classifications.Add($assessment.classification)
        [void]$assessments.Add($assessment)
    }
    $summaryLoaded=Read-MyspeedProofJsonDocument $Value.summaryDocument 'Proof summary'
    $summary=$summaryLoaded.value
    Assert-MyspeedCleanExactKeys $summary @('schemaVersion','kind','status','qualifying','releaseGatesCleared',
        'manifestSha256','caseIds','classifications','cases','allCasesObserved') 'Proof summary'
    [void](Assert-MyspeedCleanInteger $summary.schemaVersion 'Proof summary schema' 1 1)
    if((Assert-MyspeedCleanString $summary.kind 'Proof summary kind') -cne $script:SummaryKind -or
        (Assert-MyspeedCleanString $summary.status 'Proof summary status') -cne 'completed' -or
        (Assert-MyspeedCleanBoolean $summary.qualifying 'Proof summary qualifying') -or
        -not (Assert-MyspeedCleanBoolean $summary.allCasesObserved 'Proof summary completion') -or
        $summary.manifestSha256 -cne $manifestSha){throw 'Proof summary header differs'}
    $gates=Assert-MyspeedCleanArray $summary.releaseGatesCleared 'Proof summary gates'
    if($gates.Count -ne 0){throw 'Proof summary clears a release gate'}
    $summaryIds=Assert-MyspeedCleanArray $summary.caseIds 'Proof summary case IDs'
    $summaryClassifications=Assert-MyspeedCleanArray $summary.classifications 'Proof summary classifications'
    $summaryCases=Assert-MyspeedCleanArray $summary.cases 'Proof summary cases'
    if($summaryIds.Count -ne $script:CaseIds.Count -or $summaryClassifications.Count -ne $script:CaseIds.Count -or
        $summaryCases.Count -ne $script:CaseIds.Count){throw 'Proof summary case count differs'}
    for($index=0;$index -lt $script:CaseIds.Count;$index++){
        if($summaryIds[$index] -isnot [string] -or $summaryIds[$index] -cne $script:CaseIds[$index] -or
            $summaryClassifications[$index] -isnot [string] -or $summaryClassifications[$index] -cne $classifications[$index]){
            throw 'Proof summary case order differs'
        }
        $record=$summaryCases[$index]
        Assert-MyspeedCleanExactKeys $record @('caseId','launchSha256','abiSha256','readySha256','stdoutReadinessSha256',
            'stopSha256','resultSha256','outerLauncherSha256') 'Proof summary case'
        if($record.caseId -cne $script:CaseIds[$index]){throw 'Proof summary case identity differs'}
        foreach($name in @('launchSha256','abiSha256','readySha256','stdoutReadinessSha256','resultSha256','outerLauncherSha256')){
            [void](Assert-MyspeedCleanString $record.$name "Proof summary $name" '^[0-9a-f]{64}$')
        }
        if($script:CaseIds[$index] -ceq 'missing-stop'){
            if($null -ne $record.stopSha256){throw 'Proof summary stop SHA differs'}
        }else{[void](Assert-MyspeedCleanString $record.stopSha256 'Proof summary stop SHA' '^[0-9a-f]{64}$')}
        $expectedCase=$assessments[$index]
        foreach($binding in @{launchSha256='launchSha256';abiSha256='abiSha256';readySha256='readySha256';
            stdoutReadinessSha256='stdoutReadinessSha256';stopSha256='stopSha256';resultSha256='resultSha256';
            outerLauncherSha256='outerLauncherSha256'}.GetEnumerator()){
            if($record.($binding.Key) -cne $expectedCase.($binding.Value)){throw 'Proof summary case hash binding differs'}
        }
    }
    return [pscustomobject][ordered]@{schemaVersion=1;kind='myspeed-windows-clean-stop-native-proof-assessment'
        caseIds=@($script:CaseIds);classifications=@($classifications);allCasesObserved=$true
        qualifying=$false;releaseGatesCleared=@()}
}

function Invoke-MyspeedProofInjectedObserver {
    param([object]$Value,[bool]$Detached=$false)
    $inputKeys=@('case','contexts','abiPresentAtTick','resultPresentAtTick')
    $hasPartial=$Value.PSObject.Properties.Name -ccontains 'partialStdoutUntilTick'
    if($hasPartial){$inputKeys+=@('partialStdoutUntilTick')}
    $hasEmpty=$Value.PSObject.Properties.Name -ccontains 'emptyStdoutUntilTick'
    if($hasEmpty){$inputKeys+=@('emptyStdoutUntilTick')}
    $hasUnstableAbi=$Value.PSObject.Properties.Name -ccontains 'unstableAbiUntilTick'
    if($hasUnstableAbi){$inputKeys+=@('unstableAbiUntilTick')}
    $hasUnstableReady=$Value.PSObject.Properties.Name -ccontains 'unstableReadyUntilTick'
    if($hasUnstableReady){$inputKeys+=@('unstableReadyUntilTick')}
    Assert-MyspeedCleanExactKeys $Value $inputKeys 'Injected observer'
    $case=$Value.case
    Assert-MyspeedCleanExactKeys $case @('manifestSha256','launchDocument','abiDocument','readyDocument',
        'stdoutReadinessDocument','stdoutBase64','stdoutSha256','stopDocument','resultDocument','outerLauncherDocument') 'Injected observer case'
    $launch=Read-MyspeedProofJsonDocument $case.launchDocument 'Launch request'
    $abi=Read-MyspeedProofJsonDocument $case.abiDocument 'ABI observation'
    $ready=Read-MyspeedProofJsonDocument $case.readyDocument 'Ready evidence'
    try{$stdout=[Convert]::FromBase64String($case.stdoutBase64)}catch{throw 'Injected observer stdout is invalid'}
    $events=[Collections.Generic.List[string]]::new();$responses=[Collections.Generic.List[object]]::new();$writes=@{}
    $observerHarnessState=@{currentTick=-1}
    $resultPresentAtTick=if($null -eq $Value.resultPresentAtTick){$null}else{
        Assert-MyspeedCleanInteger $Value.resultPresentAtTick 'Injected result-present tick' 0 1000000}
    $abiPresentAtTick=if($null -eq $Value.abiPresentAtTick){$null}else{
        Assert-MyspeedCleanInteger $Value.abiPresentAtTick 'Injected ABI-present tick' 0 1000000}
    $partialStdoutUntilTick=if(-not $hasPartial){$null}else{
        Assert-MyspeedCleanInteger $Value.partialStdoutUntilTick 'Injected partial-stdout tick' 0 1000000}
    $emptyStdoutUntilTick=if(-not $hasEmpty){$null}else{
        Assert-MyspeedCleanInteger $Value.emptyStdoutUntilTick 'Injected empty-stdout tick' 0 1000000}
    $unstableAbiUntilTick=if(-not $hasUnstableAbi){$null}else{
        Assert-MyspeedCleanInteger $Value.unstableAbiUntilTick 'Injected unstable-ABI tick' 0 1000000}
    $unstableReadyUntilTick=if(-not $hasUnstableReady){$null}else{
        Assert-MyspeedCleanInteger $Value.unstableReadyUntilTick 'Injected unstable-ready tick' 0 1000000}
    $operations=[pscustomobject]@{
        Exists={param($path)
            if($path -ceq $launch.value.abiPath){return $null -ne $abiPresentAtTick -and $observerHarnessState.currentTick -ge $abiPresentAtTick}
            if($path -ceq $launch.value.readyPath){return $true}
            if($path -ceq $launch.value.resultPath){
                return $null -ne $resultPresentAtTick -and $observerHarnessState.currentTick -ge $resultPresentAtTick
            }
            return $false
        }.GetNewClosure()
        CanReadStable={param($path)
            if($path -ceq $launch.value.abiPath -and $null -ne $unstableAbiUntilTick){
                return $observerHarnessState.currentTick -gt $unstableAbiUntilTick
            }
            if($path -ceq $launch.value.readyPath -and $null -ne $unstableReadyUntilTick){
                return $observerHarnessState.currentTick -gt $unstableReadyUntilTick
            }
            return $true
        }.GetNewClosure()
        ReadDocument={param($path,$label)
            if($path -ceq $launch.value.abiPath){[void]$events.Add('read-abi');return $abi}
            [void]$events.Add('read-ready');return $ready
        }.GetNewClosure()
        ReadBytes={param($path)
            [void]$events.Add('read-stdout')
            if($null -ne $emptyStdoutUntilTick -and $observerHarnessState.currentTick -le $emptyStdoutUntilTick){
                return ,([byte[]]@())
            }
            if($null -ne $partialStdoutUntilTick -and $observerHarnessState.currentTick -le $partialStdoutUntilTick){
                $partialLength=[int][Math]::Floor($stdout.Length/2)
                return [byte[]]$stdout[0..($partialLength-1)]
            }
            return [byte[]]$stdout
        }.GetNewClosure()
        WriteDocument={param($path,$document,$label)
            $event=if($label -ceq 'Stdout readiness'){'write-readiness'}else{'write-stop'};[void]$events.Add($event)
            $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($document|ConvertTo-Json -Depth 20 -Compress))
            $hash=Get-MyspeedProofSha256 $bytes;$writes[$label]=[pscustomobject]@{value=$document;sha256=$hash};return $hash
        }.GetNewClosure()
    }
    if($Detached){
        $factoryModule=New-Module -ScriptBlock {
            param([string]$Path)
            . $Path -Mode Library
            Export-ModuleMember -Function New-MyspeedCleanStopProofObserver
        } -ArgumentList $PSCommandPath
        $observer=& $factoryModule {param($launchValue,$launchSha,$ops)
            New-MyspeedCleanStopProofObserver $launchValue $launchSha $ops
        } $launch.value $launch.sha256 $operations
    }else{$observer=New-MyspeedCleanStopProofObserver $launch.value $launch.sha256 $operations}
    $contexts=Assert-MyspeedCleanArray $Value.contexts 'Injected observer contexts'
    foreach($context in $contexts){$observerHarnessState.currentTick=$context.tick;[void]$responses.Add((& $observer $context))}
    return [pscustomobject][ordered]@{events=@($events);responses=@($responses);readiness=$writes['Stdout readiness'].value
        stop=if($writes.ContainsKey('Stop request')){$writes['Stop request'].value}else{$null}}
}

function Invoke-MyspeedProofInjectedLauncherBridge {
    $launcherPath=Join-Path $PSScriptRoot 'media-job-launcher.ps1'
    $launcherModule=New-MyspeedProofModule $launcherPath 'MyspeedCleanStopLauncherBridge'
    try{
        $executable=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
        $stream=[IO.File]::Open($executable,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        try{$algorithm=[Security.Cryptography.SHA256]::Create();try{$executableSha=[BitConverter]::ToString(
                    $algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}finally{$algorithm.Dispose()}}finally{$stream.Dispose()}
        $workingDirectory=[IO.Path]::GetDirectoryName($executable)
        $launch=[pscustomobject]@{abiPath='C:\owned\abi.json';readyPath='C:\owned\ready.json';resultPath='C:\owned\result.json'
            stdoutPath='C:\owned\stdout.log';stdoutReadinessPath='C:\owned\readiness.json';stopRequestPath='C:\owned\stop.json';caseId='handler'}
        $operations=[pscustomobject]@{
            Exists={param($path)return $false}
            CanReadStable={param($path)return $true}
            ReadDocument={param($path,$label)throw 'Injected bridge read is forbidden'}
            ReadBytes={param($path)return ,([byte[]]@())}
            WriteDocument={param($path,$value,$label)throw 'Injected bridge write is forbidden'}}
        $observer=New-MyspeedCleanStopProofObserver $launch ('1'*64) $operations
        $clockState=[pscustomobject]@{index=0};$clockValues=@(
            @{w=[double]1000;m=[double]10},@{w=[double]1001;m=[double]11},@{w=[double]1002;m=[double]12},
            @{w=[double]1003;m=[double]13},@{w=[double]1004;m=[double]14},@{w=[double]1005;m=[double]15})
        $clock={
            $selected=$clockValues[[Math]::Min($clockState.index,$clockValues.Count-1)];$clockState.index++
            return @{WallUnixMilliseconds=[double]$selected.w;MonotonicMilliseconds=[double]$selected.m}
        }.GetNewClosure()
        $nativeState=[pscustomobject]@{exited=$false}
        $native=@{
            CreateJob={return 'job'};ConfigureKillOnClose={param($job)}
            CreateSuspended={param($file,$command,$cwd)return @{ProcessHandle='process';ThreadHandle='thread';ProcessId=42}}
            Assign={param($job,$process)};Resume={param($thread)}
            Wait={param($process,$milliseconds)$nativeState.exited=$true;return 'Exited'}.GetNewClosure()
            ExitCode={param($process)return 0};Terminate={param($process)}
            ActiveProcesses={param($job)return 0};TerminateJob={param($job)};Sleep={param($milliseconds)};Close={param($handle)}}
        $call=[pscustomobject]@{executable=$executable;sha256=$executableSha;arguments=[string[]]@('-NoLogo')
            workingDirectory=$workingDirectory;observer=$observer;observerSha=(Get-MyspeedProofObserverSha256)
            native=$native;clock=$clock}
        return & $launcherModule {param($value)
            Invoke-ObservedOwnedJobProcess -Executable $value.executable -ExpectedExecutableSha256 $value.sha256 `
                -ArgumentList $value.arguments -WorkingDirectory $value.workingDirectory -WallDeadlineUnixMilliseconds 5000 `
                -MaximumDurationMilliseconds 1000 -Observer $value.observer -ExpectedObserverSha256 $value.observerSha `
                -NativeMethods $value.native -Clock $value.clock
        } $call
    }finally{Remove-Module $launcherModule -Force}
}

function Read-MyspeedProofBoundedFile {
    param([string]$Path,[int64]$MaximumBytes,[switch]$AllowEmpty)
    $stream=$null;$algorithm=$null
    try{
        $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        if(((-not $AllowEmpty) -and $stream.Length -le 0) -or $stream.Length -gt $MaximumBytes){throw 'Bounded file length differs'}
        $bytes=New-Object byte[] ([int]$stream.Length);$offset=0
        while($offset -lt $bytes.Length){$count=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($count -le 0){throw 'Bounded file read ended early'};$offset+=$count}
        if($stream.ReadByte() -ne -1){throw 'Bounded file grew during read'}
        $algorithm=[Security.Cryptography.SHA256]::Create()
        return [pscustomobject]@{bytes=[byte[]]$bytes;sha256=([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}
    }finally{if($null -ne $algorithm){$algorithm.Dispose()};if($null -ne $stream){$stream.Dispose()}}
}

function Read-MyspeedProofActiveLogBytes {
    param([string]$Path,[int64]$MaximumBytes)
    $stream=$null
    try{
        $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
        if($stream.Length -lt 0 -or $stream.Length -gt $MaximumBytes){throw 'Active log length exceeds its bound'}
        $bytes=New-Object byte[] ([int]$stream.Length);$offset=0
        while($offset -lt $bytes.Length){$count=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($count -le 0){throw 'Active log read ended early'};$offset+=$count}
        return ,([byte[]]$bytes)
    }finally{if($null -ne $stream){$stream.Dispose()}}
}

function Test-MyspeedProofStableReadable {
    param([string]$Path)
    $win32CodeMask=65535
    $sharingViolationWin32Code=32
    $stream=$null
    try{
        $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        return $true
    }catch [IO.IOException]{
        if(($_.Exception.HResult -band $win32CodeMask) -eq $sharingViolationWin32Code){return $false}
        throw
    }
    finally{if($null -ne $stream){$stream.Dispose()}}
}

function New-MyspeedProofStableReadableOperation {
    $testStableReadable=${function:Test-MyspeedProofStableReadable}
    return {param($candidatePath)& $testStableReadable $candidatePath}.GetNewClosure()
}

function Invoke-MyspeedProofActiveLogReaderFixture {
    param([object]$Value)
    Assert-MyspeedCleanExactKeys $Value @('path') 'Active-log fixture'
    $path=Assert-MyspeedCleanPath $Value.path 'Active-log fixture path'
    $tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if(-not $path.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Active-log fixture path is outside the temporary root'}
    $item=Get-Item -LiteralPath $path -Force
    if($item.PSIsContainer -or $item.Length -ne 0 -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){
        throw 'Active-log fixture file differs'
    }
    $marker=[Text.UTF8Encoding]::new($false).GetBytes($script:FixtureReadyMarker+"`r`n")
    $stableModule=New-Module -ScriptBlock {
        param([string]$SourcePath)
        . $SourcePath -Mode Library
        Export-ModuleMember -Function New-MyspeedProofStableReadableOperation
    } -ArgumentList $PSCommandPath
    try{$stableOperation=& $stableModule {New-MyspeedProofStableReadableOperation}}
    finally{Remove-Module $stableModule -Force}
    $exclusive=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stableWhileExclusive=& $stableOperation $path}finally{$exclusive.Dispose()}
    $stableAfterExclusive=& $stableOperation $path
    $writer=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{
        $empty=Read-MyspeedProofActiveLogBytes $path 2097152
        $writer.Write($marker,0,$marker.Length);$writer.Flush()
        $read=Read-MyspeedProofActiveLogBytes $path 2097152
        return [pscustomobject]@{detachedFactory=$true;stableWhileExclusive=$stableWhileExclusive;stableAfterExclusive=$stableAfterExclusive
            emptyBytesBase64=[Convert]::ToBase64String($empty);bytesBase64=[Convert]::ToBase64String($read)}
    }finally{$writer.Dispose()}
}

function Assert-MyspeedProofExactDirectoryFiles {
    param([string]$Root,[string[]]$Leaves,[string]$Label)
    if([IO.Directory]::GetDirectories($Root).Count -ne 0){throw "$Label contains a directory"}
    $actual=[string[]]@([IO.Directory]::GetFiles($Root)|ForEach-Object {[IO.Path]::GetFileName($_)}|Sort-Object -CaseSensitive)
    $expected=[string[]]@($Leaves|Sort-Object -CaseSensitive)
    if(($actual -join "`n") -cne ($expected -join "`n")){throw "$Label file set differs"}
}

function Write-MyspeedProofCreateNewBytes {
    param([string]$Path,[byte[]]$Bytes,[int64]$MaximumBytes,[switch]$AllowEmpty)
    if(((-not $AllowEmpty) -and $Bytes.Length -le 0) -or $Bytes.Length -gt $MaximumBytes){throw 'Create-new bytes exceed their bound'}
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}

function Write-MyspeedProofCreateNewJson {
    param([string]$Path,[object]$Value,[int64]$MaximumBytes=262144)
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 40 -Compress))
    Write-MyspeedProofCreateNewBytes $Path $bytes $MaximumBytes
    return Get-MyspeedProofSha256 $bytes
}

function Get-MyspeedProofNativeIdentity {
    param([string]$Name,[string]$Path,[string]$AllowedRoot,[int64]$MaximumBytes,[string]$Role)
    $request=[pscustomobject][ordered]@{name=$Name;path=$Path;allowedRoot=$AllowedRoot;maximumBytes=$MaximumBytes;role=$Role}
    return Invoke-MyspeedProofModuleCommand $script:ProofNative.identity 'Get-MyspeedVerifiedFileIdentity' @($request,$script:ProofNative.identityOperations)
}

function Read-MyspeedProofNativeBytes {
    param([string]$Name,[string]$Path,[string]$AllowedRoot,[int64]$MaximumBytes,[string]$Role)
    $request=[pscustomobject][ordered]@{name=$Name;path=$Path;allowedRoot=$AllowedRoot;maximumBytes=$MaximumBytes;role=$Role}
    $read=Invoke-MyspeedProofModuleCommand $script:ProofNative.identity 'Read-MyspeedVerifiedFileBytes' @($request,$script:ProofNative.identityOperations)
    $bytes=[Convert]::FromBase64String($read.bytesBase64)
    if($bytes.Length -le 0 -or $bytes.Length -gt $MaximumBytes -or [Convert]::ToBase64String($bytes) -cne $read.bytesBase64){
        throw 'Verified bytes differ'
    }
    return [pscustomobject]@{identity=$read.identity;bytes=[byte[]]$bytes}
}

function ConvertTo-MyspeedProofManifestFile {
    param([string]$Role,[object]$Identity)
    return [pscustomobject][ordered]@{role=$Role;path=$Identity.path;bytes=$Identity.bytes;sha256=$Identity.sha256
        volumeSerial=$Identity.volumeSerial;fileId=$Identity.fileId;linkCount=$Identity.linkCount;fileVersion=$Identity.fileVersion}
}

function Assert-MyspeedProofIdentityUnchanged {
    param([object]$Expected,[object]$Actual,[string]$Label)
    $names=@('schemaVersion','name','role','path','finalPath','volumeSerial','fileId','bytes','lastWriteFileTime',
        'linkCount','sha256','fileVersion','productVersion')
    Assert-MyspeedCleanExactKeys $Expected $names "$Label expected identity"
    Assert-MyspeedCleanExactKeys $Actual $names "$Label actual identity"
    foreach($name in $names){if($Expected.$name -ne $Actual.$name){throw "$Label identity changed"}}
}

function Assert-MyspeedProofCompilerOperation {
    param([object]$Request,[object]$RequestSha,[object]$Launcher,[object]$Result)
    Assert-MyspeedCleanExactKeys $Request @('schemaVersion','expectedRunId','expectedRunAttempt','expectedEventSha',
        'expectedSourceSha','nonce','operationId','toolPath','toolSha256','arguments','workingDirectory','streamLimitBytes',
        'maximumDurationMilliseconds','isProbe','resultPath') 'Compiler request'
    [void](Assert-MyspeedCleanInteger $Request.schemaVersion 'Compiler request schema' 1 1)
    [void](Assert-MyspeedCleanString $RequestSha 'Compiler request SHA' '^[0-9a-f]{64}$')
    [void](Assert-MyspeedCleanString $Request.expectedRunId 'Compiler request run ID' '^[1-9][0-9]{0,19}$')
    [void](Assert-MyspeedCleanString $Request.expectedRunAttempt 'Compiler request run attempt' '^[1-9][0-9]{0,9}$')
    [void](Assert-MyspeedCleanString $Request.expectedEventSha 'Compiler request event SHA' '^[0-9a-f]{40}$')
    [void](Assert-MyspeedCleanString $Request.expectedSourceSha 'Compiler request source SHA' '^[0-9a-f]{40}$')
    [void](Assert-MyspeedCleanString $Request.nonce 'Compiler request nonce' '^[0-9a-f]{32}$')
    if((Assert-MyspeedCleanString $Request.operationId 'Compiler request operation ID') -cne 'compile-clean-stop-fixture'){
        throw 'Compiler request operation ID differs'
    }
    [void](Assert-MyspeedCleanPath $Request.toolPath 'Compiler request tool path')
    [void](Assert-MyspeedCleanString $Request.toolSha256 'Compiler request tool SHA' '^[0-9a-f]{64}$')
    [void](Assert-MyspeedCleanPath $Request.workingDirectory 'Compiler request working directory')
    [void](Assert-MyspeedCleanPath $Request.resultPath 'Compiler request result path')
    [void](Assert-MyspeedCleanInteger $Request.streamLimitBytes 'Compiler request stream limit' 65536 65536)
    [void](Assert-MyspeedCleanInteger $Request.maximumDurationMilliseconds 'Compiler request duration' 30000 30000)
    if(Assert-MyspeedCleanBoolean $Request.isProbe 'Compiler request probe'){throw 'Compiler request must not be a probe'}
    $requestArguments=Assert-MyspeedCleanArray $Request.arguments 'Compiler request arguments'
    foreach($argument in $requestArguments){[void](Assert-MyspeedCleanString $argument 'Compiler request argument')}
    Assert-MyspeedCleanExactKeys $Launcher @('schemaVersion','authorizesTransfer','processId','exitCode','timedOut','processTreeExitProven') 'Compiler outer launcher'
    if((Assert-MyspeedCleanInteger $Launcher.schemaVersion 'Compiler launcher schema' 1 1) -ne 1 -or
        (Assert-MyspeedCleanBoolean $Launcher.authorizesTransfer 'Compiler launcher transfer') -or
        (Assert-MyspeedCleanInteger $Launcher.processId 'Compiler launcher PID' 1 4294967295) -lt 1 -or
        (Assert-MyspeedCleanInteger $Launcher.exitCode 'Compiler launcher exit' 0 0) -ne 0 -or
        (Assert-MyspeedCleanBoolean $Launcher.timedOut 'Compiler launcher timeout') -or
        -not (Assert-MyspeedCleanBoolean $Launcher.processTreeExitProven 'Compiler launcher tree exit')){throw 'Compiler launcher proof differs'}
    Assert-MyspeedCleanExactKeys $Result @('schemaVersion','status','classification','bindings','parentJobMembershipProven',
        'childExitProven','handlesClosedProven','errorMode','wrapper','stdoutBase64','stderrBase64','failures') 'Compiler result'
    if((Assert-MyspeedCleanInteger $Result.schemaVersion 'Compiler result schema' 1 1) -ne 1 -or
        (Assert-MyspeedCleanString $Result.status 'Compiler status') -cne 'completed' -or
        (Assert-MyspeedCleanString $Result.classification 'Compiler classification') -cne 'windows-native-host-observation-nonqualifying' -or
        -not (Assert-MyspeedCleanBoolean $Result.parentJobMembershipProven 'Compiler parent Job') -or
        -not (Assert-MyspeedCleanBoolean $Result.childExitProven 'Compiler child exit') -or
        -not (Assert-MyspeedCleanBoolean $Result.handlesClosedProven 'Compiler handles')){throw 'Compiler operation proof differs'}
    Assert-MyspeedCleanExactKeys $Result.bindings @('requestPath','requestSha256','expectedRunId','expectedRunAttempt',
        'expectedEventSha','expectedSourceSha','nonce','operationId','toolPath','toolSha256','toolSha256Before',
        'toolSha256After','arguments','workingDirectory','streamLimitBytes','maximumDurationMilliseconds','isProbe','resultPath') 'Compiler bindings'
    foreach($name in @('expectedRunId','expectedRunAttempt','expectedEventSha','expectedSourceSha','nonce',
        'operationId','toolPath','toolSha256','workingDirectory','resultPath')){
        if((Assert-MyspeedCleanString $Result.bindings.$name "Compiler bound $name") -cne $Request.$name){throw 'Compiler request binding differs'}
    }
    $expectedRequestPath=[IO.Path]::Combine($Request.workingDirectory,"$($Request.operationId).request.json")
    if((Assert-MyspeedCleanPath $Result.bindings.requestPath 'Compiler bound request path') -cne $expectedRequestPath -or
        (Assert-MyspeedCleanString $Result.bindings.requestSha256 'Compiler bound request SHA' '^[0-9a-f]{64}$') -cne $RequestSha -or
        (Assert-MyspeedCleanString $Result.bindings.toolSha256Before 'Compiler before tool SHA' '^[0-9a-f]{64}$') -cne $Request.toolSha256 -or
        (Assert-MyspeedCleanString $Result.bindings.toolSha256After 'Compiler after tool SHA' '^[0-9a-f]{64}$') -cne $Request.toolSha256 -or
        (Assert-MyspeedCleanInteger $Result.bindings.streamLimitBytes 'Compiler bound stream limit' 65536 65536) -ne 65536 -or
        (Assert-MyspeedCleanInteger $Result.bindings.maximumDurationMilliseconds 'Compiler bound duration' 30000 30000) -ne 30000 -or
        (Assert-MyspeedCleanBoolean $Result.bindings.isProbe 'Compiler bound probe')){
        throw 'Compiler request proof differs'
    }
    $boundArguments=Assert-MyspeedCleanArray $Result.bindings.arguments 'Compiler bound arguments'
    if($boundArguments.Count -ne $Request.arguments.Count){throw 'Compiler arguments differ'}
    for($index=0;$index -lt $boundArguments.Count;$index++){
        if((Assert-MyspeedCleanString $boundArguments[$index] 'Compiler bound argument') -cne $Request.arguments[$index]){throw 'Compiler arguments differ'}
    }
    Assert-MyspeedCleanExactKeys $Result.errorMode @('required','requiredFlags','before','during','after','restored') 'Compiler error mode'
    if((Assert-MyspeedCleanBoolean $Result.errorMode.required 'Compiler error-mode requirement') -or
        (Assert-MyspeedCleanInteger $Result.errorMode.requiredFlags 'Compiler error-mode flags' 0 0) -ne 0 -or
        $null -ne $Result.errorMode.before -or $null -ne $Result.errorMode.during -or
        $null -ne $Result.errorMode.after -or -not (Assert-MyspeedCleanBoolean $Result.errorMode.restored 'Compiler error-mode restore')){
        throw 'Compiler error-mode proof differs'
    }
    Assert-MyspeedCleanExactKeys $Result.wrapper @('schemaVersion','status','childProcessId','exitCode','timedOut',
        'durationMilliseconds','stdoutBytes','stderrBytes','outputDrainProven','childJobMembershipProven','errorModeRestored') 'Compiler wrapper'
    if((Assert-MyspeedCleanInteger $Result.wrapper.schemaVersion 'Compiler wrapper schema' 1 1) -ne 1 -or
        (Assert-MyspeedCleanString $Result.wrapper.status 'Compiler wrapper status') -cne 'completed' -or
        (Assert-MyspeedCleanInteger $Result.wrapper.childProcessId 'Compiler wrapper PID' 1 4294967295) -lt 1 -or
        (Assert-MyspeedCleanInteger $Result.wrapper.exitCode 'Compiler wrapper exit' 0 0) -ne 0 -or
        (Assert-MyspeedCleanBoolean $Result.wrapper.timedOut 'Compiler wrapper timeout') -or
        (Assert-MyspeedCleanInteger $Result.wrapper.durationMilliseconds 'Compiler wrapper duration' 0 30000) -gt 30000 -or
        -not (Assert-MyspeedCleanBoolean $Result.wrapper.outputDrainProven 'Compiler wrapper drain') -or
        -not (Assert-MyspeedCleanBoolean $Result.wrapper.childJobMembershipProven 'Compiler wrapper Job') -or
        -not (Assert-MyspeedCleanBoolean $Result.wrapper.errorModeRestored 'Compiler wrapper error mode')){
        throw 'Compiler wrapper proof differs'
    }
    $failures=Assert-MyspeedCleanArray $Result.failures 'Compiler failures';if($failures.Count -ne 0){throw 'Compiler failures are not empty'}
    $streamLengths=[ordered]@{}
    foreach($name in @('stdoutBase64','stderrBase64')){
        if($Result.$name -isnot [string]){throw 'Compiler stream encoding differs'}
        $bytes=[Convert]::FromBase64String($Result.$name);if($bytes.Length -gt 65536 -or [Convert]::ToBase64String($bytes) -cne $Result.$name){throw 'Compiler stream differs'}
        $streamLengths[$name]=$bytes.Length
    }
    if((Assert-MyspeedCleanInteger $Result.wrapper.stdoutBytes 'Compiler wrapper stdout bytes' 0 65536) -ne $streamLengths.stdoutBase64 -or
        (Assert-MyspeedCleanInteger $Result.wrapper.stderrBytes 'Compiler wrapper stderr bytes' 0 65536) -ne $streamLengths.stderrBase64){
        throw 'Compiler wrapper stream byte count differs'
    }
    return $true
}

function Invoke-MyspeedHostedCleanStopProof {
    $runnerTemp=[IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
    $expectedClosure=[IO.Path]::Combine($runnerTemp,'windows-clean-stop-native-proof-closure')
    $expectedEvidenceRoot=[IO.Path]::Combine($runnerTemp,"myspeed-clean-stop-native-proof-$Nonce")
    if(-not [string]::Equals([IO.Path]::GetFullPath($ClosureRoot).TrimEnd('\'),$expectedClosure,[StringComparison]::Ordinal) -or
        -not [string]::Equals([IO.Path]::GetFullPath($EvidencePath),[IO.Path]::Combine($expectedEvidenceRoot,'result.json'),[StringComparison]::Ordinal)){
        throw 'Hosted proof owned path differs'
    }
    $closureManifestPath=[IO.Path]::Combine($expectedClosure,'closure.json')
    $closureRead=Read-MyspeedProofBoundedFile $closureManifestPath 65536
    if($closureRead.sha256 -cne $ExpectedClosureSha256){throw 'Transport closure hash differs'}
    $encoding=[Text.UTF8Encoding]::new($false,$true)
    $transport=ConvertFrom-MyspeedProofJson ($encoding.GetString($closureRead.bytes)) 'Transport manifest'
    [void](Assert-MyspeedProofTransportManifest $transport)
    foreach($entry in ([ordered]@{runId=$ExpectedRunId;runAttempt=$ExpectedRunAttempt;eventSha=$ExpectedEventSha
        sourceSha=$ExpectedSourceSha;imageVersion=$ExpectedImageVersion;nonce=$Nonce}).GetEnumerator()){
        if($transport.($entry.Key) -cne $entry.Value){throw 'Transport execution identity differs'}
    }
    $actualLeaves=@([IO.Directory]::GetFiles($expectedClosure)|ForEach-Object {[IO.Path]::GetFileName($_)}|Sort-Object -CaseSensitive)
    $expectedLeaves=@($script:TransportNames+'closure.json'|Sort-Object -CaseSensitive)
    if(($actualLeaves -join "`n") -cne ($expectedLeaves -join "`n") -or
        [IO.Directory]::GetDirectories($expectedClosure).Count -ne 0){
        throw 'Transport closure members differ'
    }
    for($index=0;$index -lt $script:TransportNames.Count;$index++){
        $path=[IO.Path]::Combine($expectedClosure,$script:TransportNames[$index])
        $read=Read-MyspeedProofBoundedFile $path $script:MaximumManifestFileBytes
        if($read.bytes.Length -ne $transport.files[$index].bytes -or $read.sha256 -cne $transport.files[$index].sha256){
            throw 'Transport closure file differs'
        }
    }
    if([IO.Directory]::Exists($expectedEvidenceRoot)){throw 'Hosted proof evidence root already exists'}
    [void][IO.Directory]::CreateDirectory($expectedEvidenceRoot)
    $identityPath=[IO.Path]::Combine($expectedClosure,'windows-cpu-file-identity.ps1')
    $launcherPath=[IO.Path]::Combine($expectedClosure,'media-job-launcher.ps1')
    $script:ProofNative=[ordered]@{
        identity=New-MyspeedProofModule $identityPath 'MyspeedCleanStopFileIdentity'
    }
    $expected=[pscustomobject][ordered]@{expectedRunId=$ExpectedRunId;expectedRunAttempt=$ExpectedRunAttempt
        expectedEventSha=$ExpectedEventSha;expectedSourceSha=$ExpectedSourceSha;nonce=$Nonce}
    $script:ProofNative.identityOperations=Invoke-MyspeedProofModuleCommand $script:ProofNative.identity `
        'New-MyspeedNativeFileIdentityOperations' @($expected)
    $closureIdentities=[ordered]@{};$identitySet=[Collections.Generic.List[object]]::new()
    $verifiedClosure=Read-MyspeedProofNativeBytes 'transport-closure' $closureManifestPath $expectedClosure 65536 'closure'
    if($verifiedClosure.identity.sha256 -cne $closureRead.sha256 -or
        [Convert]::ToBase64String($verifiedClosure.bytes) -cne [Convert]::ToBase64String($closureRead.bytes)){
        throw 'Transport closure changed before physical identity capture'
    }
    [void]$identitySet.Add($verifiedClosure.identity)
    $roleMap=[ordered]@{workflow='windows-clean-stop-native-proof.yml';controller='windows-clean-stop-controller.ps1'
        coordinator='windows-clean-stop-native-proof.ps1';'outer-launcher'='media-job-launcher.ps1'
        'tool-child'='windows-cpu-tool-child.ps1';'file-identity'='windows-cpu-file-identity.ps1'
        'fixture-source'='windows-clean-stop-fixture.cs'}
    foreach($entry in $roleMap.GetEnumerator()){
        $identity=Get-MyspeedProofNativeIdentity $entry.Key ([IO.Path]::Combine($expectedClosure,$entry.Value)) `
            $expectedClosure $script:MaximumManifestFileBytes $(if($entry.Key -ceq 'fixture-source'){'source'}else{'closure'})
        $closureIdentities[$entry.Key]=$identity;[void]$identitySet.Add($identity)
    }
    $script:ProofNative.launcher=New-MyspeedProofModule $launcherPath 'MyspeedCleanStopOuterLauncher'
    $generatedSource=Invoke-MyspeedProofModuleCommand $script:ControllerModule 'Get-MyspeedCleanFixtureSource'
    $expectedSourceBytes=[Text.UTF8Encoding]::new($false).GetBytes($generatedSource)
    if((Get-MyspeedProofSha256 $expectedSourceBytes) -cne $closureIdentities['fixture-source'].sha256){throw 'Generated fixture source differs'}
    $systemRoot=[IO.Path]::GetFullPath($env:SystemRoot)
    $frameworkRoot=[IO.Path]::Combine($systemRoot,'Microsoft.NET\Framework64\v4.0.30319')
    $systemFiles=[ordered]@{ 'inbox-powershell'=[IO.Path]::Combine($systemRoot,'System32\WindowsPowerShell\v1.0\powershell.exe')
        compiler=[IO.Path]::Combine($frameworkRoot,'csc.exe');mscorlib=[IO.Path]::Combine($frameworkRoot,'mscorlib.dll')
        system=[IO.Path]::Combine($frameworkRoot,'System.dll');'system-core'=[IO.Path]::Combine($frameworkRoot,'System.Core.dll')}
    $systemIdentities=[ordered]@{}
    foreach($entry in $systemFiles.GetEnumerator()){
        $allowed=if($entry.Key -ceq 'inbox-powershell'){$systemRoot}else{$frameworkRoot}
        $identity=Get-MyspeedProofNativeIdentity $entry.Key $entry.Value $allowed $script:MaximumManifestFileBytes 'system-tool'
        $systemIdentities[$entry.Key]=$identity;[void]$identitySet.Add($identity)
    }
    $compileRoot=[IO.Path]::Combine($runnerTemp,"myspeed-cpu-readiness-$Nonce")
    if([IO.Directory]::Exists($compileRoot)){throw 'Compiler task root already exists'}
    [void][IO.Directory]::CreateDirectory($compileRoot)
    $fixturePath=[IO.Path]::Combine($compileRoot,'windows-clean-stop-fixture.exe')
    $compilerArguments=[string[]]@('/noconfig','/nostdlib','/target:exe','/platform:x64','/optimize+','/debug-','/utf8output',
        "/out:$fixturePath","/reference:$($systemFiles.mscorlib)","/reference:$($systemFiles.system)",
        "/reference:$($systemFiles['system-core'])",$closureIdentities['fixture-source'].path)
    $operationId='compile-clean-stop-fixture'
    $requestPath=[IO.Path]::Combine($compileRoot,"$operationId.request.json")
    $resultPath=[IO.Path]::Combine($compileRoot,"$operationId.result.json")
    $request=[pscustomobject][ordered]@{schemaVersion=1;expectedRunId=$ExpectedRunId;expectedRunAttempt=$ExpectedRunAttempt
        expectedEventSha=$ExpectedEventSha;expectedSourceSha=$ExpectedSourceSha;nonce=$Nonce;operationId=$operationId
        toolPath=$systemIdentities.compiler.path;toolSha256=$systemIdentities.compiler.sha256;arguments=$compilerArguments
        workingDirectory=$compileRoot;streamLimitBytes=65536;maximumDurationMilliseconds=30000;isProbe=$false;resultPath=$resultPath}
    $requestSha=Write-MyspeedProofCreateNewJson $requestPath $request 65536
    $requestIdentity=Get-MyspeedProofNativeIdentity 'compile-request' $requestPath $compileRoot 65536 'generated-command'
    $childPath=$closureIdentities['tool-child'].path
    Assert-MyspeedProofIdentityUnchanged $closureIdentities['fixture-source'] `
        (Get-MyspeedProofNativeIdentity 'fixture-source' $closureIdentities['fixture-source'].path $expectedClosure $script:MaximumManifestFileBytes 'source') 'Fixture source'
    Assert-MyspeedProofIdentityUnchanged $closureIdentities['tool-child'] `
        (Get-MyspeedProofNativeIdentity 'tool-child' $childPath $expectedClosure $script:MaximumManifestFileBytes 'closure') 'Tool child'
    foreach($entry in $systemFiles.GetEnumerator()){
        $allowed=if($entry.Key -ceq 'inbox-powershell'){$systemRoot}else{$frameworkRoot}
        Assert-MyspeedProofIdentityUnchanged $systemIdentities[$entry.Key] `
            (Get-MyspeedProofNativeIdentity $entry.Key $entry.Value $allowed $script:MaximumManifestFileBytes 'system-tool') "Compiler input $($entry.Key)"
    }
    $wrapperArguments=[string[]]@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$childPath,
        '-Mode','InvokeHostedToolChild','-RequestPath',$requestPath,'-ExpectedRequestSha256',$requestSha)
    $compileDuration=40000;$compileDeadline=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+$compileDuration
    $compileLauncher=Invoke-MyspeedProofModuleCommand $script:ProofNative.launcher 'Invoke-OwnedJobProcess' `
        @($systemIdentities['inbox-powershell'].path,$wrapperArguments,$compileRoot,$compileDeadline,$compileDuration)
    $resultRead=Read-MyspeedProofNativeBytes 'compile-result' $resultPath $compileRoot 262144 'generated-command'
    $compileResult=ConvertFrom-MyspeedProofJson ($encoding.GetString($resultRead.bytes)) 'Compiler result'
    [void](Assert-MyspeedProofCompilerOperation $request $requestSha $compileLauncher $compileResult)
    $compileLauncherPath=[IO.Path]::Combine($compileRoot,'compile-launcher.json')
    [void](Write-MyspeedProofCreateNewJson $compileLauncherPath $compileLauncher 262144)
    $compilerStdoutPath=[IO.Path]::Combine($compileRoot,'compiler.stdout')
    $compilerStderrPath=[IO.Path]::Combine($compileRoot,'compiler.stderr')
    Write-MyspeedProofCreateNewBytes $compilerStdoutPath ([Convert]::FromBase64String($compileResult.stdoutBase64)) 65536 -AllowEmpty
    Write-MyspeedProofCreateNewBytes $compilerStderrPath ([Convert]::FromBase64String($compileResult.stderrBase64)) 65536 -AllowEmpty
    $fixtureIdentity=Get-MyspeedProofNativeIdentity 'fixture-binary' $fixturePath $compileRoot $script:MaximumManifestFileBytes 'generated-command'
    [void]$identitySet.Add($requestIdentity);[void]$identitySet.Add($resultRead.identity);[void]$identitySet.Add($fixtureIdentity)
    [void]$identitySet.Add((Get-MyspeedProofNativeIdentity 'compile-launcher' $compileLauncherPath $compileRoot 262144 'generated-command'))
    if(([Convert]::FromBase64String($compileResult.stdoutBase64)).Length -gt 0){
        [void]$identitySet.Add((Get-MyspeedProofNativeIdentity 'compiler-stdout' $compilerStdoutPath $compileRoot 65536 'generated-command'))
    }
    if(([Convert]::FromBase64String($compileResult.stderrBase64)).Length -gt 0){
        [void]$identitySet.Add((Get-MyspeedProofNativeIdentity 'compiler-stderr' $compilerStderrPath $compileRoot 65536 'generated-command'))
    }
    Invoke-MyspeedProofModuleCommand $script:ProofNative.identity 'Assert-MyspeedNoFileIdentityCollisions' `
        @([pscustomobject]@{files=[object[]]$identitySet}) | Out-Null
    $manifestFiles=[Collections.Generic.List[object]]::new()
    foreach($role in $script:FileRoles){
        $identity=if($closureIdentities.Contains($role)){$closureIdentities[$role]}
            elseif($systemIdentities.Contains($role)){$systemIdentities[$role]}else{$fixtureIdentity}
        [void]$manifestFiles.Add((ConvertTo-MyspeedProofManifestFile $role $identity))
    }
    $manifest=[pscustomobject][ordered]@{schemaVersion=1;kind=$script:ManifestKind;qualifying=$false;repository=$script:Repository
        runId=$ExpectedRunId;runAttempt=$ExpectedRunAttempt;eventSha=$ExpectedEventSha;sourceSha=$ExpectedSourceSha
        imageOS=$script:ImageOS;imageVersion=$ExpectedImageVersion;architecture='X64';nonce=$Nonce;transportSha256=$closureRead.sha256
        observerSha256=Get-MyspeedProofObserverSha256;caseIds=[string[]]$script:CaseIds
        limits=[pscustomobject][ordered]@{controllerNormalDeadlineMs=300000;controllerHardDeadlineMs=310000
            stopRequestTimeoutMs=240000;stopRequestPollMs=50;gracefulExitTimeoutMs=30000;forcedCleanupTimeoutMs=10000}
        files=[object[]]$manifestFiles;compilerArguments=$compilerArguments}
    [void](Assert-MyspeedProofManifest $manifest)
    $manifestPath=[IO.Path]::Combine($expectedEvidenceRoot,'execution-manifest.json')
    $manifestSha=Write-MyspeedProofCreateNewJson $manifestPath $manifest 262144
    $manifestRead=Read-MyspeedProofNativeBytes 'execution-manifest' $manifestPath $expectedEvidenceRoot 262144 'generated-command'
    [void]$identitySet.Add($manifestRead.identity)
    $manifestDocument=[pscustomobject]@{bytesBase64=[Convert]::ToBase64String($manifestRead.bytes);sha256=$manifestSha}
    $cases=[Collections.Generic.List[object]]::new()
    foreach($caseId in $script:CaseIds){
        $caseNonce=(Get-MyspeedProofSha256 ([Text.UTF8Encoding]::new($false).GetBytes("$Nonce`:$caseId"))).Substring(0,32)
        $caseRoot=[IO.Path]::Combine($runnerTemp,"myspeed-clean-stop-$caseNonce")
        if([IO.Directory]::Exists($caseRoot)){throw 'Clean-stop case root already exists'}
        [void][IO.Directory]::CreateDirectory($caseRoot)
        $candidatePath=[IO.Path]::Combine($caseRoot,'fixture.exe')
        $fixtureRead=Read-MyspeedProofBoundedFile $fixturePath $script:MaximumManifestFileBytes
        Write-MyspeedProofCreateNewBytes $candidatePath $fixtureRead.bytes $script:MaximumManifestFileBytes
        $candidateIdentity=Get-MyspeedProofNativeIdentity "$caseId-fixture" $candidatePath $caseRoot $script:MaximumManifestFileBytes 'generated-command'
        [void]$identitySet.Add($candidateIdentity)
        $fixtureMode=if($caseId -ceq 'missing-stop'){'handler'}else{$caseId}
        $launch=[pscustomobject][ordered]@{schemaVersion=1;kind='myspeed-windows-clean-stop-launch';expectedRunId=$ExpectedRunId
            expectedRunAttempt=$ExpectedRunAttempt;expectedEventSha=$ExpectedEventSha;expectedSourceSha=$ExpectedSourceSha
            expectedImageVersion=$ExpectedImageVersion;nonce=$caseNonce;manifestSha256=$manifestSha;caseId=$caseId;taskRoot=$caseRoot
            candidatePath=$candidatePath;candidateSha256=$candidateIdentity.sha256;candidateVolumeSerial=$candidateIdentity.volumeSerial
            candidateFileId=$candidateIdentity.fileId;workingDirectory=$caseRoot;arguments=@($fixtureMode)
            environment=[pscustomobject][ordered]@{MYSPEED_CLEAN_STOP_FIXTURE_MODE=$fixtureMode;MYSPEED_CLEAN_STOP_NONCE=$caseNonce}
            stdoutPath=[IO.Path]::Combine($caseRoot,'stdout.log');stderrPath=[IO.Path]::Combine($caseRoot,'stderr.log')
            abiPath=[IO.Path]::Combine($caseRoot,'abi.json');readyPath=[IO.Path]::Combine($caseRoot,'ready.json')
            stdoutReadinessPath=[IO.Path]::Combine($caseRoot,'stdout-readiness.json');stopRequestPath=[IO.Path]::Combine($caseRoot,'stop.request.json')
            resultPath=[IO.Path]::Combine($caseRoot,'result.json');controllerNormalDeadlineMs=300000;controllerHardDeadlineMs=310000
            stopRequestTimeoutMs=240000;stopRequestPollMs=50;gracefulExitTimeoutMs=30000;forcedCleanupTimeoutMs=10000}
        [void](Assert-MyspeedCleanLaunchRequest $launch)
        $launchPath=[IO.Path]::Combine($caseRoot,'launch.request.json')
        $launchSha=Write-MyspeedProofCreateNewJson $launchPath $launch 262144
        $stableReadableOperation=New-MyspeedProofStableReadableOperation
        $observerOperations=[pscustomobject]@{
            Exists={param($path)[IO.File]::Exists($path)}
            CanReadStable=$stableReadableOperation
            ReadDocument={param($path,$label)
                $read=Read-MyspeedProofNativeBytes ($label.ToLowerInvariant().Replace(' ','-')) $path $caseRoot 262144 'generated-command'
                [pscustomobject]@{value=ConvertFrom-MyspeedProofJson ($encoding.GetString($read.bytes)) $label;sha256=$read.identity.sha256}
            }.GetNewClosure()
            ReadBytes={param($path)Read-MyspeedProofActiveLogBytes $path 2097152}.GetNewClosure()
            WriteDocument={param($path,$document,$label)
                $hash=Write-MyspeedProofCreateNewJson $path $document 262144
                $identity=Get-MyspeedProofNativeIdentity ($label.ToLowerInvariant().Replace(' ','-')) $path $caseRoot 262144 'generated-command'
                if($identity.sha256 -cne $hash){throw 'Observer create-new identity differs'};return $hash
            }.GetNewClosure()
        }
        $observer=New-MyspeedCleanStopProofObserver $launch $launchSha $observerOperations
        $controllerArguments=Get-MyspeedProofOuterArguments $manifest $launch $launchSha
        Assert-MyspeedProofIdentityUnchanged $closureIdentities.controller `
            (Get-MyspeedProofNativeIdentity 'controller' $closureIdentities.controller.path $expectedClosure $script:MaximumManifestFileBytes 'closure') 'Controller'
        Assert-MyspeedProofIdentityUnchanged $systemIdentities['inbox-powershell'] `
            (Get-MyspeedProofNativeIdentity 'inbox-powershell' $systemIdentities['inbox-powershell'].path $systemRoot $script:MaximumManifestFileBytes 'system-tool') 'Outer PowerShell'
        $outerDeadline=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+$script:MaximumObservedMilliseconds
        $outer=Invoke-MyspeedProofModuleCommand $script:ProofNative.launcher 'Invoke-ObservedOwnedJobProcess' `
            @($systemIdentities['inbox-powershell'].path,$systemIdentities['inbox-powershell'].sha256,$controllerArguments,
                $caseRoot,$outerDeadline,$script:MaximumObservedMilliseconds,$observer,$manifest.observerSha256)
        $outerPath=[IO.Path]::Combine($caseRoot,'outer-launcher.json')
        [void](Write-MyspeedProofCreateNewJson $outerPath $outer 262144)
        $collectionFiles=[pscustomobject][ordered]@{abi=[IO.File]::Exists($launch.abiPath);ready=[IO.File]::Exists($launch.readyPath)
            readiness=[IO.File]::Exists($launch.stdoutReadinessPath);result=[IO.File]::Exists($launch.resultPath)
            stdout=[IO.File]::Exists($launch.stdoutPath);stderr=[IO.File]::Exists($launch.stderrPath)}
        if($outer.status -ceq 'failed'){
            [void](Assert-MyspeedProofCaseCollectionGate ([pscustomobject][ordered]@{status=$outer.status;failure=$outer.failure;files=$collectionFiles}))
        }
        $expectedOuterExit=if($launch.caseId -ceq 'handler'){0}else{1}
        if($outer.status -ceq 'completed' -and $outer.exitCode -is [ValueType] -and
            [int64]$outer.exitCode -ne $expectedOuterExit){$streams=Get-MyspeedProofFailedProcessStreams $launch
            throw "Outer exit code differs: actual=$($outer.exitCode); expected=$expectedOuterExit; $streams"}
        [void](Assert-MyspeedProofOuterLauncher $manifest $launch $launchSha $outer)
        [void](Assert-MyspeedProofCaseCollectionGate ([pscustomobject][ordered]@{status=$outer.status;failure=$outer.failure;files=$collectionFiles}))
        $documents=[ordered]@{}
        foreach($entry in ([ordered]@{launch=$launchPath;abi=$launch.abiPath;ready=$launch.readyPath
            readiness=$launch.stdoutReadinessPath;result=$launch.resultPath;outer=$outerPath}).GetEnumerator()){
            $read=Read-MyspeedProofNativeBytes "$caseId-$($entry.Key)" $entry.Value $caseRoot 262144 'generated-command'
            [void]$identitySet.Add($read.identity)
            $documents[$entry.Key]=[pscustomobject]@{bytesBase64=[Convert]::ToBase64String($read.bytes);sha256=$read.identity.sha256}
        }
        $stopDocument=$null;if([IO.File]::Exists($launch.stopRequestPath)){
            $read=Read-MyspeedProofNativeBytes "$caseId-stop" $launch.stopRequestPath $caseRoot 262144 'generated-command'
            [void]$identitySet.Add($read.identity)
            $stopDocument=[pscustomobject]@{bytesBase64=[Convert]::ToBase64String($read.bytes);sha256=$read.identity.sha256}
        }
        $stdoutRead=Read-MyspeedProofNativeBytes "$caseId-stdout" $launch.stdoutPath $caseRoot 2097152 'generated-command'
        [void]$identitySet.Add($stdoutRead.identity)
        $stderrRead=Read-MyspeedProofBoundedFile $launch.stderrPath 2097152 -AllowEmpty
        if($stderrRead.bytes.Length -gt 0){[void]$identitySet.Add((Get-MyspeedProofNativeIdentity "$caseId-stderr" $launch.stderrPath $caseRoot 2097152 'generated-command'))}
        [void]$cases.Add([pscustomobject][ordered]@{manifestSha256=$manifestSha;launchDocument=$documents.launch
            abiDocument=$documents.abi;readyDocument=$documents.ready;stdoutReadinessDocument=$documents.readiness
            stdoutBase64=[Convert]::ToBase64String($stdoutRead.bytes);stdoutSha256=$stdoutRead.identity.sha256
            stopDocument=$stopDocument;resultDocument=$documents.result;outerLauncherDocument=$documents.outer})
    }
    $assessments=[Collections.Generic.List[object]]::new();foreach($case in $cases){[void]$assessments.Add((Assert-MyspeedProofCase $case $manifest))}
    $summary=[pscustomobject][ordered]@{schemaVersion=1;kind=$script:SummaryKind;status='completed';qualifying=$false
        releaseGatesCleared=@();manifestSha256=$manifestSha;caseIds=[string[]]$script:CaseIds
        classifications=[string[]]@($assessments|ForEach-Object {$_.classification})
        cases=[object[]]@(for($index=0;$index -lt $cases.Count;$index++){
            [pscustomobject][ordered]@{caseId=$script:CaseIds[$index];launchSha256=$cases[$index].launchDocument.sha256
                abiSha256=$cases[$index].abiDocument.sha256;readySha256=$cases[$index].readyDocument.sha256
                stdoutReadinessSha256=$cases[$index].stdoutReadinessDocument.sha256
                stopSha256=if($null -eq $cases[$index].stopDocument){$null}else{$cases[$index].stopDocument.sha256}
                resultSha256=$cases[$index].resultDocument.sha256;outerLauncherSha256=$cases[$index].outerLauncherDocument.sha256}
        });allCasesObserved=$true}
    $summaryPath=[IO.Path]::Combine($expectedEvidenceRoot,'summary.json')
    $summarySha=Write-MyspeedProofCreateNewJson $summaryPath $summary 262144
    $summaryRead=Read-MyspeedProofNativeBytes 'summary' $summaryPath $expectedEvidenceRoot 262144 'generated-command'
    [void]$identitySet.Add($summaryRead.identity)
    Invoke-MyspeedProofModuleCommand $script:ProofNative.identity 'Assert-MyspeedNoFileIdentityCollisions' `
        @([pscustomobject]@{files=[object[]]$identitySet}) | Out-Null
    $summaryDocument=[pscustomobject]@{bytesBase64=[Convert]::ToBase64String($summaryRead.bytes);sha256=$summarySha}
    $matrix=[pscustomobject][ordered]@{manifestDocument=$manifestDocument;cases=[object[]]$cases;summaryDocument=$summaryDocument}
    [void](Assert-MyspeedProofMatrix $matrix)
    Assert-MyspeedProofExactDirectoryFiles $expectedClosure ([string[]]@($script:TransportNames+'closure.json')) 'Transport closure'
    Assert-MyspeedProofExactDirectoryFiles $compileRoot @('compile-clean-stop-fixture.request.json',
        'compile-clean-stop-fixture.result.json','windows-clean-stop-fixture.exe','compile-launcher.json',
        'compiler.stdout','compiler.stderr') 'Compiler evidence'
    Assert-MyspeedProofExactDirectoryFiles $expectedEvidenceRoot @('execution-manifest.json','summary.json') 'Proof evidence'
    foreach($caseId in $script:CaseIds){
        $caseNonce=(Get-MyspeedProofSha256 ([Text.UTF8Encoding]::new($false).GetBytes("$Nonce`:$caseId"))).Substring(0,32)
        $caseLeaves=@('fixture.exe','launch.request.json','abi.json','ready.json','stdout-readiness.json','result.json',
            'outer-launcher.json','stdout.log','stderr.log')
        if($caseId -cne 'missing-stop'){$caseLeaves+=@('stop.request.json')}
        Assert-MyspeedProofExactDirectoryFiles ([IO.Path]::Combine($runnerTemp,"myspeed-clean-stop-$caseNonce")) $caseLeaves "$caseId evidence"
    }
    $inventoryFiles=[Collections.Generic.List[object]]::new()
    $inventoryEntries=[Collections.Generic.List[object]]::new()
    foreach($name in @($script:TransportNames+'closure.json')){
        [void]$inventoryEntries.Add([pscustomobject]@{name="closure/$name";path=[IO.Path]::Combine($expectedClosure,$name)})
    }
    foreach($name in @('compile-clean-stop-fixture.request.json','compile-clean-stop-fixture.result.json',
        'windows-clean-stop-fixture.exe','compile-launcher.json','compiler.stdout','compiler.stderr')){
        [void]$inventoryEntries.Add([pscustomobject]@{name="compiler/$name";path=[IO.Path]::Combine($compileRoot,$name)})
    }
    foreach($name in @('execution-manifest.json','summary.json')){
        [void]$inventoryEntries.Add([pscustomobject]@{name="evidence/$name";path=[IO.Path]::Combine($expectedEvidenceRoot,$name)})
    }
    foreach($caseId in $script:CaseIds){
        $caseNonce=(Get-MyspeedProofSha256 ([Text.UTF8Encoding]::new($false).GetBytes("$Nonce`:$caseId"))).Substring(0,32)
        $caseRoot=[IO.Path]::Combine($runnerTemp,"myspeed-clean-stop-$caseNonce")
        $leaves=@('fixture.exe','launch.request.json','abi.json','ready.json','stdout-readiness.json','result.json',
            'outer-launcher.json','stdout.log','stderr.log')
        if($caseId -cne 'missing-stop'){$leaves+=@('stop.request.json')}
        foreach($leaf in $leaves){[void]$inventoryEntries.Add([pscustomobject]@{name="$caseId/$leaf";path=[IO.Path]::Combine($caseRoot,$leaf)})}
    }
    $expectedInventoryNames=Get-MyspeedProofExpectedInventoryNames
    if($inventoryEntries.Count -ne $expectedInventoryNames.Count){throw 'Evidence inventory producer count differs'}
    for($index=0;$index -lt $inventoryEntries.Count;$index++){
        $entry=$inventoryEntries[$index]
        if($entry.name -cne $expectedInventoryNames[$index]){throw 'Evidence inventory producer order differs'}
        $read=Read-MyspeedProofBoundedFile $entry.path $script:MaximumManifestFileBytes -AllowEmpty
        [void]$inventoryFiles.Add([pscustomobject][ordered]@{name=$entry.name;path=$entry.path;bytes=$read.bytes.Length;sha256=$read.sha256})
    }
    $inventory=[pscustomobject][ordered]@{schemaVersion=1;kind=$script:EvidenceInventoryKind;qualifying=$false
        releaseGatesCleared=@();files=[object[]]$inventoryFiles}
    [void](Assert-MyspeedProofEvidenceInventory $inventory)
    $inventoryPath=[IO.Path]::Combine($expectedEvidenceRoot,'inventory.json')
    [void](Write-MyspeedProofCreateNewJson $inventoryPath $inventory 2097152)
    $final=[pscustomobject][ordered]@{schemaVersion=1;kind='myspeed-windows-clean-stop-hosted-proof';status='completed'
        qualifying=$false;releaseGatesCleared=@();transportSha256=$closureRead.sha256;manifestSha256=$manifestSha;summarySha256=$summarySha
        inventorySha256=(Read-MyspeedProofBoundedFile $inventoryPath 2097152).sha256;matrix=$matrix;failures=@()}
    [void](Write-MyspeedProofCreateNewJson $EvidencePath $final 2097152)
    $final|ConvertTo-Json -Depth 50 -Compress
}

if($Mode -ceq 'Library'){return}
try{
    if($Mode -cne 'GetContract' -and $Mode -cne $script:NativeMode -and [string]::IsNullOrEmpty($InputJson)){
        $InputJson=[Console]::In.ReadToEnd()
    }
    $output=switch($Mode){
        'GetContract' {Get-MyspeedProofContract}
        'ValidateTransport' {Assert-MyspeedProofTransportManifest (ConvertFrom-MyspeedProofJson $InputJson 'Transport manifest')}
        'ValidateInventory' {Assert-MyspeedProofEvidenceInventory (ConvertFrom-MyspeedProofJson $InputJson 'Evidence inventory')}
        'ValidateCompilerOperation' {$value=ConvertFrom-MyspeedProofJson $InputJson 'Compiler operation';
            Assert-MyspeedCleanExactKeys $value @('request','requestSha256','launcher','result') 'Compiler operation input'
            [pscustomobject]@{accepted=Assert-MyspeedProofCompilerOperation $value.request $value.requestSha256 $value.launcher $value.result}}
        'ValidateManifest' {Assert-MyspeedProofManifest (ConvertFrom-MyspeedProofJson $InputJson 'Proof manifest')}
        'ValidateCase' {Assert-MyspeedProofBoundCase (ConvertFrom-MyspeedProofJson $InputJson 'Bound proof case')}
        'AssessMatrix' {Assert-MyspeedProofMatrix (ConvertFrom-MyspeedProofJson $InputJson 'Proof matrix')}
        'TestObserver' {Invoke-MyspeedProofInjectedObserver (ConvertFrom-MyspeedProofJson $InputJson 'Injected observer')}
        'TestDetachedObserver' {Invoke-MyspeedProofInjectedObserver (ConvertFrom-MyspeedProofJson $InputJson 'Detached observer') $true}
        'TestLauncherBridge' {Invoke-MyspeedProofInjectedLauncherBridge}
        'TestActiveLogReader' {Invoke-MyspeedProofActiveLogReaderFixture (ConvertFrom-MyspeedProofJson $InputJson 'Active-log fixture')}
        'TestCollectionGate' {Assert-MyspeedProofCaseCollectionGate (ConvertFrom-MyspeedProofJson $InputJson 'Case collection gate')}
        'TestFailureStreams' {Get-MyspeedProofFailedProcessStreams (ConvertFrom-MyspeedProofJson $InputJson 'Failure stream request')}
        'InvokeHostedProof' {Invoke-MyspeedHostedCleanStopProof}
    }
    $output|ConvertTo-Json -Depth 40 -Compress
}catch{
    if($Mode -ceq $script:NativeMode -and -not [string]::IsNullOrEmpty($EvidencePath)){
        try{
            $parent=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($EvidencePath))
            if([IO.Directory]::Exists($parent) -and -not [IO.File]::Exists($EvidencePath)){
                $message=[string]$_.Exception.Message;if($message.Length -gt $script:MaximumFailureMessageLength){$message=$message.Substring(0,$script:MaximumFailureMessageLength)}
                $failed=[pscustomobject][ordered]@{schemaVersion=1;kind='myspeed-windows-clean-stop-hosted-proof';status='failed'
                    qualifying=$false;releaseGatesCleared=@();transportSha256=$null;manifestSha256=$null;summarySha256=$null
                    inventorySha256=$null;matrix=$null;failures=@($message)}
                [void](Write-MyspeedProofCreateNewJson $EvidencePath $failed 2097152)
            }
        }catch{}
    }
    [Console]::Error.WriteLine($_.Exception.Message);exit 1
}
