[CmdletBinding()]
param(
    [ValidateSet('Library','GetContract','GetAbiContract','ValidateAbi','ValidateLaunchRequest','ValidateStdoutReadiness','ValidateStopRequest',
        'ValidateResult','GetFixtureSource','GetNativeSource','TestLifecycle','TestEntryFailure','InvokeHostedController')]
    [string] $Mode='Library',
    [string] $InputJson='',
    [string] $LaunchRequestPath='',
    [string] $ExpectedLaunchRequestSha256='',
    [string] $ExpectedRunId='',
    [string] $ExpectedRunAttempt='',
    [string] $ExpectedEventSha='',
    [string] $ExpectedSourceSha='',
    [string] $ExpectedImageVersion='',
    [string] $Nonce=''
)

Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$script:CONTROLLER_NORMAL_DEADLINE_MS=300000
$script:CONTROLLER_HARD_DEADLINE_MS=310000
$script:STOP_REQUEST_TIMEOUT_MS=240000
$script:STOP_REQUEST_POLL_MS=50
$script:GRACEFUL_EXIT_TIMEOUT_MS=30000
$script:FORCED_CLEANUP_TIMEOUT_MS=10000
$script:MaximumJsonBytes=262144
$script:MaximumEntryFailurePrefixBytes=512
$script:Repository='i7Gamer/MySpeed'
$script:ImageOS='win25-vs2026'
$script:LaunchKind='myspeed-windows-clean-stop-launch'
$script:StopKind='myspeed-windows-clean-stop-request'
$script:ResultKind='myspeed-windows-clean-stop-result'
$script:StdoutReadinessKind='myspeed-windows-clean-stop-stdout-readiness'
$script:FixtureReadyMarker='MYSPEED_CLEAN_STOP_FIXTURE_READY_V1'
$script:FixtureModes=@('handler','ignore','extra-participant')
$script:CaseIds=@('handler','ignore','extra-participant','missing-stop')
$script:InjectedControllerPid=4000
$script:AbiKind='myspeed-windows-clean-stop-abi'
$script:AbiExpected=[ordered]@{
    pointerBytes=8;startupInfoBytes=104;startupInfoExBytes=112;processInformationBytes=24
    securityAttributesBytes=24;fileTimeBytes=8;ioCountersBytes=48;basicLimitBytes=64
    extendedLimitBytes=144;accountingBytes=48;fileInformationBytes=52;startupCbOffset=0
    startupReservedOffset=8;startupDesktopOffset=16;startupTitleOffset=24;startupXOffset=32
    startupYOffset=36;startupXSizeOffset=40;startupYSizeOffset=44;startupXCountOffset=48
    startupYCountOffset=52;startupFillOffset=56;startupFlagsOffset=60;startupShowOffset=64
    startupReserved2CountOffset=66;startupReserved2Offset=72;startupInputOffset=80
    startupOutputOffset=88;startupErrorOffset=96;startupAttributeListOffset=104
    fileTimeLowOffset=0;fileTimeHighOffset=4;accountingActiveOffset=40;basicFlagsOffset=16
    basicMinimumOffset=24;basicActiveOffset=40;basicAffinityOffset=48;extendedIoOffset=64
    extendedProcessMemoryOffset=112;handleListCount=3;handleListBytes=24
    processCreationFlags=525332;startupFlags=257
}
$script:LifecyclePhases=@('assertConsoleFree','openCandidateAndJob','createStandardHandles','queryAttributeList',
    'initializeAttributeList','updateHandleList','launchSuspended','assignJob','captureIdentity','resume',
    'writeReady','awaitStdoutReadiness','validateStdoutReadiness','awaitStopRequest','validateStopRequest','attachConsole','installIgnoreHandler',
    'revalidateHandle','proveConsoleMembers','generateCtrlC','freeConsole','proveConsoleFree',
    'waitCandidateExit','proveJobZero','closeResources')

function Assert-MyspeedCleanExactKeys {
    param([object]$Value,[string[]]$Keys,[string]$Label)
    if($null -eq $Value){throw "$Label is absent"}
    $actual=@($Value.PSObject.Properties.Name)
    if($actual.Count -ne $Keys.Count -or (@($actual|Where-Object {$Keys -cnotcontains $_}).Count -ne 0)){
        throw "$Label keys differ"
    }
}

function Assert-MyspeedCleanString {
    param([object]$Value,[string]$Label,[string]$Pattern='^.+$')
    if($Value -isnot [string]){throw "$Label must be an exact string"}
    $match=[Text.RegularExpressions.Regex]::Match($Value,$Pattern,[Text.RegularExpressions.RegexOptions]::CultureInvariant)
    if(-not $match.Success -or $match.Index -ne 0 -or $match.Length -ne $Value.Length){throw "$Label must be an exact string"}
    return $Value
}

function Assert-MyspeedCleanInteger {
    param([object]$Value,[string]$Label,[int64]$Minimum,[int64]$Maximum)
    if($Value -is [bool] -or $Value -isnot [sbyte] -and $Value -isnot [byte] -and
        $Value -isnot [int16] -and $Value -isnot [uint16] -and $Value -isnot [int32] -and
        $Value -isnot [uint32] -and $Value -isnot [int64]){
        throw "$Label must be an exact integer"
    }
    $number=[int64]$Value
    if($number -lt $Minimum -or $number -gt $Maximum){throw "$Label is outside its bound"}
    return $number
}

function Assert-MyspeedCleanBoolean {
    param([object]$Value,[string]$Label)
    if($Value -isnot [bool]){throw "$Label must be an exact Boolean"}
    return [bool]$Value
}

function Assert-MyspeedCleanArray {
    param([object]$Value,[string]$Label)
    if($Value -isnot [array]){throw "$Label must be an array"}
    Write-Output -NoEnumerate ([object[]]$Value)
}

function Get-MyspeedCleanExpectedAbiMeasurements {
    $copy=[ordered]@{};foreach($entry in $script:AbiExpected.GetEnumerator()){$copy[$entry.Key]=[int64]$entry.Value}
    return [pscustomobject]$copy
}

function Assert-MyspeedCleanAbiObservation {
    param([object]$Value)
    Assert-MyspeedCleanExactKeys $Value @('schemaVersion','kind','expected','observed','matched') 'ABI observation'
    [void](Assert-MyspeedCleanInteger $Value.schemaVersion 'ABI observation schema' 1 1)
    if((Assert-MyspeedCleanString $Value.kind 'ABI observation kind') -cne $script:AbiKind){throw 'ABI observation kind differs'}
    $names=[string[]]@($script:AbiExpected.Keys)
    Assert-MyspeedCleanExactKeys $Value.expected $names 'ABI expected measurements'
    Assert-MyspeedCleanExactKeys $Value.observed $names 'ABI observed measurements'
    $matches=$true
    foreach($entry in $script:AbiExpected.GetEnumerator()){
        $expected=Assert-MyspeedCleanInteger $Value.expected.($entry.Key) "ABI expected $($entry.Key)" 0 1048576
        $observed=Assert-MyspeedCleanInteger $Value.observed.($entry.Key) "ABI observed $($entry.Key)" 0 1048576
        if($expected -ne $entry.Value){throw 'ABI expected measurement differs'}
        if($observed -ne $entry.Value){$matches=$false}
    }
    if((Assert-MyspeedCleanBoolean $Value.matched 'ABI matched') -ne $matches){throw 'ABI matched classification differs'}
    return [pscustomobject]@{accepted=$true;matched=$matches}
}

function New-MyspeedCleanAbiObservation {
    param([object]$Observed)
    $names=[string[]]@($script:AbiExpected.Keys);Assert-MyspeedCleanExactKeys $Observed $names 'Native ABI measurements'
    $actual=[ordered]@{};$matches=$true
    foreach($entry in $script:AbiExpected.GetEnumerator()){
        $value=Assert-MyspeedCleanInteger $Observed.($entry.Key) "Native ABI $($entry.Key)" 0 1048576
        $actual[$entry.Key]=$value;if($value -ne $entry.Value){$matches=$false}
    }
    $result=[pscustomobject][ordered]@{schemaVersion=1;kind=$script:AbiKind
        expected=Get-MyspeedCleanExpectedAbiMeasurements;observed=[pscustomobject]$actual;matched=$matches}
    [void](Assert-MyspeedCleanAbiObservation $result);return $result
}

function Get-MyspeedCleanStopPollMilliseconds {
    param([int64]$Now,[int64]$Deadline)
    if($Now -ge $Deadline){throw 'Stop request deadline expired'}
    return [int][Math]::Min($script:STOP_REQUEST_POLL_MS,$Deadline-$Now)
}

function Assert-MyspeedCleanPath {
    param([object]$Value,[string]$Label)
    $path=Assert-MyspeedCleanString $Value $Label '^[A-Za-z]:\\.*$'
    if($path -match '[\x00-\x1f*?]' -or $path.Substring(2).Contains(':')){throw "$Label contains a forbidden path form"}
    if(-not [IO.Path]::IsPathRooted($path) -or [IO.Path]::GetFullPath($path) -cne $path){
        throw "$Label must be canonical and absolute"
    }
    foreach($segment in $path.Substring(3).Split('\')){
        if($segment -in @('','.','..') -or $segment.TrimEnd('.',' ') -cne $segment -or
            $segment -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$'){
            throw "$Label contains a forbidden path segment"
        }
    }
    return $path
}

function Assert-MyspeedCleanDescendant {
    param([string]$Root,[string]$Path,[string]$Label,[switch]$AllowRoot)
    $prefix=$Root.TrimEnd('\')+'\'
    if(($Path -ieq $Root -and -not $AllowRoot) -or
        ($Path -ine $Root -and -not $Path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase))){
        throw "$Label escapes the task root"
    }
}

function Assert-MyspeedCleanPhysicalPath {
    param([string]$Path,[string]$Label,[ValidateSet('File','Directory','Absent')][string]$ExpectedKind)
    $cursor=$Path
    $first=$true
    while($true){
        if(Test-Path -LiteralPath $cursor){
            $item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
            if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw "$Label traverses a reparse point"}
            if($item.FullName -ine $cursor){throw "$Label uses an alias"}
            if($first -and $ExpectedKind -ceq 'File' -and $item.PSIsContainer){throw "$Label is not a file"}
            if($first -and $ExpectedKind -ceq 'Directory' -and -not $item.PSIsContainer){throw "$Label is not a directory"}
            if($first -and $ExpectedKind -ceq 'Absent'){throw "$Label collides"}
        }elseif($first -and $ExpectedKind -cne 'Absent'){
            throw "$Label is absent"
        }
        $parent=[IO.Path]::GetDirectoryName($cursor)
        if([string]::IsNullOrEmpty($parent) -or $parent -ceq $cursor){break}
        $cursor=$parent;$first=$false
    }
}

function Assert-MyspeedCleanPhysicalLaunchPaths {
    param([object]$Request)
    Assert-MyspeedCleanPhysicalPath $Request.taskRoot 'Launch request task root' 'Directory'
    Assert-MyspeedCleanPhysicalPath $Request.workingDirectory 'Launch request working directory' 'Directory'
    Assert-MyspeedCleanPhysicalPath $Request.candidatePath 'Launch request candidate' 'File'
    foreach($name in @('stdoutPath','stderrPath','abiPath','readyPath','stdoutReadinessPath','stopRequestPath','resultPath')){
        Assert-MyspeedCleanPhysicalPath $Request.$name "Launch request $name" 'Absent'
    }
}

function ConvertFrom-MyspeedCleanJson {
    param([string]$Json,[string]$Label)
    if([string]::IsNullOrEmpty($Json)){throw "$Label JSON is absent"}
    try{return $Json|ConvertFrom-Json -ErrorAction Stop}catch{throw "$Label JSON is invalid"}
}

