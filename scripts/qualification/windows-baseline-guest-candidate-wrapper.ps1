[CmdletBinding()]
param(
    [ValidateSet('Library','TestGuard','TestActualGuard','TestControllerBinding','TestOwnedListener','ObserveOwnedListener','InspectCandidate','InvokeGuestCandidate')]
    [string] $Mode='Library',
    [string] $InputJson='{}',
    [string] $RequestPath='',
    [string] $ExpectedRequestSha256='',
    [string] $CandidateControllerPath='',
    [string] $ExpectedCandidateControllerSha256='',
    [string] $CleanStopControllerPath='',
    [string] $ExpectedCleanStopControllerSha256='',
    [string] $ExpectedRunId='',
    [string] $ExpectedRunAttempt='',
    [string] $ExpectedEventSha='',
    [string] $ExpectedSourceSha='',
    [string] $ExpectedImageVersion='',
    [string] $ExpectedNonce='',
    [string] $InspectedCandidatePath='',
    [string] $ExpectedCandidateSha256='',
    [int64] $MaximumCandidateBytes=0,
    [int64] $CandidatePid=0,
    [string] $CandidateCreationTime='',
    [int64] $CandidatePort=0
)

Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$script:MaximumJsonBytes=4194304
$script:MaximumScriptBytes=2097152
$script:Profile='baseline-cpu'
$script:SeedLabel='MYSPEEDSEED'
$script:OutputLabel='MYSPEEDOUT'
$script:CandidateResultKind='myspeed-windows-native-candidate-result'
$script:AllowedIntegralTypes=@([TypeCode]::SByte,[TypeCode]::Byte,[TypeCode]::Int16,[TypeCode]::UInt16,
    [TypeCode]::Int32,[TypeCode]::UInt32,[TypeCode]::Int64,[TypeCode]::UInt64)

function Get-MyspeedBaselineGuestKeys {
    param([object]$Value)
    if($null -eq $Value -or $Value -is [string] -or $Value -is [array]){throw 'Value must be an object'}
    if($Value -is [Collections.IDictionary]){return @($Value.Keys)}
    return @($Value.PSObject.Properties.Name)
}

function Assert-MyspeedBaselineGuestKeys {
    param([object]$Value,[string[]]$Expected,[string]$Label)
    $actual=@(Get-MyspeedBaselineGuestKeys $Value|Sort-Object);$wanted=@($Expected|Sort-Object)
    if(($actual -join "`n") -cne ($wanted -join "`n")){throw "$Label schema differs"}
}

function Assert-MyspeedBaselineGuestString {
    param([object]$Value,[string]$Label,[string]$Pattern='\A[^\x00-\x1f\x7f]+\z')
    if($Value -isnot [string] -or $Value -cnotmatch $Pattern){throw "$Label differs"}
    return [string]$Value
}

function Assert-MyspeedBaselineGuestInteger {
    param([object]$Value,[string]$Label,[int64]$Minimum,[int64]$Maximum)
    if($null -eq $Value -or [Type]::GetTypeCode($Value.GetType()) -notin $script:AllowedIntegralTypes){throw "$Label differs"}
    $number=[int64]$Value;if($number -lt $Minimum -or $number -gt $Maximum){throw "$Label differs"};return $number
}

function Assert-MyspeedBaselineGuestBoolean {
    param([object]$Value,[string]$Label)
    if($Value -isnot [bool]){throw "$Label differs"};return [bool]$Value
}

