[CmdletBinding()]
param(
    [ValidateSet('Library','TestInjected','InvokeGuest')]
    [string]$Mode='Library',
    [string]$InputJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$script:SchemaVersion=1
$script:RequestKind='myspeed-windows-msi-guest-launch-request'
$script:ResultKind='myspeed-windows-msi-guest-launch-result'
$script:CpuClass='modern-msi'
$script:NodeSqliteFlag='--experimental-sqlite'
# The guest runner reads the seeded SQLite database through sqlite-check.mjs, so node prints an
# ExperimentalWarning to stderr. media-job-launcher.ps1 never captures the guest node's stdout/stderr
# today, so that warning is currently harmless here - but the baseline guest executor was held to
# exactly-empty streams and failed a full run on this same warning. Suppress it at the source so a
# future stderr gate on this launch (for parity with the baseline flow) cannot reintroduce that bug.
$script:NodeWarningSuppressionFlag='--disable-warning=ExperimentalWarning'
$script:MaximumInputCharacters=1048576
$script:MaximumDurationMilliseconds=86400000
$script:MaximumStringCharacters=1024
$script:MaximumSeedFileBytes=1073741824
$script:CreateSuspendedNoWindow=0x08000004
$script:SuccessExitCode=0
$script:Sha256Pattern='\A[0-9a-f]{64}\z'
$script:Sha1Pattern='\A[0-9a-f]{40}\z'
$script:NoncePattern='\A[0-9a-f]{32}\z'
$script:WindowsPathRootCharacters=3
$script:PathSeparator=[char]'\'
$script:ForeignPathSeparator='/'
$script:SegmentTrimmedFinalCharacters=[char[]]@(' ','.')
$script:ObserverSource={
    param($Context)
    [pscustomobject][ordered]@{schemaVersion=1;status='observed';action='observe';observation='guest-runner'}
}

function Assert-MyspeedGuestKeys {
    param($Value,[string[]]$Expected,[string]$Label)
    if($null -eq $Value -or $Value -is [string] -or $Value -is [array]){throw "$Label must be an object"}
    $actual=@($Value.PSObject.Properties.Name|Sort-Object)
    $wanted=@($Expected|Sort-Object)
    if($actual.Count -ne $wanted.Count){throw "$Label keys differ"}
    for($index=0;$index -lt $actual.Count;$index++){
        if(-not [string]::Equals($actual[$index],$wanted[$index],[StringComparison]::Ordinal)){
            throw "$Label keys differ"
        }
    }
}

function Assert-MyspeedGuestString {
    param($Value,[string]$Label,[string]$Pattern='\A[^\x00-\x1f\x7f]+\z')
    if($Value -isnot [string] -or $Value.Length -lt 1 -or
        $Value.Length -gt $script:MaximumStringCharacters -or $Value -cnotmatch $Pattern){throw "$Label differs"}
    return [string]$Value
}

function Assert-MyspeedGuestInteger {
    param($Value,[string]$Label,[int64]$Minimum,[int64]$Maximum)
    if(($Value -isnot [int] -and $Value -isnot [long]) -or
        [int64]$Value -lt $Minimum -or [int64]$Value -gt $Maximum){throw "$Label differs"}
    return [int64]$Value
}

function Assert-MyspeedGuestBoolean {
    param($Value,[string]$Label)
    if($Value -isnot [bool]){throw "$Label differs"};return [bool]$Value
}

function Assert-MyspeedGuestNumber {
    param($Value,[string]$Label)
    if($Value -isnot [ValueType] -or [double]::IsNaN([double]$Value) -or
        [double]::IsInfinity([double]$Value) -or [double]$Value -lt 0){
        throw "$Label differs"
    }
    return [double]$Value
}

function Test-MyspeedGuestCanonicalPath {
    param([string]$Candidate)
    # Windows rewrites some paths on the way to their real target, and two spellings that reach one
    # target break the identity comparisons the request is built on. Deciding that here, from the
    # string alone, keeps the verdict the same on every host: [IO.Path]::GetFullPath answers for the
    # platform it runs on, so on Linux it rejects every drive-letter path and resolves no traversal.
    $tail=$Candidate.Substring($script:WindowsPathRootCharacters)
    if($tail.Length -eq 0){return $true}
    if($tail.Contains($script:ForeignPathSeparator)){return $false}
    foreach($segment in $tail.Split($script:PathSeparator)){
        # An empty segment is a doubled or trailing separator; a final space or dot is what Windows
        # trims, which is also what makes '.' and '..' unusable here.
        if($segment.Length -eq 0 -or
            $script:SegmentTrimmedFinalCharacters -ccontains $segment[$segment.Length-1]){return $false}
    }
    return $true
}

function Assert-MyspeedGuestPath {
    param($Value,[string]$Label,[string]$Root=$null,[bool]$AllowRoot=$false)
    $candidate=Assert-MyspeedGuestString $Value $Label '\A[A-Za-z]:\\[^\x00-\x1f\x7f:*?"<>|]*\z'
    if(-not (Test-MyspeedGuestCanonicalPath $candidate)){throw "$Label is not canonical"}
    if(-not [string]::IsNullOrEmpty($Root)){
        $prefix=$Root.TrimEnd('\')+'\'
        $same=[string]::Equals($candidate,$Root,[StringComparison]::OrdinalIgnoreCase)
        if(($same -and -not $AllowRoot) -or (-not $same -and
            -not $candidate.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase))){throw "$Label escapes its root"}
    }
    return $candidate
}

function Assert-MyspeedGuestFileBinding {
    param($Value,[string]$Label,[string]$SeedRoot)
    Assert-MyspeedGuestKeys $Value @('path','bytes','sha256') $Label
    [void](Assert-MyspeedGuestPath $Value.path "$Label path" $SeedRoot)
    [void](Assert-MyspeedGuestInteger $Value.bytes "$Label bytes" 1 $script:MaximumSeedFileBytes)
    [void](Assert-MyspeedGuestString $Value.sha256 "$Label SHA-256" $script:Sha256Pattern)
}

function Assert-MyspeedMsiGuestLaunchRequest {
    param($Value)
    Assert-MyspeedGuestKeys $Value @('schemaVersion','kind','qualifying','sourceSha','eventSha','runId',
        'runAttempt','nonce','observerSha256','guest','files','semanticOutputPath','launcherOutputPath',
        'wallDeadlineUnixMilliseconds','maximumDurationMilliseconds','maximumSemanticResultBytes') 'Guest launch request'
    [void](Assert-MyspeedGuestInteger $Value.schemaVersion 'Guest launch schema' 1 1)
    if((Assert-MyspeedGuestString $Value.kind 'Guest launch kind') -cne $script:RequestKind){throw 'Guest launch kind differs'}
    if(Assert-MyspeedGuestBoolean $Value.qualifying 'Guest launch qualifying'){throw 'Guest launch must be nonqualifying'}
    [void](Assert-MyspeedGuestString $Value.sourceSha 'Guest launch source SHA' $script:Sha1Pattern)
    [void](Assert-MyspeedGuestString $Value.eventSha 'Guest launch event SHA' $script:Sha1Pattern)
    [void](Assert-MyspeedGuestString $Value.runId 'Guest launch run ID' '\A[1-9][0-9]{0,19}\z')
    [void](Assert-MyspeedGuestString $Value.runAttempt 'Guest launch run attempt' '\A[1-9][0-9]{0,9}\z')
    [void](Assert-MyspeedGuestString $Value.nonce 'Guest launch nonce' $script:NoncePattern)
    [void](Assert-MyspeedGuestString $Value.observerSha256 'Guest observer SHA-256' $script:Sha256Pattern)
    Assert-MyspeedGuestKeys $Value.guest @('cpuClass','serial','cpuEvidenceSha256','qemuLaunchSha256',
        'seedRoot','outputRoot') 'Guest launch guest'
    if((Assert-MyspeedGuestString $Value.guest.cpuClass 'Guest CPU class') -cne $script:CpuClass){
        throw 'Guest launch requires the modern MSI CPU class'
    }
    [void](Assert-MyspeedGuestString $Value.guest.serial 'Guest serial' $script:NoncePattern)
    [void](Assert-MyspeedGuestString $Value.guest.cpuEvidenceSha256 'Guest CPU evidence' $script:Sha256Pattern)
    [void](Assert-MyspeedGuestString $Value.guest.qemuLaunchSha256 'Guest QEMU launch' $script:Sha256Pattern)
    $seedRoot=Assert-MyspeedGuestPath $Value.guest.seedRoot 'Guest seed root'
    $outputRoot=Assert-MyspeedGuestPath $Value.guest.outputRoot 'Guest output root'
    if([string]::Equals($seedRoot,$outputRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Guest roots collide'}
    Assert-MyspeedGuestKeys $Value.files @('node','runner','launcher','semanticRequest') 'Guest launch files'
    foreach($name in @('node','runner','launcher','semanticRequest')){
        Assert-MyspeedGuestFileBinding $Value.files.$name "Guest launch $name" $seedRoot
    }
    [void](Assert-MyspeedGuestPath $Value.semanticOutputPath 'Guest semantic output' $outputRoot)
    [void](Assert-MyspeedGuestPath $Value.launcherOutputPath 'Guest launcher output' $outputRoot)
    if([string]::Equals($Value.semanticOutputPath,$Value.launcherOutputPath,[StringComparison]::OrdinalIgnoreCase)){
        throw 'Guest output paths collide'
    }
    [void](Assert-MyspeedGuestInteger $Value.wallDeadlineUnixMilliseconds 'Guest wall deadline' 1 ([int64]::MaxValue))
    [void](Assert-MyspeedGuestInteger $Value.maximumDurationMilliseconds 'Guest duration' 1 $script:MaximumDurationMilliseconds)
    [void](Assert-MyspeedGuestInteger $Value.maximumSemanticResultBytes 'Guest semantic result bound' 1 `
        $script:MaximumSeedFileBytes)
    return $Value
}

function Get-MyspeedGuestArguments {
    param($Request)
    return [string[]]@($script:NodeSqliteFlag,$script:NodeWarningSuppressionFlag,$Request.files.runner.path,'--request',
        $Request.files.semanticRequest.path,'--request-sha256',$Request.files.semanticRequest.sha256)
}

function Assert-MyspeedGuestStringArray {
    param($Value,[string[]]$Expected,[string]$Label)
    if($Value -isnot [array] -or $Value.Count -ne $Expected.Count){throw "$Label differs"}
    for($index=0;$index -lt $Expected.Count;$index++){
        if($Value[$index] -isnot [string] -or
            -not [string]::Equals($Value[$index],$Expected[$index],[StringComparison]::Ordinal)){
            throw "$Label differs"
        }
    }
}

function Test-MyspeedGuestLauncherResult {
    param($Value,$Request,$SemanticOutput)
    if($null -eq $Value -or $Value -is [string] -or $Value -is [array]){return $false}
    try{
        Assert-MyspeedGuestKeys $Value @('schemaVersion','kind','status','authorizesTransfer','executable',
            'arguments','workingDirectory','creationFlags','process','timing','timedOut','forced','exitCode',
            'processTreeExitProven','handles','observer','failure') 'Guest launcher result'
        Assert-MyspeedGuestKeys $Value.executable @('path','expectedSha256','beforeSha256','afterSha256') `
            'Guest launcher executable'
        Assert-MyspeedGuestKeys $Value.process @('processId','assignedBeforeResume','resumed','retainedHandleThroughExit') `
            'Guest launcher process'
        Assert-MyspeedGuestKeys $Value.timing @('initialWallUnixMilliseconds','initialMonotonicMilliseconds',
            'wallDeadlineUnixMilliseconds','monotonicDeadlineMilliseconds','lastWallUnixMilliseconds',
            'lastMonotonicMilliseconds','postReturnWallUnixMilliseconds','postReturnMonotonicMilliseconds') `
            'Guest launcher timing'
        Assert-MyspeedGuestKeys $Value.handles @('job','process','thread') 'Guest launcher handles'
        Assert-MyspeedGuestKeys $Value.observer @('sha256','tickCount','firstMonotonicMilliseconds',
            'lastMonotonicMilliseconds','maximumDurationMilliseconds','contextKeys','lastAction',
            'lastObservation','synchronousCancellationProven') 'Guest launcher observer'
        if((Assert-MyspeedGuestInteger $Value.schemaVersion 'Guest launcher schema' 1 1) -ne 1 -or
            (Assert-MyspeedGuestString $Value.kind 'Guest launcher kind') -cne 'myspeed-owned-job-observed-launch' -or
            (Assert-MyspeedGuestString $Value.status 'Guest launcher status') -cne 'completed' -or
            (Assert-MyspeedGuestBoolean $Value.authorizesTransfer 'Guest launcher transfer') -or
            (Assert-MyspeedGuestInteger $Value.creationFlags 'Guest launcher flags' 0 ([int64]::MaxValue)) -ne
                $script:CreateSuspendedNoWindow -or
            (Assert-MyspeedGuestInteger $Value.exitCode 'Guest launcher exit' 0 4294967295) -ne $script:SuccessExitCode -or
            (Assert-MyspeedGuestBoolean $Value.timedOut 'Guest launcher timeout') -or
            (Assert-MyspeedGuestBoolean $Value.forced 'Guest launcher forced') -or
            -not (Assert-MyspeedGuestBoolean $Value.processTreeExitProven 'Guest launcher tree')){return $false}
        if($null -ne $Value.failure -or $null -eq $SemanticOutput){return $false}
        Assert-MyspeedGuestKeys $SemanticOutput @('path','bytes','sha256') 'Guest semantic output'
        if(-not [string]::Equals($SemanticOutput.path,$Request.semanticOutputPath,[StringComparison]::Ordinal) -or
            (Assert-MyspeedGuestInteger $SemanticOutput.bytes 'Guest semantic output bytes' 1 `
                $Request.maximumSemanticResultBytes) -gt $Request.maximumSemanticResultBytes){return $false}
        [void](Assert-MyspeedGuestString $SemanticOutput.sha256 'Guest semantic output SHA-256' $script:Sha256Pattern)
        foreach($name in @('path','expectedSha256','beforeSha256','afterSha256')){
            $expected=if($name -ceq 'path'){$Request.files.node.path}else{$Request.files.node.sha256}
            if($Value.executable.$name -isnot [string] -or
                -not [string]::Equals($Value.executable.$name,$expected,[StringComparison]::Ordinal)){return $false}
        }
        Assert-MyspeedGuestStringArray $Value.arguments (Get-MyspeedGuestArguments $Request) 'Guest launcher arguments'
        if(-not [string]::Equals($Value.workingDirectory,$Request.guest.outputRoot,[StringComparison]::Ordinal)){return $false}
        foreach($name in @('assignedBeforeResume','resumed','retainedHandleThroughExit')){
            if(-not (Assert-MyspeedGuestBoolean $Value.process.$name "Guest launcher process $name")){return $false}
        }
        [void](Assert-MyspeedGuestInteger $Value.process.processId 'Guest launcher process ID' 1 4294967295)
        foreach($name in @('job','process','thread')){if($Value.handles.$name -cne 'closed'){return $false}}
        if($Value.observer.sha256 -cne $Request.observerSha256 -or
            $Value.observer.lastAction -cne 'observe' -or $Value.observer.lastObservation -cne 'guest-runner'){
            return $false
        }
        [void](Assert-MyspeedGuestInteger $Value.observer.tickCount 'Guest observer count' 1 ([int64]::MaxValue))
        if(Assert-MyspeedGuestBoolean $Value.observer.synchronousCancellationProven 'Guest observer cancellation'){
            return $false
        }
        Assert-MyspeedGuestStringArray $Value.observer.contextKeys @('schemaVersion','tick','processId',
            'wallUnixMilliseconds','monotonicMilliseconds','wallDeadlineUnixMilliseconds',
            'monotonicDeadlineMilliseconds') 'Guest observer context'
        foreach($name in @('initialWallUnixMilliseconds','initialMonotonicMilliseconds',
            'monotonicDeadlineMilliseconds','lastWallUnixMilliseconds','lastMonotonicMilliseconds',
            'postReturnWallUnixMilliseconds','postReturnMonotonicMilliseconds')){
            [void](Assert-MyspeedGuestNumber $Value.timing.$name "Guest launcher timing $name")
        }
        if([double]$Value.timing.wallDeadlineUnixMilliseconds -ne [double]$Request.wallDeadlineUnixMilliseconds -or
            [double]$Value.timing.lastWallUnixMilliseconds -lt [double]$Value.timing.initialWallUnixMilliseconds -or
            [double]$Value.timing.postReturnWallUnixMilliseconds -lt [double]$Value.timing.lastWallUnixMilliseconds -or
            [double]$Value.timing.lastMonotonicMilliseconds -lt [double]$Value.timing.initialMonotonicMilliseconds -or
            [double]$Value.timing.postReturnMonotonicMilliseconds -lt [double]$Value.timing.lastMonotonicMilliseconds){
            return $false
        }
        return $true
    }catch{return $false}
}

function New-MyspeedGuestLaunchResult {
    param($Request,$Launcher,$SemanticOutput)
    $passed=Test-MyspeedGuestLauncherResult $Launcher $Request $SemanticOutput
    return [pscustomobject][ordered]@{
        schemaVersion=$script:SchemaVersion;kind=$script:ResultKind
        status=$(if($passed){'completed'}else{'failed'});qualifying=$false;guestRunnerPassed=$passed
        semanticResultAccepted=$false;sourceSha=$Request.sourceSha;eventSha=$Request.eventSha
        runId=$Request.runId;runAttempt=$Request.runAttempt;nonce=$Request.nonce
        cpuClass=$Request.guest.cpuClass;launcher=$Launcher;semanticOutput=$SemanticOutput;releaseGatesCleared=@()
    }
}

function Get-MyspeedGuestFileSha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}

function Get-MyspeedGuestFileIdentity {
    param([string]$Path,[int64]$MaximumBytes)
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{
        $before=$stream.Length
        if($before -le 0 -or $before -gt $MaximumBytes){throw 'MSI guest semantic result exceeds its bound'}
        $sha=[Security.Cryptography.SHA256]::Create()
        try{$digest=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}
        finally{$sha.Dispose()}
        if($stream.Length -ne $before){throw 'MSI guest semantic result changed while reading'}
        return [pscustomobject][ordered]@{path=$Path;bytes=[int64]$before;sha256=$digest}
    }finally{$stream.Dispose()}
}

function Write-MyspeedGuestCreateNewJson {
    param([string]$Path,$Value)
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 32 -Compress))
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose();[Array]::Clear($bytes,0,$bytes.Length)}
}

function Assert-MyspeedMsiGuestContext {
    param($Request)
    if($env:GITHUB_ACTIONS -eq 'true'){throw 'MSI guest execution cannot impersonate a hosted runner'}
    if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT){throw 'MSI guest execution requires Windows'}
    foreach($name in @('node','runner','launcher','semanticRequest')){
        $file=$Request.files.$name
        if(-not (Test-Path -LiteralPath $file.path -PathType Leaf) -or
            (Get-Item -LiteralPath $file.path -Force -ErrorAction Stop).Length -ne $file.bytes -or
            (Get-MyspeedGuestFileSha256 $file.path) -cne $file.sha256){throw 'MSI guest seed identity differs'}
    }
    if(Test-Path -LiteralPath $Request.semanticOutputPath -or Test-Path -LiteralPath $Request.launcherOutputPath){
        throw 'MSI guest output collision'
    }
    $bios=Get-CimInstance Win32_BIOS -ErrorAction Stop
    $computer=Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
    $adapters=@(Get-NetAdapter -IncludeHidden -ErrorAction Stop|Where-Object HardwareInterface)
    if($bios.SerialNumber -cne $Request.guest.serial -or $computer.Manufacturer -notmatch '\AQEMU' -or
        $adapters.Count -ne 0){throw 'MSI guest hardware boundary differs'}
}

function Invoke-MyspeedMsiGuest {
    param($Request)
    Assert-MyspeedMsiGuestContext $Request
    . $Request.files.launcher.path
    $observer=$script:ObserverSource
    $observerSha=Get-MediaJobScriptBlockSha256 $observer
    if($observerSha -cne $Request.observerSha256){throw 'MSI guest observer binding differs'}
    $launcher=Invoke-ObservedOwnedJobProcess -Executable $Request.files.node.path `
        -ExpectedExecutableSha256 $Request.files.node.sha256 -ArgumentList (Get-MyspeedGuestArguments $Request) `
        -WorkingDirectory $Request.guest.outputRoot -WallDeadlineUnixMilliseconds $Request.wallDeadlineUnixMilliseconds `
        -MaximumDurationMilliseconds $Request.maximumDurationMilliseconds -Observer $observer `
        -ExpectedObserverSha256 $observerSha
    foreach($name in @('node','runner','launcher','semanticRequest')){
        $file=$Request.files.$name
        if((Get-MyspeedGuestFileSha256 $file.path) -cne $file.sha256){throw 'MSI guest seed identity changed'}
    }
    $semanticOutput=if(Test-Path -LiteralPath $Request.semanticOutputPath -PathType Leaf){
        Get-MyspeedGuestFileIdentity $Request.semanticOutputPath $Request.maximumSemanticResultBytes
    }else{$null}
    $result=New-MyspeedGuestLaunchResult $Request $launcher $semanticOutput
    Write-MyspeedGuestCreateNewJson $Request.launcherOutputPath $result
    return $result
}

if($Mode -ceq 'Library'){return}
try{
    if([string]::IsNullOrWhiteSpace($InputJson) -or $InputJson.Length -gt $script:MaximumInputCharacters){
        throw 'Guest launch input differs'
    }
    $inputValue=$InputJson|ConvertFrom-Json -ErrorAction Stop
    $result=switch($Mode){
        'TestInjected' {
            Assert-MyspeedGuestKeys $inputValue @('request','launcher','semanticOutput') 'Injected guest launch'
            $request=Assert-MyspeedMsiGuestLaunchRequest $inputValue.request
            New-MyspeedGuestLaunchResult $request $inputValue.launcher $inputValue.semanticOutput
        }
        'InvokeGuest' {
            $request=Assert-MyspeedMsiGuestLaunchRequest $inputValue
            Invoke-MyspeedMsiGuest $request
        }
    }
    $result|ConvertTo-Json -Depth 32 -Compress
}catch{Write-Error $_.Exception.Message;exit 1}