function Assert-MyspeedCleanLaunchRequest {
    param([object]$Request)
    $keys=@('schemaVersion','kind','expectedRunId','expectedRunAttempt','expectedEventSha',
        'expectedSourceSha','expectedImageVersion','nonce','manifestSha256','caseId','taskRoot','candidatePath','candidateSha256',
        'candidateVolumeSerial','candidateFileId','workingDirectory','arguments','environment','stdoutPath','stderrPath',
        'abiPath','readyPath','stdoutReadinessPath','stopRequestPath','resultPath','controllerNormalDeadlineMs','controllerHardDeadlineMs',
        'stopRequestTimeoutMs','stopRequestPollMs','gracefulExitTimeoutMs','forcedCleanupTimeoutMs')
    Assert-MyspeedCleanExactKeys $Request $keys 'Launch request'
    [void](Assert-MyspeedCleanInteger $Request.schemaVersion 'Launch request schema' 1 1)
    if((Assert-MyspeedCleanString $Request.kind 'Launch request kind') -cne $script:LaunchKind){
        throw 'Launch request kind differs'
    }
    [void](Assert-MyspeedCleanString $Request.expectedRunId 'Launch request run ID' '^[1-9][0-9]{0,19}$')
    [void](Assert-MyspeedCleanString $Request.expectedRunAttempt 'Launch request run attempt' '^[1-9][0-9]{0,9}$')
    [void](Assert-MyspeedCleanString $Request.expectedEventSha 'Launch request event SHA' '^[0-9a-f]{40}$')
    [void](Assert-MyspeedCleanString $Request.expectedSourceSha 'Launch request source SHA' '^[0-9a-f]{40}$')
    [void](Assert-MyspeedCleanString $Request.expectedImageVersion 'Launch request image version' '^[0-9A-Za-z._-]{1,128}$')
    [void](Assert-MyspeedCleanString $Request.nonce 'Launch request nonce' '^[0-9a-f]{32}$')
    [void](Assert-MyspeedCleanString $Request.manifestSha256 'Launch request manifest SHA' '^[0-9a-f]{64}$')
    $caseId=Assert-MyspeedCleanString $Request.caseId 'Launch request case ID'
    if($script:CaseIds -cnotcontains $caseId){throw 'Launch request case ID differs'}
    $root=Assert-MyspeedCleanPath $Request.taskRoot 'Launch request task root'
    foreach($name in @('candidatePath','workingDirectory','stdoutPath','stderrPath','abiPath','readyPath','stdoutReadinessPath','stopRequestPath','resultPath')){
        $candidate=Assert-MyspeedCleanPath $Request.$name "Launch request $name"
        Assert-MyspeedCleanDescendant $root $candidate "Launch request $name" -AllowRoot:($name -ceq 'workingDirectory')
    }
    $ownedPaths=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($name in @('candidatePath','stdoutPath','stderrPath','abiPath','readyPath','stdoutReadinessPath','stopRequestPath','resultPath')){
        if(-not $ownedPaths.Add($Request.$name)){throw 'Launch request owned paths must be distinct'}
    }
    [void](Assert-MyspeedCleanString $Request.candidateSha256 'Launch request candidate SHA' '^[0-9a-f]{64}$')
    [void](Assert-MyspeedCleanString $Request.candidateVolumeSerial 'Launch request candidate volume serial' '^[0-9a-f]{8}$')
    [void](Assert-MyspeedCleanString $Request.candidateFileId 'Launch request candidate file ID' '^[0-9a-f]{16}$')
    $arguments=Assert-MyspeedCleanArray $Request.arguments 'Launch request arguments'
    $expectedMode=if($caseId -ceq 'missing-stop'){'handler'}else{$caseId}
    if($arguments.Count -ne 1 -or $arguments[0] -isnot [string] -or $arguments[0] -cne $expectedMode){
        throw 'Launch request arguments differ'
    }
    Assert-MyspeedCleanExactKeys $Request.environment @('MYSPEED_CLEAN_STOP_FIXTURE_MODE','MYSPEED_CLEAN_STOP_NONCE') 'Launch request environment'
    if((Assert-MyspeedCleanString $Request.environment.MYSPEED_CLEAN_STOP_FIXTURE_MODE 'Launch request fixture mode') -cne $arguments[0] -or
        (Assert-MyspeedCleanString $Request.environment.MYSPEED_CLEAN_STOP_NONCE 'Launch request environment nonce') -cne $Request.nonce){
        throw 'Launch request environment differs'
    }
    $limits=@{
        controllerNormalDeadlineMs=$script:CONTROLLER_NORMAL_DEADLINE_MS
        controllerHardDeadlineMs=$script:CONTROLLER_HARD_DEADLINE_MS
        stopRequestTimeoutMs=$script:STOP_REQUEST_TIMEOUT_MS
        stopRequestPollMs=$script:STOP_REQUEST_POLL_MS
        gracefulExitTimeoutMs=$script:GRACEFUL_EXIT_TIMEOUT_MS
        forcedCleanupTimeoutMs=$script:FORCED_CLEANUP_TIMEOUT_MS}
    foreach($entry in $limits.GetEnumerator()){
        if((Assert-MyspeedCleanInteger $Request.($entry.Key) "Launch request $($entry.Key)" $entry.Value $entry.Value) -ne $entry.Value){
            throw 'Launch request deadline differs'
        }
    }
    return [pscustomobject]@{accepted=$true}
}

function Assert-MyspeedCleanStopRequest {
    param([object]$Launch,[string]$LaunchRequestSha256,[string]$AbiSha256,[string]$ReadySha256,[object]$Stop)
    [void](Assert-MyspeedCleanLaunchRequest $Launch)
    [void](Assert-MyspeedCleanString $LaunchRequestSha256 'Stop request launch SHA input' '^[0-9a-f]{64}$')
    [void](Assert-MyspeedCleanString $AbiSha256 'Stop request ABI SHA input' '^[0-9a-f]{64}$')
    [void](Assert-MyspeedCleanString $ReadySha256 'Stop request ready SHA input' '^[0-9a-f]{64}$')
    $keys=@('schemaVersion','kind','expectedRunId','expectedRunAttempt','expectedEventSha','nonce','manifestSha256',
        'launchRequestSha256','abiSha256','readySha256','stdoutReadinessSha256','caseId',
        'candidatePid','candidateCreationTime','candidateImagePath','candidateSha256','candidateVolumeSerial','candidateFileId')
    Assert-MyspeedCleanExactKeys $Stop $keys 'Stop request'
    [void](Assert-MyspeedCleanInteger $Stop.schemaVersion 'Stop request schema' 1 1)
    if((Assert-MyspeedCleanString $Stop.kind 'Stop request kind') -cne $script:StopKind){throw 'Stop request kind differs'}
    foreach($binding in @{
        expectedRunId='expectedRunId';expectedRunAttempt='expectedRunAttempt';expectedEventSha='expectedEventSha'
        nonce='nonce';manifestSha256='manifestSha256';caseId='caseId';candidateImagePath='candidatePath';candidateSha256='candidateSha256'
        candidateVolumeSerial='candidateVolumeSerial';candidateFileId='candidateFileId'}.GetEnumerator()){
        if((Assert-MyspeedCleanString $Stop.($binding.Key) "Stop request $($binding.Key)") -cne $Launch.($binding.Value)){
            throw 'Stop request identity binding differs'
        }
    }
    if((Assert-MyspeedCleanString $Stop.launchRequestSha256 'Stop request launch SHA' '^[0-9a-f]{64}$') -cne $LaunchRequestSha256 -or
        (Assert-MyspeedCleanString $Stop.abiSha256 'Stop request ABI SHA' '^[0-9a-f]{64}$') -cne $AbiSha256 -or
        (Assert-MyspeedCleanString $Stop.readySha256 'Stop request ready SHA' '^[0-9a-f]{64}$') -cne $ReadySha256){
        throw 'Stop request evidence binding differs'
    }
    [void](Assert-MyspeedCleanString $Stop.stdoutReadinessSha256 'Stop request stdout readiness SHA' '^[0-9a-f]{64}$')
    [void](Assert-MyspeedCleanInteger $Stop.candidatePid 'Stop request candidate PID' 1 4294967295)
    [void](Assert-MyspeedCleanString $Stop.candidateCreationTime 'Stop request candidate creation time' '^[0-9a-f]{16}$')
    return [pscustomobject]@{accepted=$true}
}

function Assert-MyspeedCleanStdoutReadiness {
    param([object]$Launch,[string]$LaunchRequestSha256,[string]$AbiSha256,[string]$ReadySha256,[object]$Value)
    [void](Assert-MyspeedCleanLaunchRequest $Launch)
    Assert-MyspeedCleanExactKeys $Value @('schemaVersion','kind','manifestSha256','caseId','launchRequestSha256',
        'abiSha256','readySha256','stdoutSha256','marker','observedMonotonicMs') 'Stdout readiness'
    [void](Assert-MyspeedCleanInteger $Value.schemaVersion 'Stdout readiness schema' 1 1)
    if((Assert-MyspeedCleanString $Value.kind 'Stdout readiness kind') -cne $script:StdoutReadinessKind){throw 'Stdout readiness kind differs'}
    foreach($binding in @{manifestSha256='manifestSha256';caseId='caseId'}.GetEnumerator()){
        if((Assert-MyspeedCleanString $Value.($binding.Key) "Stdout readiness $($binding.Key)") -cne $Launch.($binding.Value)){throw 'Stdout readiness identity differs'}
    }
    foreach($binding in @{launchRequestSha256=$LaunchRequestSha256;abiSha256=$AbiSha256;readySha256=$ReadySha256}.GetEnumerator()){
        if((Assert-MyspeedCleanString $Value.($binding.Key) "Stdout readiness $($binding.Key)" '^[0-9a-f]{64}$') -cne $binding.Value){throw 'Stdout readiness evidence binding differs'}
    }
    [void](Assert-MyspeedCleanString $Value.stdoutSha256 'Stdout readiness stdout SHA' '^[0-9a-f]{64}$')
    if((Assert-MyspeedCleanString $Value.marker 'Stdout readiness marker') -cne $script:FixtureReadyMarker){throw 'Stdout readiness marker differs'}
    [void](Assert-MyspeedCleanInteger $Value.observedMonotonicMs 'Stdout readiness monotonic time' 0 $script:CONTROLLER_NORMAL_DEADLINE_MS)
    return [pscustomobject]@{accepted=$true}
}

function Assert-MyspeedCleanResult {
    param([object]$Result)
    $keys=@('schemaVersion','kind','status','qualifying','controllerLifecyclePassed','forced',
        'manifestSha256','caseId','requestSha256','abiSha256','readySha256','stdoutReadinessSha256','stopRequestSha256',
        'stdoutReadinessObserved','stopRequestObserved','stopRequestDeadlineMs','graceExpired','observedConsoleProcessIds','lifecycleEvents',
        'runId','runAttempt','eventSha','sourceSha','imageVersion','nonce',
        'controllerPid','candidatePid','candidateCreationTime','candidateImagePath','candidateSha256','candidateVolumeSerial',
        'candidateFileId','controllerInitiallyConsoleFree','candidateCreatedSuspended','privateConsoleRequested',
        'handleListConfigured','jobAssignedBeforeResume','initialJobMembership','candidateIdentityCaptured',
        'candidateResumed','threadHandleClosedBeforeReady','preAttachIdentityMatch','postAttachHandleUnsignaled','postAttachIdentityMatch',
        'postAttachJobMembership','consoleProcessIdsExact','ctrlEventGenerated','candidateExited','exitCode',
        'jobActiveProcesses','consoleFreeAfter','handlesClosed','elapsedMs','failures','releaseGatesCleared')
    Assert-MyspeedCleanExactKeys $Result $keys 'Controller result'
    [void](Assert-MyspeedCleanInteger $Result.schemaVersion 'Controller result schema' 1 1)
    if((Assert-MyspeedCleanString $Result.kind 'Controller result kind') -cne $script:ResultKind){
        throw 'Controller result kind differs'
    }
    $status=Assert-MyspeedCleanString $Result.status 'Controller result status' '^(completed|failed)$'
    if(Assert-MyspeedCleanBoolean $Result.qualifying 'Controller result qualifying'){
        throw 'Controller result must remain nonqualifying'
    }
    $passed=Assert-MyspeedCleanBoolean $Result.controllerLifecyclePassed 'Controller result lifecycle'
    $forced=Assert-MyspeedCleanBoolean $Result.forced 'Controller result forced'
    [void](Assert-MyspeedCleanString $Result.manifestSha256 'Controller result manifest SHA' '^[0-9a-f]{64}$')
    $caseId=Assert-MyspeedCleanString $Result.caseId 'Controller result case ID'
    if($script:CaseIds -cnotcontains $caseId){throw 'Controller result case ID differs'}
    [void](Assert-MyspeedCleanString $Result.requestSha256 'Controller result request SHA' '^[0-9a-f]{64}$')
    [void](Assert-MyspeedCleanString $Result.abiSha256 'Controller result ABI SHA' '^[0-9a-f]{64}$')
    if($null -ne $Result.readySha256){
        [void](Assert-MyspeedCleanString $Result.readySha256 'Controller result ready SHA' '^[0-9a-f]{64}$')
    }
    if($null -ne $Result.stopRequestSha256){
        [void](Assert-MyspeedCleanString $Result.stopRequestSha256 'Controller result stop request SHA' '^[0-9a-f]{64}$')
    }
    if($null -ne $Result.stdoutReadinessSha256){
        [void](Assert-MyspeedCleanString $Result.stdoutReadinessSha256 'Controller result stdout readiness SHA' '^[0-9a-f]{64}$')
    }
    $stdoutObserved=Assert-MyspeedCleanBoolean $Result.stdoutReadinessObserved 'Controller result stdout readiness observed'
    $stopObserved=Assert-MyspeedCleanBoolean $Result.stopRequestObserved 'Controller result stop request observed'
    $stopDeadline=if($null -eq $Result.stopRequestDeadlineMs){$null}else{Assert-MyspeedCleanInteger $Result.stopRequestDeadlineMs 'Controller result stop deadline' 0 $script:CONTROLLER_NORMAL_DEADLINE_MS}
    $graceExpired=if($null -eq $Result.graceExpired){$null}else{Assert-MyspeedCleanBoolean $Result.graceExpired 'Controller result grace expired'}
    $consoleIds=if($null -eq $Result.observedConsoleProcessIds){$null}else{Assert-MyspeedCleanArray $Result.observedConsoleProcessIds 'Controller result console process IDs'}
    if($null -ne $consoleIds){
        $uniqueConsoleIds=[Collections.Generic.HashSet[int64]]::new()
        foreach($id in $consoleIds){
            $processId=Assert-MyspeedCleanInteger $id 'Controller result console process ID' 1 4294967295
            if(-not $uniqueConsoleIds.Add($processId)){throw 'Controller result console process IDs are duplicated'}
        }
    }
    $events=Assert-MyspeedCleanArray $Result.lifecycleEvents 'Controller result lifecycle events'
    foreach($event in $events){$name=Assert-MyspeedCleanString $event 'Controller result lifecycle event';if($script:LifecyclePhases -cnotcontains $name){throw 'Controller result lifecycle event differs'}}
    if($stdoutObserved -ne ($null -ne $Result.stdoutReadinessSha256) -or $stopObserved -ne ($null -ne $Result.stopRequestSha256)){throw 'Controller result observation binding differs'}
    [void](Assert-MyspeedCleanString $Result.runId 'Controller result run ID' '^[1-9][0-9]{0,19}$')
    [void](Assert-MyspeedCleanString $Result.runAttempt 'Controller result run attempt' '^[1-9][0-9]{0,9}$')
    [void](Assert-MyspeedCleanString $Result.eventSha 'Controller result event SHA' '^[0-9a-f]{40}$')
    [void](Assert-MyspeedCleanString $Result.sourceSha 'Controller result source SHA' '^[0-9a-f]{40}$')
    [void](Assert-MyspeedCleanString $Result.imageVersion 'Controller result image version' '^[0-9A-Za-z._-]{1,128}$')
    [void](Assert-MyspeedCleanString $Result.nonce 'Controller result nonce' '^[0-9a-f]{32}$')
    [void](Assert-MyspeedCleanInteger $Result.controllerPid 'Controller process PID' 1 4294967295)
    if($null -ne $Result.candidatePid){[void](Assert-MyspeedCleanInteger $Result.candidatePid 'Controller result PID' 1 4294967295)}
    if($null -ne $Result.candidateCreationTime){[void](Assert-MyspeedCleanString $Result.candidateCreationTime 'Controller result creation time' '^[0-9a-f]{16}$')}
    if($null -ne $Result.candidateImagePath){[void](Assert-MyspeedCleanPath $Result.candidateImagePath 'Controller result image path')}
    [void](Assert-MyspeedCleanString $Result.candidateSha256 'Controller result candidate SHA' '^[0-9a-f]{64}$')
    if($null -ne $Result.candidateVolumeSerial){[void](Assert-MyspeedCleanString $Result.candidateVolumeSerial 'Controller result volume serial' '^[0-9a-f]{8}$')}
    if($null -ne $Result.candidateFileId){[void](Assert-MyspeedCleanString $Result.candidateFileId 'Controller result file ID' '^[0-9a-f]{16}$')}
    $allProofs=$true
    foreach($name in @('controllerInitiallyConsoleFree','candidateCreatedSuspended','privateConsoleRequested',
        'handleListConfigured','jobAssignedBeforeResume','initialJobMembership','candidateIdentityCaptured',
        'candidateResumed','threadHandleClosedBeforeReady','preAttachIdentityMatch','postAttachHandleUnsignaled','postAttachIdentityMatch',
        'postAttachJobMembership','consoleProcessIdsExact','ctrlEventGenerated','candidateExited',
        'consoleFreeAfter','handlesClosed')){
        $proofValue=Assert-MyspeedCleanBoolean $Result.$name "Controller result $name"
        $allProofs=$allProofs -and $proofValue
    }
    $exitCode=if($null -eq $Result.exitCode){$null}else{Assert-MyspeedCleanInteger $Result.exitCode 'Controller result exit code' -2147483648 2147483647}
    $active=if($null -eq $Result.jobActiveProcesses){$null}else{Assert-MyspeedCleanInteger $Result.jobActiveProcesses 'Controller result active processes' 0 4294967295}
    $elapsed=Assert-MyspeedCleanInteger $Result.elapsedMs 'Controller result elapsed' 0 $script:CONTROLLER_HARD_DEADLINE_MS
    $failures=Assert-MyspeedCleanArray $Result.failures 'Controller result failures'
    foreach($failure in $failures){[void](Assert-MyspeedCleanString $failure 'Controller result failure')}
    $gates=Assert-MyspeedCleanArray $Result.releaseGatesCleared 'Controller result release gates'
    if($gates.Count -ne 0){throw 'Controller result cannot clear release gates'}
    $identityComplete=$null -ne $Result.readySha256 -and $null -ne $Result.stdoutReadinessSha256 -and
        $null -ne $Result.stopRequestSha256 -and $null -ne $Result.candidatePid -and
        $null -ne $Result.candidateCreationTime -and $null -ne $Result.candidateImagePath -and
        $null -ne $Result.candidateVolumeSerial -and $null -ne $Result.candidateFileId
    $recomputed=$status -ceq 'completed' -and -not $forced -and $elapsed -le $script:CONTROLLER_NORMAL_DEADLINE_MS -and
        $identityComplete -and $stopDeadline -ne $null -and $graceExpired -eq $false -and
        $null -ne $consoleIds -and $consoleIds.Count -eq 2 -and $allProofs -and
        $exitCode -eq 0 -and $active -eq 0 -and $failures.Count -eq 0
    if($passed -ne $recomputed){throw 'Controller result lifecycle recomputation differs'}
    if($status -ceq 'completed' -and -not $passed){throw 'Controller completed result did not pass'}
    if($status -ceq 'failed' -and $failures.Count -eq 0){throw 'Controller failed result has no failure'}
    return [pscustomobject]@{accepted=$true}
}