function Assert-MyspeedBaselineGuestGuard {
    param([object]$Value)
    Assert-MyspeedBaselineGuestKeys $Value @('platform','is64BitProcess','psMajor','psMinor','profile','seed','output','network') 'Baseline guest guard'
    if((Assert-MyspeedBaselineGuestString $Value.platform 'Baseline guest platform') -cne 'Win32NT' -or
        -not (Assert-MyspeedBaselineGuestBoolean $Value.is64BitProcess 'Baseline guest process architecture') -or
        (Assert-MyspeedBaselineGuestInteger $Value.psMajor 'Baseline guest PowerShell major' 5 5) -ne 5 -or
        (Assert-MyspeedBaselineGuestInteger $Value.psMinor 'Baseline guest PowerShell minor' 1 1) -ne 1 -or
        (Assert-MyspeedBaselineGuestString $Value.profile 'Baseline guest profile') -cne $script:Profile){throw 'Baseline guest runtime differs'}
    foreach($binding in @(@($Value.seed,'seed',$script:SeedLabel,'CD-ROM'),@($Value.output,'output',$script:OutputLabel,'Fixed'))){
        $record=$binding[0];$label=[string]$binding[1]
        Assert-MyspeedBaselineGuestKeys $record @('count','driveType','label') "Baseline guest $label volume"
        if((Assert-MyspeedBaselineGuestInteger $record.count "Baseline guest $label volume count" 1 1) -ne 1 -or
            (Assert-MyspeedBaselineGuestString $record.label "Baseline guest $label volume label") -cne $binding[2] -or
            (Assert-MyspeedBaselineGuestString $record.driveType "Baseline guest $label drive type") -cne $binding[3]){
            throw "Baseline guest $label volume differs"
        }
    }
    Assert-MyspeedBaselineGuestKeys $Value.network @('hardwareNics','enabledNonLoopbackInterfaces','nonLoopbackRoutes') 'Baseline guest network'
    foreach($name in @('hardwareNics','enabledNonLoopbackInterfaces','nonLoopbackRoutes')){
        if((Assert-MyspeedBaselineGuestInteger $Value.network.$name "Baseline guest network $name" 0 2147483647) -ne 0){
            throw 'Baseline guest network is not isolated'
        }
    }
    return [pscustomobject][ordered]@{accepted=$true;profile=$script:Profile}
}

function Get-MyspeedBaselineGuestActualGuard {
    $seed=@(Get-Volume -FileSystemLabel $script:SeedLabel -ErrorAction Stop)
    $output=@(Get-Volume -FileSystemLabel $script:OutputLabel -ErrorAction Stop)
    $physical=@(Get-CimInstance Win32_NetworkAdapter -ErrorAction Stop|Where-Object{$_.PhysicalAdapter -eq $true})
    $enabled=@(Get-NetAdapter -IncludeHidden -ErrorAction Stop|Where-Object{$_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Loopback'})
    $routes=@(Get-NetRoute -ErrorAction Stop|Where-Object{$_.InterfaceAlias -notmatch 'Loopback'})
    return [pscustomobject][ordered]@{platform=[Environment]::OSVersion.Platform.ToString();is64BitProcess=[Environment]::Is64BitProcess
        psMajor=[int]$PSVersionTable.PSVersion.Major;psMinor=[int]$PSVersionTable.PSVersion.Minor;profile=$script:Profile
        seed=[pscustomobject][ordered]@{count=$seed.Count;driveType=if($seed.Count -eq 1){[string]$seed[0].DriveType}else{''};label=$script:SeedLabel}
        output=[pscustomobject][ordered]@{count=$output.Count;driveType=if($output.Count -eq 1){[string]$output[0].DriveType}else{''};label=$script:OutputLabel}
        network=[pscustomobject][ordered]@{hardwareNics=$physical.Count;enabledNonLoopbackInterfaces=$enabled.Count;nonLoopbackRoutes=$routes.Count}}
}

function Read-MyspeedBaselineGuestBytes {
    param([string]$Path,[string]$ExpectedSha,[int64]$MaximumBytes,[string]$Label)
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
    try{
        if($stream.Length -lt 1 -or $stream.Length -gt $MaximumBytes){throw "$Label size differs"}
        $bytes=[byte[]]::new([int]$stream.Length);$offset=0
        while($offset -lt $bytes.Length){$count=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($count -le 0){throw "$Label read was truncated"};$offset+=$count}
        $hash=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-','').ToLowerInvariant()
        if($hash -cne $ExpectedSha){throw "$Label SHA differs"};return $bytes
    }finally{$stream.Dispose()}
}

function Read-MyspeedBaselineGuestJson {
    param([string]$Path,[string]$ExpectedSha,[string]$Label)
    $bytes=Read-MyspeedBaselineGuestBytes $Path $ExpectedSha $script:MaximumJsonBytes $Label
    try{return [pscustomobject]@{value=([Text.UTF8Encoding]::new($false,$true).GetString($bytes)|ConvertFrom-Json);sha256=$ExpectedSha}}
    catch{throw "$Label is not valid UTF-8 JSON"}
}

function Write-MyspeedBaselineGuestJson {
    param([string]$Path,[object]$Value)
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Compress -Depth 30))
    if($bytes.Length -lt 2 -or $bytes.Length -gt $script:MaximumJsonBytes){throw 'Baseline guest result size differs'}
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}

