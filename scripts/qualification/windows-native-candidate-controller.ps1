[CmdletBinding()]
param(
    [ValidateSet('Library','GetContract','ValidateRequest','ValidateFileIdentity','TestLifecycle','InvokeHostedCandidate')]
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

$script:RequestKind='myspeed-windows-native-candidate-request'
$script:StopKind='myspeed-windows-native-candidate-stop'
$script:ReadyKind='myspeed-windows-native-candidate-ready'
$script:ResultKind='myspeed-windows-native-candidate-result'
$script:Repository='i7Gamer/MySpeed'
$script:ImageOS='win25-vs2026'
$script:MaximumJsonBytes=262144
$script:MaximumControllerBytes=2097152
$script:MaximumCandidateBytes=536870912
$script:MaximumFailureCharacters=512
$script:NormalDeadlineMs=300000
$script:HardDeadlineMs=310000
$script:StopTimeoutMs=240000
$script:PollMs=50
$script:GraceMs=30000
$script:CleanupMs=10000
$script:SuccessExit=0
$script:ResetExit=113
$script:MaximumPort=65535
$script:Win32CodeMask=65535
$script:SharingViolationCode=32
$script:AllowedAliases=@('default','baseline')
$script:AllowedScenarios=@('populated-first-boot','populated-restart','fresh-no-config-reset')
$script:AllowedEnvironment=@('PATH','SystemRoot','WINDIR','ComSpec','PATHEXT','TEMP','TMP','TMPDIR','TZ','LANG','LC_ALL',
    'NODE_ENV','DB_TYPE','SERVER_HOST','SERVER_PORT','RUN_TEST_ON_STARTUP')

function Assert-MyspeedCandidateKeys {
    param([object]$Value,[string[]]$Names,[string]$Label)
    if($null -eq $Value -or $Value -isnot [psobject]){throw "$Label must be an object"}
    $actual=[string[]]@($Value.PSObject.Properties.Name)
    if($actual.Count -ne $Names.Count){throw "$Label keys differ"}
    foreach($name in $Names){if($actual -cnotcontains $name){throw "$Label keys differ"}}
}

function Assert-MyspeedCandidateString {
    param([object]$Value,[string]$Label,[string]$Pattern='')
    if($Value -isnot [string] -or $Value.Length -eq 0){throw "$Label must be a nonempty string"}
    if($Value.Length -gt 32767){throw "$Label is too long"}
    if($Pattern){$match=[regex]::Match($Value,$Pattern,[Text.RegularExpressions.RegexOptions]::CultureInvariant)
        if(-not $match.Success -or $match.Index -ne 0 -or $match.Length -ne $Value.Length){throw "$Label differs"}}
    return [string]$Value
}

function Assert-MyspeedCandidateInteger {
    param([object]$Value,[string]$Label,[int64]$Minimum,[int64]$Maximum)
    if(($null -ne $Value -and $Value.GetType().IsArray) -or $Value -isnot [ValueType] -or $Value -is [bool] -or
        $Value -is [single] -or $Value -is [double] -or $Value -is [decimal]){throw "$Label must be an integer"}
    try{$number=[int64]$Value}catch{throw "$Label must be an integer"}
    if($number -lt $Minimum -or $number -gt $Maximum){throw "$Label is outside its bound"};return $number
}

function Assert-MyspeedCandidateBoolean {
    param([object]$Value,[string]$Label)
    if($Value -isnot [bool]){throw "$Label must be Boolean"};return [bool]$Value
}

function Get-MyspeedCandidateFailureMessage {
    param([object]$Failure)
    $message=if($Failure -is [Management.Automation.ErrorRecord]){[string]$Failure.Exception.Message}
        elseif($Failure -is [Exception]){[string]$Failure.Message}else{[string]$Failure}
    $message=[regex]::Replace($message,'[\x00-\x1f\x7f]+',' ')
    if($message.Length -gt $script:MaximumFailureCharacters){$message=$message.Substring(0,$script:MaximumFailureCharacters)}
    if(-not $message){$message='unspecified failure'}
    return $message
}

function Assert-MyspeedCandidatePath {
    param([object]$Value,[string]$Label)
    $path=Assert-MyspeedCandidateString $Value $Label '\A[A-Za-z]:\\.*\z'
    if($path -match '[\x00-\x1f*?]' -or $path.Substring(2).Contains(':')){throw "$Label contains a forbidden form"}
    if(-not [IO.Path]::IsPathRooted($path) -or [IO.Path]::GetFullPath($path) -cne $path){throw "$Label is not canonical"}
    foreach($segment in $path.Substring(3).Split('\')){
        if($segment -in @('','.','..') -or $segment.TrimEnd('.',' ') -cne $segment -or
            $segment -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$'){throw "$Label contains a forbidden segment"}
    }
    return $path
}

function Assert-MyspeedCandidateDescendant {
    param([string]$Root,[string]$Path,[string]$Label,[switch]$AllowRoot)
    $prefix=$Root.TrimEnd('\')+'\'
    if(($AllowRoot -and $Path -ieq $Root) -or $Path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){return}
    throw "$Label is outside task root"
}

function Assert-MyspeedCandidateFileIdentity {
    param([object]$Observation,[string]$Path,[string]$ExpectedSha256,[int64]$MaximumBytes)
    $canonical=Assert-MyspeedCandidatePath $Path 'Candidate identity path'
    $expectedSha=Assert-MyspeedCandidateString $ExpectedSha256 'Candidate identity expected SHA' '\A[0-9a-f]{64}\z'
    [void](Assert-MyspeedCandidateInteger $MaximumBytes 'Candidate identity maximum bytes' 1 $script:MaximumCandidateBytes)
    Assert-MyspeedCandidateKeys $Observation @('path','finalPath','bytes','sha256','volumeSerial','fileId','linkCount',
        'isRegular','reparsePoint') 'Candidate file identity'
    $observedPath=Assert-MyspeedCandidatePath $Observation.path 'Candidate identity observed path'
    $finalPath=Assert-MyspeedCandidatePath $Observation.finalPath 'Candidate identity final path'
    if(-not $observedPath.Equals($canonical,[StringComparison]::OrdinalIgnoreCase) -or
        -not $finalPath.Equals($canonical,[StringComparison]::OrdinalIgnoreCase)){throw 'Candidate identity path differs'}
    $bytes=Assert-MyspeedCandidateInteger $Observation.bytes 'Candidate identity bytes' 1 $MaximumBytes
    $sha=Assert-MyspeedCandidateString $Observation.sha256 'Candidate identity SHA' '\A[0-9a-f]{64}\z'
    if($sha -cne $expectedSha){throw 'Candidate identity SHA differs'}
    [void](Assert-MyspeedCandidateString $Observation.volumeSerial 'Candidate identity volume serial' '\A[0-9a-f]{8}\z')
    [void](Assert-MyspeedCandidateString $Observation.fileId 'Candidate identity file ID' '\A[0-9a-f]{16}\z')
    if((Assert-MyspeedCandidateInteger $Observation.linkCount 'Candidate identity link count' 1 4294967295) -ne 1 -or
        -not (Assert-MyspeedCandidateBoolean $Observation.isRegular 'Candidate identity regular-file proof') -or
        (Assert-MyspeedCandidateBoolean $Observation.reparsePoint 'Candidate identity reparse proof')){
        throw 'Candidate identity file kind differs'}
    return [pscustomobject][ordered]@{path=$observedPath;finalPath=$finalPath;bytes=$bytes;sha256=$sha
        volumeSerial=$Observation.volumeSerial;fileId=$Observation.fileId;linkCount=1;isRegular=$true;reparsePoint=$false}
}

function Get-MyspeedCandidateFileIdentity {
    param([string]$Path,[string]$ExpectedSha256,[int64]$MaximumBytes)
    $canonical=Assert-MyspeedCandidatePath $Path 'Candidate identity path'
    $sha=Assert-MyspeedCandidateString $ExpectedSha256 'Candidate identity expected SHA' '\A[0-9a-f]{64}\z'
    $maximum=Assert-MyspeedCandidateInteger $MaximumBytes 'Candidate identity maximum bytes' 1 $script:MaximumCandidateBytes
    $native=[MySpeed.Qualification.CleanStop.Session]::InspectCandidate($canonical,$sha,$maximum)
    $observation=[pscustomobject][ordered]@{path=$native.Path;finalPath=$native.FinalPath;bytes=[int64]$native.Bytes
        sha256=$native.Sha256;volumeSerial=$native.VolumeSerial;fileId=$native.FileId;linkCount=[int64]$native.LinkCount
        isRegular=[bool]$native.IsRegular;reparsePoint=[bool]$native.ReparsePoint}
    return Assert-MyspeedCandidateFileIdentity $observation $canonical $sha $maximum
}

function ConvertFrom-MyspeedCandidateJson {
    param([string]$Json,[string]$Label)
    if([Text.Encoding]::UTF8.GetByteCount($Json) -gt $script:MaximumJsonBytes){throw "$Label exceeds its byte bound"}
    try{return $Json|ConvertFrom-Json}catch{throw "$Label is not valid JSON"}
}

function Assert-MyspeedCandidateRequest {
    param([object]$Request)
    $keys=@('schemaVersion','kind','expectedRunId','expectedRunAttempt','expectedEventSha','expectedSourceSha',
        'expectedImageVersion','nonce','manifestSha256','alias','artifactLogicalName','scenario','taskRoot','candidatePath',
        'candidateSha256','candidateVolumeSerial','candidateFileId','workingDirectory','arguments','environment','stdoutPath',
        'stderrPath','readyPath','stopRequestPath','resultPath','controllerPath','controllerSha256','normalDeadlineMs',
        'hardDeadlineMs','stopRequestTimeoutMs','stopRequestPollMs','gracefulExitTimeoutMs','forcedCleanupTimeoutMs')
    Assert-MyspeedCandidateKeys $Request $keys 'Candidate request'
    [void](Assert-MyspeedCandidateInteger $Request.schemaVersion 'Candidate request schema' 1 1)
    if((Assert-MyspeedCandidateString $Request.kind 'Candidate request kind') -cne $script:RequestKind){throw 'Candidate request kind differs'}
    [void](Assert-MyspeedCandidateString $Request.expectedRunId 'Candidate run ID' '\A[1-9][0-9]{0,19}\z')
    [void](Assert-MyspeedCandidateString $Request.expectedRunAttempt 'Candidate run attempt' '\A[1-9][0-9]{0,9}\z')
    [void](Assert-MyspeedCandidateString $Request.expectedEventSha 'Candidate event SHA' '\A[0-9a-f]{40}\z')
    [void](Assert-MyspeedCandidateString $Request.expectedSourceSha 'Candidate source SHA' '\A[0-9a-f]{40}\z')
    [void](Assert-MyspeedCandidateString $Request.expectedImageVersion 'Candidate image version' '\A[0-9A-Za-z._-]{1,128}\z')
    [void](Assert-MyspeedCandidateString $Request.nonce 'Candidate nonce' '\A[0-9a-f]{32}\z')
    foreach($name in @('manifestSha256','candidateSha256','controllerSha256')){[void](Assert-MyspeedCandidateString $Request.$name "Candidate $name" '\A[0-9a-f]{64}\z')}
    [void](Assert-MyspeedCandidateString $Request.candidateVolumeSerial 'Candidate volume serial' '\A[0-9a-f]{8}\z')
    [void](Assert-MyspeedCandidateString $Request.candidateFileId 'Candidate file ID' '\A[0-9a-f]{16}\z')
    $alias=Assert-MyspeedCandidateString $Request.alias 'Candidate alias';if($script:AllowedAliases -cnotcontains $alias){throw 'Candidate alias differs'}
    $logical=Assert-MyspeedCandidateString $Request.artifactLogicalName 'Candidate artifact logical name'
    $expectedLogical=if($alias -ceq 'default'){'MySpeed-windows-x64.exe'}else{'MySpeed-windows-x64-baseline.exe'}
    if($logical -cne $expectedLogical){throw 'Candidate artifact logical identity differs'}
    $scenario=Assert-MyspeedCandidateString $Request.scenario 'Candidate scenario';if($script:AllowedScenarios -cnotcontains $scenario){throw 'Candidate scenario differs'}
    $root=Assert-MyspeedCandidatePath $Request.taskRoot 'Candidate task root'
    $paths=@('candidatePath','workingDirectory','stdoutPath','stderrPath','readyPath','stopRequestPath','resultPath','controllerPath')
    foreach($name in $paths){$path=Assert-MyspeedCandidatePath $Request.$name "Candidate $name";Assert-MyspeedCandidateDescendant $root $path "Candidate $name" -AllowRoot:($name -ceq 'workingDirectory')}
    $unique=@('candidatePath','stdoutPath','stderrPath','readyPath','stopRequestPath','resultPath','controllerPath')
    for($left=0;$left -lt $unique.Count;$left++){for($right=$left+1;$right -lt $unique.Count;$right++){
        if($Request.($unique[$left]) -ieq $Request.($unique[$right])){throw 'Candidate owned paths collide'}}}
    if($Request.arguments -isnot [object[]]){throw 'Candidate arguments must be an array'}
    foreach($argument in $Request.arguments){[void](Assert-MyspeedCandidateString $argument 'Candidate argument')}
    if($scenario -ceq 'fresh-no-config-reset'){
        if($Request.arguments.Count -ne 1 -or $Request.arguments[0] -cne '--reset-password'){throw 'Candidate arguments differ'}
    }elseif($Request.arguments.Count -ne 0){throw 'Candidate arguments differ'}
    if($Request.environment -isnot [pscustomobject]){throw 'Candidate environment must be an object'}
    foreach($property in $Request.environment.PSObject.Properties){
        if($script:AllowedEnvironment -cnotcontains $property.Name){throw 'Candidate environment key differs'}
        [void](Assert-MyspeedCandidateString $property.Value "Candidate environment $($property.Name)")
    }
    foreach($binding in @{NODE_ENV='production';DB_TYPE='sqlite';SERVER_HOST='127.0.0.1';RUN_TEST_ON_STARTUP='false'}.GetEnumerator()){
        if($Request.environment.($binding.Key) -cne $binding.Value){throw 'Candidate fixed environment differs'}}
    $port=Assert-MyspeedCandidateString $Request.environment.SERVER_PORT 'Candidate server port' '\A[1-9][0-9]{0,4}\z'
    if([int]$port -gt $script:MaximumPort){throw 'Candidate server port is outside its bound'}
    foreach($entry in @{normalDeadlineMs=$script:NormalDeadlineMs;hardDeadlineMs=$script:HardDeadlineMs
        stopRequestTimeoutMs=$script:StopTimeoutMs;stopRequestPollMs=$script:PollMs
        gracefulExitTimeoutMs=$script:GraceMs;forcedCleanupTimeoutMs=$script:CleanupMs}.GetEnumerator()){
        [void](Assert-MyspeedCandidateInteger $Request.($entry.Key) "Candidate $($entry.Key)" $entry.Value $entry.Value)}
    return $Request
}

function Assert-MyspeedCandidateStop {
    param([object]$Stop,[object]$Request,[object]$Session)
    Assert-MyspeedCandidateKeys $Stop @('schemaVersion','kind','nonce','manifestSha256','alias','scenario','candidatePid','candidateCreationTime') 'Candidate stop'
    [void](Assert-MyspeedCandidateInteger $Stop.schemaVersion 'Candidate stop schema' 1 1)
    if((Assert-MyspeedCandidateString $Stop.kind 'Candidate stop kind') -cne $script:StopKind){throw 'Candidate stop kind differs'}
    foreach($name in @('nonce','manifestSha256','alias','scenario')){if((Assert-MyspeedCandidateString $Stop.$name "Candidate stop $name") -cne $Request.$name){throw 'Candidate stop identity differs'}}
    if((Assert-MyspeedCandidateInteger $Stop.candidatePid 'Candidate stop PID' 1 4294967295) -ne $Session.candidatePid -or
        (Assert-MyspeedCandidateString $Stop.candidateCreationTime 'Candidate stop creation time' '\A[0-9a-f]{16}\z') -cne $Session.candidateCreationTime){throw 'Candidate stop process identity differs'}
}

function Assert-MyspeedCandidateLaunch {
    param([object]$Value,[object]$Request)
    $keys=@('candidatePid','candidateCreationTime','candidateImagePath','candidateSha256','candidateVolumeSerial','candidateFileId',
        'candidateCreatedSuspended','privateConsoleRequested','handleListConfigured','jobAssignedBeforeResume','initialJobMembership',
        'candidateIdentityCaptured','candidateResumed','threadHandleClosedBeforeReady')
    Assert-MyspeedCandidateKeys $Value $keys 'Candidate launch'
    [void](Assert-MyspeedCandidateInteger $Value.candidatePid 'Candidate PID' 1 4294967295)
    [void](Assert-MyspeedCandidateString $Value.candidateCreationTime 'Candidate creation time' '\A[0-9a-f]{16}\z')
    foreach($binding in @{candidateImagePath='candidatePath';candidateSha256='candidateSha256';candidateVolumeSerial='candidateVolumeSerial';candidateFileId='candidateFileId'}.GetEnumerator()){
        if((Assert-MyspeedCandidateString $Value.($binding.Key) "Candidate launch $($binding.Key)") -cne $Request.($binding.Value)){throw 'Candidate launch identity differs'}}
    foreach($name in @('candidateCreatedSuspended','privateConsoleRequested','handleListConfigured','jobAssignedBeforeResume',
        'initialJobMembership','candidateIdentityCaptured','candidateResumed','threadHandleClosedBeforeReady')){
        if(-not (Assert-MyspeedCandidateBoolean $Value.$name "Candidate launch $name")){throw 'Candidate launch proof failed'}}
    return $Value
}

function Assert-MyspeedCandidateNativeShape {
    param([object]$Value)
    $keys=@('forced','preAttachIdentityMatch','postAttachHandleUnsignaled','postAttachIdentityMatch','postAttachJobMembership',
        'consoleProcessIdsExact','ctrlEventGenerated','candidateExited','graceExpired','exitCode','jobZero','consoleFreeAfter','handlesClosed')
    Assert-MyspeedCandidateKeys $Value $keys 'Candidate native result'
    foreach($name in $keys | Where-Object {$_ -ne 'exitCode'}){[void](Assert-MyspeedCandidateBoolean $Value.$name "Candidate native result $name")}
    [void](Assert-MyspeedCandidateInteger $Value.exitCode 'Candidate native exit code' -2147483648 2147483647)
    return $Value
}

function Assert-MyspeedCandidateNativeResult {
    param([object]$Value,[object]$Request)
    $Value=Assert-MyspeedCandidateNativeShape $Value
    $exit=[int64]$Value.exitCode
    $reset=$Request.scenario -ceq 'fresh-no-config-reset';$expectedExit=if($reset){$script:ResetExit}else{$script:SuccessExit}
    foreach($name in @('candidateExited','jobZero','consoleFreeAfter')){
        if(-not $Value.$name){throw "Candidate native proof failed: $name"}}
    if($Value.forced -or $Value.graceExpired -or $exit -ne $expectedExit){throw 'Candidate native exit behavior differs'}
    $ctrlProofs=@('preAttachIdentityMatch','postAttachHandleUnsignaled','postAttachIdentityMatch','postAttachJobMembership','consoleProcessIdsExact','ctrlEventGenerated')
    if($reset){foreach($name in $ctrlProofs){if($Value.$name){throw 'Reset candidate retained unexpected Ctrl+C proof'}}}
    else{foreach($name in $ctrlProofs){if(-not $Value.$name){throw "Candidate native proof failed: $name"}}}
    return $Value
}

function Invoke-MyspeedCandidateLifecycleCore {
    param([object]$Request,[object]$Operations)
    [void](Assert-MyspeedCandidateRequest $Request)
    $required=@('elapsed','assertConsoleFree','launch','writeReady','stopExists','readStop','sleep','stop','lastResult','active','force','close')
    Assert-MyspeedCandidateKeys $Operations $required 'Candidate lifecycle operations'
    $failures=[Collections.Generic.List[string]]::new();$failureDetails=[Collections.Generic.List[object]]::new();$session=$null;$native=$null;$nativeEvidence=$null;$handlesClosed=$false;$handleCleanupAttempted=$false;$active=$null;$ready=$null
    $launchAttempted=$false;$started=0L
    try{
        $entryElapsed=Assert-MyspeedCandidateInteger (& $Operations.elapsed) 'Candidate entry monotonic time' 0 9223372036854775807
        if($entryElapsed -ge $script:NormalDeadlineMs){throw 'Candidate normal deadline expired during setup'}
        & $Operations.assertConsoleFree
        $before=Assert-MyspeedCandidateInteger (& $Operations.elapsed) 'Candidate prelaunch monotonic time' $entryElapsed 9223372036854775807;if($before -ge $script:NormalDeadlineMs){throw 'Candidate normal deadline expired before launch'}
        $launchAttempted=$true
        $session=Assert-MyspeedCandidateLaunch (& $Operations.launch $Request ($script:NormalDeadlineMs-($before-$started)) ($script:HardDeadlineMs-($before-$started))) $Request
        $after=Assert-MyspeedCandidateInteger (& $Operations.elapsed) 'Candidate postlaunch monotonic time' $before 9223372036854775807;if($after-$started -ge $script:NormalDeadlineMs){throw 'Candidate normal deadline expired before ready'}
        $ready=[pscustomobject][ordered]@{schemaVersion=1;kind=$script:ReadyKind;nonce=$Request.nonce;manifestSha256=$Request.manifestSha256
            alias=$Request.alias;scenario=$Request.scenario;artifactLogicalName=$Request.artifactLogicalName;candidateSha256=$Request.candidateSha256
            candidatePid=$session.candidatePid;candidateCreationTime=$session.candidateCreationTime;retainedHandleAuthority=$true
            jobAssignedBeforeResume=$true;handleListConfigured=$true}
        & $Operations.writeReady $ready
        if($Request.scenario -ceq 'fresh-no-config-reset'){
            while($null -eq $native){
                if(& $Operations.stopExists){throw 'Reset candidate received an unexpected stop request'}
                if((Assert-MyspeedCandidateInteger (& $Operations.elapsed) 'Reset monotonic time' $after 9223372036854775807)-$started -ge $script:NormalDeadlineMs){throw 'Reset candidate exit deadline expired'}
                $observedNative=& $Operations.lastResult $session;if($null -eq $observedNative){& $Operations.sleep $script:PollMs}else{
                    $nativeEvidence=Assert-MyspeedCandidateNativeShape $observedNative;$native=Assert-MyspeedCandidateNativeResult $nativeEvidence $Request}
            }
        }else{
            $stopWaitStart=Assert-MyspeedCandidateInteger (& $Operations.elapsed) 'Candidate stop wait monotonic time' $after 9223372036854775807
            $stopDeadline=[Math]::Min($script:NormalDeadlineMs,$stopWaitStart+$script:StopTimeoutMs)
            while(-not (& $Operations.stopExists)){
                if((Assert-MyspeedCandidateInteger (& $Operations.elapsed) 'Candidate stop poll monotonic time' $after 9223372036854775807) -ge $stopDeadline){throw 'Candidate stop request deadline expired'}
                & $Operations.sleep $script:PollMs
            }
            if((Assert-MyspeedCandidateInteger (& $Operations.elapsed) 'Candidate stop observed monotonic time' $after 9223372036854775807) -ge $stopDeadline){throw 'Candidate stop request arrived after its deadline'}
            $stop=$null
            while($null -eq $stop){
                if((Assert-MyspeedCandidateInteger (& $Operations.elapsed) 'Candidate stop read monotonic time' $after 9223372036854775807) -ge $stopDeadline){throw 'Candidate stop request read exceeded its deadline'}
                $stop=& $Operations.readStop;if($null -eq $stop){& $Operations.sleep $script:PollMs}
            }
            Assert-MyspeedCandidateStop $stop $Request $session
            if((Assert-MyspeedCandidateInteger (& $Operations.elapsed) 'Candidate validated stop monotonic time' $after 9223372036854775807) -ge $stopDeadline){throw 'Candidate stop request validation exceeded its deadline'}
            $remaining=$script:HardDeadlineMs-((Assert-MyspeedCandidateInteger (& $Operations.elapsed) 'Candidate prestop monotonic time' $after 9223372036854775807)-$started);if($remaining -le 0){throw 'Candidate hard deadline expired before stop'}
            $grace=[Math]::Min($script:GraceMs,$remaining);$cleanupBudget=[Math]::Max(0,$remaining-$grace)
            $observedNative=& $Operations.stop $session $grace $cleanupBudget
            $nativeEvidence=Assert-MyspeedCandidateNativeShape $observedNative;$native=Assert-MyspeedCandidateNativeResult $nativeEvidence $Request
        }
    }catch{[void]$failures.Add('candidate-lifecycle-failed')
        [void]$failureDetails.Add([pscustomobject]@{phase='lifecycle';failure=(Get-MyspeedCandidateFailureMessage $_)})}
    finally{
        if($launchAttempted){
            try{
                if($null -eq $nativeEvidence){$observedCleanup=& $Operations.lastResult $session;if($null -ne $observedCleanup){$nativeEvidence=Assert-MyspeedCandidateNativeShape $observedCleanup}}
                $active=Assert-MyspeedCandidateInteger (& $Operations.active $session) 'Candidate active process count' 0 4294967295
                if($active -ne 0){
                    $remaining=$script:HardDeadlineMs-((Assert-MyspeedCandidateInteger (& $Operations.elapsed) 'Candidate cleanup monotonic time' $started 9223372036854775807)-$started)
                    if($remaining -le 0){throw 'Candidate cleanup deadline expired'}
                    & $Operations.force $session ([Math]::Min($script:CleanupMs,$remaining));$observedCleanup=& $Operations.lastResult $session
                    if($null -ne $observedCleanup){$nativeEvidence=Assert-MyspeedCandidateNativeShape $observedCleanup}
                    $active=Assert-MyspeedCandidateInteger (& $Operations.active $session) 'Candidate final active process count' 0 4294967295
                }
            }catch{[void]$failures.Add('candidate-cleanup-failed')
                [void]$failureDetails.Add([pscustomobject]@{phase='cleanup';failure=(Get-MyspeedCandidateFailureMessage $_)})}
            try{$handleCleanupAttempted=$true;$handlesClosed=Assert-MyspeedCandidateBoolean (& $Operations.close $session) 'Candidate handles closed'}
            catch{[void]$failures.Add('candidate-handle-cleanup-failed')
                [void]$failureDetails.Add([pscustomobject]@{phase='handle-cleanup';failure=(Get-MyspeedCandidateFailureMessage $_)})}
        }
    }
    $elapsed=Assert-MyspeedCandidateInteger (& $Operations.elapsed) 'Candidate final monotonic time' $started 9223372036854775807
    $passed=$failures.Count -eq 0 -and $elapsed-$started -le $script:NormalDeadlineMs -and $handlesClosed -and $active -eq 0
    if($passed){try{[void](Assert-MyspeedCandidateNativeResult $native $Request)}catch{$passed=$false;[void]$failures.Add('candidate-proof-failed')
            [void]$failureDetails.Add([pscustomobject]@{phase='proof';failure=(Get-MyspeedCandidateFailureMessage $_)})}}
    $result=[pscustomobject][ordered]@{schemaVersion=1;kind=$script:ResultKind;status=if($passed){'completed'}else{'failed'}
        qualifying=$false;releaseGatesCleared=@();alias=$Request.alias;artifactLogicalName=$Request.artifactLogicalName;scenario=$Request.scenario
        stopKind=if($Request.scenario -ceq 'fresh-no-config-reset'){'observed-exit'}else{'ctrl-c'}
        candidatePid=if($null -eq $session){$null}else{$session.candidatePid};candidateCreationTime=if($null -eq $session){$null}else{$session.candidateCreationTime}
        candidateExited=($null -ne $nativeEvidence -and [bool]$nativeEvidence.candidateExited);exitCode=if($null -eq $nativeEvidence){$null}else{[int64]$nativeEvidence.exitCode}
        forced=($null -ne $nativeEvidence -and [bool]$nativeEvidence.forced);jobActiveProcesses=$active;handleCleanupAttempted=$handleCleanupAttempted;handlesClosed=$handlesClosed
        processTreeExitProven=($active -eq 0);listenerGone=$false;elapsedMs=($elapsed-$started);failures=@($failures)}
    if(-not $passed){Add-Member -InputObject $result -NotePropertyName failureDetails -NotePropertyValue ([object[]]$failureDetails)}
    return $result
}

function Invoke-MyspeedCandidateInjectedLifecycle {
    param([object]$Value)
    Assert-MyspeedCandidateKeys $Value @('request','clock','stopAvailable','stopReadNulls','launch','stop','nativeResult','activeProcesses','handlesClosed') 'Injected candidate lifecycle'
    if($Value.clock -isnot [object[]] -or $Value.clock.Count -lt 2 -or $Value.clock.Count -gt 64){throw 'Injected candidate clock differs'}
    $clock=@($Value.clock);$previous=-1L
    foreach($sample in $clock){$current=Assert-MyspeedCandidateInteger $sample 'Injected candidate clock sample' 0 ($script:HardDeadlineMs+1);if($current -lt $previous){throw 'Injected candidate clock is not monotonic'};$previous=$current}
    [void](Assert-MyspeedCandidateBoolean $Value.stopAvailable 'Injected candidate stop availability')
    [void](Assert-MyspeedCandidateInteger $Value.stopReadNulls 'Injected candidate null stop reads' 0 64)
    [void](Assert-MyspeedCandidateInteger $Value.activeProcesses 'Injected candidate active count' 0 4294967295)
    [void](Assert-MyspeedCandidateBoolean $Value.handlesClosed 'Injected candidate handles closed')
    $state=[pscustomobject]@{index=0;native=$null;stopReads=0};$value=$Value
    $operations=[pscustomobject]@{
        elapsed={if($state.index -lt $clock.Count){$sample=$clock[$state.index];$state.index++}else{$sample=$clock[-1]};return [int64]$sample}.GetNewClosure()
        assertConsoleFree={}
        launch={param($requestValue,$normal,$hard)return $value.launch}.GetNewClosure()
        writeReady={param($ready)}
        stopExists={return [bool]$value.stopAvailable}.GetNewClosure()
        readStop={if($state.stopReads -lt $value.stopReadNulls){$state.stopReads++;return $null};return $value.stop}.GetNewClosure()
        sleep={param($milliseconds)}
        stop={param($session,$grace,$cleanup)$state.native=$value.nativeResult;return $state.native}.GetNewClosure()
        lastResult={param($session)if($value.request.scenario -ceq 'fresh-no-config-reset'){$state.native=$value.nativeResult};return $state.native}.GetNewClosure()
        active={param($session)return [int64]$value.activeProcesses}.GetNewClosure()
        force={param($session,$timeout)$state.native=$value.nativeResult}.GetNewClosure()
        close={param($session)return [bool]$value.handlesClosed}.GetNewClosure()}
    return Invoke-MyspeedCandidateLifecycleCore $Value.request $operations
}

function Assert-MyspeedCandidateHostedContext {
    param([string]$RunId,[string]$RunAttempt,[string]$EventSha,[string]$SourceSha,[string]$ImageVersion,[string]$ExpectedNonce)
    $expected=@{GITHUB_ACTIONS='true';CI='true';GITHUB_REPOSITORY=$script:Repository;RUNNER_OS='Windows';RUNNER_ARCH='X64'
        RUNNER_ENVIRONMENT='github-hosted';ImageOS=$script:ImageOS;GITHUB_RUN_ID=$RunId;GITHUB_RUN_ATTEMPT=$RunAttempt
        GITHUB_SHA=$EventSha;ImageVersion=$ImageVersion}
    foreach($entry in $expected.GetEnumerator()){if([Environment]::GetEnvironmentVariable($entry.Key) -cne $entry.Value){throw "Hosted context $($entry.Key) differs"}}
    [void](Assert-MyspeedCandidateString $SourceSha 'Hosted source SHA' '\A[0-9a-f]{40}\z')
    [void](Assert-MyspeedCandidateString $ExpectedNonce 'Hosted nonce' '\A[0-9a-f]{32}\z')
    $expectedHost=[IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
    $actualHost=[IO.Path]::GetFullPath([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
    if(-not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -cne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or
        $PSVersionTable.PSVersion.Minor -ne 1 -or $actualHost -ine $expectedHost){throw 'Hosted context requires x64 inbox Windows PowerShell 5.1'}
}

function Read-MyspeedCandidateJson {
    param([string]$Path,[string]$ExpectedSha)
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
    try{
        if($stream.Length -lt 2 -or $stream.Length -gt $script:MaximumJsonBytes){throw 'Candidate JSON size differs'}
        $bytes=New-Object byte[] ([int]$stream.Length);$offset=0
        while($offset -lt $bytes.Length){$read=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($read -eq 0){throw 'Candidate JSON read was short'};$offset+=$read}
    }finally{$stream.Dispose()}
    $sha=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-','').ToLowerInvariant()
    if($ExpectedSha -and $sha -cne $ExpectedSha){throw 'Candidate JSON SHA differs'}
    return [pscustomobject]@{value=ConvertFrom-MyspeedCandidateJson ([Text.UTF8Encoding]::new($false,$true).GetString($bytes)) 'Candidate file';sha256=$sha}
}

function Write-MyspeedCandidateJson {
    param([string]$Path,[object]$Value)
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 20 -Compress));if($bytes.Length -gt $script:MaximumJsonBytes){throw 'Candidate result exceeds its bound'}
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}

function Invoke-MyspeedCandidateModuleCommand {
    param([object]$Module,[string]$Command,[object[]]$Arguments=@())
    $call=[pscustomobject]@{name=$Command;arguments=$Arguments}
    return & $Module {
        param($request)
        $moduleArguments=[object[]]$request.arguments
        & $request.name @moduleArguments
    } $call
}

function New-MyspeedCandidateNativeOperations {
    param([object]$Request,[Diagnostics.Stopwatch]$Watch)
    $req=$Request
    $watch=$Watch
    $limits=[pscustomobject]@{hardDeadlineMs=$script:HardDeadlineMs;cleanupMs=$script:CleanupMs
        win32CodeMask=$script:Win32CodeMask;sharingViolationCode=$script:SharingViolationCode}
    $nativeState=[pscustomobject]@{session=$null}
    return [pscustomobject]@{
        elapsed={return [int64]$watch.ElapsedMilliseconds}.GetNewClosure()
        assertConsoleFree={[MySpeed.Qualification.CleanStop.Session]::AssertConsoleFree()}
        launch={param($requestValue,$normal,$hard)
            $environment=[Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
            foreach($property in $requestValue.environment.PSObject.Properties){$environment.Add($property.Name,[string]$property.Value)}
            $session=[MySpeed.Qualification.CleanStop.Session]::Launch($requestValue.candidatePath,$requestValue.candidateSha256,$requestValue.candidateVolumeSerial,$requestValue.candidateFileId,[string[]]$requestValue.arguments,$requestValue.workingDirectory,$environment,$requestValue.stdoutPath,$requestValue.stderrPath,[uint32]$normal,[uint32]$hard)
            $nativeState.session=$session
            try{return [pscustomobject]@{candidatePid=[int64]$session.Pid;candidateCreationTime=$session.CreationTime.ToString('x16');candidateImagePath=$session.ImagePath
                    candidateSha256=$requestValue.candidateSha256;candidateVolumeSerial=$session.VolumeSerial;candidateFileId=$session.FileId
                    candidateCreatedSuspended=$session.CandidateCreatedSuspended;privateConsoleRequested=$session.PrivateConsoleRequested
                    handleListConfigured=$session.HandleListConfigured;jobAssignedBeforeResume=$session.JobAssignedBeforeResume
                    initialJobMembership=$session.InitialJobMembership;candidateIdentityCaptured=$session.CandidateIdentityCaptured
                    candidateResumed=$session.CandidateResumed;threadHandleClosedBeforeReady=$session.ThreadHandleClosedBeforeReady}}
            catch{
                try{if($session.ActiveProcesses -ne 0){$remaining=$limits.hardDeadlineMs-[int64]$watch.ElapsedMilliseconds
                        if($remaining -gt 0){$session.Force([uint32][Math]::Min($limits.cleanupMs,$remaining))}}}finally{[void]$session.CloseAndProve();$nativeState.session=$null}
                throw
            }}.GetNewClosure()
        writeReady={param($ready)Write-MyspeedCandidateJson $req.readyPath $ready}.GetNewClosure()
        stopExists={return Test-Path -LiteralPath $req.stopRequestPath -PathType Leaf}.GetNewClosure()
        readStop={try{return (Read-MyspeedCandidateJson $req.stopRequestPath '').value}catch [IO.IOException]{
                if(($_.Exception.HResult -band $limits.win32CodeMask) -eq $limits.sharingViolationCode){return $null};throw}}.GetNewClosure()
        sleep={param($milliseconds)Start-Sleep -Milliseconds $milliseconds}
        stop={param($session,$grace,$cleanup)if($null -eq $nativeState.session){throw 'Native candidate session is absent'};return $nativeState.session.Stop([uint32]$PID,[uint32]$grace,[uint32]$cleanup)}.GetNewClosure()
        lastResult={param($session)if($null -eq $nativeState.session){return $null};$result=$nativeState.session.LastResult;if($null -ne $result -and $req.scenario -ceq 'fresh-no-config-reset'){
                [MySpeed.Qualification.CleanStop.Session]::AssertConsoleFree();$result.consoleFreeAfter=$true};return $result}.GetNewClosure()
        active={param($session)if($null -eq $nativeState.session){return 0};return $nativeState.session.ActiveProcesses}.GetNewClosure()
        force={param($session,$timeout)if($null -ne $nativeState.session){$nativeState.session.Force([uint32]$timeout)}}.GetNewClosure()
        close={param($session)if($null -eq $nativeState.session){return $true};return $nativeState.session.CloseAndProve()}.GetNewClosure()}
}

function Invoke-MyspeedHostedCandidate {
    param([string]$Path,[string]$Sha,[string]$RunId,[string]$RunAttempt,[string]$EventSha,[string]$SourceSha,[string]$ImageVersion,[string]$ExpectedNonce)
    $watch=[Diagnostics.Stopwatch]::StartNew()
    # Assert-MyspeedCandidateHostedContext must remain before request I/O, module import, Add-Type, or native calls.
    Assert-MyspeedCandidateHostedContext $RunId $RunAttempt $EventSha $SourceSha $ImageVersion $ExpectedNonce
    $runnerTemp=Assert-MyspeedCandidatePath $env:RUNNER_TEMP 'Hosted runner temporary root'
    $expectedTaskRoot=[IO.Path]::GetFullPath((Join-Path $runnerTemp ("myspeed-native-candidate-$ExpectedNonce")))
    $canonicalRequestPath=Assert-MyspeedCandidatePath $Path 'Candidate request path'
    Assert-MyspeedCandidateDescendant $expectedTaskRoot $canonicalRequestPath 'Candidate request path'
    $loaded=Read-MyspeedCandidateJson $canonicalRequestPath $Sha
    $request=Assert-MyspeedCandidateRequest $loaded.value
    if($request.taskRoot -cne $expectedTaskRoot){throw 'Candidate task root differs from hosted ownership root'}
    foreach($binding in @{expectedRunId=$RunId;expectedRunAttempt=$RunAttempt;expectedEventSha=$EventSha;expectedSourceSha=$SourceSha
        expectedImageVersion=$ImageVersion;nonce=$ExpectedNonce}.GetEnumerator()){if($request.($binding.Key) -cne $binding.Value){throw 'Hosted candidate identity differs'}}
    foreach($pathName in @('candidatePath','workingDirectory','controllerPath')){if(-not (Test-Path -LiteralPath $request.$pathName)){throw "Hosted candidate $pathName is absent"}}
    $controllerStream=[IO.File]::Open($request.controllerPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{
        if($controllerStream.Length -lt 2 -or $controllerStream.Length -gt $script:MaximumControllerBytes){throw 'Hosted candidate controller size differs'}
        $controllerBytes=New-Object byte[] ([int]$controllerStream.Length);$offset=0
        while($offset -lt $controllerBytes.Length){$read=$controllerStream.Read($controllerBytes,$offset,$controllerBytes.Length-$offset);if($read -eq 0){throw 'Hosted candidate controller read was short'};$offset+=$read}
    }finally{$controllerStream.Dispose()}
    $controllerSha=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($controllerBytes)).Replace('-','').ToLowerInvariant()
    if($controllerSha -cne $request.controllerSha256){throw 'Hosted candidate controller SHA differs'}
    $controllerText=[Text.UTF8Encoding]::new($false,$true).GetString($controllerBytes)
    $controllerScript=[scriptblock]::Create($controllerText)
    $controllerModule=New-Module -ScriptBlock {param($trustedControllerScript);. $trustedControllerScript -Mode Library;Export-ModuleMember -Function Get-MyspeedCleanNativeSource} -ArgumentList $controllerScript
    try{
        $nativeSource=Invoke-MyspeedCandidateModuleCommand $controllerModule 'Get-MyspeedCleanNativeSource'
        foreach($entry in @(
            @($Path,'Candidate request path','File'),@($request.taskRoot,'Candidate task root','Directory'),
            @($request.workingDirectory,'Candidate working directory','Directory'),@($request.candidatePath,'Candidate executable','File'),
            @($request.controllerPath,'Candidate controller','File'),@($request.stdoutPath,'Candidate stdout','Absent'),
            @($request.stderrPath,'Candidate stderr','Absent'),@($request.readyPath,'Candidate ready','Absent'),
            @($request.stopRequestPath,'Candidate stop request','Absent'),@($request.resultPath,'Candidate result','Absent'))){
            Invoke-MyspeedCandidateModuleCommand $controllerModule 'Assert-MyspeedCleanPhysicalPath' $entry|Out-Null
        }
    }finally{Remove-Module $controllerModule -Force}
    Add-Type -TypeDefinition $nativeSource -Language CSharp
    $operations=New-MyspeedCandidateNativeOperations $request $watch
    $result=Invoke-MyspeedCandidateLifecycleCore $request $operations
    Write-MyspeedCandidateJson $request.resultPath $result
    if($result.status -cne 'completed'){throw 'Hosted candidate lifecycle did not pass'}
    return $result
}

if($Mode -ceq 'Library'){return}
try{
    $output=switch($Mode){
        'GetContract' {[pscustomobject][ordered]@{schemaVersion=1;kind=$script:RequestKind;aliases=$script:AllowedAliases;scenarios=$script:AllowedScenarios
            normalDeadlineMs=$script:NormalDeadlineMs;hardDeadlineMs=$script:HardDeadlineMs;qualifying=$false;releaseGatesCleared=@()}}
        'ValidateRequest' {Assert-MyspeedCandidateRequest (ConvertFrom-MyspeedCandidateJson $InputJson 'Candidate request')}
        'ValidateFileIdentity' {$value=ConvertFrom-MyspeedCandidateJson $InputJson 'Candidate identity fixture'
            Assert-MyspeedCandidateKeys $value @('path','expectedSha256','maximumBytes','observation') 'Candidate identity fixture'
            Assert-MyspeedCandidateFileIdentity $value.observation $value.path $value.expectedSha256 $value.maximumBytes}
        'TestLifecycle' {Invoke-MyspeedCandidateInjectedLifecycle (ConvertFrom-MyspeedCandidateJson $InputJson 'Injected candidate lifecycle')}
        'InvokeHostedCandidate' {Invoke-MyspeedHostedCandidate $RequestPath $ExpectedRequestSha256 $ExpectedRunId $ExpectedRunAttempt $ExpectedEventSha $ExpectedSourceSha $ExpectedImageVersion $Nonce}
    }
    $output|ConvertTo-Json -Depth 30 -Compress
}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}