function Get-MyspeedCleanFixtureSource {
    @'
using System;
using System.Diagnostics;
using System.Threading;
public static class MySpeedCleanStopFixture {
  [System.Runtime.InteropServices.DllImport("kernel32.dll",SetLastError=true)]
  static extern uint GetFileType(IntPtr handle);
  static readonly ManualResetEvent Stop = new ManualResetEvent(false);
  public static int Main(string[] args) {
    if(args.Length != 1) return 64;
    string omitted=Environment.GetEnvironmentVariable("MYSPEED_OMITTED_INHERITABLE_HANDLE");
    long raw;if(!Int64.TryParse(omitted,out raw))return 66;
    System.Runtime.InteropServices.Marshal.GetLastWin32Error();
    uint inheritedType=GetFileType(new IntPtr(raw));
    if(inheritedType!=0||System.Runtime.InteropServices.Marshal.GetLastWin32Error()!=6)return 67;
    string mode=args[0];
    if(mode=="participant"){Thread.Sleep(Timeout.Infinite);return 0;}
    if(mode=="handler") Console.CancelKeyPress += delegate(object sender,ConsoleCancelEventArgs e){e.Cancel=true;Stop.Set();};
    else if(mode=="ignore") Console.CancelKeyPress += delegate(object sender,ConsoleCancelEventArgs e){e.Cancel=true;};
    else if(mode=="extra-participant") {
      ProcessStartInfo info=new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,"participant");
      info.UseShellExecute=false;Process participant=Process.Start(info);if(participant==null||participant.HasExited)return 68;
      Console.CancelKeyPress += delegate(object sender,ConsoleCancelEventArgs e){e.Cancel=true;Stop.Set();};
    } else return 65;
    Console.Out.WriteLine("MYSPEED_CLEAN_STOP_FIXTURE_READY_V1");Console.Out.Flush();
    Stop.WaitOne();
    Environment.Exit(0);
    return 0;
  }
}
'@
}