function Assert-MyspeedBaselineGuestControllerBinding {
    param([string]$RequestControllerPath,[string]$RequestControllerSha,[string]$TrustedControllerPath,
        [string]$TrustedControllerSha)
    if($RequestControllerSha -cne $TrustedControllerSha){throw 'Baseline controller hash binding differs'}
    $requestBytes=Read-MyspeedBaselineGuestBytes $RequestControllerPath $RequestControllerSha $script:MaximumScriptBytes `
        'Baseline task-root controller'
    $trustedBytes=Read-MyspeedBaselineGuestBytes $TrustedControllerPath $TrustedControllerSha $script:MaximumScriptBytes `
        'Baseline trusted controller'
    if(-not [Collections.StructuralComparisons]::StructuralEqualityComparer.Equals($requestBytes,$trustedBytes)){
        throw 'Baseline controller bytes differ'
    }
    return [pscustomobject]@{accepted=$true;bytes=$trustedBytes}
}

function Get-MyspeedBaselineGuestCandidateIdentity {
    param([string]$Path,[string]$Sha,[int64]$Maximum,[string]$CandidatePath,[string]$CandidateSha,
        [string]$CleanPath,[string]$CleanSha)
    # The actual guest/volume/network boundary must precede script reads, Add-Type, and native identity access.
    [void](Assert-MyspeedBaselineGuestGuard (Get-MyspeedBaselineGuestActualGuard))
    $candidateBytes=Read-MyspeedBaselineGuestBytes $CandidatePath $CandidateSha $script:MaximumScriptBytes `
        'Candidate controller'
    $cleanBytes=Read-MyspeedBaselineGuestBytes $CleanPath $CleanSha $script:MaximumScriptBytes 'Clean-stop controller'
    $candidateScript=[scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($candidateBytes))
    $cleanScript=[scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($cleanBytes))
    $candidateModule=$null;$cleanModule=$null
    try{
        $candidateModule=New-Module -ScriptBlock {param($trusted). $trusted -Mode Library
            Export-ModuleMember -Function Get-MyspeedCandidateFileIdentity} -ArgumentList $candidateScript
        $cleanModule=New-Module -ScriptBlock {param($trusted). $trusted -Mode Library
            Export-ModuleMember -Function Get-MyspeedCleanNativeSource} -ArgumentList $cleanScript
        $nativeSource=& $cleanModule {Get-MyspeedCleanNativeSource};Add-Type -TypeDefinition $nativeSource -Language CSharp
        return & $candidateModule {param($value,$digest,$bound)Get-MyspeedCandidateFileIdentity $value $digest $bound} `
            $Path $Sha $Maximum
    }finally{
        if($null -ne $candidateModule){Remove-Module $candidateModule -Force -ErrorAction SilentlyContinue}
        if($null -ne $cleanModule){Remove-Module $cleanModule -Force -ErrorAction SilentlyContinue}
    }
}

function Assert-MyspeedBaselineOwnedListener {
    param([object]$Process,[object[]]$Listeners,[int64]$ExpectedPid,[string]$ExpectedCreation,[int64]$ExpectedPort)
    [void](Assert-MyspeedBaselineGuestInteger $ExpectedPid 'Baseline listener candidate PID' 1 4294967295)
    [void](Assert-MyspeedBaselineGuestString $ExpectedCreation 'Baseline listener candidate creation time' '\A[0-9a-f]{16}\z')
    [void](Assert-MyspeedBaselineGuestInteger $ExpectedPort 'Baseline listener port' 1 65535)
    Assert-MyspeedBaselineGuestKeys $Process @('pid','creationTime','exited') 'Baseline listener process'
    if((Assert-MyspeedBaselineGuestInteger $Process.pid 'Baseline listener observed PID' 1 4294967295) -ne $ExpectedPid -or
        (Assert-MyspeedBaselineGuestString $Process.creationTime 'Baseline listener observed creation time' '\A[0-9a-f]{16}\z') -cne $ExpectedCreation -or
        (Assert-MyspeedBaselineGuestBoolean $Process.exited 'Baseline listener process exited')){throw 'Baseline listener process identity differs'}
    $onPort=@($Listeners|Where-Object{[int64]$_.port -eq $ExpectedPort})
    foreach($listener in $onPort){
        Assert-MyspeedBaselineGuestKeys $listener @('address','port','pid') 'Baseline listener observation'
        [void](Assert-MyspeedBaselineGuestInteger $listener.port 'Baseline listener observed port' 1 65535)
        [void](Assert-MyspeedBaselineGuestInteger $listener.pid 'Baseline listener owner PID' 1 4294967295)
        [void](Assert-MyspeedBaselineGuestString $listener.address 'Baseline listener address')
        if($listener.address -in @('0.0.0.0','::','*')){throw 'Baseline candidate exposed a wildcard listener'}
        if($listener.address -notin @('127.0.0.1','::1') -or [int64]$listener.pid -ne $ExpectedPid){
            throw 'Baseline listener owner or address differs'
        }
    }
    $exact=@($onPort|Where-Object{$_.address -ceq '127.0.0.1'})
    if($exact.Count -eq 0){return [pscustomobject][ordered]@{listenerOwned=$false;candidatePid=$ExpectedPid
            candidateCreationTime=$ExpectedCreation;port=$ExpectedPort}}
    return [pscustomobject][ordered]@{listenerOwned=$true;candidatePid=$ExpectedPid
        candidateCreationTime=$ExpectedCreation;port=$ExpectedPort}
}

