[CmdletBinding()]
param(
    [ValidateSet('Library','GetContract','ValidateManifest','AssertContext','ValidateRecoveryRequest','ValidateEnvironmentOwnership',
        'ValidateRecoveryReadiness','ProjectIpState','ProjectOwnedProcesses','TestRecoveryTaskCleanup',
        'NormalizeAdapters','GetInertChildSource',
        'ClassifyBoundary','ValidateProbe','AssessRecovery','TestLifecycle','TestNativeController','TestPortPreflight',
        'EmitClosureManifest','InvokeHostedCanary',
        'TestRecoveryRace','InvokeRestorationOnly','InvokePostReconnect')]
    [string]$Mode = 'Library',
    [string]$InputJson = '{}',
    [string]$ExpectedRunId,
    [string]$ExpectedRunAttempt,
    [string]$ExpectedSourceSha,
    [string]$ExpectedEventSha,
    [string]$ExpectedImageVersion,
    [string]$Nonce,
    [string]$ClosureRoot,
    [string]$ManifestPath,
    [string]$EvidencePath,
    [string]$RequestPath,
    [string]$ExpectedRequestSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:SchemaVersion = 1
$script:OfflineMaximumSeconds = 60
$script:MillisecondsPerSecond = 1000
$script:HundredNanosecondsPerMillisecond = 10000
$script:OfflineMaximum100ns = 600000000
$script:SoftwareLoopbackInterfaceType = 24
$script:EnabledInterfaceAdminStatus = 1
$script:DisabledInterfaceAdminStatus = 2
$script:KnownAdapterStatuses = @('Up','Disconnected','Disabled','Not Present','Lower Layer Down','Unknown','Dormant')
$script:MaximumConfigurationBytes = 4096
$script:MaximumReportedEnvironmentNames = 8
$script:MaximumReportedEnvironmentNameCharacters = 64
$script:MaximumRequestBytes = 65536
$script:MaximumEvidenceBytes = 262144
$script:MaximumOwnedAggregateBytes = 33554432
$script:CompilerDeadlineMilliseconds = 30000
$script:ServiceDeadlineSeconds = 10
$script:RecoveryPollMilliseconds = 100
$script:MaximumExceptionInnerDepth = 8
$script:SharingViolationWin32Code = 32
$script:MaximumRecoveryReadDeadlineMilliseconds = $script:ServiceDeadlineSeconds * $script:MillisecondsPerSecond
$script:NativeControllerPhases = @('prepare','armRecovery','disableAdapters','verifyOffline','startService','probe',
    'teardownService','restoreAdapters','disarmRecovery','restoreEnvironment')
$script:ChildResultFilename = 'probe.json'
$script:RecoveryRequestFilename = 'recovery.request.json'
$script:EvidenceFilename = 'result.json'
$script:OwnershipFilename = 'service.ownership.json'
$script:EnvironmentOwnershipFilename = 'environment.ownership.json'
$script:TaskOwnershipFilename = 'task.ownership.json'
$script:ProcessCleanupMilliseconds = 5000
$script:TcpConnectMilliseconds = 1000
$script:ExpectedSystemSid = 'S-1-5-18'
$script:EnvironmentRegistryPath = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
$script:ExpectedRepository = 'i7Gamer/MySpeed'
$script:ExpectedImageOS = 'win25-vs2026'
$script:RecoveryRequestKind = 'myspeed-winsw-offline-recovery-request'
$script:MaximumSourceBytes = 262144
$script:ExpectedWinswBytes = 18286774
$script:MaximumWinswBytes = 20971520
$script:MaximumCompilerBytes = 16777216
$script:NetLuidHexFormat = 'x16'
$script:NetLuidPattern = '\A[0-9a-f]{16}\z'
$script:ZeroNetLuidHex = '0000000000000000'
$script:WinswSha256 = 'a2daa6a33a9c2b791ae31d9092e7935c339d1e03e89bfb747618ce2f4e819e20'
$script:ClosureKind = 'myspeed-winsw-offline-canary-closure'
$script:RequiredClosureFiles = @('windows-winsw-offline-canary.ps1','WinSW-x64.exe')
$script:LoopbackEndpoints = @(
    [pscustomobject]@{transport='tcp';addressFamily='ipv4';address='127.0.0.1';port=43128}
    [pscustomobject]@{transport='tcp';addressFamily='ipv6';address='::1';port=43129}
    [pscustomobject]@{transport='udp';addressFamily='ipv4';address='127.0.0.1';port=43130}
    [pscustomobject]@{transport='udp';addressFamily='ipv6';address='::1';port=43131}
)
$script:TestNetEndpoints = @(
    [pscustomobject]@{transport='tcp';addressFamily='ipv4';address='192.0.2.1';port=43132}
    [pscustomobject]@{transport='tcp';addressFamily='ipv6';address='2001:db8::1';port=43133}
    [pscustomobject]@{transport='udp';addressFamily='ipv4';address='192.0.2.1';port=43134}
    [pscustomobject]@{transport='udp';addressFamily='ipv6';address='2001:db8::1';port=43135}
)
$script:NormalPhases = @('snapshot','prepare','armRecovery','disableAdapters','verifyOffline','startService','probe',
    'teardownService','restoreAdapters','disarmRecovery','restoreEnvironment')
$script:NormalRecoveryOrder = @('teardownService','restoreAdapters','disarmRecovery','restoreEnvironment')
$script:EmergencyRecoveryOrder = @('emergencyRestore','postReconnectCleanup')
$script:FailedCleanupOrder = @('postReconnectCleanup')
$script:ExpectedEnvironment = [ordered]@{
    SERVER_HOST='127.0.0.1';SERVER_PORT='43127';HTTPS_REDIRECT='false';DB_TYPE='sqlite'
    RUN_TEST_ON_STARTUP='false';PREVIEW_MODE='false';ALLOW_NO_PASSWORD='false';ALLOW_LOCAL_NODES='false'
}
$script:ClearedServiceEnvironmentNames = @('AZURE_CONFIG_DIR','AZURE_DEVOPS_CACHE_DIR','AZURE_EXTENSION_DIR','PGPASSWORD')

function Assert-MyspeedCanaryExactKeys {
    param([object]$Value,[string[]]$Expected,[string]$Label)
    if ($null -eq $Value -or $Value -is [string] -or $Value -is [array]) { throw "$Label must be an object" }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $wanted = @($Expected | Sort-Object)
    if (($actual -join "`n") -cne ($wanted -join "`n")) { throw "$Label schema differs" }
}

function Assert-MyspeedCanaryString {
    param([object]$Value,[string]$Label,[string]$Pattern='^.+$')
    if ($Value -isnot [string] -or $Value -cnotmatch $Pattern) { throw "$Label must be an exact string" }
    return [string]$Value
}

function Assert-MyspeedCanaryBoolean {
    param([object]$Value,[string]$Label)
    if ($Value -isnot [bool]) { throw "$Label must be a Boolean" }
    return [bool]$Value
}

function Assert-MyspeedCanaryInteger {
    param([object]$Value,[string]$Label,[int64]$Minimum=0,[int64]$Maximum=[int64]::MaxValue)
    if ($null -eq $Value -or [Type]::GetTypeCode($Value.GetType()) -notin @(
        [TypeCode]::SByte,[TypeCode]::Byte,[TypeCode]::Int16,[TypeCode]::UInt16,
        [TypeCode]::Int32,[TypeCode]::UInt32,[TypeCode]::Int64)) { throw "$Label must be an integer" }
    $number = [int64]$Value
    if ($number -lt $Minimum -or $number -gt $Maximum) { throw "$Label is outside its bound" }
    return $number
}

function ConvertTo-MyspeedCanaryUInt64BigInteger {
    param([object]$Value,[string]$Label)
    $text=Assert-MyspeedCanaryString $Value $Label '^(0|[1-9][0-9]*)$'
    try { $number=[Numerics.BigInteger]::Parse($text,[Globalization.CultureInfo]::InvariantCulture) }
    catch { throw "$Label is not an unsigned integer" }
    if ($number -gt [Numerics.BigInteger][uint64]::MaxValue) { throw "$Label exceeds uint64" }
    return $number
}

function Get-MyspeedCanaryElapsedMilliseconds {
    param([object]$Start100ns,[object]$End100ns)
    $start=ConvertTo-MyspeedCanaryUInt64BigInteger $Start100ns 'Elapsed start'
    $end=ConvertTo-MyspeedCanaryUInt64BigInteger $End100ns 'Elapsed end'
    if($end -lt $start){throw 'Elapsed end precedes start'}
    return [int64](($end-$start)/[Numerics.BigInteger]$script:HundredNanosecondsPerMillisecond)
}

function Assert-MyspeedCanaryArray {
    param([object]$Value,[string]$Label)
    if ($Value -isnot [array]) { throw "$Label must be an array" }
    Write-Output -NoEnumerate ([object[]]$Value)
}

function Assert-MyspeedCanaryOrderedStrings {
    param([object]$Actual,[string[]]$Expected,[string]$Label)
    $values = Assert-MyspeedCanaryArray $Actual $Label
    if ($values.Count -ne $Expected.Count) { throw "$Label count differs" }
    for ($index=0;$index -lt $Expected.Count;$index++) {
        if ($values[$index] -isnot [string] -or $values[$index] -cne $Expected[$index]) { throw "$Label order differs" }
    }
}

function ConvertFrom-MyspeedCanaryNativeNetLuid {
    param([object]$Value,[string]$Label)
    if($null -eq $Value -or [Type]::GetTypeCode($Value.GetType()) -notin @(
        [TypeCode]::SByte,[TypeCode]::Byte,[TypeCode]::Int16,[TypeCode]::UInt16,
        [TypeCode]::Int32,[TypeCode]::UInt32,[TypeCode]::Int64,[TypeCode]::UInt64)){
        throw "$Label must be an exact primitive integer NetLuid"
    }
    if($Value -le 0){throw "$Label NetLuid must be nonzero and positive"}
    return ([uint64]$Value).ToString($script:NetLuidHexFormat,[Globalization.CultureInfo]::InvariantCulture)
}

function Assert-MyspeedCanaryNetLuid {
    param([object]$Value,[string]$Label)
    if($Value -isnot [string] -or $Value -cnotmatch $script:NetLuidPattern -or $Value -ceq $script:ZeroNetLuidHex){
        throw "$Label must be a nonzero canonical 16-digit lowercase hexadecimal NetLuid"
    }
    return [string]$Value
}

function ConvertTo-MyspeedCanaryAdapterInventory {
    param([object]$Value,[int64]$LoopbackType=$script:SoftwareLoopbackInterfaceType,
        [int64]$EnabledAdminStatus=$script:EnabledInterfaceAdminStatus,
        [int64]$DisabledAdminStatus=$script:DisabledInterfaceAdminStatus,
        [string[]]$KnownStatuses=$script:KnownAdapterStatuses)
    $adapters=Assert-MyspeedCanaryArray $Value 'Native adapter inventory'
    if($adapters.Count -eq 0){throw 'Native adapter inventory is empty'}
    $normalized=[Collections.Generic.List[object]]::new()
    $guids=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $luids=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $indices=[Collections.Generic.HashSet[uint32]]::new()
    $administrativelyDownStatuses=@('Disabled','Not Present','Lower Layer Down','Unknown','Dormant')
    foreach($adapter in $adapters){
        Assert-MyspeedCanaryExactKeys $adapter @('interfaceGuid','netLuid','hidden','interfaceType',
            'interfaceAdminStatus','status','interfaceIndex') 'Native adapter'
        if($adapter.interfaceGuid -is [guid]){$guid=$adapter.interfaceGuid.ToString('B')}
        else {$guid=Assert-MyspeedCanaryString $adapter.interfaceGuid 'Native adapter GUID' `
            '^\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$'
            $guid=([guid]$guid).ToString('B')}
        $hidden=Assert-MyspeedCanaryBoolean $adapter.hidden 'Native adapter hidden flag'
        $interfaceType=Assert-MyspeedCanaryInteger $adapter.interfaceType 'Native adapter interface type' 1 4294967295
        $adminStatus=Assert-MyspeedCanaryInteger $adapter.interfaceAdminStatus 'Native adapter administrative status' `
            $EnabledAdminStatus $DisabledAdminStatus
        $status=Assert-MyspeedCanaryString $adapter.status 'Native adapter status'
        if($KnownStatuses -cnotcontains $status){throw 'Native adapter status is unknown'}
        $index=Assert-MyspeedCanaryInteger $adapter.interfaceIndex 'Native adapter interface index' 1 4294967295
        $luid=Assert-MyspeedCanaryNetLuid $adapter.netLuid `
            'Native adapter NetLuid'
        $enabled=$adminStatus -eq $EnabledAdminStatus
        # NetAdapter.Status primarily describes operational state. Administrative
        # Down does not imply its formatted value is Disabled (for example Not Present).
        # Preserve inactive hidden rows, but reject contradictory formatted states.
        if(($enabled -and $status -ceq 'Disabled') -or
            (-not $enabled -and $administrativelyDownStatuses -cnotcontains $status)){
            throw "Native adapter administrative status is inconsistent (admin=$adminStatus;status=$status)"
        }
        $duplicates=[Collections.Generic.List[string]]::new()
        if(-not $guids.Add($guid)){[void]$duplicates.Add('guid')}
        if(-not $luids.Add($luid)){[void]$duplicates.Add('luid')}
        if(-not $indices.Add([uint32]$index)){[void]$duplicates.Add('index')}
        if($duplicates.Count -gt 0){
            # Keep rejection strict; report only already validated identity facts,
            # never provider display names, addresses or environment values.
            $row=$normalized.Count+1
            throw "Native adapter identity or index is duplicated;fields=$($duplicates -join ',');row=$row;hidden=$hidden;type=$interfaceType;admin=$adminStatus;guid=$guid;luid=$luid;index=$index"
        }
        [void]$normalized.Add([pscustomobject][ordered]@{interfaceGuid=$guid;netLuid=$luid;hidden=$hidden
            interfaceType=$interfaceType;interfaceAdminStatus=$adminStatus;status=$status;interfaceIndex=$index
            loopback=($interfaceType -eq $LoopbackType);enabled=$enabled})
    }
    Write-Output -NoEnumerate ([object[]]$normalized)
}

function ConvertFrom-MyspeedCanaryNetAdapterProviderInventory {
    param([object]$Value,[int64]$LoopbackType=$script:SoftwareLoopbackInterfaceType,
        [int64]$EnabledAdminStatus=$script:EnabledInterfaceAdminStatus,
        [int64]$DisabledAdminStatus=$script:DisabledInterfaceAdminStatus,
        [string[]]$KnownStatuses=$script:KnownAdapterStatuses,[scriptblock]$NormalizeAdapters)
    $raw=Assert-MyspeedCanaryArray $Value 'Native provider adapter inventory'
    $dtos=@($raw|ForEach-Object {
        [pscustomobject]@{interfaceGuid=$_.InterfaceGuid;netLuid=(ConvertFrom-MyspeedCanaryNativeNetLuid $_.NetLuid 'Native adapter');hidden=$_.Hidden
            interfaceType=$_.InterfaceType;interfaceAdminStatus=$_.InterfaceAdminStatus
            status=$_.Status;interfaceIndex=$_.ifIndex}})
    if($null -eq $NormalizeAdapters){ConvertTo-MyspeedCanaryAdapterInventory $dtos $LoopbackType $EnabledAdminStatus `
        $DisabledAdminStatus $KnownStatuses}
    else {& $NormalizeAdapters $dtos $LoopbackType $EnabledAdminStatus $DisabledAdminStatus $KnownStatuses}
}

function Get-MyspeedCanaryAdapterProviderSnapshot {
    param([object]$Value,[scriptblock]$NormalizeProviderAdapters,
        [int64]$LoopbackType=$script:SoftwareLoopbackInterfaceType,
        [int64]$EnabledAdminStatus=$script:EnabledInterfaceAdminStatus,
        [int64]$DisabledAdminStatus=$script:DisabledInterfaceAdminStatus,
        [string[]]$KnownStatuses=$script:KnownAdapterStatuses,[scriptblock]$NormalizeAdapters)
    $raw=Assert-MyspeedCanaryArray $Value 'Native provider adapter snapshot'
    $inventory=if($null -eq $NormalizeProviderAdapters){
        ConvertFrom-MyspeedCanaryNetAdapterProviderInventory $raw $LoopbackType $EnabledAdminStatus `
            $DisabledAdminStatus $KnownStatuses $NormalizeAdapters
    } else {
        & $NormalizeProviderAdapters $raw $LoopbackType $EnabledAdminStatus $DisabledAdminStatus $KnownStatuses $NormalizeAdapters
    }
    if($inventory -isnot [array] -or $inventory.Count -ne $raw.Count -or
        @($inventory|Where-Object {$_ -is [array]}).Count -ne 0){throw 'Normalized adapter snapshot shape differs'}
    for($index=0;$index -lt $raw.Count;$index++){
        $rawGuid=([guid]$raw[$index].InterfaceGuid).ToString('B')
        $rawLuid=ConvertFrom-MyspeedCanaryNativeNetLuid $raw[$index].NetLuid `
            'Raw adapter NetLuid'
        if($inventory[$index].interfaceGuid -isnot [string] -or $inventory[$index].interfaceGuid -ine $rawGuid -or
            $inventory[$index].netLuid -isnot [string] -or
            -not [string]::Equals($inventory[$index].netLuid,$rawLuid,[StringComparison]::Ordinal)){
            throw 'Normalized adapter snapshot order differs'
        }
    }
    return [pscustomobject]@{raw=$raw;inventory=$inventory}
}

function Assert-MyspeedCanaryEnvironmentOwnership {
    param([object]$Value)
    Assert-MyspeedCanaryExactKeys $Value @('schemaVersion','names') 'Environment ownership'
    [void](Assert-MyspeedCanaryInteger $Value.schemaVersion 'Environment ownership schema' 1 1)
    Assert-MyspeedCanaryOrderedStrings $Value.names @($script:ExpectedEnvironment.Keys) 'Environment ownership names'
    return [pscustomobject]@{accepted=$true}
}

function Assert-MyspeedCanaryNormalRestoreWindow {
    param([object]$Current100ns,[object]$Deadline100ns,[object]$EmergencyResultPresent)
    $current=ConvertTo-MyspeedCanaryUInt64BigInteger $Current100ns 'Normal restoration clock'
    $deadline=ConvertTo-MyspeedCanaryUInt64BigInteger $Deadline100ns 'Normal restoration deadline'
    $emergency=Assert-MyspeedCanaryBoolean $EmergencyResultPresent 'Emergency result presence'
    if($emergency){throw 'Independent emergency restoration already ran'}
    if($current -ge $deadline){throw 'Normal restoration reached the watchdog deadline'}
    return [pscustomobject]@{accepted=$true}
}

function Assert-MyspeedCanaryEmergencyRestorationRecorded {
    param([object]$AdapterRestored,[object]$ResultWritten)
    $restored=Assert-MyspeedCanaryBoolean $AdapterRestored 'Emergency adapter restoration'
    $written=Assert-MyspeedCanaryBoolean $ResultWritten 'Emergency restoration record'
    if(-not $restored -or -not $written){throw 'Emergency restoration is not durably recorded'}
    return [pscustomobject]@{accepted=$true}
}

function Invoke-MyspeedCanaryRecoveryTaskDisposition {
    param([bool]$TaskPresent,[bool]$TaskRunning,[bool]$ReadyPresent,[scriptblock]$CancelWhenSafe,
        [scriptblock]$WaitTaskNotRunning,[scriptblock]$WaitProcessGone,[scriptblock]$UnregisterTask)
    $events=[Collections.Generic.List[string]]::new()
    if($TaskRunning){
        if(-not $TaskPresent -or -not $ReadyPresent){throw 'Running recovery task lacks exact readiness proof'}
        & $CancelWhenSafe;[void]$events.Add('cancel')
        & $WaitTaskNotRunning;[void]$events.Add('taskStopped')
    }
    if($ReadyPresent){& $WaitProcessGone;[void]$events.Add('processGone')}
    if($TaskPresent){& $UnregisterTask;[void]$events.Add('unregister')}
    return [pscustomobject]@{events=[string[]]$events}
}

function Get-MyspeedCanaryOwnedPathProcesses {
    param([object]$Value,[string[]]$OwnedPaths)
    if($OwnedPaths.Count -ne 2){throw 'Owned process path set differs'}
    $paths=@($OwnedPaths|ForEach-Object {Test-MyspeedCanaryWindowsPath $_ 'Owned process path'})
    $owned=[Collections.Generic.List[object]]::new()
    foreach($entry in (Assert-MyspeedCanaryArray $Value 'Native process inventory')){
        if($null -eq $entry.ExecutablePath){continue}
        $path=Assert-MyspeedCanaryString $entry.ExecutablePath 'Native process executable path'
        if(@($paths|Where-Object {[string]::Equals($_,$path,[StringComparison]::OrdinalIgnoreCase)}).Count -gt 0){
            $processId=Assert-MyspeedCanaryInteger $entry.ProcessId 'Native process PID' 1 4294967295
            [void]$owned.Add([pscustomobject]@{processId=$processId;executablePath=$path})
        }
    }
    $owned.ToArray()
}

function Assert-MyspeedCanaryPortPreflight {
    param([object]$TcpEndpoints,[object]$UdpEndpoints,[int[]]$FixedPorts=@($script:LoopbackEndpoints.port))
    foreach($set in @(@{value=$TcpEndpoints;label='TCP'},@{value=$UdpEndpoints;label='UDP'})){
        foreach($endpoint in (Assert-MyspeedCanaryArray $set.value "$($set.label) endpoint inventory")){
            $port=Assert-MyspeedCanaryInteger $endpoint.LocalPort "$($set.label) endpoint port" 1 65535
            if($FixedPorts -contains $port){throw "Canary port collision: $($set.label) $port"}
        }
    }
    return [pscustomobject]@{accepted=$true}
}

function Assert-MyspeedCanaryRecoveryReadiness {
    param([object]$Ready,[object]$Request,[string]$RequestSha)
    Assert-MyspeedCanaryExactKeys $Ready @('schemaVersion','sid','pid','creationFileTime','requestSha256','scriptSha256','taskName') `
        'Recovery readiness'
    [void](Assert-MyspeedCanaryInteger $Ready.schemaVersion 'Recovery readiness schema' 1 1)
    [void](Assert-MyspeedCanaryInteger $Ready.pid 'Recovery readiness PID' 1 4294967295)
    [void](Assert-MyspeedCanaryString $Ready.creationFileTime 'Recovery readiness creation time' '^[0-9a-f]{16}$')
    if($Ready.creationFileTime -ceq '0000000000000000' -or $Ready.sid -isnot [string] -or $Ready.sid -cne $script:ExpectedSystemSid -or
        $Ready.requestSha256 -isnot [string] -or $Ready.requestSha256 -cne $RequestSha -or
        $Ready.scriptSha256 -isnot [string] -or $Ready.scriptSha256 -cne $Request.scriptSha256 -or
        $Ready.taskName -isnot [string] -or $Ready.taskName -cne $Request.taskName){throw 'Recovery readiness identity differs'}
    return [pscustomobject]@{accepted=$true}
}

function ConvertTo-MyspeedCanaryKnownEnumName {
    param([object]$Value,[string[]]$Names,[string]$Label)
    if($Value -is [string]){
        if($Names -cnotcontains $Value){throw "$Label is unknown"}
        return [string]$Value
    }
    $number=Assert-MyspeedCanaryInteger $Value $Label 0 ($Names.Count-1)
    return $Names[$number]
}

function ConvertTo-MyspeedCanaryIpState {
    param([object[]]$Inventory,[object]$Interfaces,[object]$Addresses,[object]$Routes)
    $interfaceRows=Assert-MyspeedCanaryArray $Interfaces 'Native IP interface inventory'
    $addressRows=Assert-MyspeedCanaryArray $Addresses 'Native IP address inventory'
    $routeRows=Assert-MyspeedCanaryArray $Routes 'Native IP route inventory'
    $loopbackIpIndices=[Collections.Generic.HashSet[uint32]]::new()
    foreach($entry in $addressRows){
        $index=Assert-MyspeedCanaryInteger $entry.InterfaceIndex 'IP address interface index' 1 4294967295
        $literal=Assert-MyspeedCanaryString $entry.IPAddress 'IP address literal'
        try{$address=[Net.IPAddress]::Parse($literal)}catch{throw 'IP address literal is invalid'}
        if([Net.IPAddress]::IsLoopback($address)){[void]$loopbackIpIndices.Add([uint32]$index)}
    }
    $ip=[Collections.Generic.List[object]]::new()
    foreach($entry in $interfaceRows){
        $index=Assert-MyspeedCanaryInteger $entry.InterfaceIndex 'IP interface index' 1 4294967295
        $compartment=Assert-MyspeedCanaryInteger $entry.CompartmentId 'IP interface compartment' 0 4294967295
        $connection=ConvertTo-MyspeedCanaryKnownEnumName $entry.ConnectionState @('Disconnected','Connected') 'IP interface connection state'
        $matches=@($Inventory|Where-Object {$_.interfaceIndex -eq $index})
        if($matches.Count -gt 1 -or ($matches.Count -eq 0 -and -not $loopbackIpIndices.Contains([uint32]$index))){
            throw 'Non-loopback IP interface cannot be mapped unambiguously to an adapter'}
        $loop=if($matches.Count -eq 0){$true}else{$matches[0].loopback};$enabled=$matches.Count -eq 1 -and $matches[0].enabled
        [void]$ip.Add([pscustomobject]@{kind='interface';compartmentId=$compartment;loopback=$loop
            routable=(-not $loop -and $enabled -and $connection -ceq 'Connected')})
    }
    foreach($entry in $addressRows){
        $index=Assert-MyspeedCanaryInteger $entry.InterfaceIndex 'IP address interface index' 1 4294967295
        # MSFT_NetIPAddress has no CompartmentId. Its interface index must map
        # to one compartment in the complete MSFT_NetIPInterface snapshot.
        # IPv4/IPv6 rows may repeat that same compartment; ambiguity is rejected.
        $compartments=@($interfaceRows|Where-Object {$_.InterfaceIndex -eq $index}|
            ForEach-Object {$_.CompartmentId}|Sort-Object -Unique)
        if($compartments.Count -ne 1){throw 'IP address compartment cannot be mapped unambiguously'}
        $compartment=$compartments[0]
        if($entry.PSObject.Properties.Name -ccontains 'CompartmentId'){
            $reported=Assert-MyspeedCanaryInteger $entry.CompartmentId 'IP address compartment' 0 4294967295
            if($reported -ne $compartment){throw 'IP address compartment differs from its interface'}
        }
        $literal=Assert-MyspeedCanaryString $entry.IPAddress 'IP address literal';try{$address=[Net.IPAddress]::Parse($literal)}catch{throw 'IP address literal is invalid'}
        $loop=[Net.IPAddress]::IsLoopback($address);$matches=@($Inventory|Where-Object {$_.interfaceIndex -eq $index})
        if($matches.Count -gt 1 -or ($matches.Count -eq 0 -and -not $loop)){throw 'Non-loopback IP address cannot be mapped unambiguously to an adapter'}
        $enabled=$matches.Count -eq 1 -and $matches[0].enabled
        [void]$ip.Add([pscustomobject]@{kind='address';compartmentId=$compartment;loopback=$loop;routable=(-not $loop -and $enabled)})
    }
    foreach($entry in $routeRows){
        $index=Assert-MyspeedCanaryInteger $entry.InterfaceIndex 'IP route interface index' 1 4294967295
        $compartment=Assert-MyspeedCanaryInteger $entry.CompartmentId 'IP route compartment' 0 4294967295
        [void](ConvertTo-MyspeedCanaryKnownEnumName $entry.State @('Alive','Dead','Probe') 'IP route state')
        $matches=@($Inventory|Where-Object {$_.interfaceIndex -eq $index})
        if($matches.Count -gt 1 -or ($matches.Count -eq 0 -and -not $loopbackIpIndices.Contains([uint32]$index))){
            throw 'Non-loopback IP route cannot be mapped unambiguously to an adapter'}
        $loop=if($matches.Count -eq 0){$true}else{$matches[0].loopback};$enabled=$matches.Count -eq 1 -and $matches[0].enabled
        [void]$ip.Add([pscustomobject]@{kind='route';compartmentId=$compartment;loopback=$loop;routable=(-not $loop -and $enabled)})
    }
    # Inbox PowerShell decorates Write-Output -NoEnumerate arrays with Count,
    # making nested JSON serialize as {value,Count}. Return one undecorated array.
    return ,([object[]]$ip)
}

function New-MyspeedCanaryProviderProjectionOperations {
    $normalizeAdapters=${function:ConvertTo-MyspeedCanaryAdapterInventory}
    $normalizeProviderAdapters=${function:ConvertFrom-MyspeedCanaryNetAdapterProviderInventory}
    $projectIpState=${function:ConvertTo-MyspeedCanaryIpState}
    return [pscustomobject]@{
        normalizeAdapters={
            param([object]$Raw)
            & $normalizeProviderAdapters $Raw -NormalizeAdapters $normalizeAdapters
        }.GetNewClosure()
        projectIpState={
            param([object[]]$Inventory,[object]$Interfaces,[object]$Addresses,[object]$Routes)
            & $projectIpState $Inventory $Interfaces $Addresses $Routes
        }.GetNewClosure()
    }
}

function Get-MyspeedCanaryContract {
    return [pscustomobject][ordered]@{
        schemaVersion=$script:SchemaVersion
        offlineMaximumSeconds=$script:OfflineMaximumSeconds
        winswSha256=$script:WinswSha256
        winswBytes=$script:ExpectedWinswBytes
        expectedEnvironment=[pscustomobject]$script:ExpectedEnvironment
        loopbackEndpoints=$script:LoopbackEndpoints
        testNetEndpoints=$script:TestNetEndpoints
        qualifying=$false
        releaseGatesCleared=@()
    }
}

function Assert-MyspeedCanaryManifest {
    param([object]$Manifest)
    Assert-MyspeedCanaryExactKeys $Manifest @('schemaVersion','kind','expectedRunId','expectedRunAttempt',
        'expectedSourceSha','expectedEventSha','nonce','files') 'Closure manifest'
    if ((Assert-MyspeedCanaryInteger $Manifest.schemaVersion 'Manifest schema' 1 1) -ne $script:SchemaVersion) {
        throw 'Manifest schema differs'
    }
    if ((Assert-MyspeedCanaryString $Manifest.kind 'Manifest kind') -cne $script:ClosureKind) { throw 'Manifest kind differs' }
    [void](Assert-MyspeedCanaryString $Manifest.expectedRunId 'Manifest run ID' '^[1-9][0-9]*$')
    [void](Assert-MyspeedCanaryString $Manifest.expectedRunAttempt 'Manifest run attempt' '^[1-9][0-9]*$')
    [void](Assert-MyspeedCanaryString $Manifest.expectedSourceSha 'Manifest source SHA' '^[0-9a-f]{40}$')
    [void](Assert-MyspeedCanaryString $Manifest.expectedEventSha 'Manifest event SHA' '^[0-9a-f]{40}$')
    [void](Assert-MyspeedCanaryString $Manifest.nonce 'Manifest nonce' '^[0-9a-f]{32}$')
    $files = Assert-MyspeedCanaryArray $Manifest.files 'Manifest files'
    if ($files.Count -ne $script:RequiredClosureFiles.Count) { throw 'Closure file count differs' }
    for ($index=0;$index -lt $files.Count;$index++) {
        $file=$files[$index]
        Assert-MyspeedCanaryExactKeys $file @('name','bytes','sha256') 'Manifest file'
        if ((Assert-MyspeedCanaryString $file.name 'Manifest file name') -cne $script:RequiredClosureFiles[$index]) {
            throw 'Closure file order differs'
        }
        $maximum = if ($index -eq 0) { $script:MaximumSourceBytes } else { $script:MaximumWinswBytes }
        [void](Assert-MyspeedCanaryInteger $file.bytes 'Manifest file bytes' 1 $maximum)
        $sha = Assert-MyspeedCanaryString $file.sha256 'Manifest file SHA' '^[0-9a-f]{64}$'
        if ($index -eq 1 -and ($sha -cne $script:WinswSha256 -or [int64]$file.bytes -ne $script:ExpectedWinswBytes)) {
            throw 'WinSW bytes or SHA differs from the pinned closure'
        }
    }
    return [pscustomobject]@{accepted=$true}
}

function Test-MyspeedCanaryWindowsPath {
    param([object]$Value,[string]$Label)
    $path=Assert-MyspeedCanaryString $Value $Label '^[A-Za-z]:\\.+$'
    if ($path.Substring(2) -match '[:*?]' -or $path -match '[\x00-\x1f]') { throw "$Label is not a literal Windows path" }
    try { $full=[IO.Path]::GetFullPath($path) } catch { throw "$Label is invalid" }
    if (-not [string]::Equals($full,$path,[StringComparison]::OrdinalIgnoreCase)) { throw "$Label is not canonical" }
    return $full
}

function Assert-MyspeedCanaryRecoveryRequest {
    param([object]$Request)
    $keys=@('schemaVersion','kind','expectedRunId','expectedRunAttempt','expectedEventSha','expectedSourceSha',
        'expectedImageVersion','nonce','scriptPath','scriptSha256','taskRoot','lockPath','cancelPath','readyPath',
        'recoveryResultPath','cleanupResultPath','ownershipPath','taskName','serviceName','serviceExecutablePath',
        'serviceXmlPath','childPath','environment','adapters','offlineStart100ns','watchdogDeadline100ns')
    Assert-MyspeedCanaryExactKeys $Request $keys 'Recovery request'
    [void](Assert-MyspeedCanaryInteger $Request.schemaVersion 'Recovery schema' 1 1)
    if ((Assert-MyspeedCanaryString $Request.kind 'Recovery kind') -cne $script:RecoveryRequestKind) {
        throw 'Recovery request kind differs'
    }
    [void](Assert-MyspeedCanaryString $Request.expectedRunId 'Recovery run ID' '^[1-9][0-9]*$')
    [void](Assert-MyspeedCanaryString $Request.expectedRunAttempt 'Recovery run attempt' '^[1-9][0-9]*$')
    [void](Assert-MyspeedCanaryString $Request.expectedEventSha 'Recovery event SHA' '^[0-9a-f]{40}$')
    [void](Assert-MyspeedCanaryString $Request.expectedSourceSha 'Recovery source SHA' '^[0-9a-f]{40}$')
    [void](Assert-MyspeedCanaryString $Request.expectedImageVersion 'Recovery image version' '^[0-9A-Za-z._-]+$')
    $nonce=Assert-MyspeedCanaryString $Request.nonce 'Recovery nonce' '^[0-9a-f]{32}$'
    $scriptPath=Test-MyspeedCanaryWindowsPath $Request.scriptPath 'Recovery script path'
    [void](Assert-MyspeedCanaryString $Request.scriptSha256 'Recovery script SHA' '^[0-9a-f]{64}$')
    if ([IO.Path]::GetFileName($scriptPath) -cne 'windows-winsw-offline-canary.ps1') { throw 'Recovery script name differs' }
    $taskRoot=Test-MyspeedCanaryWindowsPath $Request.taskRoot 'Recovery owned root'
    $expectedRootName="myspeed-winsw-offline-$nonce"
    if ([IO.Path]::GetFileName($taskRoot) -cne $expectedRootName) { throw 'Recovery owned root differs from nonce' }
    if(-not [string]::Equals([IO.Path]::GetDirectoryName($taskRoot),
        [IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($scriptPath)),[StringComparison]::OrdinalIgnoreCase)){
        throw 'Recovery owned root and sealed script do not share the expected parent'
    }
    $paths=[ordered]@{
        lockPath='recovery.lock';cancelPath='recovery.cancel';readyPath='recovery.ready.json'
        recoveryResultPath='recovery.result.json';cleanupResultPath='cleanup.result.json'
        ownershipPath='service.ownership.json';serviceExecutablePath="MySpeedOfflineCanary-$nonce.exe"
        serviceXmlPath="MySpeedOfflineCanary-$nonce.xml";childPath='inert-child.exe'
    }
    foreach ($entry in $paths.GetEnumerator()) {
        $actual=Test-MyspeedCanaryWindowsPath $Request.($entry.Key) "Recovery $($entry.Key)"
        $expected=[IO.Path]::Combine($taskRoot,$entry.Value)
        if (-not [string]::Equals($actual,$expected,[StringComparison]::OrdinalIgnoreCase)) {
            throw "Recovery owned path differs: $($entry.Key)"
        }
    }
    if ($Request.taskName -isnot [string] -or $Request.taskName -cne "MySpeedOfflineRecovery-$nonce" -or
        $Request.serviceName -isnot [string] -or $Request.serviceName -cne "MySpeedOfflineCanary-$nonce") {
        throw 'Recovery task or service identity differs'
    }
    Assert-MyspeedCanaryExactKeys $Request.environment @($script:ExpectedEnvironment.Keys) 'Recovery environment'
    foreach ($entry in $script:ExpectedEnvironment.GetEnumerator()) {
        if ($Request.environment.($entry.Key) -isnot [string] -or $Request.environment.($entry.Key) -cne $entry.Value) {
            throw "Recovery environment differs: $($entry.Key)"
        }
    }
    $adapters=Assert-MyspeedCanaryArray $Request.adapters 'Recovery adapters'
    if ($adapters.Count -eq 0) { throw 'Recovery adapter target set is empty' }
    $guids=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $luids=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($adapter in $adapters) {
        Assert-MyspeedCanaryExactKeys $adapter @('interfaceGuid','netLuid') 'Recovery adapter'
        $guid=Assert-MyspeedCanaryString $adapter.interfaceGuid 'Recovery adapter GUID' `
            '^\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$'
        $luid=Assert-MyspeedCanaryNetLuid $adapter.netLuid `
            'Recovery adapter NetLuid'
        if (-not $guids.Add($guid) -or -not $luids.Add($luid)) { throw 'Recovery adapter identity is duplicated' }
    }
    $start=ConvertTo-MyspeedCanaryUInt64BigInteger $Request.offlineStart100ns 'Recovery offline start'
    if($start -eq [Numerics.BigInteger]::Zero){throw 'Recovery offline start is zero'}
    $deadline=ConvertTo-MyspeedCanaryUInt64BigInteger $Request.watchdogDeadline100ns 'Recovery watchdog deadline'
    $expectedDeadline=$start + ([Numerics.BigInteger]($script:OfflineMaximumSeconds * $script:MillisecondsPerSecond) *
        $script:HundredNanosecondsPerMillisecond)
    if ($deadline -ne $expectedDeadline) { throw 'Recovery watchdog deadline differs from the fixed offline maximum' }
    return [pscustomobject]@{accepted=$true}
}

function Assert-MyspeedEndpointSet {
    param([object]$Value,[string]$Label,[bool]$RequirePassed,[Nullable[int64]]$ExpectedOwnerPid,
        [object[]]$ExpectedEndpoints)
    $entries = Assert-MyspeedCanaryArray $Value $Label
    if ($entries.Count -ne $ExpectedEndpoints.Count) { throw "$Label count differs" }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $observedOwner=$null
    foreach ($entry in $entries) {
        $keys = @('transport','addressFamily','address','port','ownerPid')
        if ($RequirePassed) { $keys += 'passed' }
        Assert-MyspeedCanaryExactKeys $entry $keys $Label
        $transport=Assert-MyspeedCanaryString $entry.transport "$Label transport" '^(tcp|udp)$'
        $family=Assert-MyspeedCanaryString $entry.addressFamily "$Label address family" '^(ipv4|ipv6)$'
        $address=Assert-MyspeedCanaryString $entry.address "$Label address"
        $port=Assert-MyspeedCanaryInteger $entry.port "$Label port" 1 65535
        $owner=Assert-MyspeedCanaryInteger $entry.ownerPid "$Label owner PID" 1 4294967295
        if ($null -ne $ExpectedOwnerPid -and $owner -ne [int64]$ExpectedOwnerPid) { throw "$Label owner differs" }
        if ($null -eq $ExpectedOwnerPid -and $null -ne $observedOwner -and $owner -ne $observedOwner) {
            throw "$Label owner differs"
        }
        if ($null -eq $observedOwner) { $observedOwner=$owner }
        if ($RequirePassed -and -not (Assert-MyspeedCanaryBoolean $entry.passed "$Label passed")) { throw "$Label failed" }
        $key="$transport/$family"
        $expected=@($ExpectedEndpoints | Where-Object { "$($_.transport)/$($_.addressFamily)" -ceq $key })
        if ($expected.Count -ne 1 -or $address -cne $expected[0].address -or $port -ne $expected[0].port) {
            throw "$Label literal endpoint differs"
        }
        if (-not $seen.Add($key)) { throw "$Label contains a duplicate" }
    }
    foreach ($endpoint in $ExpectedEndpoints) {
        if (-not $seen.Contains("$($endpoint.transport)/$($endpoint.addressFamily)")) { throw "$Label is incomplete" }
    }
}

function Assert-MyspeedOfflineBoundary {
    param([object]$Boundary)
    Assert-MyspeedCanaryExactKeys $Boundary @('schemaVersion','offlineTiming','providers','adapters','ipState','loopback','testNet') 'Boundary'
    [void](Assert-MyspeedCanaryInteger $Boundary.schemaVersion 'Boundary schema' 1 1)
    Assert-MyspeedCanaryExactKeys $Boundary.offlineTiming @('clock','start100ns','end100ns','watchdogDeadline100ns',
        'elapsedMilliseconds') 'Boundary offline timing'
    if ((Assert-MyspeedCanaryString $Boundary.offlineTiming.clock 'Boundary offline clock') -cne
        'QueryUnbiasedInterruptTime100ns') { throw 'Boundary offline timing clock differs' }
    $start=ConvertTo-MyspeedCanaryUInt64BigInteger $Boundary.offlineTiming.start100ns 'Boundary offline start'
    $end=ConvertTo-MyspeedCanaryUInt64BigInteger $Boundary.offlineTiming.end100ns 'Boundary offline end'
    $deadline=ConvertTo-MyspeedCanaryUInt64BigInteger $Boundary.offlineTiming.watchdogDeadline100ns `
        'Boundary watchdog deadline'
    $maximumMilliseconds=$script:OfflineMaximumSeconds * $script:MillisecondsPerSecond
    $expectedDeadline=$start + ([Numerics.BigInteger]$maximumMilliseconds * $script:HundredNanosecondsPerMillisecond)
    if ($end -lt $start -or $deadline -ne $expectedDeadline -or $end -gt $deadline) {
        throw 'Boundary offline timing exceeds or differs from the fixed watchdog deadline'
    }
    $elapsed=Assert-MyspeedCanaryInteger $Boundary.offlineTiming.elapsedMilliseconds 'Boundary offline elapsed' 0 `
        $maximumMilliseconds
    if ($elapsed -ne (Get-MyspeedCanaryElapsedMilliseconds $Boundary.offlineTiming.start100ns $Boundary.offlineTiming.end100ns)) {
        throw 'Boundary offline elapsed does not match monotonic observations'
    }
    Assert-MyspeedCanaryExactKeys $Boundary.providers @('adapters','ipInterfaces','ipAddresses','routes') 'Boundary providers'
    foreach ($name in @('adapters','ipInterfaces','ipAddresses','routes')) {
        if (-not (Assert-MyspeedCanaryBoolean $Boundary.providers.$name "Boundary provider $name")) {
            throw "Boundary provider failed: $name"
        }
    }
    $adapters=Assert-MyspeedCanaryArray $Boundary.adapters 'Boundary adapters'
    if ($adapters.Count -eq 0) { throw 'Boundary adapter inventory is empty' }
    $adapterGuids=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $adapterLuids=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($adapter in $adapters) {
        Assert-MyspeedCanaryExactKeys $adapter @('interfaceGuid','netLuid','hidden','loopback','enabled','status') 'Boundary adapter'
        $guid=Assert-MyspeedCanaryString $adapter.interfaceGuid 'Boundary adapter GUID' `
            '^\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$'
        $luid=Assert-MyspeedCanaryNetLuid $adapter.netLuid `
            'Boundary adapter NetLuid'
        [void](Assert-MyspeedCanaryBoolean $adapter.hidden 'Boundary adapter hidden flag')
        $loopback=Assert-MyspeedCanaryBoolean $adapter.loopback 'Boundary adapter loopback flag'
        $enabled=Assert-MyspeedCanaryBoolean $adapter.enabled 'Boundary adapter enabled flag'
        [void](Assert-MyspeedCanaryString $adapter.status 'Boundary adapter status')
        if (-not $adapterGuids.Add($guid) -or -not $adapterLuids.Add($luid)) {
            throw 'Boundary adapter GUID or NetLuid is duplicated'
        }
        if (-not $loopback -and $enabled) { throw 'Boundary contains an enabled non-loopback adapter' }
    }
    $ipKinds=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($state in (Assert-MyspeedCanaryArray $Boundary.ipState 'Boundary IP state')) {
        Assert-MyspeedCanaryExactKeys $state @('kind','compartmentId','loopback','routable') 'Boundary IP state'
        $kind=Assert-MyspeedCanaryString $state.kind 'Boundary IP state kind' '^(interface|address|route)$'
        [void]$ipKinds.Add($kind)
        [void](Assert-MyspeedCanaryInteger $state.compartmentId 'Boundary compartment' 0 4294967295)
        $loopback=Assert-MyspeedCanaryBoolean $state.loopback 'Boundary IP loopback flag'
        $routable=Assert-MyspeedCanaryBoolean $state.routable 'Boundary IP routable flag'
        if ($routable -and -not $loopback) { throw 'Boundary contains non-loopback routable state' }
    }
    foreach ($kind in @('interface','address','route')) {
        if (-not $ipKinds.Contains($kind)) { throw "Boundary IP state is missing $kind observations" }
    }
    Assert-MyspeedEndpointSet $Boundary.loopback 'Boundary loopback' $true $null $script:LoopbackEndpoints
    $attempts=Assert-MyspeedCanaryArray $Boundary.testNet 'Boundary TEST-NET'
    $expectedAttemptCount=$script:TestNetEndpoints.Count * 2
    if ($attempts.Count -ne $expectedAttemptCount) { throw 'Boundary TEST-NET count differs' }
    $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $udpSendAccepted=$false
    foreach ($attempt in $attempts) {
        Assert-MyspeedCanaryExactKeys $attempt @('actor','transport','addressFamily','address','port','outcome') 'Boundary TEST-NET'
        $actor=Assert-MyspeedCanaryString $attempt.actor 'Boundary TEST-NET actor' '^(controller|child)$'
        $transport=Assert-MyspeedCanaryString $attempt.transport 'Boundary TEST-NET transport' '^(tcp|udp)$'
        $family=Assert-MyspeedCanaryString $attempt.addressFamily 'Boundary TEST-NET address family' '^(ipv4|ipv6)$'
        $address=Assert-MyspeedCanaryString $attempt.address 'Boundary TEST-NET address'
        $port=Assert-MyspeedCanaryInteger $attempt.port 'Boundary TEST-NET port' 1 65535
        $outcome=Assert-MyspeedCanaryString $attempt.outcome 'Boundary TEST-NET outcome' '^(denied|sendAccepted)$'
        if ($outcome -ceq 'sendAccepted' -and $transport -cne 'udp') { throw 'Boundary TEST-NET TCP connection was accepted' }
        if ($outcome -ceq 'sendAccepted') { $udpSendAccepted=$true }
        $expected=@($script:TestNetEndpoints | Where-Object {
            $_.transport -ceq $transport -and $_.addressFamily -ceq $family })
        if ($expected.Count -ne 1 -or $address -cne $expected[0].address -or $port -ne $expected[0].port) {
            throw 'Boundary TEST-NET literal endpoint differs'
        }
        if (-not $seen.Add("$actor/$transport/$family")) { throw 'Boundary TEST-NET contains a duplicate' }
    }
    foreach ($actor in @('controller','child')) { foreach ($endpoint in $script:TestNetEndpoints) {
        $pair="$($endpoint.transport)/$($endpoint.addressFamily)"
        if (-not $seen.Contains("$actor/$pair")) { throw 'Boundary TEST-NET is incomplete' }
    } }
    return [pscustomobject]@{accepted=$true;qualifying=$false;udpSendAccepted=$udpSendAccepted}
}

function Assert-MyspeedWinswProbe {
    param([object]$Probe)
    Assert-MyspeedCanaryExactKeys $Probe @('schemaVersion','nonce','serviceName','wrapperPid','childPid','parentPid',
        'wrapperCreationFileTime','childCreationFileTime','sid','environment','forbiddenNames','configuration','endpoints',
        'winswSha256','childSha256') 'WinSW probe'
    [void](Assert-MyspeedCanaryInteger $Probe.schemaVersion 'Probe schema' 1 1)
    $nonce=Assert-MyspeedCanaryString $Probe.nonce 'Probe nonce' '^[0-9a-f]{32}$'
    if ((Assert-MyspeedCanaryString $Probe.serviceName 'Probe service name') -cne "MySpeedOfflineCanary-$nonce") {
        throw 'Probe service name differs from its nonce'
    }
    $wrapperPid=Assert-MyspeedCanaryInteger $Probe.wrapperPid 'Probe wrapper PID' 1 4294967295
    $childPid=Assert-MyspeedCanaryInteger $Probe.childPid 'Probe child PID' 1 4294967295
    $parentPid=Assert-MyspeedCanaryInteger $Probe.parentPid 'Probe parent PID' 1 4294967295
    if ($wrapperPid -eq $childPid -or $parentPid -ne $wrapperPid) { throw 'Probe WinSW parent relationship differs' }
    $nonzeroFileTimePattern='^(?!0000000000000000$)[0-9a-f]{16}$'
    [void](Assert-MyspeedCanaryString $Probe.wrapperCreationFileTime 'Probe wrapper creation identity' $nonzeroFileTimePattern)
    [void](Assert-MyspeedCanaryString $Probe.childCreationFileTime 'Probe child creation identity' $nonzeroFileTimePattern)
    if ((Assert-MyspeedCanaryString $Probe.sid 'Probe LocalSystem SID') -cne 'S-1-5-18') { throw 'Probe is not LocalSystem' }
    Assert-MyspeedCanaryExactKeys $Probe.environment @($script:ExpectedEnvironment.Keys) 'Probe environment'
    foreach ($entry in $script:ExpectedEnvironment.GetEnumerator()) {
        if ($Probe.environment.($entry.Key) -isnot [string] -or $Probe.environment.($entry.Key) -cne $entry.Value) {
            throw "Probe environment differs: $($entry.Key)"
        }
    }
    $forbidden=Assert-MyspeedCanaryArray $Probe.forbiddenNames 'Probe forbidden names'
    if ($forbidden.Count -ne 0) {
        # Report identifiers only, never environment values or malformed payloads.
        $reportedNames=@($forbidden | Select-Object -First $script:MaximumReportedEnvironmentNames | ForEach-Object {
            if ($_ -is [string] -and $_.Length -le $script:MaximumReportedEnvironmentNameCharacters -and
                $_ -cmatch '\A[A-Za-z_][A-Za-z0-9_]*\z') { $_ } else { '<invalid-name>' }
        })
        throw "Probe forbidden environment names are present (count=$($forbidden.Count); names=$($reportedNames -join ','))"
    }
    Assert-MyspeedCanaryExactKeys $Probe.configuration @('bytesBase64','sha256') 'Probe WinSW configuration'
    if ($Probe.configuration.bytesBase64 -isnot [string]) { throw 'Probe WinSW configuration bytes must be a string' }
    try { $configurationBytes=[Convert]::FromBase64String($Probe.configuration.bytesBase64) }
    catch { throw 'Probe WinSW configuration bytes are malformed' }
    if ($configurationBytes.Length -le 0 -or $configurationBytes.Length -gt $script:MaximumConfigurationBytes -or
        [Convert]::ToBase64String($configurationBytes) -cne $Probe.configuration.bytesBase64) {
        throw 'Probe WinSW configuration bytes are noncanonical or oversized'
    }
    $encoding=New-Object Text.UTF8Encoding($false,$true)
    try { $configurationText=$encoding.GetString($configurationBytes) }
    catch { throw 'Probe WinSW configuration is not strict UTF-8' }
    $expectedConfiguration=New-MyspeedCanaryWinswConfiguration $nonce
    if ($configurationText -cne $expectedConfiguration) { throw 'Probe WinSW configuration differs from the trusted generator' }
    $algorithm=[Security.Cryptography.SHA256]::Create()
    try { $configurationHash=([BitConverter]::ToString($algorithm.ComputeHash($configurationBytes))).Replace('-','').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
    if ($Probe.configuration.sha256 -isnot [string] -or $Probe.configuration.sha256 -cne $configurationHash) {
        throw 'Probe WinSW configuration SHA differs'
    }
    Assert-MyspeedEndpointSet $Probe.endpoints 'Probe endpoint' $false ([Nullable[int64]]$childPid) $script:LoopbackEndpoints
    if ((Assert-MyspeedCanaryString $Probe.winswSha256 'Probe WinSW SHA' '^[0-9a-f]{64}$') -cne $script:WinswSha256) {
        throw 'Probe WinSW SHA differs'
    }
    [void](Assert-MyspeedCanaryString $Probe.childSha256 'Probe child SHA' '^[0-9a-f]{64}$')
    return [pscustomobject]@{accepted=$true;qualifying=$false}
}

function New-MyspeedCanaryWinswConfiguration {
    param([string]$Nonce)
    [void](Assert-MyspeedCanaryString $Nonce 'WinSW configuration nonce' '^[0-9a-f]{32}$')
    $lines=@('<service>',"  <id>MySpeedOfflineCanary-$Nonce</id>",
        "  <name>MySpeed Offline Canary $Nonce</name>",'  <description>Candidate-neutral WinSW inheritance canary</description>',
        '  <executable>inert-child.exe</executable>','  <startmode>Manual</startmode>','  <stoptimeout>5 sec</stoptimeout>')
    $lines += @($script:ClearedServiceEnvironmentNames | ForEach-Object { '  <env name="' + $_ + '" value=""/>' })
    $lines += @('</service>','')
    return ($lines -join "`r`n")
}

function Get-MyspeedCanarySha256 {
    param([byte[]]$Bytes)
    $algorithm=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function ConvertTo-MyspeedCanaryCSharpLiteral {
    param([string]$Value)
    return '"' + $Value.Replace('\','\\').Replace('"','\"').Replace("`r",'\r').Replace("`n",'\n') + '"'
}

function Get-MyspeedCanaryInertChildSource {
    param([string]$Nonce,[string]$ResultPath)
    [void](Assert-MyspeedCanaryString $Nonce 'Inert child nonce' '^[0-9a-f]{32}$')
    $result=Test-MyspeedCanaryWindowsPath $ResultPath 'Inert child result path'
    $nonceLiteral=ConvertTo-MyspeedCanaryCSharpLiteral $Nonce
    $resultLiteral=ConvertTo-MyspeedCanaryCSharpLiteral $result
    $environmentRows=@($script:ExpectedEnvironment.GetEnumerator() | ForEach-Object {
        '        new string[] { ' + (ConvertTo-MyspeedCanaryCSharpLiteral $_.Key) + ', ' +
            (ConvertTo-MyspeedCanaryCSharpLiteral $_.Value) + ' }'
    }) -join ",`r`n"
    $clearedEnvironmentNames=@($script:ClearedServiceEnvironmentNames | ForEach-Object {
        ConvertTo-MyspeedCanaryCSharpLiteral $_
    }) -join ', '
    $source=@"
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;

internal static class InertChild
{
    private const string Nonce = $nonceLiteral;
    private const string ResultPath = $resultLiteral;
    private const int IoTimeoutMilliseconds = 1000;
    private const uint ChildErrorMode = 3;
    private static readonly string[][] ExpectedEnvironment = new string[][] {
$environmentRows
    };
    private static readonly string[] ClearedEnvironmentNames = new string[] { $clearedEnvironmentNames };
    private static readonly object[] EndpointSpecs = new object[] {
        new object[] { "tcp", "ipv4", "127.0.0.1", 43128 }, new object[] { "tcp", "ipv6", "::1", 43129 },
        new object[] { "udp", "ipv4", "127.0.0.1", 43130 }, new object[] { "udp", "ipv6", "::1", 43131 }
    };

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32 { public uint dwSize; public uint cntUsage; public uint th32ProcessID;
        public IntPtr th32DefaultHeapID; public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID;
        public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint id);
    [DllImport("kernel32.dll", EntryPoint="Process32FirstW", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    private static extern bool Process32First(IntPtr snapshot,ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", EntryPoint="Process32NextW", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    private static extern bool Process32Next(IntPtr snapshot,ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern uint SetErrorMode(uint mode);

    private static string Json(string value) { if (value == null) return "null"; StringBuilder b=new StringBuilder("\"");
        foreach(char c in value) { if(c=='\\' || c=='\"') b.Append('\\').Append(c); else if(c=='\r') b.Append("\\r");
            else if(c=='\n') b.Append("\\n"); else if(c<32) b.Append("\\u"+((int)c).ToString("x4")); else b.Append(c); }
        return b.Append('\"').ToString(); }
    private static uint ParentPid(uint pid) { IntPtr h=CreateToolhelp32Snapshot(2,0); if(h==new IntPtr(-1)) throw new InvalidOperationException("snapshot");
        try { PROCESSENTRY32 e=new PROCESSENTRY32(); e.dwSize=(uint)Marshal.SizeOf(e); if(Process32First(h,ref e)) do {
            if(e.th32ProcessID==pid) return e.th32ParentProcessID; } while(Process32Next(h,ref e)); throw new InvalidOperationException("pid"); }
        finally { CloseHandle(h); } }
    private static void TcpEcho(object state) { TcpListener listener=(TcpListener)state; for(;;) using(TcpClient client=listener.AcceptTcpClient()) {
        client.ReceiveTimeout=IoTimeoutMilliseconds; client.SendTimeout=IoTimeoutMilliseconds; NetworkStream stream=client.GetStream();
        byte[] data=new byte[32]; int count=stream.Read(data,0,data.Length); if(count>0) stream.Write(data,0,count); } }
    private static void UdpEcho(object state) { UdpClient socket=(UdpClient)state; IPEndPoint peer=null; for(;;) {
        byte[] data=socket.Receive(ref peer); socket.Send(data,data.Length,peer); } }
    private static string TcpTest(string address,int port) { using(TcpClient client=new TcpClient(address.Contains(":")?AddressFamily.InterNetworkV6:AddressFamily.InterNetwork)) {
        try { IAsyncResult pending=client.BeginConnect(IPAddress.Parse(address),port,null,null); using(WaitHandle wait=pending.AsyncWaitHandle) {
            if(!wait.WaitOne(IoTimeoutMilliseconds)) return "timeout"; } client.EndConnect(pending); return "accepted"; }
        catch(SocketException) { return "denied"; } } }
    private static string UdpTest(string address,int port) { try { using(UdpClient client=new UdpClient(address.Contains(":")?AddressFamily.InterNetworkV6:AddressFamily.InterNetwork)) {
        byte[] value=new byte[] { 77 }; client.Connect(IPAddress.Parse(address),port); client.Send(value,value.Length); return "sendAccepted"; } }
        catch(SocketException) { return "denied"; } }
    private static bool Forbidden(string name,object value) {
        // WinSW retains explicitly empty overrides as empty entries; no nonempty value is exempt.
        foreach(string cleared in ClearedEnvironmentNames) if(String.Equals(cleared,name,StringComparison.OrdinalIgnoreCase) &&
            String.Equals(value as string,String.Empty,StringComparison.Ordinal)) return false;
        string upper=name.ToUpperInvariant(); if(upper.Contains("TOKEN")||upper.Contains("SECRET")||upper.Contains("PASSWORD")||
        upper.Contains("PROXY")||upper.Contains("API_KEY")||upper.StartsWith("AWS_")||upper.StartsWith("AZURE_")||upper.StartsWith("GOOGLE_")) {
        foreach(string[] pair in ExpectedEnvironment) if(String.Equals(pair[0],name,StringComparison.OrdinalIgnoreCase)) return false; return true; } return false; }

    public static void Main()
    {
        SetErrorMode(ChildErrorMode);
        TcpListener tcp4=new TcpListener(IPAddress.Parse("127.0.0.1"),43128); TcpListener tcp6=new TcpListener(IPAddress.Parse("::1"),43129);
        UdpClient udp4=new UdpClient(new IPEndPoint(IPAddress.Parse("127.0.0.1"),43130));
        UdpClient udp6=new UdpClient(new IPEndPoint(IPAddress.Parse("::1"),43131));
        tcp4.Start(1); tcp6.Start(1); new Thread(TcpEcho){IsBackground=true}.Start(tcp4); new Thread(TcpEcho){IsBackground=true}.Start(tcp6);
        new Thread(UdpEcho){IsBackground=true}.Start(udp4); new Thread(UdpEcho){IsBackground=true}.Start(udp6);
        Process current=Process.GetCurrentProcess(); IDictionary all=Environment.GetEnvironmentVariables(); List<string> forbidden=new List<string>();
        foreach(DictionaryEntry entry in all) if(Forbidden(Convert.ToString(entry.Key),entry.Value)) forbidden.Add(Convert.ToString(entry.Key)); forbidden.Sort(StringComparer.OrdinalIgnoreCase);
        StringBuilder json=new StringBuilder("{\"schemaVersion\":1,\"nonce\":").Append(Json(Nonce));
        json.Append(",\"sid\":").Append(Json(WindowsIdentity.GetCurrent().User.Value));
        json.Append(",\"pid\":").Append(current.Id).Append(",\"parentPid\":").Append(ParentPid((uint)current.Id));
        json.Append(",\"creationFileTime\":").Append(Json(current.StartTime.ToUniversalTime().ToFileTimeUtc().ToString("x16")));
        json.Append(",\"environment\":{"); for(int i=0;i<ExpectedEnvironment.Length;i++) { if(i>0) json.Append(',');
            json.Append(Json(ExpectedEnvironment[i][0])).Append(':').Append(Json(Environment.GetEnvironmentVariable(ExpectedEnvironment[i][0]))); }
        json.Append("},\"forbiddenNames\":["); for(int i=0;i<forbidden.Count;i++){if(i>0)json.Append(',');json.Append(Json(forbidden[i]));}
        json.Append("],\"testNet\":["); string[] modes=new string[]{"tcp","tcp","udp","udp"}; string[] families=new string[]{"ipv4","ipv6","ipv4","ipv6"};
        string[] addresses=new string[]{"192.0.2.1","2001:db8::1","192.0.2.1","2001:db8::1"}; int[] ports=new int[]{43132,43133,43134,43135};
        for(int i=0;i<4;i++){if(i>0)json.Append(',');string outcome=modes[i]=="tcp"?TcpTest(addresses[i],ports[i]):UdpTest(addresses[i],ports[i]);
            json.Append("{\"actor\":\"child\",\"transport\":").Append(Json(modes[i])).Append(",\"addressFamily\":").Append(Json(families[i]));
            json.Append(",\"address\":").Append(Json(addresses[i])).Append(",\"port\":").Append(ports[i]).Append(",\"outcome\":").Append(Json(outcome)).Append('}'); }
        json.Append("]}"); using(FileStream stream=new FileStream(ResultPath,FileMode.CreateNew,FileAccess.Write,FileShare.None))
        using(StreamWriter writer=new StreamWriter(stream,new UTF8Encoding(false))) writer.Write(json.ToString());
        for(;;) Thread.Sleep(1000);
    }
}
"@
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes($source)
    return [pscustomobject]@{source=$source;sha256=Get-MyspeedCanarySha256 $bytes;bytes=$bytes.Length}
}

function Get-MyspeedRecoveryAssessment {
    param([object]$Recovery)
    Assert-MyspeedCanaryExactKeys $Recovery @('schemaVersion','classification','emergencyRestore','serviceTeardownProven',
        'adapterRestoreProven','recoveryTaskGoneProven','environmentRestoredProven','continuationObserved',
        'cleanupAfterReconnectProven','phaseOrder') 'Recovery'
    [void](Assert-MyspeedCanaryInteger $Recovery.schemaVersion 'Recovery schema' 1 1)
    $classification=Assert-MyspeedCanaryString $Recovery.classification 'Recovery classification' '^(completed|inconclusive)$'
    $emergency=Assert-MyspeedCanaryBoolean $Recovery.emergencyRestore 'Recovery emergency flag'
    $teardown=Assert-MyspeedCanaryBoolean $Recovery.serviceTeardownProven 'Recovery teardown proof'
    foreach ($name in @('adapterRestoreProven','recoveryTaskGoneProven','environmentRestoredProven','continuationObserved',
        'cleanupAfterReconnectProven')) { [void](Assert-MyspeedCanaryBoolean $Recovery.$name "Recovery $name") }
    if ($emergency) {
        if ($classification -cne 'inconclusive' -or $teardown) { throw 'Emergency recovery must remain inconclusive with teardown unproven' }
        Assert-MyspeedCanaryOrderedStrings $Recovery.phaseOrder $script:EmergencyRecoveryOrder 'Emergency recovery order'
        return [pscustomobject]@{accepted=$false;qualifying=$false;classification='inconclusive';emergencyRestore=$true
            serviceTeardownProven=$false}
    }
    if ($classification -ceq 'inconclusive') {
        Assert-MyspeedCanaryOrderedStrings $Recovery.phaseOrder $script:FailedCleanupOrder 'Failed recovery order'
        return [pscustomobject]@{accepted=$false;qualifying=$false;classification='inconclusive';emergencyRestore=$false
            serviceTeardownProven=$teardown}
    }
    if ($classification -cne 'completed' -or -not $teardown) { throw 'Normal recovery requires proven service teardown' }
    Assert-MyspeedCanaryOrderedStrings $Recovery.phaseOrder $script:NormalRecoveryOrder 'Normal teardown recovery order'
    foreach ($name in @('adapterRestoreProven','recoveryTaskGoneProven','environmentRestoredProven','continuationObserved',
        'cleanupAfterReconnectProven')) {
        if (-not $Recovery.$name) { throw "Normal recovery proof failed: $name" }
    }
    return [pscustomobject]@{accepted=$true;qualifying=$false;classification='completed';emergencyRestore=$false
        serviceTeardownProven=$true}
}

function Assert-MyspeedAwaitingContinuationRecovery {
    param([object]$Recovery)
    Assert-MyspeedCanaryExactKeys $Recovery @('schemaVersion','classification','emergencyRestore','serviceTeardownProven',
        'adapterRestoreProven','recoveryTaskGoneProven','environmentRestoredProven','continuationObserved',
        'cleanupAfterReconnectProven','phaseOrder') 'Awaiting-continuation recovery'
    [void](Assert-MyspeedCanaryInteger $Recovery.schemaVersion 'Awaiting-continuation recovery schema' 1 1)
    if((Assert-MyspeedCanaryString $Recovery.classification 'Awaiting-continuation recovery classification') -cne 'awaitingContinuation'){
        throw 'Awaiting-continuation recovery classification differs'}
    foreach($name in @('emergencyRestore','serviceTeardownProven','adapterRestoreProven','recoveryTaskGoneProven',
        'environmentRestoredProven','continuationObserved','cleanupAfterReconnectProven')){
        [void](Assert-MyspeedCanaryBoolean $Recovery.$name "Awaiting-continuation recovery $name")
    }
    if($Recovery.emergencyRestore -or -not $Recovery.serviceTeardownProven -or -not $Recovery.adapterRestoreProven -or
        -not $Recovery.recoveryTaskGoneProven -or -not $Recovery.environmentRestoredProven -or
        $Recovery.continuationObserved -or $Recovery.cleanupAfterReconnectProven){
        throw 'Awaiting-continuation recovery proof differs'
    }
    Assert-MyspeedCanaryOrderedStrings $Recovery.phaseOrder $script:NormalRecoveryOrder 'Awaiting-continuation recovery order'
    return [pscustomobject]@{accepted=$true}
}

function Invoke-MyspeedInjectedCanaryLifecycle {
    param([hashtable]$Operations)
    $required=@($script:NormalPhases)+@('emergencyRestore','postReconnectCleanup')
    if ($null -eq $Operations -or $Operations.Count -ne $required.Count) { throw 'Injected lifecycle operation set differs' }
    foreach ($name in $required) { if (-not $Operations.ContainsKey($name) -or $Operations[$name] -isnot [scriptblock]) {
        throw "Injected lifecycle operation differs: $name"
    } }
    $events=New-Object 'System.Collections.Generic.List[string]'
    $disabled=$false;$restored=$false;$failures=New-Object 'System.Collections.Generic.List[string]'
    try {
        foreach ($phase in $script:NormalPhases) {
            [void]$events.Add($phase)
            if ($phase -ceq 'disableAdapters') { $disabled=$true }
            & $Operations[$phase]
            if ($phase -ceq 'restoreAdapters') { $restored=$true }
        }
        $recovery=[pscustomobject]@{schemaVersion=1;classification='completed';emergencyRestore=$false
            serviceTeardownProven=$true;adapterRestoreProven=$true;recoveryTaskGoneProven=$true
            environmentRestoredProven=$true;continuationObserved=$true;cleanupAfterReconnectProven=$true
            phaseOrder=$script:NormalRecoveryOrder}
        [void](Get-MyspeedRecoveryAssessment $recovery)
        return [pscustomobject]@{status='completed';canaryPassed=$true;qualifying=$false;events=[string[]]$events
            failures=[string[]]$failures;recovery=$recovery}
    } catch {
        [void]$failures.Add($_.Exception.Message)
        $emergency=$disabled -and -not $restored
        $adapterRestored=-not $disabled -or $restored
        if ($emergency) {
            [void]$events.Add('emergencyRestore')
            try { & $Operations.emergencyRestore;$adapterRestored=$true }
            catch { $adapterRestored=$false;[void]$failures.Add($_.Exception.Message) }
        }
        [void]$events.Add('postReconnectCleanup')
        $cleanup=$true
        try { & $Operations.postReconnectCleanup } catch { $cleanup=$false;[void]$failures.Add($_.Exception.Message) }
        $recovery=[pscustomobject]@{schemaVersion=1;classification='inconclusive';emergencyRestore=$emergency
            serviceTeardownProven=$(if($emergency){$false}else{$cleanup});adapterRestoreProven=$adapterRestored
            recoveryTaskGoneProven=$cleanup;environmentRestoredProven=$cleanup;continuationObserved=$adapterRestored
            cleanupAfterReconnectProven=$cleanup
                phaseOrder=@($(if($emergency){$script:EmergencyRecoveryOrder}else{$script:FailedCleanupOrder}))}
        [void](Get-MyspeedRecoveryAssessment $recovery)
        return [pscustomobject]@{status='failed';canaryPassed=$false;qualifying=$false;events=[string[]]$events
            failures=[string[]]$failures;recovery=$recovery}
    }
}

function Assert-MyspeedCanaryHostedContext {
    param([object]$Context)
    Assert-MyspeedCanaryExactKeys $Context @('environment','expectedRunId','expectedRunAttempt','expectedEventSha',
        'expectedSourceSha','expectedImageVersion','nonce','manifest') 'Hosted context'
    $environment=$Context.environment
    if ($null -eq $environment -or $environment -is [array] -or $environment -is [string]) { throw 'Hosted context environment differs' }
    $expected=[ordered]@{GITHUB_ACTIONS='true';GITHUB_REPOSITORY='i7Gamer/MySpeed';RUNNER_OS='Windows';
        RUNNER_ARCH='X64';RUNNER_ENVIRONMENT='github-hosted';ImageOS='win25-vs2026';CI='true'}
    foreach ($entry in $expected.GetEnumerator()) {
        if ($environment.PSObject.Properties.Name -cnotcontains $entry.Key -or
            $environment.($entry.Key) -isnot [string] -or $environment.($entry.Key) -cne $entry.Value) {
            throw "Hosted context differs: $($entry.Key)"
        }
    }
    $bindings=[ordered]@{
        expectedRunId=@('GITHUB_RUN_ID','^[1-9][0-9]*$')
        expectedRunAttempt=@('GITHUB_RUN_ATTEMPT','^[1-9][0-9]*$')
        expectedEventSha=@('GITHUB_SHA','^[0-9a-f]{40}$')
        expectedImageVersion=@('ImageVersion','^[0-9A-Za-z._-]+$')
    }
    foreach ($binding in $bindings.GetEnumerator()) {
        $value=Assert-MyspeedCanaryString $Context.($binding.Key) "Hosted context $($binding.Key)" $binding.Value[1]
        if ($environment.PSObject.Properties.Name -cnotcontains $binding.Value[0] -or
            $environment.($binding.Value[0]) -isnot [string] -or $environment.($binding.Value[0]) -cne $value) {
            throw "Hosted context binding differed: $($binding.Key)"
        }
    }
    [void](Assert-MyspeedCanaryString $Context.expectedSourceSha 'Hosted context source SHA' '^[0-9a-f]{40}$')
    [void](Assert-MyspeedCanaryString $Context.nonce 'Hosted context nonce' '^[0-9a-f]{32}$')
    [void](Assert-MyspeedCanaryManifest $Context.manifest)
    foreach ($name in @('expectedRunId','expectedRunAttempt','expectedEventSha','expectedSourceSha','nonce')) {
        if ($Context.manifest.$name -cne $Context.$name) { throw "Hosted context manifest binding differed: $name" }
    }
    return [pscustomobject]@{accepted=$true}
}

function Read-MyspeedCanaryBoundedFile {
    param([string]$Path,[int64]$MaximumBytes)
    $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Bounded file is not a regular non-reparse file'}
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        if ($stream.Length -le 0 -or $stream.Length -gt $MaximumBytes) { throw 'File size is outside its bound' }
        $bytes=New-Object byte[] ([int]$stream.Length);$offset=0
        while($offset -lt $bytes.Length){$read=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($read -le 0){throw 'File ended before bounded read'};$offset += $read}
        $sha=[Security.Cryptography.SHA256]::Create();try{$hash=(($sha.ComputeHash($bytes)|ForEach-Object{$_.ToString('x2')}) -join '')}finally{$sha.Dispose()}
        return [pscustomobject]@{bytes=$bytes;sha256=$hash;length=$bytes.Length}
    } finally { $stream.Dispose() }
}

function Get-MyspeedCanarySha256File {
    param([string]$Path,[int64]$MaximumBytes)
    return (Read-MyspeedCanaryBoundedFile $Path $MaximumBytes).sha256
}

function Assert-MyspeedCanaryOwnedAggregate {
    param([string]$Root,[int64]$ReservedBytes=0)
    $directories=@(Get-ChildItem -LiteralPath $Root -Force -Directory -ErrorAction Stop)
    $files=@(Get-ChildItem -LiteralPath $Root -Force -File -ErrorAction Stop)
    if($directories.Count -ne 0 -or @($files|Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count -ne 0){
        throw 'Owned evidence root contains a directory or reparse point'
    }
    $total=[int64]$ReservedBytes;foreach($file in $files){$total += [int64]$file.Length}
    if($total -gt $script:MaximumOwnedAggregateBytes){throw 'Owned evidence aggregate exceeds its bound'}
    return $total
}

function Read-MyspeedCanaryBoundedJson {
    param([string]$Path,[int]$MaximumBytes)
    $bytes=(Read-MyspeedCanaryBoundedFile $Path $MaximumBytes).bytes
    try { return ([Text.UTF8Encoding]::new($false,$true).GetString($bytes) | ConvertFrom-Json) }
    catch { throw ('JSON file is invalid: ' + $_.Exception.Message) }
}

function Test-MyspeedCanarySharingViolation {
    param([object]$Exception)
    $current=$Exception
    for($depth=0;$depth -lt $script:MaximumExceptionInnerDepth -and $null -ne $current;$depth++){
        if($current -is [IO.IOException] -and (($current.HResult -band 0xffff) -eq $script:SharingViolationWin32Code)){
            return $true
        }
        $current=$current.InnerException
    }
    return $false
}

function Read-MyspeedCanaryBoundedJsonUntilStable {
    param([string]$Path,[int]$MaximumBytes,[int64]$DeadlineMilliseconds,[object]$Operations)
    [void](Assert-MyspeedCanaryInteger $DeadlineMilliseconds 'Recovery readiness publication deadline' 1 `
        $script:MaximumRecoveryReadDeadlineMilliseconds)
    Assert-MyspeedCanaryExactKeys $Operations @('elapsed','sleep') 'Recovery readiness publication operations'
    while($true){
        try{$loaded=Read-MyspeedCanaryBoundedJson $Path $MaximumBytes}catch{
            if(-not (Test-MyspeedCanarySharingViolation $_.Exception)){throw}
            $now=Assert-MyspeedCanaryInteger (& $Operations.elapsed) 'Recovery readiness publication elapsed time' 0 `
                $script:MaximumRecoveryReadDeadlineMilliseconds
            if($now -ge $DeadlineMilliseconds){throw 'Recovery readiness publication remained exclusively locked through its deadline'}
            & $Operations.sleep ([int][Math]::Min($script:RecoveryPollMilliseconds,$DeadlineMilliseconds-$now))
            continue
        }
        $completed=Assert-MyspeedCanaryInteger (& $Operations.elapsed) 'Recovery readiness publication completion time' 0 `
            $script:MaximumRecoveryReadDeadlineMilliseconds
        if($completed -ge $DeadlineMilliseconds){throw 'Recovery readiness publication completed at or after its deadline'}
        return $loaded
    }
}

function Write-MyspeedCanaryCreateNewBytes {
    param([string]$Path,[byte[]]$Bytes,[int]$MaximumBytes)
    if ($Bytes.Length -le 0 -or $Bytes.Length -gt $MaximumBytes) { throw 'Owned output size is outside its bound' }
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true) } finally { $stream.Dispose() }
}