function Get-MyspeedCleanNativeSource {
    @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace MySpeed.Qualification.CleanStop {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
  public struct STARTUPINFOW {
    public uint cb; public IntPtr lpReserved,lpDesktop,lpTitle;
    public uint dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags;
    public ushort wShowWindow,cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFOEXW { public STARTUPINFOW StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess,hThread; public uint dwProcessId,dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] public struct SECURITY_ATTRIBUTES { public uint nLength; public IntPtr lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle; }
  [StructLayout(LayoutKind.Sequential)] public struct FILETIME { public uint Low,High; public ulong Value { get { return ((ulong)High<<32)|Low; } } }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] public struct BASIC_LIMIT { public long a,b; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] public struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [StructLayout(LayoutKind.Sequential)] public struct ACCOUNTING { public long a,b,c,d; public uint faults,total,active,terminated; }
  [StructLayout(LayoutKind.Sequential)] public struct BY_HANDLE_FILE_INFORMATION {
    public uint attributes; public FILETIME creation,access,write; public uint volumeSerial,sizeHigh,sizeLow,links,fileIndexHigh,fileIndexLow;
  }
  public sealed class NativeResult {
    public bool preAttachIdentityMatch,postAttachHandleUnsignaled,postAttachIdentityMatch,postAttachJobMembership;
    public bool consoleProcessIdsExact,ctrlEventGenerated,candidateExited,graceExpired,forced,jobZero,consoleFreeAfter,handlesClosed;
    public uint[] consoleProcessIds;
    public int exitCode; public uint candidatePid; public ulong candidateCreationTime; public string candidateImagePath,candidateVolumeSerial,candidateFileId;
  }
  public sealed class Session : IDisposable {
    const uint CREATE_SUSPENDED=0x4,CREATE_NEW_CONSOLE=0x10,CREATE_UNICODE_ENVIRONMENT=0x400,EXTENDED_STARTUPINFO_PRESENT=0x80000;
    const uint STARTF_USESHOWWINDOW=1,STARTF_USESTDHANDLES=0x100; const ushort SW_HIDE=0;
    const uint PROC_THREAD_ATTRIBUTE_HANDLE_LIST=0x20002,JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x2000;
    const int JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION=1,JOB_OBJECT_EXTENDED_LIMIT_INFORMATION=9;
    const uint WAIT_OBJECT_0=0,WAIT_TIMEOUT=258,CTRL_C_EVENT=0,ERROR_INVALID_HANDLE=6,ERROR_INSUFFICIENT_BUFFER=122;
    const uint NATIVE_CLEANUP_TIMEOUT_MS=10000,NATIVE_CLEANUP_POLL_MS=10,MAX_ATTRIBUTE_LIST_BYTES=1048576;
    const uint STOP_FAILURE_EXIT_CODE=197,LAUNCH_FAILURE_EXIT_CODE=199;
    const uint GENERIC_READ=0x80000000,FILE_APPEND_DATA=4,FILE_SHARE_READ=1,CREATE_NEW=1,OPEN_EXISTING=3,FILE_ATTRIBUTE_NORMAL=0x80;
    IntPtr job=IntPtr.Zero,process=IntPtr.Zero; FileStream image; uint pid; ulong creation; string imagePath,volumeSerial,fileId;
    NativeResult lastResult;
    NativeResult NewResult(){NativeResult r=new NativeResult();r.candidatePid=pid;r.candidateCreationTime=creation;r.candidateImagePath=imagePath;r.candidateVolumeSerial=volumeSerial;r.candidateFileId=fileId;return r;}
    NativeResult ObserveExitedResult(bool forced){NativeResult r=lastResult??NewResult();r.forced=r.forced||forced;r.jobZero=job==IntPtr.Zero||Active(job)==0;r.candidateExited=process!=IntPtr.Zero&&WaitForSingleObject(process,0)==WAIT_OBJECT_0;if(!r.candidateExited)throw new InvalidOperationException("Retained candidate process did not exit");uint code;if(!GetExitCodeProcess(process,out code))throw Error("GetExitCodeProcess");r.exitCode=unchecked((int)code);lastResult=r;return r;}
    public NativeResult LastResult {get{if(lastResult==null&&process!=IntPtr.Zero&&WaitForSingleObject(process,0)==WAIT_OBJECT_0)return ObserveExitedResult(false);return lastResult;}private set{lastResult=value;}}
    public static bool LastLaunchForced {get;private set;}
    public bool StopCleanupAttempted {get;private set;}
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint="CreateProcessW")]
    static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFOEXW si,out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,ref EXTENDED_LIMIT i,uint l);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j,int c,ref ACCOUNTING i,uint l,IntPtr r);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr p,IntPtr j,out bool b);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr j,uint c);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr p,uint c);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr t);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint m);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr p,out uint c);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr p,out FILETIME c,out FILETIME e,out FILETIME k,out FILETIME u);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint="QueryFullProcessImageNameW")]
    static extern bool QueryImage(IntPtr p,uint f,StringBuilder s,ref uint n);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(IntPtr p);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr h,out BY_HANDLE_FILE_INFORMATION i);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint="CreateFileW")]
    static extern IntPtr CreateFile(string n,uint a,uint s,ref SECURITY_ATTRIBUTES sa,uint d,uint f,IntPtr t);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr l,int c,uint f,ref UIntPtr z);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr l,uint f,UIntPtr a,IntPtr v,UIntPtr z,IntPtr p,IntPtr r);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr l);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetConsoleProcessList([Out] uint[] p,uint c);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AttachConsole(uint p);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetConsoleCtrlHandler(IntPtr h,bool a);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GenerateConsoleCtrlEvent(uint e,uint g);
    static Exception Error(string n){return new Win32Exception(Marshal.GetLastWin32Error(),n);}
    public static IDictionary<string,long> ObserveAbi(){
      Dictionary<string,long> r=new Dictionary<string,long>();
      r["pointerBytes"]=IntPtr.Size;r["startupInfoBytes"]=Marshal.SizeOf(typeof(STARTUPINFOW));r["startupInfoExBytes"]=Marshal.SizeOf(typeof(STARTUPINFOEXW));
      r["processInformationBytes"]=Marshal.SizeOf(typeof(PROCESS_INFORMATION));r["securityAttributesBytes"]=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));r["fileTimeBytes"]=Marshal.SizeOf(typeof(FILETIME));
      r["ioCountersBytes"]=Marshal.SizeOf(typeof(IO_COUNTERS));r["basicLimitBytes"]=Marshal.SizeOf(typeof(BASIC_LIMIT));r["extendedLimitBytes"]=Marshal.SizeOf(typeof(EXTENDED_LIMIT));
      r["accountingBytes"]=Marshal.SizeOf(typeof(ACCOUNTING));r["fileInformationBytes"]=Marshal.SizeOf(typeof(BY_HANDLE_FILE_INFORMATION));
      r["startupCbOffset"]=Marshal.OffsetOf(typeof(STARTUPINFOW),"cb").ToInt64();r["startupReservedOffset"]=Marshal.OffsetOf(typeof(STARTUPINFOW),"lpReserved").ToInt64();
      r["startupDesktopOffset"]=Marshal.OffsetOf(typeof(STARTUPINFOW),"lpDesktop").ToInt64();r["startupTitleOffset"]=Marshal.OffsetOf(typeof(STARTUPINFOW),"lpTitle").ToInt64();
      r["startupXOffset"]=Marshal.OffsetOf(typeof(STARTUPINFOW),"dwX").ToInt64();r["startupYOffset"]=Marshal.OffsetOf(typeof(STARTUPINFOW),"dwY").ToInt64();
      r["startupXSizeOffset"]=Marshal.OffsetOf(typeof(STARTUPINFOW),"dwXSize").ToInt64();r["startupYSizeOffset"]=Marshal.OffsetOf(typeof(STARTUPINFOW),"dwYSize").ToInt64();
      r["startupXCountOffset"]=Marshal.OffsetOf(typeof(STARTUPINFOW),"dwXCountChars").ToInt64();r["startupYCountOffset"]=Marshal.OffsetOf(typeof(STARTUPINFOW),"dwYCountChars").ToInt64();
      r["startupFillOffset"]=Marshal.OffsetOf(typeof(STARTUPINFOW),"dwFillAttribute").ToInt64();r["startupFlagsOffset"]=Marshal.OffsetOf(typeof(STARTUPINFOW),"dwFlags").ToInt64();
      r["startupShowOffset"]=Marshal.OffsetOf(typeof(STARTUPINFOW),"wShowWindow").ToInt64();r["startupReserved2CountOffset"]=Marshal.OffsetOf(typeof(STARTUPINFOW),"cbReserved2").ToInt64();
      r["startupReserved2Offset"]=Marshal.OffsetOf(typeof(STARTUPINFOW),"lpReserved2").ToInt64();r["startupInputOffset"]=Marshal.OffsetOf(typeof(STARTUPINFOW),"hStdInput").ToInt64();
      r["startupOutputOffset"]=Marshal.OffsetOf(typeof(STARTUPINFOW),"hStdOutput").ToInt64();r["startupErrorOffset"]=Marshal.OffsetOf(typeof(STARTUPINFOW),"hStdError").ToInt64();
      r["startupAttributeListOffset"]=Marshal.OffsetOf(typeof(STARTUPINFOEXW),"lpAttributeList").ToInt64();r["fileTimeLowOffset"]=Marshal.OffsetOf(typeof(FILETIME),"Low").ToInt64();
      r["fileTimeHighOffset"]=Marshal.OffsetOf(typeof(FILETIME),"High").ToInt64();r["accountingActiveOffset"]=Marshal.OffsetOf(typeof(ACCOUNTING),"active").ToInt64();
      r["basicFlagsOffset"]=Marshal.OffsetOf(typeof(BASIC_LIMIT),"flags").ToInt64();r["basicMinimumOffset"]=Marshal.OffsetOf(typeof(BASIC_LIMIT),"min").ToInt64();
      r["basicActiveOffset"]=Marshal.OffsetOf(typeof(BASIC_LIMIT),"active").ToInt64();r["basicAffinityOffset"]=Marshal.OffsetOf(typeof(BASIC_LIMIT),"affinity").ToInt64();
      r["extendedIoOffset"]=Marshal.OffsetOf(typeof(EXTENDED_LIMIT),"io").ToInt64();r["extendedProcessMemoryOffset"]=Marshal.OffsetOf(typeof(EXTENDED_LIMIT),"processMemory").ToInt64();
      r["handleListCount"]=3;r["handleListBytes"]=IntPtr.Size*3;r["processCreationFlags"]=CREATE_SUSPENDED|CREATE_NEW_CONSOLE|CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT;
      r["startupFlags"]=STARTF_USESHOWWINDOW|STARTF_USESTDHANDLES;return r;
    }
    public static void AssertAbi(){
      if(IntPtr.Size!=8)throw new InvalidOperationException("x64 required");
      if(Marshal.SizeOf(typeof(STARTUPINFOW)) != 104)throw new InvalidOperationException("STARTUPINFOW ABI");
      if(Marshal.SizeOf(typeof(STARTUPINFOEXW)) != 112)throw new InvalidOperationException("STARTUPINFOEXW ABI");
      if(Marshal.SizeOf(typeof(PROCESS_INFORMATION)) != 24)throw new InvalidOperationException("PROCESS_INFORMATION ABI");
      if(Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)) != 24)throw new InvalidOperationException("SECURITY_ATTRIBUTES ABI");
      if(Marshal.SizeOf(typeof(FILETIME)) != 8)throw new InvalidOperationException("FILETIME ABI");
      if(Marshal.SizeOf(typeof(IO_COUNTERS)) != 48)throw new InvalidOperationException("IO_COUNTERS ABI");
      if(Marshal.SizeOf(typeof(BASIC_LIMIT)) != 64)throw new InvalidOperationException("BASIC_LIMIT ABI");
      if(Marshal.SizeOf(typeof(EXTENDED_LIMIT)) != 144)throw new InvalidOperationException("EXTENDED_LIMIT ABI");
      if(Marshal.SizeOf(typeof(ACCOUNTING)) != 48)throw new InvalidOperationException("ACCOUNTING ABI");
      if(Marshal.SizeOf(typeof(BY_HANDLE_FILE_INFORMATION)) != 52)throw new InvalidOperationException("BY_HANDLE_FILE_INFORMATION ABI");
      if(Marshal.OffsetOf(typeof(STARTUPINFOW),"cb").ToInt32()!=0||Marshal.OffsetOf(typeof(STARTUPINFOW),"lpReserved").ToInt32()!=8||Marshal.OffsetOf(typeof(STARTUPINFOW),"lpDesktop").ToInt32()!=16||Marshal.OffsetOf(typeof(STARTUPINFOW),"lpTitle").ToInt32()!=24)throw new InvalidOperationException("STARTUPINFOW header offsets ABI");
      if(Marshal.OffsetOf(typeof(STARTUPINFOW),"dwX").ToInt32()!=32||Marshal.OffsetOf(typeof(STARTUPINFOW),"dwY").ToInt32()!=36||Marshal.OffsetOf(typeof(STARTUPINFOW),"dwXSize").ToInt32()!=40||Marshal.OffsetOf(typeof(STARTUPINFOW),"dwYSize").ToInt32()!=44||Marshal.OffsetOf(typeof(STARTUPINFOW),"dwXCountChars").ToInt32()!=48||Marshal.OffsetOf(typeof(STARTUPINFOW),"dwYCountChars").ToInt32()!=52||Marshal.OffsetOf(typeof(STARTUPINFOW),"dwFillAttribute").ToInt32()!=56||Marshal.OffsetOf(typeof(STARTUPINFOW),"dwFlags").ToInt32()!=60)throw new InvalidOperationException("STARTUPINFOW DWORD offsets ABI");
      if(Marshal.OffsetOf(typeof(STARTUPINFOW),"wShowWindow").ToInt32()!=64||Marshal.OffsetOf(typeof(STARTUPINFOW),"cbReserved2").ToInt32()!=66)throw new InvalidOperationException("STARTUPINFOW WORD offsets ABI");
      if(Marshal.OffsetOf(typeof(STARTUPINFOW),"lpReserved2").ToInt32()!=72||Marshal.OffsetOf(typeof(STARTUPINFOW),"hStdInput").ToInt32()!=80||Marshal.OffsetOf(typeof(STARTUPINFOW),"hStdOutput").ToInt32()!=88||Marshal.OffsetOf(typeof(STARTUPINFOW),"hStdError").ToInt32()!=96)throw new InvalidOperationException("STARTUPINFOW handle offsets ABI");
      if(Marshal.OffsetOf(typeof(STARTUPINFOEXW),"lpAttributeList").ToInt32()!=104)throw new InvalidOperationException("STARTUPINFOEXW attribute offset ABI");
      if(Marshal.OffsetOf(typeof(FILETIME),"Low").ToInt32()!=0||Marshal.OffsetOf(typeof(FILETIME),"High").ToInt32()!=4)throw new InvalidOperationException("FILETIME offsets ABI");
      if(Marshal.OffsetOf(typeof(ACCOUNTING),"active").ToInt32()!=40)throw new InvalidOperationException("ACCOUNTING active offset ABI");
      if(Marshal.OffsetOf(typeof(BASIC_LIMIT),"flags").ToInt32()!=16||Marshal.OffsetOf(typeof(BASIC_LIMIT),"min").ToInt32()!=24||Marshal.OffsetOf(typeof(BASIC_LIMIT),"active").ToInt32()!=40||Marshal.OffsetOf(typeof(BASIC_LIMIT),"affinity").ToInt32()!=48)throw new InvalidOperationException("BASIC_LIMIT offsets ABI");
      if(Marshal.OffsetOf(typeof(EXTENDED_LIMIT),"io").ToInt32()!=64||Marshal.OffsetOf(typeof(EXTENDED_LIMIT),"processMemory").ToInt32()!=112)throw new InvalidOperationException("EXTENDED_LIMIT offsets ABI");
      if(IntPtr.Size*3!=24)throw new InvalidOperationException("HANDLE_LIST buffer ABI");
    }
    public static void AssertConsoleFree(){uint[] p=new uint[1];uint n=GetConsoleProcessList(p,1);if(n!=0||Marshal.GetLastWin32Error()!=ERROR_INVALID_HANDLE)throw new InvalidOperationException("Controller must start console-free");}
    static string Quote(string value){if(value.Length>0&&value.IndexOfAny(new[]{' ','\t','"'})<0)return value;if(value.IndexOf('"')>=0)throw new InvalidOperationException("Argument contains a quote");return "\""+value+"\"";}
    static IntPtr EnvironmentBlock(IDictionary<string,string> env){List<string> keys=new List<string>(env.Keys);keys.Sort(StringComparer.OrdinalIgnoreCase);StringBuilder b=new StringBuilder();foreach(string k in keys)b.Append(k).Append('=').Append(env[k]).Append('\0');b.Append('\0');byte[] bytes=Encoding.Unicode.GetBytes(b.ToString());IntPtr p=Marshal.AllocHGlobal(bytes.Length);Marshal.Copy(bytes,0,p,bytes.Length);return p;}
    static string Id(IntPtr h){BY_HANDLE_FILE_INFORMATION i;if(!GetFileInformationByHandle(h,out i))throw Error("GetFileInformationByHandle");return (((ulong)i.fileIndexHigh<<32)|i.fileIndexLow).ToString("x16");}
    static string Volume(IntPtr h){BY_HANDLE_FILE_INFORMATION i;if(!GetFileInformationByHandle(h,out i))throw Error("GetFileInformationByHandle");return i.volumeSerial.ToString("x8");}
    static string Image(IntPtr h){uint n=32768;StringBuilder b=new StringBuilder((int)n);if(!QueryImage(h,0,b,ref n))throw Error("QueryFullProcessImageNameW");return Path.GetFullPath(b.ToString());}
    static ulong Creation(IntPtr h){FILETIME c,e,k,u;if(!GetProcessTimes(h,out c,out e,out k,out u))throw Error("GetProcessTimes");return c.Value;}
    static uint Active(IntPtr j){ACCOUNTING a=new ACCOUNTING();if(!QueryInformationJobObject(j,JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,ref a,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero))throw Error("QueryInformationJobObject");return a.active;}
    static void CloseLocal(ref IntPtr handle,string label,List<Exception> failures){if(handle==IntPtr.Zero||handle.ToInt64()==-1){handle=IntPtr.Zero;return;}if(!CloseHandle(handle)){failures.Add(Error(label));return;}handle=IntPtr.Zero;}
    static void ReleaseLaunchLocals(ref IntPtr thread,ref IntPtr list,ref IntPtr values,ref IntPtr block,ref IntPtr input,ref IntPtr output,ref IntPtr error,ref IntPtr omitted,bool attributeListInitialized){
      List<Exception> failures=new List<Exception>();CloseLocal(ref thread,"CloseHandle launch thread",failures);CloseLocal(ref input,"CloseHandle stdin",failures);CloseLocal(ref output,"CloseHandle stdout",failures);CloseLocal(ref error,"CloseHandle stderr",failures);CloseLocal(ref omitted,"CloseHandle omitted sentinel",failures);
      if(list!=IntPtr.Zero){IntPtr owned=list;list=IntPtr.Zero;try{if(attributeListInitialized)DeleteProcThreadAttributeList(owned);}catch(Exception e){failures.Add(e);}try{Marshal.FreeHGlobal(owned);}catch(Exception e){failures.Add(e);}}
      if(values!=IntPtr.Zero){IntPtr owned=values;values=IntPtr.Zero;try{Marshal.FreeHGlobal(owned);}catch(Exception e){failures.Add(e);}}
      if(block!=IntPtr.Zero){IntPtr owned=block;block=IntPtr.Zero;try{Marshal.FreeHGlobal(owned);}catch(Exception e){failures.Add(e);}}
      if(failures.Count!=0)throw new AggregateException("Launch-local resource cleanup failed",failures);
    }
    static void AssertLaunchBudget(Stopwatch watch,uint normalRemaining,uint hardRemaining){long elapsed=watch.ElapsedMilliseconds;if(elapsed>=hardRemaining)throw new InvalidOperationException("Controller hard deadline expired before resume");if(elapsed>=normalRemaining)throw new InvalidOperationException("Controller normal deadline expired before resume");}
    public static Session Launch(string exe,string expectedSha,string expectedVolumeSerial,string expectedFileId,string[] args,string cwd,IDictionary<string,string> env,string stdout,string stderr,uint normalRemaining,uint hardRemaining){
      LastLaunchForced=false;AssertAbi();AssertConsoleFree();Stopwatch launchWatch=Stopwatch.StartNew();Session s=new Session();PROCESS_INFORMATION pi=new PROCESS_INFORMATION();IntPtr list=IntPtr.Zero,values=IntPtr.Zero,block=IntPtr.Zero,input=IntPtr.Zero,output=IntPtr.Zero,error=IntPtr.Zero,omitted=IntPtr.Zero;bool attributeListInitialized=false,assigned=false;
      try{
        s.image=new FileStream(exe,FileMode.Open,FileAccess.Read,FileShare.Read);using(SHA256 hash=SHA256.Create()){string actual=BitConverter.ToString(hash.ComputeHash(s.image)).Replace("-","").ToLowerInvariant();if(actual!=expectedSha)throw new InvalidOperationException("Candidate SHA differs");s.image.Position=0;}
        s.volumeSerial=Volume(s.image.SafeFileHandle.DangerousGetHandle());s.fileId=Id(s.image.SafeFileHandle.DangerousGetHandle());if(s.volumeSerial!=expectedVolumeSerial||s.fileId!=expectedFileId)throw new InvalidOperationException("Candidate file identity differs");
        s.job=CreateJobObject(IntPtr.Zero,null);if(s.job==IntPtr.Zero)throw Error("CreateJobObject");EXTENDED_LIMIT limit=new EXTENDED_LIMIT();limit.basic.flags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;if(!SetInformationJobObject(s.job,JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,ref limit,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))))throw Error("SetInformationJobObject");
        SECURITY_ATTRIBUTES sa=new SECURITY_ATTRIBUTES();sa.nLength=(uint)Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));sa.bInheritHandle=true;
        input=CreateFile("NUL",GENERIC_READ,FILE_SHARE_READ,ref sa,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,IntPtr.Zero);
        output=CreateFile(stdout,FILE_APPEND_DATA,FILE_SHARE_READ,ref sa,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,IntPtr.Zero);
        error=CreateFile(stderr,FILE_APPEND_DATA,FILE_SHARE_READ,ref sa,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,IntPtr.Zero);
        omitted=CreateFile("NUL",GENERIC_READ,FILE_SHARE_READ,ref sa,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,IntPtr.Zero);
        if(input.ToInt64()==-1||output.ToInt64()==-1||error.ToInt64()==-1||omitted.ToInt64()==-1)throw Error("CreateFile standard handle");
        UIntPtr size=UIntPtr.Zero;bool sizeQuery=InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);int sizeError=Marshal.GetLastWin32Error();ulong attributeBytes=size.ToUInt64();if(sizeQuery||sizeError!=(int)ERROR_INSUFFICIENT_BUFFER||attributeBytes==0||attributeBytes>MAX_ATTRIBUTE_LIST_BYTES)throw new InvalidOperationException("Attribute-list size query differs");list=Marshal.AllocHGlobal((int)attributeBytes);if(!InitializeProcThreadAttributeList(list,1,0,ref size))throw Error("InitializeProcThreadAttributeList");attributeListInitialized=true;
        IntPtr[] handles=new[]{input,output,error};values=Marshal.AllocHGlobal(IntPtr.Size*handles.Length);Marshal.Copy(handles,0,values,handles.Length);
        if(!UpdateProcThreadAttribute(list,0,(UIntPtr)PROC_THREAD_ATTRIBUTE_HANDLE_LIST,values,(UIntPtr)(IntPtr.Size*handles.Length),IntPtr.Zero,IntPtr.Zero))throw Error("UpdateProcThreadAttribute");s.HandleListConfigured=true;
        STARTUPINFOEXW si=new STARTUPINFOEXW();si.StartupInfo.cb=(uint)Marshal.SizeOf(typeof(STARTUPINFOEXW));si.StartupInfo.dwFlags=STARTF_USESHOWWINDOW|STARTF_USESTDHANDLES;si.StartupInfo.wShowWindow=SW_HIDE;si.StartupInfo.hStdInput=input;si.StartupInfo.hStdOutput=output;si.StartupInfo.hStdError=error;si.lpAttributeList=list;
        env["MYSPEED_OMITTED_INHERITABLE_HANDLE"]=omitted.ToInt64().ToString();
        StringBuilder command=new StringBuilder(Quote(exe));foreach(string a in args)command.Append(' ').Append(Quote(a));block=EnvironmentBlock(env);
        if(!CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_NEW_CONSOLE|CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT,block,cwd,ref si,out pi))throw Error("CreateProcessW");s.CandidateCreatedSuspended=true;s.PrivateConsoleRequested=true;
        s.process=pi.hProcess;s.pid=pi.dwProcessId;if(!AssignProcessToJobObject(s.job,s.process))throw Error("AssignProcessToJobObject");assigned=true;s.JobAssignedBeforeResume=true;bool member;if(!IsProcessInJob(s.process,s.job,out member)||!member)throw Error("IsProcessInJob");s.InitialJobMembership=true;
        s.creation=Creation(s.process);s.imagePath=Image(s.process);if(!String.Equals(Path.GetFullPath(exe),s.imagePath,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Candidate image differs");s.CandidateIdentityCaptured=true;AssertLaunchBudget(launchWatch,normalRemaining,hardRemaining);
        if(ResumeThread(pi.hThread)==UInt32.MaxValue)throw Error("ResumeThread");s.CandidateResumed=true;ReleaseLaunchLocals(ref pi.hThread,ref list,ref values,ref block,ref input,ref output,ref error,ref omitted,attributeListInitialized);s.ThreadHandleClosedBeforeReady=true;return s;
      }catch(Exception primary){List<Exception> failures=new List<Exception>();failures.Add(primary);try{ReleaseLaunchLocals(ref pi.hThread,ref list,ref values,ref block,ref input,ref output,ref error,ref omitted,attributeListInitialized);}catch(Exception cleanup){failures.Add(cleanup);}try{if(pi.hProcess!=IntPtr.Zero){LastLaunchForced=true;long available=(long)hardRemaining-launchWatch.ElapsedMilliseconds;uint cleanupTimeout=(uint)Math.Max(0,Math.Min((long)NATIVE_CLEANUP_TIMEOUT_MS,available));Stopwatch cleanupWatch=Stopwatch.StartNew();if(!assigned){if(!TerminateProcess(pi.hProcess,LAUNCH_FAILURE_EXIT_CODE))throw Error("TerminateProcess retained process");if(WaitForSingleObject(pi.hProcess,cleanupTimeout)!=WAIT_OBJECT_0)throw new InvalidOperationException("Retained process cleanup deadline expired");}else{if(!TerminateJobObject(s.job,LAUNCH_FAILURE_EXIT_CODE))throw Error("TerminateJobObject launch cleanup");if(WaitForSingleObject(pi.hProcess,cleanupTimeout)!=WAIT_OBJECT_0)throw new InvalidOperationException("Owned process cleanup deadline expired");while(Active(s.job)!=0&&cleanupWatch.ElapsedMilliseconds<cleanupTimeout)System.Threading.Thread.Sleep((int)NATIVE_CLEANUP_POLL_MS);if(Active(s.job)!=0)throw new InvalidOperationException("Owned Job launch cleanup deadline expired");}}}catch(Exception cleanup){failures.Add(cleanup);}try{s.Dispose();}catch(Exception cleanup){failures.Add(cleanup);}if(failures.Count!=1)throw new AggregateException(failures);throw;}
    }
    public uint Pid {get{return pid;}} public ulong CreationTime {get{return creation;}} public string ImagePath {get{return imagePath;}} public string VolumeSerial {get{return volumeSerial;}} public string FileId {get{return fileId;}}
    public bool CandidateCreatedSuspended {get;private set;} public bool PrivateConsoleRequested {get;private set;} public bool HandleListConfigured {get;private set;} public bool JobAssignedBeforeResume {get;private set;} public bool InitialJobMembership {get;private set;} public bool CandidateIdentityCaptured {get;private set;} public bool CandidateResumed {get;private set;} public bool ThreadHandleClosedBeforeReady {get;private set;}
    bool Identity(){bool member;return process!=IntPtr.Zero&&WaitForSingleObject(process,0)==WAIT_TIMEOUT&&GetProcessId(process)==pid&&Creation(process)==creation&&String.Equals(Image(process),imagePath,StringComparison.OrdinalIgnoreCase)&&IsProcessInJob(process,job,out member)&&member&&Volume(image.SafeFileHandle.DangerousGetHandle())==volumeSerial&&Id(image.SafeFileHandle.DangerousGetHandle())==fileId;}
    static uint[] ConsoleIds(){uint[] p=new uint[2];uint n=GetConsoleProcessList(p,(uint)p.Length);if(n>p.Length){p=new uint[n];n=GetConsoleProcessList(p,(uint)p.Length);}if(n==0)throw Error("GetConsoleProcessList");Array.Resize(ref p,(int)n);Array.Sort(p);return p;}
    static uint RemainingBudget(uint budget,Stopwatch watch){long available=(long)budget-watch.ElapsedMilliseconds;return (uint)Math.Max(0,available);}
    static uint RemainingCleanup(uint hardRemaining,Stopwatch watch){return Math.Min(NATIVE_CLEANUP_TIMEOUT_MS,RemainingBudget(hardRemaining,watch));}
    public NativeResult Stop(uint expectedControllerPid,uint grace,uint hardRemaining){
      NativeResult r=NewResult();
      LastResult=r;StopCleanupAttempted=false;Stopwatch stopWatch=Stopwatch.StartNew();
      try{
        r.preAttachIdentityMatch=Identity();if(!r.preAttachIdentityMatch)throw new InvalidOperationException("Pre-attach identity differs");
        if(!AttachConsole(pid))throw Error("AttachConsole");
        try{
          if(!SetConsoleCtrlHandler(IntPtr.Zero,true))throw Error("SetConsoleCtrlHandler");
          r.postAttachHandleUnsignaled=WaitForSingleObject(process,0)==WAIT_TIMEOUT;
          r.postAttachIdentityMatch=Identity();bool member;r.postAttachJobMembership=IsProcessInJob(process,job,out member)&&member;
          uint[] ids=ConsoleIds();r.consoleProcessIds=ids;r.consoleProcessIdsExact=ids.Length==2&&ids[0]==Math.Min(expectedControllerPid,pid)&&ids[1]==Math.Max(expectedControllerPid,pid);
          if(!r.postAttachHandleUnsignaled||!r.postAttachIdentityMatch||!r.postAttachJobMembership||!r.consoleProcessIdsExact)throw new InvalidOperationException("Post-attach proof differs");
          r.ctrlEventGenerated=GenerateConsoleCtrlEvent(CTRL_C_EVENT,0);if(!r.ctrlEventGenerated)throw Error("GenerateConsoleCtrlEvent");
        }finally{if(!FreeConsole())throw Error("FreeConsole");r.consoleFreeAfter=true;AssertConsoleFree();}
        r.candidateExited=WaitForSingleObject(process,RemainingBudget(grace,stopWatch))==WAIT_OBJECT_0;r.graceExpired=!r.candidateExited;
        if(r.candidateExited){uint code;if(!GetExitCodeProcess(process,out code))throw Error("GetExitCodeProcess");r.exitCode=unchecked((int)code);}
        r.jobZero=Active(job)==0;
        if(!r.candidateExited||!r.jobZero){r.forced=true;StopCleanupAttempted=true;Force(RemainingCleanup(hardRemaining,stopWatch));r.jobZero=Active(job)==0;}
        return r;
      }catch{r.forced=true;if(!StopCleanupAttempted&&Active(job)!=0){StopCleanupAttempted=true;Force(RemainingCleanup(hardRemaining,stopWatch));}throw;}
    }
    public void Force(uint timeout){if(job==IntPtr.Zero)return;if(!TerminateJobObject(job,STOP_FAILURE_EXIT_CODE))throw Error("TerminateJobObject");Stopwatch watch=Stopwatch.StartNew();while(Active(job)!=0&&watch.ElapsedMilliseconds<timeout)System.Threading.Thread.Sleep((int)NATIVE_CLEANUP_POLL_MS);if(Active(job)!=0)throw new InvalidOperationException("Owned Job did not empty");NativeResult observed=ObserveExitedResult(true);if(!observed.jobZero)throw new InvalidOperationException("Owned Job cleanup proof differs");}
    public uint ActiveProcesses {get{return job==IntPtr.Zero?0:Active(job);}}
    public bool CloseAndProve(){bool ok=true;if(process!=IntPtr.Zero){ok=CloseHandle(process)&&ok;process=IntPtr.Zero;}if(job!=IntPtr.Zero){ok=CloseHandle(job)&&ok;job=IntPtr.Zero;}if(image!=null){SafeFileHandle held=image.SafeFileHandle;image.Dispose();ok=held.IsClosed&&ok;image=null;}return ok;}
    public void Dispose(){if(!CloseAndProve())throw new InvalidOperationException("Session handle cleanup failed");}
  }
}
'@
}