function Get-MyspeedBaselineOwnedListener {
    param([int64]$ExpectedPid,[string]$ExpectedCreation,[int64]$ExpectedPort)
    [void](Assert-MyspeedBaselineGuestGuard (Get-MyspeedBaselineGuestActualGuard))
    $process=Get-Process -Id $ExpectedPid -ErrorAction Stop
    try{
        $observed=[pscustomobject]@{pid=[int64]$process.Id;creationTime=([uint64]($process.StartTime.ToFileTimeUtc())).ToString('x16')
            exited=[bool]$process.HasExited}
        $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object{$_.LocalPort -eq $ExpectedPort}|ForEach-Object{
            [pscustomobject]@{address=[string]$_.LocalAddress;port=[int64]$_.LocalPort;pid=[int64]$_.OwningProcess}})
        $process.Refresh()
        $after=[pscustomobject]@{pid=[int64]$process.Id;creationTime=([uint64]($process.StartTime.ToFileTimeUtc())).ToString('x16')
            exited=[bool]$process.HasExited}
        [void](Assert-MyspeedBaselineOwnedListener $after $listeners $ExpectedPid $ExpectedCreation $ExpectedPort)
        return Assert-MyspeedBaselineOwnedListener $observed $listeners $ExpectedPid $ExpectedCreation $ExpectedPort
    }finally{$process.Dispose()}
}