function Write-MyspeedCanaryCreateNewJson {
    param([string]$Path,[object]$Value,[int]$MaximumBytes=$script:MaximumEvidenceBytes)
    $json=$Value | ConvertTo-Json -Compress -Depth 16
    Write-MyspeedCanaryCreateNewBytes $Path ([Text.UTF8Encoding]::new($false).GetBytes($json)) $MaximumBytes
}

function Enter-MyspeedCanaryRecoveryLock {
    param([string]$Path,[int]$MaximumWaitMilliseconds=$script:ProcessCleanupMilliseconds)
    $timer=[Diagnostics.Stopwatch]::StartNew()
    do {
        try { return [IO.File]::Open($Path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
        catch [IO.IOException] { if($timer.ElapsedMilliseconds -ge $MaximumWaitMilliseconds){throw 'Recovery lock acquisition timed out'} }
        Start-Sleep -Milliseconds $script:RecoveryPollMilliseconds
    } while($true)
}

function Get-MyspeedCanaryProcessIfPresent {
    param([int]$ProcessId)
    try { return [Diagnostics.Process]::GetProcessById($ProcessId) }
    catch [ArgumentException] { return $null }
}

function Assert-MyspeedCanaryClosureFiles {
    param([object]$Context,[string]$Root,[string]$ManifestFile)
    [void](Assert-MyspeedCanaryHostedContext $Context)
    $rootPath=Test-MyspeedCanaryWindowsPath $Root 'Closure root'
    $manifestPath=Test-MyspeedCanaryWindowsPath $ManifestFile 'Closure manifest path'
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($manifestPath),$rootPath,[StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($manifestPath) -cne 'closure.json') { throw 'Closure manifest path differs' }
    $items=@(Get-ChildItem -LiteralPath $rootPath -Force -ErrorAction Stop)
    $names=@($items.Name | Sort-Object)
    $expected=@('WinSW-x64.exe','closure.json','windows-winsw-offline-canary.ps1' | Sort-Object)
    if ($items.Count -ne 3 -or ($names -join "`n") -cne ($expected -join "`n") -or
        @($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count -ne 0) {
        throw 'Closure membership differs'
    }
    for ($index=0;$index -lt $Context.manifest.files.Count;$index++) {
        $record=$Context.manifest.files[$index];$path=Join-Path $rootPath $record.name
        $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or $item.Length -ne [int64]$record.bytes -or
            (Get-MyspeedCanarySha256File $path $(if($index -eq 0){$script:MaximumSourceBytes}else{$script:MaximumWinswBytes})) -cne
                $record.sha256) { throw "Closure file differs: $($record.name)" }
    }
    return [pscustomobject]@{scriptPath=(Join-Path $rootPath $script:RequiredClosureFiles[0]);winswPath=(Join-Path $rootPath $script:RequiredClosureFiles[1])}
}

function Write-MyspeedCanaryClosureManifest {
    param([string]$Root,[string]$Path)
    foreach ($value in @($ExpectedRunId,$ExpectedRunAttempt,$ExpectedSourceSha,$ExpectedEventSha,$Nonce)) {
        if ([string]::IsNullOrWhiteSpace($value)) { throw 'Closure identity input is missing' }
    }
    $rootPath=Test-MyspeedCanaryWindowsPath $Root 'Closure root'
    $manifestPath=Test-MyspeedCanaryWindowsPath $Path 'Closure manifest path'
    if ([IO.Path]::GetFileName($manifestPath) -cne 'closure.json' -or
        -not [string]::Equals([IO.Path]::GetDirectoryName($manifestPath),$rootPath,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'Closure manifest path differs'
    }
    $records=@()
    for ($index=0;$index -lt $script:RequiredClosureFiles.Count;$index++) {
        $name=$script:RequiredClosureFiles[$index];$file=Join-Path $rootPath $name
        $maximum=if($index -eq 0){$script:MaximumSourceBytes}else{$script:MaximumWinswBytes}
        $item=Get-Item -LiteralPath $file -Force -ErrorAction Stop
        $records += [pscustomobject][ordered]@{name=$name;bytes=[int64]$item.Length;sha256=Get-MyspeedCanarySha256File $file $maximum}
    }
    if ($records[1].sha256 -cne $script:WinswSha256) { throw 'WinSW closure hash differs from pin' }
    $manifest=[pscustomobject][ordered]@{schemaVersion=1;kind=$script:ClosureKind;expectedRunId=$ExpectedRunId
        expectedRunAttempt=$ExpectedRunAttempt;expectedSourceSha=$ExpectedSourceSha;expectedEventSha=$ExpectedEventSha
        nonce=$Nonce;files=$records}
    [void](Assert-MyspeedCanaryManifest $manifest)
    Write-MyspeedCanaryCreateNewJson $manifestPath $manifest $script:MaximumRequestBytes
    return $manifest
}

function Get-MyspeedActualHostedContext {
    param([string]$ManifestFile)
    $actual=[pscustomobject]@{GITHUB_ACTIONS=$env:GITHUB_ACTIONS;CI=$env:CI;GITHUB_REPOSITORY=$env:GITHUB_REPOSITORY
        RUNNER_OS=$env:RUNNER_OS;RUNNER_ARCH=$env:RUNNER_ARCH;RUNNER_ENVIRONMENT=$env:RUNNER_ENVIRONMENT
        ImageOS=$env:ImageOS;ImageVersion=$env:ImageVersion;GITHUB_RUN_ID=$env:GITHUB_RUN_ID
        GITHUB_RUN_ATTEMPT=$env:GITHUB_RUN_ATTEMPT;GITHUB_SHA=$env:GITHUB_SHA}
    $fixed=[ordered]@{GITHUB_ACTIONS='true';CI='true';GITHUB_REPOSITORY=$script:ExpectedRepository;RUNNER_OS='Windows'
        RUNNER_ARCH='X64';RUNNER_ENVIRONMENT='github-hosted';ImageOS=$script:ExpectedImageOS}
    foreach($entry in $fixed.GetEnumerator()){
        if($actual.($entry.Key) -isnot [string] -or $actual.($entry.Key) -cne $entry.Value){throw "Hosted context differs: $($entry.Key)"}
    }
    $required=[ordered]@{expectedRunId=@($ExpectedRunId,'^[1-9][0-9]*$');expectedRunAttempt=@($ExpectedRunAttempt,'^[1-9][0-9]*$')
        expectedSourceSha=@($ExpectedSourceSha,'^[0-9a-f]{40}$');expectedEventSha=@($ExpectedEventSha,'^[0-9a-f]{40}$')
        expectedImageVersion=@($ExpectedImageVersion,'^[0-9A-Za-z._-]+$');nonce=@($Nonce,'^[0-9a-f]{32}$')}
    foreach($entry in $required.GetEnumerator()){[void](Assert-MyspeedCanaryString $entry.Value[0] "Hosted context $($entry.Key)" $entry.Value[1])}
    $manifest=Read-MyspeedCanaryBoundedJson $ManifestFile $script:MaximumRequestBytes
    return [pscustomobject]@{environment=$actual
        expectedRunId=$ExpectedRunId;expectedRunAttempt=$ExpectedRunAttempt;expectedEventSha=$ExpectedEventSha
        expectedSourceSha=$ExpectedSourceSha;expectedImageVersion=$ExpectedImageVersion;nonce=$Nonce;manifest=$manifest}
}

function Invoke-MyspeedNativeControllerCore {
    param([hashtable]$Operations)
    $required=@($script:NativeControllerPhases)+@('emergencyRestore','postReconnectCleanup')
    foreach ($name in $required) {
        if ($null -eq $Operations -or -not $Operations.ContainsKey($name) -or $Operations[$name] -isnot [scriptblock]) {
            throw "Native controller operation differs: $name"
        }
    }
    $events=[Collections.Generic.List[string]]::new();$failures=[Collections.Generic.List[string]]::new()
    $restoreRequired=$false;$restored=$false
    try {
        foreach ($phase in $script:NativeControllerPhases) {
            [void]$events.Add($phase)
            if ($phase -ceq 'disableAdapters') { $restoreRequired=$true }
            & $Operations[$phase]
            if ($phase -ceq 'restoreAdapters') { $restored=$true }
        }
        return [pscustomobject][ordered]@{status='completed';canaryPassed=$true;qualifying=$false;events=[string[]]$events
            failures=[string[]]$failures;emergencyRestore=$false;adapterRestoreProven=$true;cleanupAfterReconnectProven=$true}
    } catch {
        [void]$failures.Add($_.Exception.Message)
        $emergency=$restoreRequired -and -not $restored
        if ($restoreRequired -and -not $restored) {
            [void]$events.Add('emergencyRestore')
            try { & $Operations.emergencyRestore;$restored=$true } catch { [void]$failures.Add($_.Exception.Message) }
        }
        [void]$events.Add('postReconnectCleanup')
        $cleanup=$true;try { & $Operations.postReconnectCleanup } catch { $cleanup=$false;[void]$failures.Add($_.Exception.Message) }
        return [pscustomobject][ordered]@{status='failed';canaryPassed=$false;qualifying=$false;events=[string[]]$events
            failures=[string[]]$failures;emergencyRestore=$emergency;adapterRestoreProven=(-not $restoreRequired -or $restored)
            cleanupAfterReconnectProven=$cleanup}
    }
}

function Invoke-MyspeedCanaryTcpEcho {
    param([string]$Address,[int]$Port)
    $client=[Net.Sockets.TcpClient]::new($(if($Address.Contains(':')){[Net.Sockets.AddressFamily]::InterNetworkV6}else{[Net.Sockets.AddressFamily]::InterNetwork}))
    try {
        $pending=$client.BeginConnect([Net.IPAddress]::Parse($Address),$Port,$null,$null)
        $wait=$pending.AsyncWaitHandle
        try {if(-not $wait.WaitOne($script:TcpConnectMilliseconds)){throw 'Loopback TCP connect timed out'}} finally {$wait.Dispose()}
        $client.EndConnect($pending);$stream=$client.GetStream();$stream.ReadTimeout=$script:TcpConnectMilliseconds
        $bytes=[Text.Encoding]::ASCII.GetBytes('myspeed-canary');$stream.Write($bytes,0,$bytes.Length)
        $echo=New-Object byte[] $bytes.Length;$count=$stream.Read($echo,0,$echo.Length)
        return $count -eq $bytes.Length -and [Linq.Enumerable]::SequenceEqual([byte[]]$bytes,[byte[]]$echo)
    } finally {$client.Dispose()}
}

function Invoke-MyspeedCanaryUdpEcho {
    param([string]$Address,[int]$Port)
    $family=if($Address.Contains(':')){[Net.Sockets.AddressFamily]::InterNetworkV6}else{[Net.Sockets.AddressFamily]::InterNetwork}
    $client=[Net.Sockets.UdpClient]::new($family)
    try {
        $client.Client.ReceiveTimeout=$script:TcpConnectMilliseconds;$client.Connect([Net.IPAddress]::Parse($Address),$Port)
        $bytes=[Text.Encoding]::ASCII.GetBytes('myspeed-canary');[void]$client.Send($bytes,$bytes.Length)
        $any=if($Address.Contains(':')){[Net.IPAddress]::IPv6Any}else{[Net.IPAddress]::Any}
        $peer=New-Object Net.IPEndPoint ($any,0);$echo=$client.Receive([ref]$peer)
        return [Linq.Enumerable]::SequenceEqual([byte[]]$bytes,[byte[]]$echo)
    } finally {$client.Dispose()}
}

function Invoke-MyspeedCanaryTestNet {
    param([string]$Actor)
    foreach($endpoint in $script:TestNetEndpoints){
        $outcome='denied'
        try {
            if($endpoint.transport -ceq 'tcp'){
                $client=[Net.Sockets.TcpClient]::new($(if($endpoint.addressFamily -ceq 'ipv6'){[Net.Sockets.AddressFamily]::InterNetworkV6}else{[Net.Sockets.AddressFamily]::InterNetwork}))
                try{$pending=$client.BeginConnect([Net.IPAddress]::Parse($endpoint.address),$endpoint.port,$null,$null)
                    $wait=$pending.AsyncWaitHandle
                    try{$connected=$wait.WaitOne($script:TcpConnectMilliseconds)}finally{$wait.Dispose()}
                    if(-not $connected){$outcome='timeout'}else{
                        try{$client.EndConnect($pending);$outcome='accepted'} catch [Net.Sockets.SocketException] {$outcome='denied'}}} finally {$client.Dispose()}
            } else {
                $udp=[Net.Sockets.UdpClient]::new($(if($endpoint.addressFamily -ceq 'ipv6'){[Net.Sockets.AddressFamily]::InterNetworkV6}else{[Net.Sockets.AddressFamily]::InterNetwork}))
                try{$udp.Connect([Net.IPAddress]::Parse($endpoint.address),$endpoint.port);[void]$udp.Send([byte[]](77),1);$outcome='sendAccepted'}
                catch [Net.Sockets.SocketException] {$outcome='denied'} finally {$udp.Dispose()}
            }
        } catch [Net.Sockets.SocketException] {$outcome='denied'}
        [pscustomobject]@{actor=$Actor;transport=$endpoint.transport;addressFamily=$endpoint.addressFamily
            address=$endpoint.address;port=$endpoint.port;outcome=$outcome}
    }
}

function Get-MyspeedNativeOfflineBoundary {
    param([hashtable]$State,[scriptblock]$Clock,[scriptblock]$NormalizeProviderAdapters,[scriptblock]$NormalizeAdapters,
        [scriptblock]$GetAdapterSnapshot,[scriptblock]$ProjectIpState,
        [scriptblock]$GetElapsed,[int64]$LoopbackType,
        [int64]$EnabledAdminStatus,[int64]$DisabledAdminStatus,[string[]]$KnownStatuses)
    $rawAdapters=@(Get-NetAdapter -IncludeHidden -ErrorAction Stop)
    $snapshot=& $GetAdapterSnapshot $rawAdapters $NormalizeProviderAdapters $LoopbackType $EnabledAdminStatus `
        $DisabledAdminStatus $KnownStatuses $NormalizeAdapters
    $inventory=$snapshot.inventory
    $adapters=@($inventory | ForEach-Object {[pscustomobject]@{interfaceGuid=$_.interfaceGuid;netLuid=$_.netLuid
        hidden=$_.hidden;loopback=$_.loopback;enabled=$_.enabled;status=$_.status}})
    $interfaces=@(Get-NetIPInterface -IncludeAllCompartments -ErrorAction Stop)
    $addresses=@(Get-NetIPAddress -IncludeAllCompartments -ErrorAction Stop)
    $routes=@(Get-NetRoute -IncludeAllCompartments -ErrorAction Stop)
    $ip=& $ProjectIpState $inventory $interfaces $addresses $routes
    $end=[uint64](& $Clock);$start=[uint64]$State.request.offlineStart100ns
    return [pscustomobject]@{schemaVersion=1;offlineTiming=[pscustomobject]@{clock='QueryUnbiasedInterruptTime100ns'
        start100ns=[string]$start;end100ns=[string]$end;watchdogDeadline100ns=$State.request.watchdogDeadline100ns
        elapsedMilliseconds=& $GetElapsed ([string]$start) ([string]$end)};providers=[pscustomobject]@{adapters=$true;ipInterfaces=$true
        ipAddresses=$true;routes=$true};adapters=$adapters;ipState=$ip;loopback=@();testNet=@(Invoke-MyspeedCanaryTestNet 'controller')}
}

function Get-MyspeedNativeProbeEvidence {
    param([hashtable]$State)
    $child=Read-MyspeedCanaryBoundedJson $State.probePath $script:MaximumEvidenceBytes;$State.childRecord=$child
    Assert-MyspeedCanaryExactKeys $child @('schemaVersion','nonce','sid','pid','parentPid','creationFileTime','environment','forbiddenNames','testNet') 'Child record'
    [void](Assert-MyspeedCanaryInteger $child.schemaVersion 'Child schema' 1 1)
    if($child.nonce -isnot [string] -or $child.nonce -cne $State.nonce -or $child.sid -isnot [string] -or
        $child.creationFileTime -isnot [string] -or $child.creationFileTime -cnotmatch '^[0-9a-f]{16}$'){
        throw 'Child record identity differs'
    }
    [void](Assert-MyspeedCanaryInteger $child.pid 'Child PID' 1 4294967295)
    [void](Assert-MyspeedCanaryInteger $child.parentPid 'Child parent PID' 1 4294967295)
    $service=Get-CimInstance Win32_Service -Filter ("Name='"+$State.request.serviceName.Replace("'","''")+"'") -ErrorAction Stop
    if($null -eq $service){throw 'Owned WinSW service is absent'}
    $servicePath=([string]$service.PathName).Trim().Trim('"')
    if([string]$service.StartName -cne 'LocalSystem' -or [string]$service.ServiceType -cne 'Own Process' -or
        [int]$service.ProcessId -le 0 -or
        [string]$service.StartMode -cne 'Manual' -or
        -not [string]::Equals([IO.Path]::GetFullPath($servicePath),$State.request.serviceExecutablePath,[StringComparison]::OrdinalIgnoreCase)){
        throw 'Owned WinSW service identity differs'
    }
    $wrapper=Get-Process -Id ([int]$service.ProcessId) -ErrorAction Stop;$childProcess=Get-Process -Id ([int]$child.pid) -ErrorAction Stop
    if(-not [string]::Equals($wrapper.Path,$State.request.serviceExecutablePath,[StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($childProcess.Path,$State.request.childPath,[StringComparison]::OrdinalIgnoreCase) -or
        [int]$child.parentPid -ne $wrapper.Id){throw 'Owned WinSW process tree identity differs'}
    $loops=@();foreach($endpoint in $script:LoopbackEndpoints){
        $passed=if($endpoint.transport -ceq 'tcp'){Invoke-MyspeedCanaryTcpEcho $endpoint.address $endpoint.port}else{Invoke-MyspeedCanaryUdpEcho $endpoint.address $endpoint.port}
        $owners=if($endpoint.transport -ceq 'tcp'){@(Get-NetTCPConnection -LocalPort $endpoint.port -ErrorAction Stop)}else{@(Get-NetUDPEndpoint -LocalPort $endpoint.port -ErrorAction Stop)}
        $ownedEndpoints=@($owners|Where-Object {[int]$_.OwningProcess -eq $childProcess.Id -and [string]$_.LocalAddress -ceq $endpoint.address})
        if($endpoint.transport -ceq 'tcp'){$ownedEndpoints=@($ownedEndpoints|Where-Object {[string]$_.State -ceq 'Listen'})}
        if($ownedEndpoints.Count -ne 1){
            throw 'Owned loopback endpoint identity differs'
        }
        $loops += [pscustomobject]@{transport=$endpoint.transport;addressFamily=$endpoint.addressFamily;address=$endpoint.address
            port=$endpoint.port;ownerPid=$childProcess.Id;passed=[bool]$passed}
    };$State.boundary.loopback=$loops
    $probeEndpoints=@($loops|ForEach-Object {[pscustomobject]@{transport=$_.transport;addressFamily=$_.addressFamily
        address=$_.address;port=$_.port;ownerPid=$_.ownerPid}})
    $xmlBytes=(Read-MyspeedCanaryBoundedFile $State.request.serviceXmlPath $script:MaximumConfigurationBytes).bytes
    $wrapperTime=$wrapper.StartTime.ToUniversalTime().ToFileTimeUtc().ToString('x16')
    $childTime=$childProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString('x16')
    if($child.creationFileTime -cne $childTime){throw 'Child creation identity differs'}
    Write-MyspeedCanaryCreateNewJson $State.request.ownershipPath ([pscustomobject][ordered]@{schemaVersion=1
        serviceName=$State.request.serviceName;wrapperPid=$wrapper.Id;wrapperCreationFileTime=$wrapperTime
        childPid=$childProcess.Id;childCreationFileTime=$childTime;wrapperPath=$State.request.serviceExecutablePath
        childPath=$State.request.childPath}) $script:MaximumRequestBytes
    return [pscustomobject]@{schemaVersion=1;nonce=$State.nonce;serviceName=$State.request.serviceName;wrapperPid=$wrapper.Id
        childPid=$childProcess.Id;parentPid=[int]$child.parentPid
        wrapperCreationFileTime=$wrapperTime;childCreationFileTime=$childTime;sid=$child.sid
        environment=$child.environment;forbiddenNames=@($child.forbiddenNames)
        configuration=[pscustomobject]@{bytesBase64=[Convert]::ToBase64String($xmlBytes);sha256=Get-MyspeedCanarySha256 $xmlBytes}
        endpoints=$probeEndpoints;winswSha256=Get-MyspeedCanarySha256File $State.request.serviceExecutablePath $script:MaximumWinswBytes
        childSha256=Get-MyspeedCanarySha256File $State.request.childPath $script:MaximumSourceBytes}
}

# Native mutations are reached only after Assert-MyspeedCanaryHostedContext.
function New-MyspeedNativeCanaryOperations {
    param([hashtable]$State)
    Import-Module NetAdapter -ErrorAction Stop
    Import-Module NetTCPIP -ErrorAction Stop
    Import-Module ScheduledTasks -ErrorAction Stop
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MySpeedCanaryClock {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool QueryUnbiasedInterruptTime(out ulong value);
}
public sealed class MySpeedCanaryRunResult { public int ProcessId; public uint ExitCode; }
public static class MySpeedCanaryJob {
  const uint CREATE_SUSPENDED=0x4,CREATE_NO_WINDOW=0x08000000,WAIT_OBJECT_0=0,WAIT_TIMEOUT=0x102;
  const int JobObjectBasicAccountingInformation=1,JobObjectExtendedLimitInformation=9;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x2000;
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUPINFO { public uint cb; public string lpReserved,lpDesktop,lpTitle; public uint dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags; public ushort wShowWindow,cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint processId,threadId; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint flags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass,SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long TotalUserTime,TotalKernelTime,ThisPeriodTotalUserTime,ThisPeriodTotalKernelTime; public uint TotalPageFaultCount,TotalProcesses,ActiveProcesses,TotalTerminatedProcesses; }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref EXTENDED_LIMIT info,uint length);
  [DllImport("kernel32.dll",EntryPoint="QueryInformationJobObject",SetLastError=true)] static extern bool QueryExtended(IntPtr job,int type,ref EXTENDED_LIMIT info,uint length,IntPtr returned);
  [DllImport("kernel32.dll",EntryPoint="QueryInformationJobObject",SetLastError=true)] static extern bool QueryAccounting(IntPtr job,int type,ref ACCOUNTING info,uint length,IntPtr returned);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,System.Text.StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint exitCode);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint exitCode);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint exitCode);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  static Exception Error(string name){return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),name);}
  static string Quote(string value){if(value.IndexOf('\0')>=0)throw new ArgumentException("NUL argument");var b=new System.Text.StringBuilder("\"");int slash=0;foreach(char ch in value){if(ch=='\\'){slash++;continue;}if(ch=='\"'){b.Append('\\',slash*2+1).Append(ch);slash=0;continue;}if(slash>0){b.Append('\\',slash);slash=0;}b.Append(ch);}if(slash>0)b.Append('\\',slash*2);return b.Append('\"').ToString();}
  static uint Active(IntPtr job){ACCOUNTING a=new ACCOUNTING();if(!QueryAccounting(job,JobObjectBasicAccountingInformation,ref a,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero))throw Error("QueryInformationJobObject");return a.ActiveProcesses;}
  static void Drain(IntPtr job,int cleanup){var watch=System.Diagnostics.Stopwatch.StartNew();while(Active(job)!=0&&watch.ElapsedMilliseconds<cleanup)System.Threading.Thread.Sleep(10);if(Active(job)!=0)throw new InvalidOperationException("Owned Job process-tree exit unproven");}
  public static MySpeedCanaryRunResult Run(string exe,string[] args,string cwd,int timeout,int cleanup){
    IntPtr job=IntPtr.Zero,process=IntPtr.Zero,thread=IntPtr.Zero;bool assigned=false;
    try{
      job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw Error("CreateJobObject");
      EXTENDED_LIMIT limit=new EXTENDED_LIMIT();limit.basic.flags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,ref limit,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))))throw Error("SetInformationJobObject");
      EXTENDED_LIMIT observed=new EXTENDED_LIMIT();if(!QueryExtended(job,JobObjectExtendedLimitInformation,ref observed,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT)),IntPtr.Zero))throw Error("QueryInformationJobObject limits");if(observed.basic.flags!=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)throw new InvalidOperationException("Job limits differ");
      var command=new System.Text.StringBuilder(Quote(exe));foreach(string arg in args)command.Append(' ').Append(Quote(arg));
      STARTUPINFO si=new STARTUPINFO();si.cb=(uint)Marshal.SizeOf(typeof(STARTUPINFO));PROCESS_INFORMATION pi;
      if(!CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,false,CREATE_SUSPENDED|CREATE_NO_WINDOW,IntPtr.Zero,cwd,ref si,out pi))throw Error("CreateProcessW");
      process=pi.process;thread=pi.thread;
      if(!AssignProcessToJobObject(job,process))throw Error("AssignProcessToJobObject");assigned=true;
      if(ResumeThread(thread)==UInt32.MaxValue)throw Error("ResumeThread");
      uint wait=WaitForSingleObject(process,(uint)timeout);if(wait==WAIT_TIMEOUT){if(!TerminateJobObject(job,1))throw Error("TerminateJobObject");if(WaitForSingleObject(process,(uint)cleanup)!=WAIT_OBJECT_0)throw new InvalidOperationException("Timed-out process exit unproven");Drain(job,cleanup);throw new TimeoutException("Owned Job process exceeded deadline");}
      if(wait!=WAIT_OBJECT_0)throw Error("WaitForSingleObject");uint exit;if(!GetExitCodeProcess(process,out exit))throw Error("GetExitCodeProcess");
      if(Active(job)!=0){if(!TerminateJobObject(job,1))throw Error("TerminateJobObject descendants");Drain(job,cleanup);throw new InvalidOperationException("Owned Job retained a process after the root exited");}
      return new MySpeedCanaryRunResult{ProcessId=(int)pi.processId,ExitCode=exit};
    } finally {
      if(process!=IntPtr.Zero&&!assigned){if(!TerminateProcess(process,1))throw Error("TerminateProcess cleanup");if(WaitForSingleObject(process,(uint)cleanup)!=WAIT_OBJECT_0)throw new InvalidOperationException("Unassigned process exit unproven");}
      if(job!=IntPtr.Zero){if(Active(job)!=0){if(!TerminateJobObject(job,1))throw Error("TerminateJobObject cleanup");Drain(job,cleanup);}CloseHandle(job);}if(thread!=IntPtr.Zero)CloseHandle(thread);if(process!=IntPtr.Zero)CloseHandle(process);
    }
  }
}
'@
    $getClock={ $value=[uint64]0;if(-not [MySpeedCanaryClock]::QueryUnbiasedInterruptTime([ref]$value)){throw 'Monotonic clock failed'};return $value }
    $writeJson=${function:Write-MyspeedCanaryCreateNewJson};$readJson=${function:Read-MyspeedCanaryBoundedJson}
    $readStableJson=${function:Read-MyspeedCanaryBoundedJsonUntilStable}
    $hashFile=${function:Get-MyspeedCanarySha256File};$expectedEnvironment=$script:ExpectedEnvironment
    $writeBytes=${function:Write-MyspeedCanaryCreateNewBytes};$generateChild=${function:Get-MyspeedCanaryInertChildSource}
    $enterLock=${function:Enter-MyspeedCanaryRecoveryLock}
    $getConfiguration=${function:New-MyspeedCanaryWinswConfiguration};$assertRequest=${function:Assert-MyspeedCanaryRecoveryRequest}
    $getBoundary=${function:Get-MyspeedNativeOfflineBoundary};$getProbe=${function:Get-MyspeedNativeProbeEvidence}
    $providerProjection=New-MyspeedCanaryProviderProjectionOperations
    $normalizeProviderAdapters=$providerProjection.normalizeAdapters
    $projectIpState=$providerProjection.projectIpState
    $getAdapterSnapshot=${function:Get-MyspeedCanaryAdapterProviderSnapshot}
    $assertProbe=${function:Assert-MyspeedWinswProbe};$assertBoundary=${function:Assert-MyspeedOfflineBoundary}
    $assertKeys=${function:Assert-MyspeedCanaryExactKeys};$assertInteger=${function:Assert-MyspeedCanaryInteger}
    $assertString=${function:Assert-MyspeedCanaryString}
    $getProcess=${function:Get-MyspeedCanaryProcessIfPresent}
    $assertEnvironmentOwnership=${function:Assert-MyspeedCanaryEnvironmentOwnership}
    $assertRecoveryReadiness=${function:Assert-MyspeedCanaryRecoveryReadiness}
    $disposeRecoveryTask=${function:Invoke-MyspeedCanaryRecoveryTaskDisposition}
    $getOwnedPathProcesses=${function:Get-MyspeedCanaryOwnedPathProcesses}
    $assertRestoreWindow=${function:Assert-MyspeedCanaryNormalRestoreWindow}
    $assertPortPreflight=${function:Assert-MyspeedCanaryPortPreflight};$fixedLoopbackPorts=[int[]]$script:LoopbackEndpoints.port
    $getElapsed=${function:Get-MyspeedCanaryElapsedMilliseconds}
    $maximumEvidence=$script:MaximumEvidenceBytes;$maximumRequest=$script:MaximumRequestBytes
    $maximumWinsw=$script:MaximumWinswBytes;$maximumSource=$script:MaximumSourceBytes
    $maximumCompiler=$script:MaximumCompilerBytes
    $maximumConfiguration=$script:MaximumConfigurationBytes;$winswSha=$script:WinswSha256
    $loopbackType=$script:SoftwareLoopbackInterfaceType
    $enabledAdminStatus=$script:EnabledInterfaceAdminStatus;$disabledAdminStatus=$script:DisabledInterfaceAdminStatus
    $knownAdapterStatuses=$script:KnownAdapterStatuses
    $offlineMaximum100ns=$script:OfflineMaximum100ns
    $poll=$script:RecoveryPollMilliseconds;$processDeadline=$script:CompilerDeadlineMilliseconds
    $readinessDeadlineMilliseconds=$script:MaximumRecoveryReadDeadlineMilliseconds
    $processCleanup=$script:ProcessCleanupMilliseconds
    $serviceDeadline=$script:ServiceDeadlineSeconds;$endpoints=$script:LoopbackEndpoints;$testNet=$script:TestNetEndpoints
    $runProcess={
        param([string]$File,[string[]]$Arguments,[int]$ExpectedExit=0)
        $result=[MySpeedCanaryJob]::Run($File,$Arguments,$State.taskRoot,$processDeadline,$processCleanup)
        if([int64]$result.ExitCode -ne $ExpectedExit){throw "Owned Job process exit differed: $($result.ExitCode)"}
        $record=[pscustomobject]@{file=$File;arguments=[string[]]$Arguments;processId=$result.ProcessId
            exitCode=[int64]$result.ExitCode;jobAssignedBeforeResume=$true;processTreeExitProven=$true;outputCaptured=$false}
        [void]$State.operations.Add($record);return $record
    }.GetNewClosure()
    $runWinsw={param([string]$Command)
        if((& $hashFile $State.request.serviceExecutablePath $maximumWinsw) -cne $winswSha){throw 'WinSW changed before use'}
        & $runProcess $State.request.serviceExecutablePath @($Command) 0
    }.GetNewClosure()
    $getNativeAdapters={
        $all=@(Get-NetAdapter -IncludeHidden -ErrorAction Stop)
        if($all.Count -eq 0){throw 'Adapter inventory is empty'}
        & $getAdapterSnapshot $all $normalizeProviderAdapters $loopbackType $enabledAdminStatus $disabledAdminStatus `
            $knownAdapterStatuses $normalizeAdapters
    }.GetNewClosure()
    $snapshotAdapters={ return @((& $getNativeAdapters).inventory) }.GetNewClosure()
    $waitRecoveryProcessGone={
        param([object]$Ready)
        [void](& $assertRecoveryReadiness $Ready $State.request $State.requestSha)
        $readyPid=& $assertInteger $Ready.pid 'Recovery readiness PID' 1 4294967295
        $timer=[Diagnostics.Stopwatch]::StartNew();$ownedPresent=$false
        do {
            $candidate=& $getProcess ([int]$readyPid)
            $ownedPresent=$null -ne $candidate -and
                $candidate.StartTime.ToUniversalTime().ToFileTimeUtc().ToString('x16') -ceq $Ready.creationFileTime
            if(-not $ownedPresent){break};Start-Sleep -Milliseconds $poll
        }while($timer.Elapsed.TotalSeconds -lt $serviceDeadline)
        if($ownedPresent){throw 'Owned recovery process remained after task stop'}
    }.GetNewClosure()
    $cancelRecoveryWhenAdaptersEnabled={
        if((Test-Path -LiteralPath $State.request.cancelPath -PathType Leaf) -or
            (Test-Path -LiteralPath $State.request.recoveryResultPath -PathType Leaf)){return}
        $lock=& $enterLock $State.request.lockPath
        try {
            if(Test-Path -LiteralPath $State.request.recoveryResultPath -PathType Leaf){return}
            $inventory=(& $getNativeAdapters).inventory
            foreach($target in $State.request.adapters){$matches=@($inventory|Where-Object {
                $_.interfaceGuid -ieq $target.interfaceGuid -and
                [string]::Equals($_.netLuid,$target.netLuid,[StringComparison]::Ordinal) -and $_.enabled})
                if($matches.Count -ne 1){return}}
            if(Test-Path -LiteralPath $State.request.cancelPath -PathType Leaf){return}
            & $writeBytes $State.request.cancelPath ([byte[]](1)) 1
        } finally {$lock.Dispose()}
    }.GetNewClosure()
    $restore={
        $lock=& $enterLock $State.request.lockPath
        try {
            $normalClock=[uint64](& $getClock)
            [void](& $assertRestoreWindow ([string]$normalClock) $State.request.watchdogDeadline100ns `
                ([bool](Test-Path -LiteralPath $State.request.recoveryResultPath -PathType Leaf)))
            $snapshot=& $getNativeAdapters;$all=$snapshot.raw;$inventory=$snapshot.inventory
            $matched=[Collections.Generic.List[object]]::new()
            foreach($target in $State.request.adapters){
                $indexes=@(for($index=0;$index -lt $inventory.Count;$index++){
                    if($inventory[$index].interfaceGuid -ieq $target.interfaceGuid -and
                        [string]::Equals($inventory[$index].netLuid,$target.netLuid,[StringComparison]::Ordinal)){$index}})
                if($indexes.Count -ne 1){throw 'Recovery adapter identity drifted'}
                [void]$matched.Add($all[$indexes[0]])
            }
            @($matched) | Enable-NetAdapter -Confirm:$false -ErrorAction Stop
            $after=(& $getNativeAdapters).inventory
            foreach($target in $State.request.adapters){$matches=@($after|Where-Object {$_.interfaceGuid -ieq $target.interfaceGuid -and
                [string]::Equals($_.netLuid,$target.netLuid,[StringComparison]::Ordinal) -and $_.enabled});if($matches.Count -ne 1){throw 'Recovery adapter enable proof failed'}}
            $offlineEnd=[uint64](& $getClock)
            [void](& $assertRestoreWindow ([string]$offlineEnd) $State.request.watchdogDeadline100ns $false)
            if($null -eq $State.boundary){throw 'Offline boundary is absent before restoration'}
            $offlineStart=[uint64]$State.boundary.offlineTiming.start100ns
            $State.boundary.offlineTiming.end100ns=[string]$offlineEnd
            $State.boundary.offlineTiming.elapsedMilliseconds=& $getElapsed ([string]$offlineStart) ([string]$offlineEnd)
            [void](& $assertBoundary $State.boundary)
            & $writeBytes $State.request.cancelPath ([byte[]](1)) 1
            if(Test-Path -LiteralPath $State.request.recoveryResultPath -PathType Leaf){throw 'Independent emergency restoration raced normal restoration'}
        } finally {$lock.Dispose()}
    }.GetNewClosure()
    $cleanup={
        $cleanupFailures=[Collections.Generic.List[string]]::new()
        if($State.serviceOwnershipEligible){try{
            $service=Get-CimInstance Win32_Service -Filter ("Name='"+$State.request.serviceName.Replace("'","''")+"'") -ErrorAction Stop
            if($null -ne $service){
                $path=([string]$service.PathName).Trim().Trim('"')
                if(-not [string]::Equals([IO.Path]::GetFullPath($path),$State.request.serviceExecutablePath,[StringComparison]::OrdinalIgnoreCase) -or
                    (& $hashFile $State.request.serviceExecutablePath $maximumWinsw) -cne $winswSha){throw 'Owned service drifted before cleanup'}
                if([string]$service.State -cne 'Stopped'){& $runWinsw 'stop' | Out-Null}
                & $runWinsw 'uninstall' | Out-Null
            }
            if($null -ne (Get-CimInstance Win32_Service -Filter ("Name='"+$State.request.serviceName.Replace("'","''")+"'") -ErrorAction Stop)){
                throw 'Owned service remained after cleanup'
            }
            $wait=[Diagnostics.Stopwatch]::StartNew();do{
                $remaining=@(& $getOwnedPathProcesses @(Get-CimInstance Win32_Process -ErrorAction Stop) `
                    @($State.request.serviceExecutablePath,$State.request.childPath))
                if($remaining.Count -eq 0){break};Start-Sleep -Milliseconds $poll
            }while($wait.Elapsed.TotalSeconds -lt $serviceDeadline)
            if($remaining.Count -ne 0){throw 'Owned lingering service tree exit is unproven; PID-based forced cleanup is forbidden'}
            $owned=$null
            if($null -ne $State.probe){$owned=[pscustomobject]@{wrapperPid=$State.probe.wrapperPid;wrapperCreationFileTime=$State.probe.wrapperCreationFileTime
                childPid=$State.probe.childPid;childCreationFileTime=$State.probe.childCreationFileTime}}
            elseif(Test-Path -LiteralPath $State.request.ownershipPath -PathType Leaf){$owned=& $readJson $State.request.ownershipPath $maximumRequest
                & $assertKeys $owned @('schemaVersion','serviceName','wrapperPid','wrapperCreationFileTime','childPid','childCreationFileTime','wrapperPath','childPath') 'Owned service record'
                if($owned.serviceName -cne $State.request.serviceName -or $owned.wrapperPath -cne $State.request.serviceExecutablePath -or
                    $owned.childPath -cne $State.request.childPath){throw 'Owned service record identity differs'}
                [void](& $assertInteger $owned.schemaVersion 'Owned service schema' 1 1)
                [void](& $assertInteger $owned.wrapperPid 'Owned wrapper PID' 1 4294967295)
                [void](& $assertInteger $owned.childPid 'Owned child PID' 1 4294967295)
                [void](& $assertString $owned.wrapperCreationFileTime 'Owned wrapper creation time' '^[0-9a-f]{16}$')
                [void](& $assertString $owned.childCreationFileTime 'Owned child creation time' '^[0-9a-f]{16}$')
            }
            if($null -ne $owned){foreach($record in @(@($owned.wrapperPid,$owned.wrapperCreationFileTime),@($owned.childPid,$owned.childCreationFileTime))){
                $candidate=& $getProcess ([int]$record[0])
                if($null -ne $candidate -and $candidate.StartTime.ToUniversalTime().ToFileTimeUtc().ToString('x16') -ceq $record[1]){
                    throw 'Owned service process remained after cleanup'
                }
            }}
        }catch{[void]$cleanupFailures.Add('service cleanup: '+$_.Exception.Message)}}
        if($State.taskOwnershipEligible){try{
            $tasks=@(Get-ScheduledTask -ErrorAction Stop | Where-Object {$_.TaskName -ceq $State.request.taskName})
            if($tasks.Count -gt 1){throw 'Owned recovery task is duplicated'}
            $taskPresent=$tasks.Count -eq 1;$taskRunning=$false
            if($taskPresent){$task=$tasks[0];$actions=@($task.Actions);if($actions.Count -ne 1 -or $actions[0].Execute -cne $State.recoveryPowerShell -or
                $actions[0].Arguments -cne $State.recoveryArguments){throw 'Owned recovery task drifted before cleanup'}
                $taskRunning=$task.State -ceq 'Running'}
            $readyPresent=Test-Path -LiteralPath $State.request.readyPath -PathType Leaf
            $cleanupReady=$null
            if($readyPresent){
                # Cleanup gets a fresh read budget even when arming used its full deadline.
                $cleanupReadTimer=[Diagnostics.Stopwatch]::StartNew()
                $capturedCleanupReadTimer=$cleanupReadTimer
                $cleanupReadOperations=[pscustomobject]@{
                    elapsed={return [int64]$capturedCleanupReadTimer.ElapsedMilliseconds}.GetNewClosure()
                    sleep={param([int]$milliseconds) Start-Sleep -Milliseconds $milliseconds}.GetNewClosure()}
                $cleanupReady=& $readStableJson $State.request.readyPath $maximumRequest $readinessDeadlineMilliseconds `
                    $cleanupReadOperations
            }
            # Nested dynamic modules do not inherit the outer closure's captured
            # variables. Reuse its existing callback and explicitly bind locals
            # for the callbacks that need this cleanup invocation's readiness.
            $cancelCallback=$cancelRecoveryWhenAdaptersEnabled
            $cleanupState=$State;$cleanupPoll=$poll;$cleanupDeadline=$serviceDeadline
            $cleanupWaitProcess=$waitRecoveryProcessGone
            $waitTaskCallback={
                $taskTimer=[Diagnostics.Stopwatch]::StartNew();do{$observed=Get-ScheduledTask -TaskName $cleanupState.request.taskName -ErrorAction Stop
                    if($observed.State -cne 'Running'){return};Start-Sleep -Milliseconds $cleanupPoll
                }while($taskTimer.Elapsed.TotalSeconds -lt $cleanupDeadline)
                throw 'Owned recovery task remains active; cleanup cannot interrupt restoration'
            }.GetNewClosure()
            $waitProcessCallback={& $cleanupWaitProcess $cleanupReady}.GetNewClosure()
            $unregisterCallback={Unregister-ScheduledTask -TaskName $cleanupState.request.taskName -Confirm:$false -ErrorAction Stop}.GetNewClosure()
            [void](& $disposeRecoveryTask $taskPresent $taskRunning $readyPresent $cancelCallback $waitTaskCallback `
                $waitProcessCallback $unregisterCallback)
        }catch{[void]$cleanupFailures.Add('task cleanup: '+$_.Exception.Message)}}
        if($State.insertedEnvironment.Count -gt 0){try{
            $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)
            try {$key=$base.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment',$true);try{
                foreach($name in @($State.insertedEnvironment)){$expected=[string]$expectedEnvironment[$name]
                    if($key.GetValueNames() -cnotcontains $name){continue}
                    if($key.GetValueKind($name) -ne [Microsoft.Win32.RegistryValueKind]::String -or
                        [string]$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -cne $expected){throw "Owned environment drifted: $name"}
                    $key.DeleteValue($name,$true)}
                }finally{$key.Dispose()}}finally{$base.Dispose()};$State.insertedEnvironment.Clear()
        }catch{[void]$cleanupFailures.Add('environment cleanup: '+$_.Exception.Message)}}
        if($cleanupFailures.Count -ne 0){throw ($cleanupFailures -join '; ')}
    }.GetNewClosure()
    return @{
        prepare={
            if(Test-Path -LiteralPath $State.taskRoot){throw 'Owned task root collision'}
            [IO.Directory]::CreateDirectory($State.taskRoot) | Out-Null
            $State.rootOwned=$true
            if($null -ne (Get-CimInstance Win32_Service -Filter ("Name='"+$State.request.serviceName.Replace("'","''")+"'") -ErrorAction Stop)){
                throw 'Owned service name collision'
            }
            [void](& $assertPortPreflight @(Get-NetTCPConnection -ErrorAction Stop) @(Get-NetUDPEndpoint -ErrorAction Stop) `
                $fixedLoopbackPorts)
            [IO.File]::Copy($State.closure.winswPath,$State.request.serviceExecutablePath,$false)
            if((& $hashFile $State.request.serviceExecutablePath $maximumWinsw) -cne $winswSha){throw 'Copied WinSW differs'}
            $signature=Get-AuthenticodeSignature -LiteralPath $State.closure.winswPath -ErrorAction Stop
            $State.winswAuthenticodeStatus=& $assertString ([string]$signature.Status) 'WinSW Authenticode status'
            $generated=& $generateChild $State.nonce $State.probePath
            [void](& $writeBytes $State.sourcePath ([Text.UTF8Encoding]::new($false).GetBytes($generated.source)) $maximumSource)
            $State.sourceSha=$generated.sha256
            $compiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
            if(-not (Test-Path -LiteralPath $compiler -PathType Leaf)){throw 'Pinned inbox compiler is absent'}
            $State.compiler=[pscustomobject][ordered]@{path=$compiler;sha256=& $hashFile $compiler $maximumCompiler
                fileVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($compiler).FileVersion}
            & $runProcess $compiler @('/nologo','/target:exe','/platform:x64','/optimize+',('/out:'+$State.request.childPath),$State.sourcePath) 0 | Out-Null
            $State.childSha=& $hashFile $State.request.childPath $maximumSource
            $xml=& $getConfiguration $State.nonce
            [void](& $writeBytes $State.request.serviceXmlPath ([Text.UTF8Encoding]::new($false).GetBytes($xml)) $maximumConfiguration)
            $State.configurationSha=& $hashFile $State.request.serviceXmlPath $maximumConfiguration
            $State.adapters=& $snapshotAdapters
            $State.request.adapters=@($State.adapters | Where-Object {-not $_.loopback -and $_.enabled} | ForEach-Object {
                [pscustomobject]@{interfaceGuid=$_.interfaceGuid;netLuid=$_.netLuid}})
            if($State.request.adapters.Count -eq 0){throw 'No enabled non-loopback recovery adapters'}
            $State.request.offlineStart100ns=([string](& $getClock));$State.request.watchdogDeadline100ns=
                ([string]([uint64]$State.request.offlineStart100ns+[uint64]$offlineMaximum100ns))
            [void](& $assertRequest $State.request)
            & $writeJson $State.requestPath $State.request $maximumRequest
            $State.requestSha=& $hashFile $State.requestPath $maximumRequest
            $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)
            try{$key=$base.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment',$true);try{
                foreach($entry in $expectedEnvironment.GetEnumerator()){if($key.GetValueNames() -icontains $entry.Key){throw "Machine environment collision: $($entry.Key)"}}
                $environmentOwnership=[pscustomobject][ordered]@{schemaVersion=1;names=@($expectedEnvironment.Keys)}
                [void](& $assertEnvironmentOwnership $environmentOwnership)
                & $writeJson $State.environmentOwnershipPath $environmentOwnership $maximumRequest
                foreach($entry in $expectedEnvironment.GetEnumerator()){$key.SetValue($entry.Key,$entry.Value,[Microsoft.Win32.RegistryValueKind]::String)
                    [void]$State.insertedEnvironment.Add($entry.Key)}
                }finally{$key.Dispose()}}finally{$base.Dispose()}
            $State.serviceOwnershipEligible=$true
            & $runWinsw 'install' | Out-Null
            $installed=Get-CimInstance Win32_Service -Filter ("Name='"+$State.request.serviceName.Replace("'","''")+"'") -ErrorAction Stop
            if($null -eq $installed){throw 'Installed WinSW service is absent'}
            $installedPath=([string]$installed.PathName).Trim().Trim('"')
            if([string]$installed.StartName -cne 'LocalSystem' -or [string]$installed.ServiceType -cne 'Own Process' -or
                [string]$installed.StartMode -cne 'Manual' -or
                -not [string]::Equals([IO.Path]::GetFullPath($installedPath),$State.request.serviceExecutablePath,[StringComparison]::OrdinalIgnoreCase)){
                throw 'Installed WinSW service identity differs'
            }
        }.GetNewClosure()
        armRecovery={
            if(@(Get-ScheduledTask -ErrorAction Stop | Where-Object {$_.TaskName -ceq $State.request.taskName}).Count -ne 0){throw 'Recovery task collision'}
            $powerShell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $arguments="-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$($State.request.scriptPath)`" -Mode InvokeRestorationOnly -RequestPath `"$($State.requestPath)`" -ExpectedRequestSha256 $($State.requestSha)"
            $action=New-ScheduledTaskAction -Execute $powerShell -Argument $arguments
            $principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
            $State.recoveryPowerShell=$powerShell;$State.recoveryArguments=$arguments
            & $writeJson $State.taskOwnershipPath ([pscustomobject][ordered]@{schemaVersion=1;taskName=$State.request.taskName
                powerShell=$powerShell;arguments=$arguments;requestSha256=$State.requestSha}) $maximumRequest
            $State.taskOwnershipEligible=$true
            Register-ScheduledTask -TaskName $State.request.taskName -Action $action -Principal $principal -ErrorAction Stop | Out-Null
            $registered=Get-ScheduledTask -TaskName $State.request.taskName -ErrorAction Stop;$registeredActions=@($registered.Actions)
            if($registeredActions.Count -ne 1 -or $registeredActions[0].Execute -cne $powerShell -or
                $registeredActions[0].Arguments -cne $arguments -or [string]$registered.Principal.UserId -cne 'SYSTEM'){
                throw 'Registered recovery task identity differs'
            }
            Start-ScheduledTask -TaskName $State.request.taskName -ErrorAction Stop
            $timer=[Diagnostics.Stopwatch]::StartNew();$State.readinessTimer=$timer
            while(-not (Test-Path -LiteralPath $State.request.readyPath)){
                if($timer.Elapsed.TotalSeconds -ge $serviceDeadline){throw 'Recovery task readiness timed out'};Start-Sleep -Milliseconds $poll}
            $capturedReadinessTimer=$timer
            $readinessOperations=[pscustomobject]@{
                elapsed={return [int64]$capturedReadinessTimer.ElapsedMilliseconds}.GetNewClosure()
                sleep={param([int]$milliseconds) Start-Sleep -Milliseconds $milliseconds}.GetNewClosure()}
            $State.ready=& $readStableJson $State.request.readyPath $maximumRequest $readinessDeadlineMilliseconds `
                $readinessOperations
            [void](& $assertRecoveryReadiness $State.ready $State.request $State.requestSha)
            $readyPid=& $assertInteger $State.ready.pid 'Recovery readiness PID' 1 4294967295
            $readyProcess=Get-Process -Id $readyPid -ErrorAction Stop
            if($State.ready.creationFileTime -cne $readyProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString('x16')){
                throw 'Recovery readiness identity differs'
            }
            if((Get-ScheduledTask -TaskName $State.request.taskName -ErrorAction Stop).State -cne 'Running' -or
                [uint64](& $getClock) -ge [uint64]$State.request.watchdogDeadline100ns){throw 'Recovery task is not armed before its deadline'}
        }.GetNewClosure()
        disableAdapters={
            if((& $hashFile $State.requestPath $maximumRequest) -cne $State.requestSha -or
                (& $hashFile $State.request.scriptPath $maximumSource) -cne $State.request.scriptSha256 -or
                (& $hashFile $State.request.serviceExecutablePath $maximumWinsw) -cne $winswSha -or
                (& $hashFile $State.sourcePath $maximumSource) -cne $State.sourceSha -or
                (& $hashFile $State.request.childPath $maximumSource) -cne $State.childSha -or
                (& $hashFile $State.request.serviceXmlPath $maximumConfiguration) -cne $State.configurationSha){
                throw 'Owned input changed before adapter disable'
            }
            # Arming and the pre-disable re-read deliberately share one readiness deadline.
            $capturedDisableReadinessTimer=$State.readinessTimer
            $disableReadinessOperations=[pscustomobject]@{
                elapsed={return [int64]$capturedDisableReadinessTimer.ElapsedMilliseconds}.GetNewClosure()
                sleep={param([int]$milliseconds) Start-Sleep -Milliseconds $milliseconds}.GetNewClosure()}
            $ready=& $readStableJson $State.request.readyPath $maximumRequest $readinessDeadlineMilliseconds `
                $disableReadinessOperations
            [void](& $assertRecoveryReadiness $ready $State.request $State.requestSha)
            $readyPid=& $assertInteger $ready.pid 'Recovery readiness recheck PID' 1 4294967295;$readyProcess=& $getProcess ([int]$readyPid)
            if($null -eq $readyProcess -or $ready.creationFileTime -cne $readyProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString('x16')){
                throw 'Recovery readiness changed before adapter disable'
            }
            $task=Get-ScheduledTask -TaskName $State.request.taskName -ErrorAction Stop;$taskActions=@($task.Actions)
            if($task.State -cne 'Running' -or [string]$task.Principal.UserId -cne 'SYSTEM' -or $taskActions.Count -ne 1 -or
                $taskActions[0].Execute -cne $State.recoveryPowerShell -or $taskActions[0].Arguments -cne $State.recoveryArguments){
                throw 'Recovery task changed before adapter disable'
            }
            $current=& $getNativeAdapters;$matched=[Collections.Generic.List[object]]::new()
            foreach($target in $State.request.adapters){$indexes=@(for($index=0;$index -lt $current.inventory.Count;$index++){
                if($current.inventory[$index].interfaceGuid -ieq $target.interfaceGuid -and
                    [string]::Equals($current.inventory[$index].netLuid,$target.netLuid,[StringComparison]::Ordinal) -and
                    $current.inventory[$index].enabled){$index}})
                if($indexes.Count -ne 1){throw 'Adapter changed before disable'};[void]$matched.Add($current.raw[$indexes[0]])}
            $preIp=& $projectIpState $current.inventory @(Get-NetIPInterface -IncludeAllCompartments -ErrorAction Stop) `
                @(Get-NetIPAddress -IncludeAllCompartments -ErrorAction Stop) @(Get-NetRoute -IncludeAllCompartments -ErrorAction Stop)
            $preKinds=@($preIp.kind|Sort-Object -Unique)
            if(($preKinds -join "`n") -cne (@('address','interface','route') -join "`n")){throw 'Pre-disable IP provider projection is incomplete'}
            $State.preDisable=[pscustomobject][ordered]@{providers=[pscustomobject]@{adapters=$true;ipInterfaces=$true
                ipAddresses=$true;routes=$true};adapters=@($current.inventory|ForEach-Object {[pscustomobject]@{
                    interfaceGuid=$_.interfaceGuid;netLuid=$_.netLuid;hidden=$_.hidden;loopback=$_.loopback
                    enabled=$_.enabled;status=$_.status}});ipState=$preIp}
            @($matched) | Disable-NetAdapter -Confirm:$false -ErrorAction Stop
        }.GetNewClosure()
        verifyOffline={ $State.boundary=& $getBoundary -State $State -Clock $getClock -NormalizeProviderAdapters $normalizeProviderAdapters `
            -NormalizeAdapters $normalizeAdapters -GetAdapterSnapshot $getAdapterSnapshot `
            -ProjectIpState $projectIpState -GetElapsed $getElapsed `
            -LoopbackType $loopbackType -EnabledAdminStatus $enabledAdminStatus -DisabledAdminStatus $disabledAdminStatus `
            -KnownStatuses $knownAdapterStatuses }.GetNewClosure()
        startService={
            & $runWinsw 'start' | Out-Null
            $timer=[Diagnostics.Stopwatch]::StartNew();while(-not (Test-Path -LiteralPath $State.probePath)){
                if($timer.Elapsed.TotalSeconds -ge $serviceDeadline){throw 'Inert child readiness timed out'};Start-Sleep -Milliseconds $poll}
        }.GetNewClosure()
        probe={ $State.probe=& $getProbe -State $State;[void](& $assertProbe $State.probe)
            $State.boundary.testNet=@($State.boundary.testNet)+@($State.childRecord.testNet) }.GetNewClosure()
        teardownService={
            & $runWinsw 'stop' | Out-Null
            & $runWinsw 'uninstall' | Out-Null
            $timer=[Diagnostics.Stopwatch]::StartNew();do{
                $ownedRemain=$false
                foreach($record in @(@($State.probe.wrapperPid,$State.probe.wrapperCreationFileTime),@($State.probe.childPid,$State.probe.childCreationFileTime))){
                    $candidate=& $getProcess ([int]$record[0])
                    if($null -ne $candidate -and $candidate.StartTime.ToUniversalTime().ToFileTimeUtc().ToString('x16') -ceq $record[1]){$ownedRemain=$true}
                }
                $ownedPaths=@(& $getOwnedPathProcesses @(Get-CimInstance Win32_Process -ErrorAction Stop) `
                    @($State.request.serviceExecutablePath,$State.request.childPath))
                if(-not $ownedRemain -and $ownedPaths.Count -eq 0){break};Start-Sleep -Milliseconds $poll
            }while($timer.Elapsed.TotalSeconds -lt $serviceDeadline)
            if($ownedRemain -or $ownedPaths.Count -ne 0){throw 'Owned service tree remained after teardown'}
            if($null -ne (Get-CimInstance Win32_Service -Filter ("Name='"+$State.request.serviceName.Replace("'","''")+"'") -ErrorAction Stop)){
                throw 'Owned service remained after uninstall'
            }
        }.GetNewClosure()
        restoreAdapters=$restore
        disarmRecovery={
            if(-not (Test-Path -LiteralPath $State.request.cancelPath -PathType Leaf) -or
                (Get-Item -LiteralPath $State.request.cancelPath -Force -ErrorAction Stop).Length -ne 1){throw 'Recovery cancellation proof differs'}
            $timer=[Diagnostics.Stopwatch]::StartNew();do{$task=Get-ScheduledTask -TaskName $State.request.taskName -ErrorAction Stop
                if($task.State -ne 'Running'){break};Start-Sleep -Milliseconds $poll}while($timer.Elapsed.TotalSeconds -lt $serviceDeadline)
            if($task.State -eq 'Running'){throw 'Recovery task did not stop'}
            & $waitRecoveryProcessGone $State.ready
            $actions=@($task.Actions);if($actions.Count -ne 1 -or $actions[0].Execute -cne $State.recoveryPowerShell -or
                $actions[0].Arguments -cne $State.recoveryArguments){throw 'Recovery task drifted before disarm'}
            Unregister-ScheduledTask -TaskName $State.request.taskName -Confirm:$false -ErrorAction Stop;$State.taskOwnershipEligible=$false
            if(Test-Path -LiteralPath $State.request.recoveryResultPath -PathType Leaf){throw 'Emergency recovery result forbids normal completion'}
        }.GetNewClosure()
        restoreEnvironment=$cleanup
        emergencyRestore=$restore
        postReconnectCleanup=$cleanup
    }
}

function Assert-MyspeedCanaryAdministrator {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=[Security.Principal.WindowsPrincipal]::new($identity)
    if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or $identity.User.Value -ceq $script:ExpectedSystemSid){
        throw 'Hosted canary controller requires the non-System administrator'
    }
}

function Assert-MyspeedCanaryInboxPowerShellHost {
    $expected=[IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
    $actual=[IO.Path]::GetFullPath([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
    if($PSVersionTable.PSEdition -cne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or
        -not [Environment]::Is64BitProcess -or -not [Environment]::Is64BitOperatingSystem -or
        -not [string]::Equals($actual,$expected,[StringComparison]::OrdinalIgnoreCase)){
        throw 'Native canary requires pinned inbox 64-bit Windows PowerShell 5.1'
    }
}

function New-MyspeedCanaryRequestState {
    param([object]$Context,[object]$Closure)
    $runnerTemp=Test-MyspeedCanaryWindowsPath $env:RUNNER_TEMP 'RUNNER_TEMP'
    $taskRoot=[IO.Path]::Combine($runnerTemp,"myspeed-winsw-offline-$($Context.nonce)")
    $expectedEvidence=[IO.Path]::Combine($taskRoot,$script:EvidenceFilename)
    if(-not [string]::Equals((Test-MyspeedCanaryWindowsPath $EvidencePath 'Evidence path'),$expectedEvidence,[StringComparison]::OrdinalIgnoreCase)){
        throw 'Evidence path differs from the exact nonce root'
    }
    $serviceName="MySpeedOfflineCanary-$($Context.nonce)";$taskName="MySpeedOfflineRecovery-$($Context.nonce)"
    $request=[pscustomobject][ordered]@{schemaVersion=1;kind=$script:RecoveryRequestKind
        expectedRunId=$Context.expectedRunId;expectedRunAttempt=$Context.expectedRunAttempt;expectedEventSha=$Context.expectedEventSha
        expectedSourceSha=$Context.expectedSourceSha;expectedImageVersion=$Context.expectedImageVersion;nonce=$Context.nonce
        scriptPath=$Closure.scriptPath;scriptSha256=$Context.manifest.files[0].sha256;taskRoot=$taskRoot
        lockPath=[IO.Path]::Combine($taskRoot,'recovery.lock');cancelPath=[IO.Path]::Combine($taskRoot,'recovery.cancel')
        readyPath=[IO.Path]::Combine($taskRoot,'recovery.ready.json');recoveryResultPath=[IO.Path]::Combine($taskRoot,'recovery.result.json')
        cleanupResultPath=[IO.Path]::Combine($taskRoot,'cleanup.result.json');ownershipPath=[IO.Path]::Combine($taskRoot,$script:OwnershipFilename)
        taskName=$taskName;serviceName=$serviceName;serviceExecutablePath=[IO.Path]::Combine($taskRoot,"$serviceName.exe")
        serviceXmlPath=[IO.Path]::Combine($taskRoot,"$serviceName.xml");childPath=[IO.Path]::Combine($taskRoot,'inert-child.exe')
        environment=[pscustomobject]$script:ExpectedEnvironment;adapters=@();offlineStart100ns='0'
        watchdogDeadline100ns=[string]$script:OfflineMaximum100ns}
    return @{context=$Context;closure=$Closure;nonce=$Context.nonce;taskRoot=$taskRoot;request=$request
        requestPath=[IO.Path]::Combine($taskRoot,$script:RecoveryRequestFilename);probePath=[IO.Path]::Combine($taskRoot,$script:ChildResultFilename)
        sourcePath=[IO.Path]::Combine($taskRoot,'inert-child.cs');evidencePath=$expectedEvidence
        environmentOwnershipPath=[IO.Path]::Combine($taskRoot,$script:EnvironmentOwnershipFilename)
        taskOwnershipPath=[IO.Path]::Combine($taskRoot,$script:TaskOwnershipFilename)
        rootOwned=$false;serviceOwnershipEligible=$false;taskOwnershipEligible=$false;preDisable=$null;boundary=$null;probe=$null
        sourceSha=$null;childSha=$null;configurationSha=$null;compiler=$null;operations=[Collections.Generic.List[object]]::new()
        winswAuthenticodeStatus=$null
        insertedEnvironment=[Collections.Generic.List[string]]::new()}
}

function New-MyspeedHostedCanaryEvidence {
    param([object]$Context,[hashtable]$State,[object]$Result)
    $result=$Result;$state=$State
    $normal=$result.status -ceq 'completed';$emergency=[bool]$result.emergencyRestore
    $recovery=[pscustomobject][ordered]@{schemaVersion=1;classification=$(if($normal){'awaitingContinuation'}else{'inconclusive'})
        emergencyRestore=$emergency;serviceTeardownProven=$normal;adapterRestoreProven=[bool]$result.adapterRestoreProven
        recoveryTaskGoneProven=$(if($normal){$true}else{[bool]$result.cleanupAfterReconnectProven})
        environmentRestoredProven=$(if($normal){$true}else{[bool]$result.cleanupAfterReconnectProven})
        continuationObserved=$false;cleanupAfterReconnectProven=$false
        phaseOrder=$(if($normal){$script:NormalRecoveryOrder}elseif($emergency){$script:EmergencyRecoveryOrder}else{$script:FailedCleanupOrder})}
    return [pscustomobject][ordered]@{schemaVersion=1;kind='myspeed-winsw-offline-canary';status=$result.status
        qualifying=$false;canaryPassed=$false;offlineCanaryPassed=[bool]$result.canaryPassed
        sourceSha=$Context.expectedSourceSha;eventSha=$Context.expectedEventSha
        runId=$Context.expectedRunId;runAttempt=$Context.expectedRunAttempt;imageVersion=$Context.expectedImageVersion;nonce=$Context.nonce
        preDisable=$state.preDisable;boundary=$state.boundary;probe=$state.probe;recovery=$recovery;events=$result.events;failures=$result.failures
        build=[pscustomobject][ordered]@{sourcePath=$state.sourcePath;sourceSha256=$state.sourceSha;compiler=$state.compiler
            childPath=$state.request.childPath;childSha256=$state.childSha;configurationSha256=$state.configurationSha
            winswAuthenticodeStatus=$state.winswAuthenticodeStatus}
        operations=@($state.operations)
        releaseGatesCleared=@()}
}

function Invoke-MyspeedHostedNativeCanary {
    param([object]$Context)
    # Native mutations are reached only after Assert-MyspeedCanaryHostedContext.
    [void](Assert-MyspeedCanaryHostedContext $Context)
    Assert-MyspeedCanaryInboxPowerShellHost
    $closure=Assert-MyspeedCanaryClosureFiles $Context $ClosureRoot $ManifestPath
    Assert-MyspeedCanaryAdministrator
    $state=New-MyspeedCanaryRequestState $Context $closure
    $operations=New-MyspeedNativeCanaryOperations $state
    $result=Invoke-MyspeedNativeControllerCore $operations
    $evidence=New-MyspeedHostedCanaryEvidence $Context $state $result
    $normal=$result.status -ceq 'completed'
    if($state.rootOwned){[void](Assert-MyspeedCanaryOwnedAggregate $state.taskRoot $script:MaximumEvidenceBytes)
        Write-MyspeedCanaryCreateNewJson $state.evidencePath $evidence $script:MaximumEvidenceBytes}
    if(-not $normal){throw ('Hosted canary failed: '+($result.failures -join '; '))}
    return $evidence
}

function Read-MyspeedVerifiedRecoveryRequest {
    param([string]$Path,[string]$Hash)
    $requestPath=Test-MyspeedCanaryWindowsPath $Path 'Recovery request path'
    $expected=Assert-MyspeedCanaryString $Hash 'Recovery request SHA' '^[0-9a-f]{64}$'
    $file=Read-MyspeedCanaryBoundedFile $requestPath $script:MaximumRequestBytes
    if($file.sha256 -cne $expected){throw 'Recovery request SHA differs'}
    try{$request=([Text.UTF8Encoding]::new($false,$true).GetString($file.bytes)|ConvertFrom-Json)}catch{throw 'Recovery request JSON is invalid'}
    [void](Assert-MyspeedCanaryRecoveryRequest $request)
    $expectedPath=[IO.Path]::Combine($request.taskRoot,$script:RecoveryRequestFilename)
    if(-not [string]::Equals($requestPath,$expectedPath,[StringComparison]::OrdinalIgnoreCase)){throw 'Recovery request path differs from owned root'}
    if(-not [string]::Equals([IO.Path]::GetFullPath($PSCommandPath),$request.scriptPath,[StringComparison]::OrdinalIgnoreCase)){
        throw 'Recovery request is not bound to the executing sealed script'
    }
    if((Get-MyspeedCanarySha256File $request.scriptPath $script:MaximumSourceBytes) -cne $request.scriptSha256){throw 'Recovery script SHA differs'}
    return $request
}

function Invoke-MyspeedRestorationOnly {
    param([object]$Request,[string]$RequestSha)
    Assert-MyspeedCanaryInboxPowerShellHost
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    if($identity.User.Value -cne $script:ExpectedSystemSid){throw 'Restoration-only entry requires LocalSystem'}
    Import-Module NetAdapter -ErrorAction Stop
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MySpeedRestorationClock {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool QueryUnbiasedInterruptTime(out ulong value);
}
'@
    $process=[Diagnostics.Process]::GetCurrentProcess()
    $ready=[pscustomobject][ordered]@{schemaVersion=1;sid=$identity.User.Value;pid=$process.Id
        creationFileTime=$process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString('x16');requestSha256=$RequestSha
        scriptSha256=$Request.scriptSha256;taskName=$Request.taskName}
    Write-MyspeedCanaryCreateNewJson $Request.readyPath $ready $script:MaximumRequestBytes
    $deadline=[uint64]$Request.watchdogDeadline100ns;$now=[uint64]0
    do {
        if(Test-Path -LiteralPath $Request.cancelPath -PathType Leaf){return [pscustomobject]@{cancelled=$true;emergencyRestore=$false}}
        if(-not [MySpeedRestorationClock]::QueryUnbiasedInterruptTime([ref]$now)){throw 'Restoration clock failed'}
        if($now -ge $deadline){break};Start-Sleep -Milliseconds $script:RecoveryPollMilliseconds
    } while($true)
    $adapterRestored=$false;$resultWritten=$false;$failure=$null;$lock=$null;$result=$null
    try {
        $lock=Enter-MyspeedCanaryRecoveryLock $Request.lockPath
        if(Test-Path -LiteralPath $Request.cancelPath -PathType Leaf){return [pscustomobject]@{cancelled=$true;emergencyRestore=$false}}
        $all=@(Get-NetAdapter -IncludeHidden -ErrorAction Stop)
        $snapshot=Get-MyspeedCanaryAdapterProviderSnapshot $all
        $inventory=$snapshot.inventory
        $matched=[Collections.Generic.List[object]]::new()
        foreach($target in $Request.adapters){
            $indexes=@(for($index=0;$index -lt $inventory.Count;$index++){
                if($inventory[$index].interfaceGuid -ieq $target.interfaceGuid -and
                    [string]::Equals($inventory[$index].netLuid,$target.netLuid,[StringComparison]::Ordinal)){$index}})
            if($indexes.Count -ne 1){throw 'Emergency adapter identity drifted'}
            [void]$matched.Add($all[$indexes[0]])
        }
        @($matched) | Enable-NetAdapter -Confirm:$false -ErrorAction Stop
        $after=@(Get-NetAdapter -IncludeHidden -ErrorAction Stop)
        $afterInventory=(Get-MyspeedCanaryAdapterProviderSnapshot $after).inventory
        foreach($target in $Request.adapters){if(@($afterInventory|Where-Object {$_.interfaceGuid -ieq $target.interfaceGuid -and
            [string]::Equals($_.netLuid,$target.netLuid,[StringComparison]::Ordinal) -and $_.enabled}).Count -ne 1){throw 'Emergency adapter enable proof failed'}}
        $adapterRestored=$true
        $result=[pscustomobject][ordered]@{schemaVersion=1;classification='inconclusive';emergencyRestore=$true
            serviceTeardownProven=$false;adapterRestoreProven=$true;requestSha256=$RequestSha;failure=$null}
        Write-MyspeedCanaryCreateNewJson $Request.recoveryResultPath $result $script:MaximumRequestBytes
        $resultWritten=$true
    } catch {$failure=$_.Exception.Message} finally {if($null -ne $lock){$lock.Dispose()}}
    if(-not $resultWritten -and -not (Test-Path -LiteralPath $Request.recoveryResultPath -PathType Leaf)){
        $failedResult=[pscustomobject][ordered]@{schemaVersion=1;classification='inconclusive';emergencyRestore=$true
            serviceTeardownProven=$false;adapterRestoreProven=$adapterRestored;requestSha256=$RequestSha;failure=$failure}
        try{Write-MyspeedCanaryCreateNewJson $Request.recoveryResultPath $failedResult $script:MaximumRequestBytes}
        catch{$failure="$failure; emergency result write: $($_.Exception.Message)"}
    }
    [void](Assert-MyspeedCanaryEmergencyRestorationRecorded $adapterRestored $resultWritten)
    return $result
}

function Invoke-MyspeedPostReconnectCleanup {
    param([object]$Context,[object]$Request,[string]$RequestSha)
    # Native cleanup is reached only after Assert-MyspeedCanaryHostedContext.
    [void](Assert-MyspeedCanaryHostedContext $Context)
    Assert-MyspeedCanaryInboxPowerShellHost
    $closure=Assert-MyspeedCanaryClosureFiles $Context $ClosureRoot $ManifestPath
    if(-not [string]::Equals($closure.scriptPath,$Request.scriptPath,[StringComparison]::OrdinalIgnoreCase)){throw 'Cleanup script path differs'}
    Assert-MyspeedCanaryAdministrator
    $state=@{context=$Context;closure=$closure;nonce=$Context.nonce;taskRoot=$Request.taskRoot;request=$Request
        requestSha=$RequestSha;requestPath=$RequestPath;probePath=[IO.Path]::Combine($Request.taskRoot,$script:ChildResultFilename)
        sourcePath=[IO.Path]::Combine($Request.taskRoot,'inert-child.cs');serviceOwnershipEligible=$true
        taskOwnershipEligible=$false;probe=$null;operations=[Collections.Generic.List[object]]::new()
        insertedEnvironment=[Collections.Generic.List[string]]::new()}
    $state.recoveryPowerShell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $state.recoveryArguments="-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$($Request.scriptPath)`" -Mode InvokeRestorationOnly -RequestPath `"$RequestPath`" -ExpectedRequestSha256 $RequestSha"
    $taskOwnershipPath=[IO.Path]::Combine($Request.taskRoot,$script:TaskOwnershipFilename)
    if(Test-Path -LiteralPath $taskOwnershipPath -PathType Leaf){
        $taskOwnership=Read-MyspeedCanaryBoundedJson $taskOwnershipPath $script:MaximumRequestBytes
        Assert-MyspeedCanaryExactKeys $taskOwnership @('schemaVersion','taskName','powerShell','arguments','requestSha256') 'Task ownership'
        [void](Assert-MyspeedCanaryInteger $taskOwnership.schemaVersion 'Task ownership schema' 1 1)
        if($taskOwnership.taskName -isnot [string] -or $taskOwnership.taskName -cne $Request.taskName -or
            $taskOwnership.powerShell -isnot [string] -or $taskOwnership.powerShell -cne $state.recoveryPowerShell -or
            $taskOwnership.arguments -isnot [string] -or $taskOwnership.arguments -cne $state.recoveryArguments -or
            $taskOwnership.requestSha256 -isnot [string] -or $taskOwnership.requestSha256 -cne $RequestSha){
            throw 'Task ownership identity differs'
        }
        $state.taskOwnershipEligible=$true
    }
    $state.taskOwnershipPath=$taskOwnershipPath
    $environmentOwnershipPath=[IO.Path]::Combine($Request.taskRoot,$script:EnvironmentOwnershipFilename)
    if(Test-Path -LiteralPath $environmentOwnershipPath -PathType Leaf){
        $environmentOwnership=Read-MyspeedCanaryBoundedJson $environmentOwnershipPath $script:MaximumRequestBytes
        [void](Assert-MyspeedCanaryEnvironmentOwnership $environmentOwnership)
        foreach($name in $environmentOwnership.names){[void]$state.insertedEnvironment.Add($name)}
    }
    $state.environmentOwnershipPath=$environmentOwnershipPath
    $operations=New-MyspeedNativeCanaryOperations $state
    & $operations.postReconnectCleanup
    $expectedEvidence=[IO.Path]::Combine($Request.taskRoot,$script:EvidenceFilename)
    if(-not [string]::Equals((Test-MyspeedCanaryWindowsPath $EvidencePath 'Post-reconnect evidence path'),$expectedEvidence,
        [StringComparison]::OrdinalIgnoreCase)){throw 'Post-reconnect evidence path differs'}
    $main=Read-MyspeedCanaryBoundedJson $expectedEvidence $script:MaximumEvidenceBytes
    Assert-MyspeedCanaryExactKeys $main @('schemaVersion','kind','status','qualifying','canaryPassed','offlineCanaryPassed',
        'sourceSha','eventSha','runId','runAttempt','imageVersion','nonce','preDisable','boundary','probe','recovery','events','failures',
        'build','operations','releaseGatesCleared') 'Hosted canary result'
    [void](Assert-MyspeedCanaryInteger $main.schemaVersion 'Hosted canary result schema' 1 1)
    $strings=[ordered]@{kind='myspeed-winsw-offline-canary';status='completed';sourceSha=$Context.expectedSourceSha
        eventSha=$Context.expectedEventSha;runId=$Context.expectedRunId;runAttempt=$Context.expectedRunAttempt
        imageVersion=$Context.expectedImageVersion;nonce=$Context.nonce}
    foreach($entry in $strings.GetEnumerator()){
        if($main.($entry.Key) -isnot [string] -or $main.($entry.Key) -cne $entry.Value){throw "Hosted canary result binding differs: $($entry.Key)"}
    }
    foreach($name in @('qualifying','canaryPassed','offlineCanaryPassed')){[void](Assert-MyspeedCanaryBoolean $main.$name "Hosted canary result $name")}
    [void](Assert-MyspeedAwaitingContinuationRecovery $main.recovery)
    Assert-MyspeedCanaryOrderedStrings $main.events $script:NativeControllerPhases 'Hosted canary result events'
    if((Assert-MyspeedCanaryArray $main.failures 'Hosted canary result failures').Count -ne 0 -or
        (Assert-MyspeedCanaryArray $main.releaseGatesCleared 'Hosted canary result release gates').Count -ne 0){
        throw 'Hosted canary result contains failures or gate claims'}
    $normal=-not $main.qualifying -and -not $main.canaryPassed -and $main.offlineCanaryPassed -and
        -not (Test-Path -LiteralPath $Request.recoveryResultPath -PathType Leaf)
    $result=[pscustomobject][ordered]@{schemaVersion=1;status=$(if($normal){'completed'}else{'failed'})
        classification=$(if($normal){'completed'}else{'inconclusive'});qualifying=$false;canaryPassed=[bool]$normal
        emergencyRestore=$(if($normal){$false}else{$true});serviceTeardownProven=$(if($normal){$true}else{$false})
        adapterRestoreProven=[bool]$main.recovery.adapterRestoreProven;recoveryTaskGoneProven=$true
        environmentRestoredProven=$true;continuationObserved=$true;cleanupAfterReconnectProven=$true
        requestSha256=$RequestSha;sourceSha=$Context.expectedSourceSha;eventSha=$Context.expectedEventSha
        runId=$Context.expectedRunId;runAttempt=$Context.expectedRunAttempt;nonce=$Context.nonce;releaseGatesCleared=@()}
    [void](Assert-MyspeedCanaryOwnedAggregate $Request.taskRoot $script:MaximumRequestBytes)
    Write-MyspeedCanaryCreateNewJson $Request.cleanupResultPath $result $script:MaximumRequestBytes
    if(-not $normal){throw 'Post-reconnect continuation did not validate the offline canary'}
    return $result
}

function ConvertFrom-MyspeedCanaryInput {
    if ($InputJson -isnot [string] -or [string]::IsNullOrWhiteSpace($InputJson)) { throw 'Input JSON is empty' }
    return $InputJson | ConvertFrom-Json
}

if ($Mode -ceq 'Library') { return }
$inputValue=ConvertFrom-MyspeedCanaryInput
$outputValue=switch ($Mode) {
    'GetContract' { Get-MyspeedCanaryContract }
    'ValidateManifest' { Assert-MyspeedCanaryManifest $inputValue }
    'AssertContext' { Assert-MyspeedCanaryHostedContext $inputValue }
    'ValidateRecoveryRequest' { Assert-MyspeedCanaryRecoveryRequest $inputValue }
    'ValidateEnvironmentOwnership' { Assert-MyspeedCanaryEnvironmentOwnership $inputValue }
    'ValidateRecoveryReadiness' {
        Assert-MyspeedCanaryExactKeys $inputValue @('ready','request','requestSha256') 'Recovery readiness validation request'
        [void](Assert-MyspeedCanaryRecoveryRequest $inputValue.request)
        Assert-MyspeedCanaryRecoveryReadiness $inputValue.ready $inputValue.request $inputValue.requestSha256
    }
    'NormalizeAdapters' {
        Assert-MyspeedCanaryExactKeys $inputValue @('adapters') 'Native adapter normalization request'
        $providerProjection=New-MyspeedCanaryProviderProjectionOperations
        (Get-MyspeedCanaryAdapterProviderSnapshot $inputValue.adapters $providerProjection.normalizeAdapters).inventory
    }
    'ProjectIpState' {
        Assert-MyspeedCanaryExactKeys $inputValue @('adapters','interfaces','addresses','routes') 'Native IP state projection request'
        $providerProjection=New-MyspeedCanaryProviderProjectionOperations
        $inventory=(Get-MyspeedCanaryAdapterProviderSnapshot $inputValue.adapters $providerProjection.normalizeAdapters).inventory
        & $providerProjection.projectIpState $inventory $inputValue.interfaces $inputValue.addresses $inputValue.routes
    }
    'ProjectOwnedProcesses' {
        Assert-MyspeedCanaryExactKeys $inputValue @('processes','ownedPaths') 'Native owned process projection request'
        [pscustomobject]@{processes=@(Get-MyspeedCanaryOwnedPathProcesses $inputValue.processes $inputValue.ownedPaths)}
    }
    'GetInertChildSource' {
        Assert-MyspeedCanaryExactKeys $inputValue @('nonce','resultPath') 'Inert child source request'
        Get-MyspeedCanaryInertChildSource $inputValue.nonce $inputValue.resultPath
    }
    'ClassifyBoundary' { Assert-MyspeedOfflineBoundary $inputValue }
    'ValidateProbe' { Assert-MyspeedWinswProbe $inputValue }
    'AssessRecovery' { Get-MyspeedRecoveryAssessment $inputValue }
    'TestPortPreflight' {
        Assert-MyspeedCanaryExactKeys $inputValue @('tcpEndpoints','udpEndpoints') 'Injected port preflight request'
        Assert-MyspeedCanaryPortPreflight $inputValue.tcpEndpoints $inputValue.udpEndpoints
    }
    'TestRecoveryRace' {
        Assert-MyspeedCanaryExactKeys $inputValue @('current100ns','deadline100ns','emergencyResultPresent',
            'adapterRestored','resultWritten') 'Injected recovery race request'
        [void](Assert-MyspeedCanaryNormalRestoreWindow $inputValue.current100ns $inputValue.deadline100ns `
            $inputValue.emergencyResultPresent)
        [void](Assert-MyspeedCanaryEmergencyRestorationRecorded $inputValue.adapterRestored $inputValue.resultWritten)
        [pscustomobject]@{accepted=$true}
    }
    'TestRecoveryTaskCleanup' {
        Assert-MyspeedCanaryExactKeys $inputValue @('taskPresent','taskRunning','readyPresent','failAt') `
            'Injected recovery task cleanup request'
        $taskPresent=Assert-MyspeedCanaryBoolean $inputValue.taskPresent 'Injected task presence'
        $taskRunning=Assert-MyspeedCanaryBoolean $inputValue.taskRunning 'Injected task running state'
        $readyPresent=Assert-MyspeedCanaryBoolean $inputValue.readyPresent 'Injected readiness presence'
        if($null -ne $inputValue.failAt -and ($inputValue.failAt -isnot [string] -or
            @('cancel','waitTask','waitProcess','unregister') -cnotcontains $inputValue.failAt)){
            throw 'Injected recovery cleanup failure point differs'
        }
        $failure=$inputValue.failAt
        $makeCallback={param([string]$Name)
            $capturedName=$Name;$capturedFailure=$failure
            return {if($capturedFailure -ceq $capturedName){throw "Injected failure: $capturedName"}}.GetNewClosure()
        }
        Invoke-MyspeedCanaryRecoveryTaskDisposition $taskPresent $taskRunning $readyPresent `
            (& $makeCallback 'cancel') (& $makeCallback 'waitTask') (& $makeCallback 'waitProcess') `
            (& $makeCallback 'unregister')
    }
    'TestLifecycle' {
        Assert-MyspeedCanaryExactKeys $inputValue @('failAt','emergencyRestoreSucceeded','emergencyCleanupSucceeded') `
            'Injected lifecycle request'
        if ($null -ne $inputValue.failAt -and ($inputValue.failAt -isnot [string] -or
            $script:NormalPhases -cnotcontains $inputValue.failAt)) { throw 'Injected lifecycle failure phase differs' }
        [void](Assert-MyspeedCanaryBoolean $inputValue.emergencyCleanupSucceeded 'Injected cleanup result')
        [void](Assert-MyspeedCanaryBoolean $inputValue.emergencyRestoreSucceeded 'Injected restoration result')
        $operations=@{}
        foreach ($phase in (@($script:NormalPhases)+@('emergencyRestore','postReconnectCleanup'))) {
            $capturedPhase=$phase;$capturedInput=$inputValue
            $operations[$phase]={
                if ($capturedInput.failAt -ceq $capturedPhase) { throw "Injected failure: $capturedPhase" }
                if ($capturedPhase -ceq 'emergencyRestore' -and -not $capturedInput.emergencyRestoreSucceeded) {
                    throw 'Injected emergency restoration failure'
                }
                if ($capturedPhase -ceq 'postReconnectCleanup' -and -not $capturedInput.emergencyCleanupSucceeded) {
                    throw 'Injected post-reconnect cleanup failure'
                }
            }.GetNewClosure()
        }
        Invoke-MyspeedInjectedCanaryLifecycle $operations
    }
    'TestNativeController' {
        Assert-MyspeedCanaryExactKeys $inputValue @('failAt','cleanupFails') 'Injected native controller request'
        [void](Assert-MyspeedCanaryBoolean $inputValue.cleanupFails 'Injected native cleanup result')
        if($null -ne $inputValue.failAt -and ($inputValue.failAt -isnot [string] -or
            (@($script:NativeControllerPhases)+@('emergencyRestore','postReconnectCleanup')) -cnotcontains $inputValue.failAt)){
            throw 'Injected native controller phase differs'
        }
        $events=[Collections.Generic.List[string]]::new();$operations=@{}
        foreach($phase in (@($script:NativeControllerPhases)+@('emergencyRestore','postReconnectCleanup'))){
            $captured=$phase;$failure=$inputValue.failAt;$cleanupFails=$inputValue.cleanupFails;$list=$events
            $operations[$phase]={ [void]$list.Add($captured);if($failure -ceq $captured -or
                ($captured -ceq 'postReconnectCleanup' -and $cleanupFails)){throw "Injected failure: $captured"} }.GetNewClosure()
        }
        $result=Invoke-MyspeedNativeControllerCore $operations
        $context=[pscustomobject]@{expectedSourceSha=('a'*40);expectedEventSha=('b'*40);expectedRunId='1';expectedRunAttempt='1'
            expectedImageVersion='test';nonce=('c'*32)}
        $state=@{preDisable=$null;boundary=$null;probe=$null;sourcePath='C:\injected\inert-child.cs';sourceSha=$null;compiler=$null
            request=[pscustomobject]@{childPath='C:\injected\inert-child.exe'};childSha=$null;configurationSha=$null
            winswAuthenticodeStatus=$null
            operations=[Collections.Generic.List[object]]::new()}
        New-MyspeedHostedCanaryEvidence $context $state $result
    }
    'EmitClosureManifest' { Write-MyspeedCanaryClosureManifest $ClosureRoot $ManifestPath }
    'InvokeHostedCanary' {
        $context=Get-MyspeedActualHostedContext $ManifestPath
        Invoke-MyspeedHostedNativeCanary $context
    }
    'InvokeRestorationOnly' {
        $request=Read-MyspeedVerifiedRecoveryRequest $RequestPath $ExpectedRequestSha256
        Invoke-MyspeedRestorationOnly $request $ExpectedRequestSha256
    }
    'InvokePostReconnect' {
        $context=Get-MyspeedActualHostedContext $ManifestPath
        [void](Assert-MyspeedCanaryHostedContext $context)
        $request=Read-MyspeedVerifiedRecoveryRequest $RequestPath $ExpectedRequestSha256
        Invoke-MyspeedPostReconnectCleanup $context $request $ExpectedRequestSha256
    }
}
if ($null -ne $outputValue) { $outputValue | ConvertTo-Json -Compress -Depth 12 }