function Test-MyspeedCleanLifecyclePass {
    param([object]$Proof,[int64]$ElapsedMs,[int]$FailureCount)
    return $FailureCount -eq 0 -and $ElapsedMs -le $script:CONTROLLER_NORMAL_DEADLINE_MS -and
        -not $Proof.forced -and $Proof.controllerInitiallyConsoleFree -and $Proof.candidateCreatedSuspended -and
        $Proof.privateConsoleRequested -and $Proof.handleListConfigured -and $Proof.jobAssignedBeforeResume -and
        $Proof.initialJobMembership -and $Proof.candidateIdentityCaptured -and $Proof.candidateResumed -and
        $Proof.threadHandleClosedBeforeReady -and $Proof.preAttachIdentityMatch -and
        $Proof.postAttachHandleUnsignaled -and $Proof.postAttachIdentityMatch -and $Proof.postAttachJobMembership -and
        $Proof.consoleProcessIdsExact -and $Proof.ctrlEventGenerated -and $Proof.candidateExited -and
        $Proof.exitCode -eq 0 -and $Proof.jobActiveProcesses -eq 0 -and $Proof.consoleFreeAfter -and $Proof.handlesClosed
}

function Invoke-MyspeedCleanLifecycleCore {
    param([object]$Request,[string]$RequestSha,[string]$AbiSha,[object]$Operations)
    [void](Assert-MyspeedCleanString $RequestSha 'Lifecycle request SHA' '^[0-9a-f]{64}$')
    [void](Assert-MyspeedCleanString $AbiSha 'Lifecycle ABI SHA' '^[0-9a-f]{64}$')
    Assert-MyspeedCleanExactKeys $Operations @('record','elapsed','assertConsoleFree','launch','launchForced','writeReady',
        'stdoutReadinessExists','readStdoutReadiness','stopExists','sleep','readStop','stop','lastResult','cleanupAttempted','active','force','close') 'Lifecycle operations'
    $failures=[Collections.Generic.List[object]]::new()
    $session=$null;$native=$null;$stdoutReadinessLoaded=$null;$stopLoaded=$null;$readySha=$null;$stopDeadline=$null;$forced=$false;$handlesClosed=$false;$jobActive=$null
    $controllerInitiallyConsoleFree=$false;$controllerConsoleFreeAfter=$false
    try{
        & $Operations.record 'assertConsoleFree';& $Operations.assertConsoleFree;$controllerInitiallyConsoleFree=$true
        $beforeLaunch=& $Operations.elapsed
        if($beforeLaunch -ge $script:CONTROLLER_NORMAL_DEADLINE_MS){throw 'Controller normal deadline expired before launch'}
        $normalRemaining=$script:CONTROLLER_NORMAL_DEADLINE_MS-$beforeLaunch
        $launchRemaining=$script:CONTROLLER_HARD_DEADLINE_MS-$beforeLaunch
        if($launchRemaining -le 0){throw 'Controller hard deadline expired before launch'}
        $session=& $Operations.launch $Request ([uint32]$normalRemaining) ([uint32]$launchRemaining)
        $afterLaunch=& $Operations.elapsed
        if($afterLaunch -ge $script:CONTROLLER_NORMAL_DEADLINE_MS){throw 'Controller normal deadline expired after launch'}
        $ready=[pscustomobject][ordered]@{schemaVersion=1;kind='myspeed-windows-clean-stop-ready'
            manifestSha256=$Request.manifestSha256;caseId=$Request.caseId;requestSha256=$RequestSha;abiSha256=$AbiSha
            candidatePid=[int64]$session.Pid
            candidateCreationTime=$session.CreationTime.ToString('x16');candidateImagePath=$session.ImagePath
            candidateSha256=$Request.candidateSha256;candidateVolumeSerial=$session.VolumeSerial
            candidateFileId=$session.FileId;controllerInitiallyConsoleFree=$true
            candidateCreatedSuspended=$session.CandidateCreatedSuspended;privateConsoleRequested=$session.PrivateConsoleRequested
            handleListConfigured=$session.HandleListConfigured;jobAssignedBeforeResume=$session.JobAssignedBeforeResume
            initialJobMembership=$session.InitialJobMembership;candidateIdentityCaptured=$session.CandidateIdentityCaptured
            candidateResumed=$session.CandidateResumed;threadHandleClosedBeforeReady=$session.ThreadHandleClosedBeforeReady
            qualifying=$false}
        & $Operations.record 'writeReady';$readySha=& $Operations.writeReady $ready
        $stopDeadline=[Math]::Min($script:CONTROLLER_NORMAL_DEADLINE_MS,
            (& $Operations.elapsed)+$script:STOP_REQUEST_TIMEOUT_MS)
        & $Operations.record 'awaitStdoutReadiness'
        while($true){
            $now=& $Operations.elapsed;$sleep=Get-MyspeedCleanStopPollMilliseconds $now $stopDeadline
            if(& $Operations.stdoutReadinessExists){break};& $Operations.sleep $sleep
        }
        & $Operations.record 'validateStdoutReadiness';$stdoutReadinessLoaded=& $Operations.readStdoutReadiness
        [void](Assert-MyspeedCleanStdoutReadiness $Request $RequestSha $AbiSha $readySha $stdoutReadinessLoaded.value)
        & $Operations.record 'awaitStopRequest'
        while($true){
            $now=& $Operations.elapsed
            $sleep=Get-MyspeedCleanStopPollMilliseconds $now $stopDeadline
            if(& $Operations.stopExists){break}
            & $Operations.sleep $sleep
        }
        & $Operations.record 'validateStopRequest';$stopLoaded=& $Operations.readStop
        [void](Assert-MyspeedCleanStopRequest $Request $RequestSha $AbiSha $readySha $stopLoaded.value)
        if($stopLoaded.value.stdoutReadinessSha256 -cne $stdoutReadinessLoaded.sha256){throw 'Stop request stdout readiness binding differs'}
        if((& $Operations.elapsed) -ge $stopDeadline){throw 'Stop request deadline expired during validation'}
        if($stopLoaded.value.candidatePid -ne $session.Pid -or
            $stopLoaded.value.candidateCreationTime -cne $session.CreationTime.ToString('x16')){
            throw 'Stop request retained-handle identity differs'
        }
        $remaining=$script:CONTROLLER_NORMAL_DEADLINE_MS-(& $Operations.elapsed)
        if($remaining -le 0){throw 'Controller normal deadline expired before stop'}
        $grace=[Math]::Min($script:GRACEFUL_EXIT_TIMEOUT_MS,$remaining)
        $remainingHard=$script:CONTROLLER_HARD_DEADLINE_MS-(& $Operations.elapsed)
        if($remainingHard -le 0){throw 'Controller hard deadline expired before stop'}
        $native=& $Operations.stop $session ([uint32]$grace) ([uint32]$remainingHard)
        $forced=$native.forced
    }catch{
        [void]$failures.Add($_.Exception.Message)
        if($null -eq $session){$forced=[bool](& $Operations.launchForced)}
        if($null -ne $session){
            if($null -eq $native){try{$native=& $Operations.lastResult $session}catch{[void]$failures.Add("Last-result observation failed: $($_.Exception.Message)")}}
            try{
                if((& $Operations.active $session) -ne 0){
                    $remainingHard=$script:CONTROLLER_HARD_DEADLINE_MS-(& $Operations.elapsed)
                    if($remainingHard -le 0){throw 'Controller hard deadline expired before cleanup'}
                    if(& $Operations.cleanupAttempted $session){throw 'Owned Job cleanup was already attempted and remains unproven'}
                    $forced=$true;& $Operations.force $session ([uint32][Math]::Min($script:FORCED_CLEANUP_TIMEOUT_MS,$remainingHard))
                    $native=& $Operations.lastResult $session
                    if($null -eq $native -or -not $native.candidateExited){throw 'Retained candidate exit proof is absent after cleanup'}
                }
            }catch{[void]$failures.Add("Owned Job cleanup failed: $($_.Exception.Message)")}
        }
    }finally{
        if($null -ne $session){
            try{$jobActive=[int64](& $Operations.active $session)}catch{[void]$failures.Add("Job accounting failed: $($_.Exception.Message)")}
            try{& $Operations.assertConsoleFree;$controllerConsoleFreeAfter=$true}catch{[void]$failures.Add("Final console-free proof failed: $($_.Exception.Message)")}
            try{& $Operations.record 'closeResources';$handlesClosed=[bool](& $Operations.close $session)}catch{$handlesClosed=$false;[void]$failures.Add("Handle cleanup failed: $($_.Exception.Message)")}
        }
    }
    $elapsed=[int64](& $Operations.elapsed)
    if($elapsed -gt $script:CONTROLLER_HARD_DEADLINE_MS){[void]$failures.Add('Controller hard deadline expired')}
    if($null -ne $native){$forced=$forced -or $native.forced}
    return [pscustomobject]@{session=$session;native=$native;stdoutReadinessLoaded=$stdoutReadinessLoaded;stopLoaded=$stopLoaded;readySha256=$readySha
        controllerInitiallyConsoleFree=$controllerInitiallyConsoleFree;forced=$forced;handlesClosed=$handlesClosed
        consoleFreeAfter=$controllerConsoleFreeAfter;jobActiveProcesses=$jobActive;stopRequestDeadlineMs=$stopDeadline;elapsedMs=$elapsed;failures=@($failures)}
}