function Invoke-MyspeedBaselineGuestCandidate {
    param([string]$Path,[string]$Sha,[string]$CandidatePath,[string]$CandidateSha,
        [string]$CleanPath,[string]$CleanSha,[string]$RunId,[string]$RunAttempt,[string]$EventSha,
        [string]$SourceSha,[string]$ImageVersion,[string]$Nonce)
    # Guest/volume/network guards must remain before request or script I/O and before Add-Type/native calls.
    [void](Assert-MyspeedBaselineGuestGuard (Get-MyspeedBaselineGuestActualGuard))
    $loaded=Read-MyspeedBaselineGuestJson $Path $Sha 'Baseline candidate request'
    $candidateBytes=Read-MyspeedBaselineGuestBytes $CandidatePath $CandidateSha $script:MaximumScriptBytes 'Candidate controller'
    $candidateScript=[scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($candidateBytes))
    $candidateModule=$null;$cleanModule=$null
    try{
        $candidateModule=New-Module -ScriptBlock {param($trusted). $trusted -Mode Library;Export-ModuleMember -Function Assert-MyspeedCandidateRequest,New-MyspeedCandidateNativeOperations,Invoke-MyspeedCandidateLifecycleCore} -ArgumentList $candidateScript
        $request=& $candidateModule {param($value)Assert-MyspeedCandidateRequest $value} $loaded.value
        foreach($binding in @{expectedRunId=$RunId;expectedRunAttempt=$RunAttempt;expectedEventSha=$EventSha
            expectedSourceSha=$SourceSha;expectedImageVersion=$ImageVersion;nonce=$Nonce}.GetEnumerator()){
            if($request.($binding.Key) -cne $binding.Value){throw 'Baseline candidate identity differs'}
        }
        $controllerBinding=Assert-MyspeedBaselineGuestControllerBinding $request.controllerPath `
            $request.controllerSha256 $CleanPath $CleanSha
        $cleanScript=[scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($controllerBinding.bytes))
        $cleanModule=New-Module -ScriptBlock {param($trusted). $trusted -Mode Library;Export-ModuleMember -Function Get-MyspeedCleanNativeSource,Assert-MyspeedCleanPhysicalPath,Invoke-MyspeedCleanInitialConsoleCore} -ArgumentList $cleanScript
        foreach($entry in @(@($request.taskRoot,'Baseline task root','Directory'),@($request.candidatePath,'Baseline candidate','File'),
            @($request.workingDirectory,'Baseline work directory','Directory'),@($request.controllerPath,'Baseline clean-stop controller','File'),
            @($request.stdoutPath,'Baseline stdout','Absent'),@($request.stderrPath,'Baseline stderr','Absent'),
            @($request.readyPath,'Baseline ready','Absent'),@($request.stopRequestPath,'Baseline stop','Absent'),
            @($request.resultPath,'Baseline result','Absent'))){
            & $cleanModule {param($value)Assert-MyspeedCleanPhysicalPath $value[0] $value[1] $value[2]|Out-Null} $entry
        }
        $nativeSource=& $cleanModule {Get-MyspeedCleanNativeSource};Add-Type -TypeDefinition $nativeSource -Language CSharp
        # This wrapper is spawned windowsHide (CREATE_NO_WINDOW) with no console to inherit, so Windows hands it a
        # fresh hidden console it solely owns. The shared lifecycle core opens with a bare AssertConsoleFree, so detach
        # that console first via the same validated observe -> FreeConsole -> prove contract the hosted candidate uses.
        $initialConsoleOperations=[pscustomobject]@{
            observe={$native=[MySpeed.Qualification.CleanStop.Session]::ObserveInitialConsole()
                return [pscustomobject]@{processIds=@($native.processIds);error=[int64]$native.error}}
            detach={return [MySpeed.Qualification.CleanStop.Session]::DetachInitialConsole()}
            proveFree={[MySpeed.Qualification.CleanStop.Session]::AssertConsoleFree();return $true}}
        [void](& $cleanModule {param($currentPid,$operations)Invoke-MyspeedCleanInitialConsoleCore $currentPid $operations} ([int64]$PID) $initialConsoleOperations)
        $watch=[Diagnostics.Stopwatch]::StartNew()
        $result=& $candidateModule {param($value,$clock)$operations=New-MyspeedCandidateNativeOperations $value $clock
            Invoke-MyspeedCandidateLifecycleCore $value $operations} $request $watch
        Write-MyspeedBaselineGuestJson $request.resultPath $result
        if($result.status -cne 'completed' -or $result.kind -cne $script:CandidateResultKind){throw 'Baseline candidate lifecycle did not pass'}
        return $result
    }finally{
        if($null -ne $candidateModule){Remove-Module $candidateModule -Force -ErrorAction SilentlyContinue}
        if($null -ne $cleanModule){Remove-Module $cleanModule -Force -ErrorAction SilentlyContinue}
    }
}

if($Mode -ceq 'Library'){return}
try{
    $output=switch($Mode){
        'TestGuard' {Assert-MyspeedBaselineGuestGuard ($InputJson|ConvertFrom-Json)}
        'TestActualGuard' {Assert-MyspeedBaselineGuestGuard (Get-MyspeedBaselineGuestActualGuard)}
        'TestControllerBinding' {Assert-MyspeedBaselineGuestControllerBinding $RequestPath $ExpectedRequestSha256 `
            $CleanStopControllerPath $ExpectedCleanStopControllerSha256|Select-Object accepted}
        'TestOwnedListener' {$value=$InputJson|ConvertFrom-Json
            Assert-MyspeedBaselineOwnedListener $value.process @($value.listeners) $CandidatePid $CandidateCreationTime $CandidatePort}
        'ObserveOwnedListener' {Get-MyspeedBaselineOwnedListener $CandidatePid $CandidateCreationTime $CandidatePort}
        'InspectCandidate' {Get-MyspeedBaselineGuestCandidateIdentity $InspectedCandidatePath `
            $ExpectedCandidateSha256 $MaximumCandidateBytes $CandidateControllerPath `
            $ExpectedCandidateControllerSha256 $CleanStopControllerPath $ExpectedCleanStopControllerSha256}
        'InvokeGuestCandidate' {Invoke-MyspeedBaselineGuestCandidate $RequestPath $ExpectedRequestSha256 $CandidateControllerPath $ExpectedCandidateControllerSha256 $CleanStopControllerPath $ExpectedCleanStopControllerSha256 $ExpectedRunId $ExpectedRunAttempt $ExpectedEventSha $ExpectedSourceSha $ExpectedImageVersion $ExpectedNonce}
    }
    $output|ConvertTo-Json -Compress -Depth 30
}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}