function Invoke-MyspeedCleanInjectedLifecycle {
    param([object]$InputValue)
    Assert-MyspeedCleanExactKeys $InputValue @('failAt','clock','launch','stopRequest','stopAvailable','candidateExitCode','consoleProcessIds') 'Injected lifecycle'
    if($null -ne $InputValue.failAt -and ($InputValue.failAt -isnot [string] -or $script:LifecyclePhases -cnotcontains $InputValue.failAt)){throw 'Injected failure phase differs'}
    $clock=Assert-MyspeedCleanArray $InputValue.clock 'Injected clock';if($clock.Count -ne $script:LifecyclePhases.Count){throw 'Injected clock sample count differs'}
    $previous=-1L;foreach($sample in $clock){$current=Assert-MyspeedCleanInteger $sample 'Injected clock sample' 0 ($script:CONTROLLER_HARD_DEADLINE_MS+1);if($current -lt $previous){throw 'Injected clock is not monotonic'};$previous=$current}
    Assert-MyspeedCleanExactKeys $InputValue.launch @('candidatePid','candidateCreationTime','candidateImagePath','candidateSha256','candidateVolumeSerial','candidateFileId') 'Injected launch'
    [void](Assert-MyspeedCleanInteger $InputValue.launch.candidatePid 'Injected launch PID' 1 4294967295)
    [void](Assert-MyspeedCleanString $InputValue.launch.candidateCreationTime 'Injected launch creation time' '^[0-9a-f]{16}$')
    [void](Assert-MyspeedCleanPath $InputValue.launch.candidateImagePath 'Injected launch image path')
    [void](Assert-MyspeedCleanString $InputValue.launch.candidateSha256 'Injected launch SHA' '^[0-9a-f]{64}$')
    [void](Assert-MyspeedCleanString $InputValue.launch.candidateVolumeSerial 'Injected launch volume serial' '^[0-9a-f]{8}$')
    [void](Assert-MyspeedCleanString $InputValue.launch.candidateFileId 'Injected launch file ID' '^[0-9a-f]{16}$')
    [void](Assert-MyspeedCleanInteger $InputValue.candidateExitCode 'Injected candidate exit code' -2147483648 2147483647)
    $launchRequest=[pscustomobject]@{schemaVersion=1;kind=$script:LaunchKind;expectedRunId=$InputValue.stopRequest.expectedRunId
        expectedRunAttempt=$InputValue.stopRequest.expectedRunAttempt;expectedEventSha=$InputValue.stopRequest.expectedEventSha
        expectedSourceSha=('b'*40);expectedImageVersion='test';nonce=$InputValue.stopRequest.nonce
        manifestSha256=('9'*64);caseId='handler'
        taskRoot=[IO.Path]::GetDirectoryName($InputValue.launch.candidateImagePath);candidatePath=$InputValue.launch.candidateImagePath
        candidateSha256=$InputValue.launch.candidateSha256;candidateVolumeSerial=$InputValue.launch.candidateVolumeSerial;candidateFileId=$InputValue.launch.candidateFileId
        workingDirectory=[IO.Path]::GetDirectoryName($InputValue.launch.candidateImagePath);arguments=@('handler')
        environment=[pscustomobject]@{MYSPEED_CLEAN_STOP_FIXTURE_MODE='handler';MYSPEED_CLEAN_STOP_NONCE=$InputValue.stopRequest.nonce}
        stdoutPath=([IO.Path]::Combine([IO.Path]::GetDirectoryName($InputValue.launch.candidateImagePath),'stdout.log'));stderrPath=([IO.Path]::Combine([IO.Path]::GetDirectoryName($InputValue.launch.candidateImagePath),'stderr.log'));abiPath=([IO.Path]::Combine([IO.Path]::GetDirectoryName($InputValue.launch.candidateImagePath),'abi.json'))
        readyPath=([IO.Path]::Combine([IO.Path]::GetDirectoryName($InputValue.launch.candidateImagePath),'ready.json'));stdoutReadinessPath=([IO.Path]::Combine([IO.Path]::GetDirectoryName($InputValue.launch.candidateImagePath),'stdout.readiness.json'));stopRequestPath=([IO.Path]::Combine([IO.Path]::GetDirectoryName($InputValue.launch.candidateImagePath),'stop.request.json'));resultPath=([IO.Path]::Combine([IO.Path]::GetDirectoryName($InputValue.launch.candidateImagePath),'result.json'))
        controllerNormalDeadlineMs=$script:CONTROLLER_NORMAL_DEADLINE_MS;controllerHardDeadlineMs=$script:CONTROLLER_HARD_DEADLINE_MS;stopRequestTimeoutMs=$script:STOP_REQUEST_TIMEOUT_MS;stopRequestPollMs=$script:STOP_REQUEST_POLL_MS;gracefulExitTimeoutMs=$script:GRACEFUL_EXIT_TIMEOUT_MS;forcedCleanupTimeoutMs=$script:FORCED_CLEANUP_TIMEOUT_MS}
    [void](Assert-MyspeedCleanLaunchRequest $launchRequest)
    [void](Assert-MyspeedCleanBoolean $InputValue.stopAvailable 'Injected stop availability')
    $events=[Collections.Generic.List[string]]::new();$simState=[pscustomobject]@{active=1;lastResult=$null;clockIndex=0;launchForced=$false;consoleProcessIds=@()}
    $record={param($phase)[void]$events.Add($phase);if($InputValue.failAt -is [string] -and $InputValue.failAt -ceq $phase){if($phase -ceq 'awaitStopRequest'){throw 'Stop request deadline expired'};throw "Injected $phase failure"}}.GetNewClosure()
    $elapsed={if($simState.clockIndex -ge $clock.Count){return [int64]$clock[$clock.Count-1]};$value=[int64]$clock[$simState.clockIndex];$simState.clockIndex++;return $value}.GetNewClosure()
    $launch={param($request,$normalRemaining,$hardRemaining)$created=$false;$assigned=$false;try{foreach($phase in @('openCandidateAndJob','createStandardHandles','queryAttributeList','initializeAttributeList','updateHandleList','launchSuspended','assignJob','captureIdentity','resume')){& $record $phase;if($phase -ceq 'launchSuspended'){$created=$true};if($phase -ceq 'assignJob'){$assigned=$true}}}catch{$simState.launchForced=$created;if($created -and -not $assigned){[void]$events.Add('terminateRetainedProcess');[void]$events.Add('waitRetainedProcess')}elseif($assigned){[void]$events.Add('terminateOwnedJob');[void]$events.Add('proveJobZero')};throw};$simState.active=1;return [pscustomobject]@{Pid=[uint32]$InputValue.launch.candidatePid;CreationTime=[uint64]('0x'+$InputValue.launch.candidateCreationTime);ImagePath=$InputValue.launch.candidateImagePath;VolumeSerial=$InputValue.launch.candidateVolumeSerial;FileId=$InputValue.launch.candidateFileId;CandidateCreatedSuspended=$true;PrivateConsoleRequested=$true;HandleListConfigured=$true;JobAssignedBeforeResume=$true;InitialJobMembership=$true;CandidateIdentityCaptured=$true;CandidateResumed=$true;ThreadHandleClosedBeforeReady=$true}}.GetNewClosure()
    $stop={param($session,$grace,$cleanup)foreach($phase in @('attachConsole','installIgnoreHandler','revalidateHandle','proveConsoleMembers','generateCtrlC','freeConsole','proveConsoleFree','waitCandidateExit','proveJobZero')){& $record $phase;if($phase -ceq 'proveConsoleMembers'){$ids=Assert-MyspeedCleanArray $InputValue.consoleProcessIds 'Injected console process IDs';$simState.consoleProcessIds=@($ids);if($ids.Count -ne 2 -or (Assert-MyspeedCleanInteger $ids[0] 'Injected controller console PID' 1 4294967295) -ne 4000 -or (Assert-MyspeedCleanInteger $ids[1] 'Injected candidate console PID' 1 4294967295) -ne $session.Pid){throw 'Injected console process IDs differ'}}};$exit=Assert-MyspeedCleanInteger $InputValue.candidateExitCode 'Injected candidate exit code' -2147483648 2147483647;$simState.active=0;$simState.lastResult=[pscustomobject]@{forced=$false;preAttachIdentityMatch=$true;postAttachHandleUnsignaled=$true;postAttachIdentityMatch=$true;postAttachJobMembership=$true;consoleProcessIds=@($simState.consoleProcessIds);consoleProcessIdsExact=$true;ctrlEventGenerated=$true;candidateExited=$true;graceExpired=$false;exitCode=$exit;jobZero=$true;consoleFreeAfter=$true};return $simState.lastResult}.GetNewClosure()
    $stdoutReadiness=[pscustomobject][ordered]@{schemaVersion=1;kind=$script:StdoutReadinessKind;manifestSha256=('9'*64);caseId='handler'
        launchRequestSha256=('d'*64);abiSha256=('8'*64);readySha256=('f'*64);stdoutSha256=('6'*64)
        marker=$script:FixtureReadyMarker;observedMonotonicMs=20}
    $operations=[pscustomobject]@{record=$record;elapsed=$elapsed;assertConsoleFree={};launch=$launch;launchForced={return $simState.launchForced}.GetNewClosure()
        writeReady={param($ready) return ('f'*64)};stdoutReadinessExists={return $true};readStdoutReadiness={return [pscustomobject]@{value=$stdoutReadiness;sha256=('7'*64)}}.GetNewClosure()
        stopExists={return $InputValue.stopAvailable}.GetNewClosure();sleep={param($milliseconds)}
        readStop={return [pscustomobject]@{value=$InputValue.stopRequest;sha256=('e'*64)}}.GetNewClosure();stop=$stop
        lastResult={param($session)return $simState.lastResult}.GetNewClosure();cleanupAttempted={param($session)return $false};active={param($session)return $simState.active}.GetNewClosure()
        force={param($session,$timeout)$simState.active=0;$simState.lastResult=[pscustomobject]@{forced=$true;preAttachIdentityMatch=$false;postAttachHandleUnsignaled=$false;postAttachIdentityMatch=$false;postAttachJobMembership=$false;consoleProcessIds=@($simState.consoleProcessIds);consoleProcessIdsExact=$false;ctrlEventGenerated=$false;candidateExited=$true;graceExpired=$false;exitCode=197;jobZero=$true;consoleFreeAfter=$true};[void]$events.Add('terminateOwnedJob');[void]$events.Add('proveJobZero')}.GetNewClosure()
        close={param($session)return $true}}
    $state=Invoke-MyspeedCleanLifecycleCore $launchRequest ('d'*64) ('8'*64) $operations
    $proof=[pscustomobject]@{forced=$state.forced;controllerInitiallyConsoleFree=$state.controllerInitiallyConsoleFree;candidateCreatedSuspended=$true;privateConsoleRequested=$true;handleListConfigured=$true;jobAssignedBeforeResume=$true;initialJobMembership=$true;candidateIdentityCaptured=$true;candidateResumed=$true;threadHandleClosedBeforeReady=$true;preAttachIdentityMatch=($null -ne $state.native -and $state.native.preAttachIdentityMatch);postAttachHandleUnsignaled=($null -ne $state.native -and $state.native.postAttachHandleUnsignaled);postAttachIdentityMatch=($null -ne $state.native -and $state.native.postAttachIdentityMatch);postAttachJobMembership=($null -ne $state.native -and $state.native.postAttachJobMembership);consoleProcessIdsExact=($null -ne $state.native -and $state.native.consoleProcessIdsExact);ctrlEventGenerated=($null -ne $state.native -and $state.native.ctrlEventGenerated);candidateExited=($null -ne $state.native -and $state.native.candidateExited);exitCode=if($null -eq $state.native){$null}else{$state.native.exitCode};jobActiveProcesses=$state.jobActiveProcesses;consoleFreeAfter=$state.consoleFreeAfter;handlesClosed=$state.handlesClosed}
    $passed=$null -ne $state.native -and (Test-MyspeedCleanLifecyclePass $proof $state.elapsedMs $state.failures.Count)
    return [pscustomobject][ordered]@{schemaVersion=1;kind=$script:ResultKind;status=if($passed){'completed'}else{'failed'};qualifying=$false;controllerLifecyclePassed=$passed;controllerInitiallyConsoleFree=$state.controllerInitiallyConsoleFree;handlesClosed=$state.handlesClosed;forced=$state.forced;candidateExited=($null -ne $state.native -and $state.native.candidateExited);exitCode=if($null -eq $state.native -or -not $state.native.candidateExited){$null}else{$state.native.exitCode};jobActiveProcesses=$state.jobActiveProcesses;events=@($events);failures=@($state.failures)}
}

function Assert-MyspeedCleanHostedContext {
    param([string]$RunId,[string]$RunAttempt,[string]$EventSha,[string]$SourceSha,
        [string]$ImageVersion,[string]$ExpectedNonce)
    $expected=@{GITHUB_ACTIONS='true';CI='true';GITHUB_REPOSITORY=$script:Repository;RUNNER_OS='Windows'
        RUNNER_ARCH='X64';RUNNER_ENVIRONMENT='github-hosted';ImageOS=$script:ImageOS;GITHUB_RUN_ID=$RunId
        GITHUB_RUN_ATTEMPT=$RunAttempt;GITHUB_SHA=$EventSha;ImageVersion=$ImageVersion}
    foreach($entry in $expected.GetEnumerator()){
        $actual=[Environment]::GetEnvironmentVariable($entry.Key)
        if($actual -cne $entry.Value){throw "Hosted context $($entry.Key) differs"}
    }
    [void](Assert-MyspeedCleanString $SourceSha 'Hosted context source SHA' '^[0-9a-f]{40}$')
    [void](Assert-MyspeedCleanString $ExpectedNonce 'Hosted context nonce' '^[0-9a-f]{32}$')
    if(-not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -cne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5){
        throw 'Hosted context requires x64 inbox Windows PowerShell 5.1'
    }
    $expectedHost=[IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
    $actualHost=[IO.Path]::GetFullPath([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
    if($actualHost -ine $expectedHost){throw 'Hosted context PowerShell path differs'}
}

function Read-MyspeedCleanBoundedJson {
    param([string]$Path,[string]$ExpectedSha)
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
    try{
        if($stream.Length -lt 2 -or $stream.Length -gt $script:MaximumJsonBytes){throw 'JSON file size is outside its bound'}
        $bytes=New-Object byte[] ([int]$stream.Length);$offset=0
        while($offset -lt $bytes.Length){$read=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($read -eq 0){throw 'JSON file read was short'};$offset+=$read}
    }finally{$stream.Dispose()}
    $hash=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-','').ToLowerInvariant()
    if($ExpectedSha -and $hash -cne $ExpectedSha){throw 'JSON file SHA differs'}
    $utf8=[Text.UTF8Encoding]::new($false,$true)
    return [pscustomobject]@{value=ConvertFrom-MyspeedCleanJson ($utf8.GetString($bytes)) 'Bounded';sha256=$hash}
}

function Write-MyspeedCleanCreateNewJson {
    param([string]$Path,[object]$Value)
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 20 -Compress))
    if($bytes.Length -gt $script:MaximumJsonBytes){throw 'Result JSON exceeds its bound'}
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
    return [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-','').ToLowerInvariant()
}

function Write-MyspeedCleanEntryFailure {
    param([string]$Path,[string]$Message)
    $messageBytes=[Text.UTF8Encoding]::new($false).GetBytes($Message)
    $take=[Math]::Min($script:MaximumEntryFailurePrefixBytes,$messageBytes.Length);$prefix=New-Object byte[] $take
    if($take -gt 0){[Array]::Copy($messageBytes,$prefix,$take)}
    $record=[pscustomobject][ordered]@{schemaVersion=1;kind='myspeed-windows-clean-stop-controller-entry-failure'
        stage='controller-entry';messageBytes=$messageBytes.Length;messagePrefixBase64=[Convert]::ToBase64String($prefix)}
    [void](Write-MyspeedCleanCreateNewJson $Path $record)
    return $record
}

function Invoke-MyspeedHostedCleanStopController {
    param([string]$RequestPath,[string]$RequestSha,[string]$RunId,[string]$RunAttempt,
        [string]$EventSha,[string]$SourceSha,[string]$ImageVersion,[string]$ExpectedNonce)
    $watch=[Diagnostics.Stopwatch]::StartNew()
    # This guard must remain before request I/O, Add-Type, file creation, or native calls.
    Assert-MyspeedCleanHostedContext $RunId $RunAttempt $EventSha $SourceSha $ImageVersion $ExpectedNonce
    $canonicalRequestPath=Assert-MyspeedCleanPath $RequestPath 'Launch request path'
    Assert-MyspeedCleanPhysicalPath $canonicalRequestPath 'Launch request path' 'File'
    $loaded=Read-MyspeedCleanBoundedJson $canonicalRequestPath $RequestSha
    $request=$loaded.value;[void](Assert-MyspeedCleanLaunchRequest $request)
    foreach($binding in @{expectedRunId=$RunId;expectedRunAttempt=$RunAttempt;expectedEventSha=$EventSha
        expectedSourceSha=$SourceSha;expectedImageVersion=$ImageVersion;nonce=$ExpectedNonce}.GetEnumerator()){
        if($request.($binding.Key) -cne $binding.Value){throw 'Native launch identity differs'}
    }
    Assert-MyspeedCleanPhysicalLaunchPaths $request
    $entryDiagnosticPath=$request.resultPath+'.entry-failure.json'
    Assert-MyspeedCleanDescendant $request.taskRoot $entryDiagnosticPath 'Controller entry diagnostic path'
    Assert-MyspeedCleanPhysicalPath $entryDiagnosticPath 'Controller entry diagnostic path' 'Absent'
    try{
    Add-Type -TypeDefinition (Get-MyspeedCleanNativeSource) -Language CSharp
    [MySpeed.Qualification.CleanStop.Session]::AssertConsoleFree()
    $rawAbi=[MySpeed.Qualification.CleanStop.Session]::ObserveAbi();$observedAbi=[ordered]@{}
    foreach($name in $script:AbiExpected.Keys){
        if(-not $rawAbi.ContainsKey($name)){throw 'Native ABI observation keys differ'}
        $observedAbi[$name]=[int64]$rawAbi[$name]
    }
    if($rawAbi.Count -ne $observedAbi.Count){throw 'Native ABI observation keys differ'}
    $abi=New-MyspeedCleanAbiObservation ([pscustomobject]$observedAbi)
    $abiSha=Write-MyspeedCleanCreateNewJson $request.abiPath $abi
    if(-not $abi.matched){throw 'Native ABI differs from the reviewed x64 contract'}
    $physical=${function:Assert-MyspeedCleanPhysicalPath};$readJson=${function:Read-MyspeedCleanBoundedJson};$writeJson=${function:Write-MyspeedCleanCreateNewJson}
    $events=[Collections.Generic.List[string]]::new()
    $operations=[pscustomobject]@{
        record={param($phase)[void]$events.Add($phase)}.GetNewClosure()
        elapsed={return [int64]$watch.ElapsedMilliseconds}.GetNewClosure()
        assertConsoleFree={[MySpeed.Qualification.CleanStop.Session]::AssertConsoleFree()}
        launch={param($launchRequest,$normalRemaining,$hardRemaining)$environment=@{};foreach($property in $launchRequest.environment.PSObject.Properties){$environment[$property.Name]=[string]$property.Value};return [MySpeed.Qualification.CleanStop.Session]::Launch($launchRequest.candidatePath,$launchRequest.candidateSha256,$launchRequest.candidateVolumeSerial,$launchRequest.candidateFileId,[string[]]$launchRequest.arguments,$launchRequest.workingDirectory,$environment,$launchRequest.stdoutPath,$launchRequest.stderrPath,[uint32]$normalRemaining,[uint32]$hardRemaining)}
        launchForced={return [MySpeed.Qualification.CleanStop.Session]::LastLaunchForced}
        writeReady={param($ready)return & $writeJson $request.readyPath $ready}.GetNewClosure()
        stdoutReadinessExists={return Test-Path -LiteralPath $request.stdoutReadinessPath -PathType Leaf}.GetNewClosure()
        readStdoutReadiness={& $physical $request.stdoutReadinessPath 'Stdout readiness path' 'File';return & $readJson $request.stdoutReadinessPath ''}.GetNewClosure()
        stopExists={return Test-Path -LiteralPath $request.stopRequestPath -PathType Leaf}.GetNewClosure()
        sleep={param($milliseconds)Start-Sleep -Milliseconds $milliseconds}
        readStop={& $physical $request.stopRequestPath 'Stop request path' 'File';return & $readJson $request.stopRequestPath ''}.GetNewClosure()
        stop={param($candidateSession,$grace,$cleanup)return $candidateSession.Stop([uint32]$PID,[uint32]$grace,[uint32]$cleanup)}
        lastResult={param($candidateSession)return $candidateSession.LastResult}
        cleanupAttempted={param($candidateSession)return $candidateSession.StopCleanupAttempted}
        active={param($candidateSession)return $candidateSession.ActiveProcesses}
        force={param($candidateSession,$timeout)$candidateSession.Force([uint32]$timeout)}
        close={param($candidateSession)return $candidateSession.CloseAndProve()}}
    $state=Invoke-MyspeedCleanLifecycleCore $request $loaded.sha256 $abiSha $operations
    $watch.Stop()
    $session=$state.session;$native=$state.native;$stdoutReadinessLoaded=$state.stdoutReadinessLoaded;$stopLoaded=$state.stopLoaded;$readySha=$state.readySha256
    $forced=$state.forced;$handlesClosed=$state.handlesClosed;$jobActive=$state.jobActiveProcesses;$elapsed=$state.elapsedMs
    $failures=[Collections.Generic.List[object]]::new();foreach($failure in $state.failures){[void]$failures.Add($failure)}
    $proof=[pscustomobject]@{forced=$forced;controllerInitiallyConsoleFree=$state.controllerInitiallyConsoleFree
        candidateCreatedSuspended=($null -ne $session -and $session.CandidateCreatedSuspended)
        privateConsoleRequested=($null -ne $session -and $session.PrivateConsoleRequested)
        handleListConfigured=($null -ne $session -and $session.HandleListConfigured)
        jobAssignedBeforeResume=($null -ne $session -and $session.JobAssignedBeforeResume)
        initialJobMembership=($null -ne $session -and $session.InitialJobMembership)
        candidateIdentityCaptured=($null -ne $session -and $session.CandidateIdentityCaptured)
        candidateResumed=($null -ne $session -and $session.CandidateResumed)
        threadHandleClosedBeforeReady=($null -ne $session -and $session.ThreadHandleClosedBeforeReady)
        preAttachIdentityMatch=($null -ne $native -and $native.preAttachIdentityMatch)
        postAttachHandleUnsignaled=($null -ne $native -and $native.postAttachHandleUnsignaled)
        postAttachIdentityMatch=($null -ne $native -and $native.postAttachIdentityMatch)
        postAttachJobMembership=($null -ne $native -and $native.postAttachJobMembership)
        consoleProcessIdsExact=($null -ne $native -and $native.consoleProcessIdsExact)
        ctrlEventGenerated=($null -ne $native -and $native.ctrlEventGenerated)
        candidateExited=($null -ne $native -and $native.candidateExited)
        exitCode=if($null -eq $native){$null}else{$native.exitCode};jobActiveProcesses=$jobActive
        consoleFreeAfter=$state.consoleFreeAfter;handlesClosed=$handlesClosed}
    $passed=$null -ne $native -and (Test-MyspeedCleanLifecyclePass $proof $elapsed $failures.Count)
    if(-not $passed -and $failures.Count -eq 0){[void]$failures.Add('Controller lifecycle proof did not pass')}
    $result=[pscustomobject][ordered]@{schemaVersion=1;kind=$script:ResultKind
        status=if($passed){'completed'}else{'failed'};qualifying=$false;controllerLifecyclePassed=$passed;forced=$forced
        manifestSha256=$request.manifestSha256;caseId=$request.caseId;requestSha256=$loaded.sha256;abiSha256=$abiSha
        readySha256=$readySha;stdoutReadinessSha256=if($null -eq $stdoutReadinessLoaded){$null}else{$stdoutReadinessLoaded.sha256}
        stopRequestSha256=if($null -eq $stopLoaded){$null}else{$stopLoaded.sha256}
        stdoutReadinessObserved=($null -ne $stdoutReadinessLoaded);stopRequestObserved=($null -ne $stopLoaded)
        stopRequestDeadlineMs=$state.stopRequestDeadlineMs;graceExpired=if($null -eq $native){$null}else{[bool]$native.graceExpired}
        observedConsoleProcessIds=if($null -eq $native -or $null -eq $native.consoleProcessIds){$null}else{@($native.consoleProcessIds)}
        lifecycleEvents=@($events)
        runId=$RunId;runAttempt=$RunAttempt;eventSha=$EventSha;sourceSha=$SourceSha;imageVersion=$ImageVersion;nonce=$ExpectedNonce
        controllerPid=[int64]$PID;candidatePid=if($null -eq $session){$null}else{[int64]$session.Pid}
        candidateCreationTime=if($null -eq $session){$null}else{$session.CreationTime.ToString('x16')}
        candidateImagePath=if($null -eq $session){$null}else{$session.ImagePath};candidateSha256=$request.candidateSha256
        candidateVolumeSerial=if($null -eq $session){$null}else{$session.VolumeSerial}
        candidateFileId=if($null -eq $session){$null}else{$session.FileId}
        controllerInitiallyConsoleFree=$state.controllerInitiallyConsoleFree
        candidateCreatedSuspended=($null -ne $session -and $session.CandidateCreatedSuspended)
        privateConsoleRequested=($null -ne $session -and $session.PrivateConsoleRequested)
        handleListConfigured=($null -ne $session -and $session.HandleListConfigured)
        jobAssignedBeforeResume=($null -ne $session -and $session.JobAssignedBeforeResume)
        initialJobMembership=($null -ne $session -and $session.InitialJobMembership)
        candidateIdentityCaptured=($null -ne $session -and $session.CandidateIdentityCaptured)
        candidateResumed=($null -ne $session -and $session.CandidateResumed)
        threadHandleClosedBeforeReady=($null -ne $session -and $session.ThreadHandleClosedBeforeReady)
        preAttachIdentityMatch=($null -ne $native -and $native.preAttachIdentityMatch)
        postAttachHandleUnsignaled=($null -ne $native -and $native.postAttachHandleUnsignaled)
        postAttachIdentityMatch=($null -ne $native -and $native.postAttachIdentityMatch)
        postAttachJobMembership=($null -ne $native -and $native.postAttachJobMembership)
        consoleProcessIdsExact=($null -ne $native -and $native.consoleProcessIdsExact)
        ctrlEventGenerated=($null -ne $native -and $native.ctrlEventGenerated)
        candidateExited=($null -ne $native -and $native.candidateExited)
        exitCode=if($null -eq $native -or -not $native.candidateExited){$null}else{$native.exitCode}
        jobActiveProcesses=$jobActive;consoleFreeAfter=$state.consoleFreeAfter
        handlesClosed=$handlesClosed;elapsedMs=$elapsed;failures=@($failures);releaseGatesCleared=@()}
    [void](Write-MyspeedCleanCreateNewJson $request.resultPath $result)
    if(-not $result.controllerLifecyclePassed){throw 'Hosted clean-stop controller did not pass'}
    return $result
    }catch{
        if(-not [IO.File]::Exists($request.resultPath) -and -not [IO.File]::Exists($entryDiagnosticPath)){
            try{[void](Write-MyspeedCleanEntryFailure $entryDiagnosticPath ([string]$_.Exception.Message))}catch{}
        }
        throw
    }
}

function Get-MyspeedCleanContract {
    [pscustomobject][ordered]@{schemaVersion=1;kind='myspeed-windows-clean-stop-controller';qualifying=$false
        nativeExecuted=$false;controllerNormalDeadlineMs=$script:CONTROLLER_NORMAL_DEADLINE_MS
        controllerHardDeadlineMs=$script:CONTROLLER_HARD_DEADLINE_MS
        stopRequestTimeoutMs=$script:STOP_REQUEST_TIMEOUT_MS;stopRequestPollMs=$script:STOP_REQUEST_POLL_MS
        gracefulExitTimeoutMs=$script:GRACEFUL_EXIT_TIMEOUT_MS;forcedCleanupTimeoutMs=$script:FORCED_CLEANUP_TIMEOUT_MS}
}

if($Mode -ceq 'Library'){return}
try{
    $output=switch($Mode){
        'GetContract' {Get-MyspeedCleanContract}
        'GetAbiContract' {[pscustomobject][ordered]@{schemaVersion=1;kind=$script:AbiKind;expected=Get-MyspeedCleanExpectedAbiMeasurements}}
        'ValidateAbi' {Assert-MyspeedCleanAbiObservation (ConvertFrom-MyspeedCleanJson $InputJson 'ABI observation')}
        'ValidateLaunchRequest' {Assert-MyspeedCleanLaunchRequest (ConvertFrom-MyspeedCleanJson $InputJson 'Launch request')}
        'ValidateStdoutReadiness' {$value=ConvertFrom-MyspeedCleanJson $InputJson 'Stdout readiness wrapper'
            Assert-MyspeedCleanExactKeys $value @('launch','launchRequestSha256','abiSha256','readySha256','readiness') 'Stdout readiness wrapper'
            Assert-MyspeedCleanStdoutReadiness $value.launch $value.launchRequestSha256 $value.abiSha256 $value.readySha256 $value.readiness}
        'ValidateStopRequest' {$value=ConvertFrom-MyspeedCleanJson $InputJson 'Stop request wrapper'
            Assert-MyspeedCleanExactKeys $value @('launch','launchRequestSha256','abiSha256','readySha256','stop') 'Stop request wrapper'
            Assert-MyspeedCleanStopRequest $value.launch $value.launchRequestSha256 $value.abiSha256 $value.readySha256 $value.stop}
        'ValidateResult' {Assert-MyspeedCleanResult (ConvertFrom-MyspeedCleanJson $InputJson 'Controller result')}
        'GetFixtureSource' {[pscustomobject][ordered]@{schemaVersion=1;modes=$script:FixtureModes;readyMarker=$script:FixtureReadyMarker;source=Get-MyspeedCleanFixtureSource}}
        'GetNativeSource' {[pscustomobject][ordered]@{schemaVersion=1;source=Get-MyspeedCleanNativeSource}}
        'TestLifecycle' {Invoke-MyspeedCleanInjectedLifecycle (ConvertFrom-MyspeedCleanJson $InputJson 'Injected lifecycle')}
        'TestEntryFailure' {$value=ConvertFrom-MyspeedCleanJson $InputJson 'Entry failure fixture'
            Assert-MyspeedCleanExactKeys $value @('path','message') 'Entry failure fixture'
            Write-MyspeedCleanEntryFailure (Assert-MyspeedCleanPath $value.path 'Entry failure path') `
                (Assert-MyspeedCleanString $value.message 'Entry failure message')}
        'InvokeHostedController' {Invoke-MyspeedHostedCleanStopController -RequestPath $LaunchRequestPath -RequestSha $ExpectedLaunchRequestSha256 -RunId $ExpectedRunId -RunAttempt $ExpectedRunAttempt -EventSha $ExpectedEventSha -SourceSha $ExpectedSourceSha -ImageVersion $ExpectedImageVersion -ExpectedNonce $Nonce}
    }
    $output|ConvertTo-Json -Depth 30 -Compress
}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}
