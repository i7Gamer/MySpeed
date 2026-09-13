[CmdletBinding()]
param(
    [ValidateSet('Library', 'GetContract', 'Simulate')]
    [string]$Mode = 'Library',
    [string]$InputJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RollbackSchemaVersion = 1
$script:RollbackRequestKind = 'myspeed-msi-sacrificial-rollback-state-request'
$script:InstallFilesAction = 'InstallFiles'
$script:ActionStartMessageCode = 0x08000000
$script:ActionDataMessageCode = 0x09000000
$script:ErrorMessageCode = 0x01000000
$script:MessageClassMask = 0xFF000000
$script:MessageStyleMask = 0x0000000F
$script:AbortRetryIgnoreStyle = 0x00000002
$script:ResponseOk = 'IDOK'
$script:ResponseAbort = 'IDABORT'
$script:ResponseCancel = 'IDCANCEL'
$script:ResponseUnauthorized = 'UNAUTHORIZED'
$script:MaximumPathCharacters = 1024
$script:MaximumRecordFields = 16
$script:MaximumRecordFieldCharacters = 4096
$script:MinimumStandardInstallerError = 1000
$script:MaximumStandardInstallerError = 1999
$script:ErrorWritingToFile = 1304
$script:RetryCancelStyle = 0x00000005
$script:InstallUserExit = 1602

function Test-MyspeedExactInteger {
    param($Value)
    return $Value -is [int] -or $Value -is [long]
}

function Assert-MyspeedExactObject {
    param($Value, [string[]]$Keys, [string]$Label)

    if ($null -eq $Value -or $Value -is [System.Array] -or $Value -is [string] -or
        $Value -is [ValueType]) {
        throw "$Label must be an exact object"
    }

    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $expected = @($Keys | Sort-Object)
    if ($actual.Count -ne $expected.Count) {
        throw "$Label must have exact keys"
    }
    for ($index = 0; $index -lt $expected.Count; $index++) {
        if (-not [string]::Equals($actual[$index], $expected[$index], [StringComparison]::Ordinal)) {
            throw "$Label must have exact keys"
        }
    }
}
function Assert-MyspeedExactString {
    param($Value, [string]$Label, [int]$MaximumCharacters = 4096)

    if ($Value -isnot [string] -or $Value.Length -eq 0 -or $Value.Length -gt $MaximumCharacters -or
        $Value -match '[\x00-\x1f\x7f]') {
        throw "$Label must be an exact bounded string"
    }
}

function Assert-MyspeedExactBoolean {
    param($Value, [string]$Label)
    if ($Value -isnot [bool]) {
        throw "$Label must be an exact Boolean"
    }
}

function Assert-MyspeedSha256 {
    param($Value, [string]$Label)
    if ($Value -isnot [string] -or $Value -cnotmatch '^[0-9a-f]{64}$') {
        throw "$Label must be an exact lowercase SHA-256"
    }
}

function Assert-MyspeedBoundTargetPath {
    param($Value, [string]$Label)
    Assert-MyspeedExactString $Value $Label $script:MaximumPathCharacters
    if ($Value -cnotmatch '^[A-Z]:\\[^*?"<>|:]+(?:\\[^*?"<>|:]+)*$' -or $Value -match '(?:^|\\)\.\.?(?:\\|$)') {
        throw "$Label must be an exact canonical Windows target path"
    }
}

function Assert-MyspeedStringArray {
    param($Value, [string]$Label)
    if ($Value -isnot [System.Array] -or $Value.Rank -ne 1 -or $Value.Count -lt 1 -or
        $Value.Count -gt $script:MaximumRecordFields) {
        throw "$Label must be an exact bounded string array"
    }
    foreach ($item in $Value) {
        Assert-MyspeedExactString $item "$Label item" $script:MaximumRecordFieldCharacters
    }
}

function Test-MyspeedOrdinalEqual {
    param($Left, $Right)
    return $Left -is [string] -and $Right -is [string] -and
        [string]::Equals($Left, $Right, [StringComparison]::Ordinal)
}

function Test-MyspeedOrdinalArrayEqual {
    param($Left, $Right)
    if ($Left -isnot [System.Array] -or $Right -isnot [System.Array] -or $Left.Count -ne $Right.Count) {
        return $false
    }
    for ($index = 0; $index -lt $Left.Count; $index++) {
        if (-not (Test-MyspeedOrdinalEqual $Left[$index] $Right[$index])) {
            return $false
        }
    }
    return $true
}

function Assert-MyspeedMessageCode {
    param($Value, [string]$Label)
    if (-not (Test-MyspeedExactInteger $Value) -or [long]$Value -lt 0 -or [long]$Value -gt [uint32]::MaxValue) {
        throw "$Label must be an exact unsigned 32-bit integer"
    }
}

function Assert-MyspeedActionStartRecord {
    param($Record, [string]$Label, [string]$ExpectedActionName = '')
    Assert-MyspeedExactObject $Record @('messageTypeCode', 'actionName', 'description', 'template') $Label
    Assert-MyspeedMessageCode $Record.messageTypeCode "$Label messageTypeCode"
    if ([long]$Record.messageTypeCode -ne $script:ActionStartMessageCode) {
        throw "$Label messageTypeCode is invalid"
    }
    foreach ($name in @('actionName', 'description', 'template')) {
        Assert-MyspeedExactString $Record.$name "$Label $name" $script:MaximumRecordFieldCharacters
    }
    if ($ExpectedActionName.Length -gt 0 -and -not (Test-MyspeedOrdinalEqual $Record.actionName $ExpectedActionName)) {
        throw "$Label must be for $ExpectedActionName"
    }
}

function Assert-MyspeedActionDataRecord {
    param($Record, [string]$Label)
    Assert-MyspeedExactObject $Record @('messageTypeCode', 'fileToken', 'directoryToken', 'sizeBytes') $Label
    Assert-MyspeedMessageCode $Record.messageTypeCode "$Label messageTypeCode"
    if ([long]$Record.messageTypeCode -ne $script:ActionDataMessageCode) {
        throw "$Label messageTypeCode is invalid"
    }
    Assert-MyspeedExactString $Record.fileToken "$Label fileToken" 128
    Assert-MyspeedExactString $Record.directoryToken "$Label directoryToken" 128
    if (-not (Test-MyspeedExactInteger $Record.sizeBytes) -or [long]$Record.sizeBytes -lt 1) {
        throw "$Label sizeBytes must be an exact positive integer"
    }
}

function Assert-MyspeedRemoveActionDataRecord {
    param($Record, [string]$Label)
    Assert-MyspeedExactObject $Record @('messageTypeCode', 'productCode') $Label
    Assert-MyspeedMessageCode $Record.messageTypeCode "$Label messageTypeCode"
    if ([long]$Record.messageTypeCode -ne $script:ActionDataMessageCode) {
        throw "$Label messageTypeCode is invalid"
    }
    Assert-MyspeedExactString $Record.productCode "$Label productCode" 64
    if ($Record.productCode -cnotmatch '^\{[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$') {
        throw "$Label productCode is invalid"
    }
}

function Assert-MyspeedGenericActionDataRecord {
    param($Record, [string]$Label)
    Assert-MyspeedExactObject $Record @('messageTypeCode', 'recordFields') $Label
    Assert-MyspeedMessageCode $Record.messageTypeCode "$Label messageTypeCode"
    if ([long]$Record.messageTypeCode -ne $script:ActionDataMessageCode) {
        throw "$Label messageTypeCode is invalid"
    }
    Assert-MyspeedStringArray $Record.recordFields "$Label recordFields"
}

function Assert-MyspeedErrorRecord {
    param($Record, [string]$Label)
    Assert-MyspeedExactObject $Record @('messageTypeCode', 'errorCode', 'parameters') $Label
    Assert-MyspeedMessageCode $Record.messageTypeCode "$Label messageTypeCode"
    $messageStyle = [long]$Record.messageTypeCode -band $script:MessageStyleMask
    if (([long]$Record.messageTypeCode -band $script:MessageClassMask) -ne $script:ErrorMessageCode -or
        $messageStyle -notin @($script:AbortRetryIgnoreStyle, $script:RetryCancelStyle)) {
        throw "$Label must be an ERROR record whose raw message style supports a reviewed cancel response"
    }
    if (-not (Test-MyspeedExactInteger $Record.errorCode) -or
        [long]$Record.errorCode -lt $script:MinimumStandardInstallerError -or
        [long]$Record.errorCode -gt $script:MaximumStandardInstallerError) {
        throw "$Label errorCode must be an exact standard Windows Installer error"
    }
    Assert-MyspeedStringArray $Record.parameters "$Label parameters"
}

function Assert-MyspeedSecurityDescriptor {
    param($Descriptor, [string]$Label)
    Assert-MyspeedExactObject $Descriptor @('ownerSid', 'groupSid', 'daclSddl', 'controlFlags',
        'inheritanceProtected', 'bytesBase64', 'sha256') $Label
    foreach ($name in @('ownerSid', 'groupSid', 'daclSddl')) {
        Assert-MyspeedExactString $Descriptor.$name "$Label $name" 4096
    }
    if (-not (Test-MyspeedExactInteger $Descriptor.controlFlags) -or [long]$Descriptor.controlFlags -lt 0) {
        throw "$Label controlFlags must be an exact nonnegative integer"
    }
    Assert-MyspeedExactBoolean $Descriptor.inheritanceProtected "$Label inheritanceProtected"
    if ($Descriptor.inheritanceProtected -ne $true) {
        throw "$Label must describe a non-inheriting sacrificial directory"
    }
    Assert-MyspeedExactString $Descriptor.bytesBase64 "$Label bytesBase64" 65536
    Assert-MyspeedSha256 $Descriptor.sha256 "$Label sha256"
    try {
        $bytes = [Convert]::FromBase64String($Descriptor.bytesBase64)
    } catch {
        throw "$Label bytesBase64 is invalid"
    }
    if ($bytes.Length -eq 0 -or -not (Test-MyspeedOrdinalEqual ([Convert]::ToBase64String($bytes)) $Descriptor.bytesBase64)) {
        throw "$Label bytesBase64 must be canonical and nonempty"
    }
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $actualSha = ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $hasher.Dispose()
    }
    if (-not (Test-MyspeedOrdinalEqual $actualSha $Descriptor.sha256)) {
        throw "$Label bytes and SHA-256 differ"
    }
}

function Test-MyspeedSecurityDescriptorEqual {
    param($Left, $Right)
    foreach ($name in @('ownerSid', 'groupSid', 'daclSddl', 'bytesBase64', 'sha256')) {
        if (-not (Test-MyspeedOrdinalEqual $Left.$name $Right.$name)) { return $false }
    }
    return [long]$Left.controlFlags -eq [long]$Right.controlFlags -and
        $Left.inheritanceProtected -eq $Right.inheritanceProtected
}

function Assert-MyspeedRollbackRequest {
    param($Request)
    Assert-MyspeedExactObject $Request @('schemaVersion', 'kind', 'targetDirectoryPath', 'targetFilePath', 'aceTag',
        'originalSecurity', 'expectedRemoveActionRecord', 'expectedRemoveActionDataRecord',
        'expectedActionRecord', 'expectedActionDataRecord', 'expectedErrorRecord') 'Rollback request'
    if (-not (Test-MyspeedExactInteger $Request.schemaVersion) -or
        [long]$Request.schemaVersion -ne $script:RollbackSchemaVersion) {
        throw 'Rollback request schemaVersion must be the exact supported integer'
    }
    if (-not (Test-MyspeedOrdinalEqual $Request.kind $script:RollbackRequestKind)) {
        throw 'Rollback request kind is invalid'
    }
    Assert-MyspeedBoundTargetPath $Request.targetDirectoryPath 'Rollback request targetDirectoryPath'
    Assert-MyspeedBoundTargetPath $Request.targetFilePath 'Rollback request targetFilePath'
    $targetPrefix = $Request.targetDirectoryPath + '\'
    if (-not $Request.targetFilePath.StartsWith($targetPrefix, [StringComparison]::Ordinal)) {
        throw 'Rollback request targetFilePath must be strictly below targetDirectoryPath'
    }
    Assert-MyspeedExactString $Request.aceTag 'Rollback request aceTag' 128
    if ($Request.aceTag -cnotmatch '^myspeed-rollback-[0-9a-f]{32}$') {
        throw 'Rollback request aceTag is invalid'
    }
    Assert-MyspeedSecurityDescriptor $Request.originalSecurity 'Rollback request originalSecurity'
    Assert-MyspeedActionStartRecord $Request.expectedRemoveActionRecord 'Expected removal action record' 'RemoveExistingProducts'
    Assert-MyspeedRemoveActionDataRecord $Request.expectedRemoveActionDataRecord 'Expected removal action-data record'
    Assert-MyspeedActionStartRecord $Request.expectedActionRecord 'Expected action record' $script:InstallFilesAction
    Assert-MyspeedActionDataRecord $Request.expectedActionDataRecord 'Expected action-data record'
    Assert-MyspeedErrorRecord $Request.expectedErrorRecord 'Expected error record'
    if ([long]$Request.expectedErrorRecord.errorCode -ne $script:ErrorWritingToFile -or
        $Request.expectedErrorRecord.parameters.Count -ne 1 -or
        -not (Test-MyspeedOrdinalEqual $Request.expectedErrorRecord.parameters[0] $Request.targetFilePath)) {
        throw 'Expected error record must be exact error 1304 for the canonical sacrificial target file'
    }
}

function Assert-MyspeedActionEvent {
    param($Event)
    Assert-MyspeedActionStartRecord $Event 'ACTIONSTART event'
}

function Assert-MyspeedActionDataEvent {
    param($Event)
    Assert-MyspeedActionDataRecord $Event 'ACTIONDATA event'
}

function Assert-MyspeedErrorEvent {
    param($Event)
    Assert-MyspeedErrorRecord $Event 'ERROR event'
}

function Assert-MyspeedOperationFacts {
    param($Facts)
    Assert-MyspeedExactObject $Facts @('observeTarget', 'applyDenyAce', 'verifyDenyAce',
        'removeDenyAce', 'verifyOriginalSecurity') 'Operation facts'

    Assert-MyspeedExactObject $Facts.observeTarget @('targetPath', 'removeExistingProductsCompleted',
        'targetDirectoryPresent', 'targetDirectoryOwned', 'predecessorPresent', 'candidatePresent',
        'nonInheriting', 'originalSecurity') 'observeTarget fact'
    Assert-MyspeedBoundTargetPath $Facts.observeTarget.targetPath 'observeTarget targetPath'
    Assert-MyspeedExactBoolean $Facts.observeTarget.removeExistingProductsCompleted 'observeTarget removal proof'
    Assert-MyspeedExactBoolean $Facts.observeTarget.targetDirectoryPresent 'observeTarget directory existence'
    Assert-MyspeedExactBoolean $Facts.observeTarget.targetDirectoryOwned 'observeTarget directory ownership'
    Assert-MyspeedExactBoolean $Facts.observeTarget.predecessorPresent 'observeTarget predecessor state'
    Assert-MyspeedExactBoolean $Facts.observeTarget.candidatePresent 'observeTarget candidate state'
    Assert-MyspeedExactBoolean $Facts.observeTarget.nonInheriting 'observeTarget inheritance state'
    Assert-MyspeedSecurityDescriptor $Facts.observeTarget.originalSecurity 'observeTarget original security'

    Assert-MyspeedExactObject $Facts.applyDenyAce @('targetPath', 'aceTag', 'applied') 'applyDenyAce fact'
    Assert-MyspeedBoundTargetPath $Facts.applyDenyAce.targetPath 'applyDenyAce targetPath'
    Assert-MyspeedExactString $Facts.applyDenyAce.aceTag 'applyDenyAce aceTag' 128
    Assert-MyspeedExactBoolean $Facts.applyDenyAce.applied 'applyDenyAce applied'

    Assert-MyspeedExactObject $Facts.verifyDenyAce @('targetPath', 'aceTag', 'denyAcePresent',
        'denyAceCanonical', 'installerWriteDenied', 'originalSecurity') 'verifyDenyAce fact'
    Assert-MyspeedBoundTargetPath $Facts.verifyDenyAce.targetPath 'verifyDenyAce targetPath'
    Assert-MyspeedExactString $Facts.verifyDenyAce.aceTag 'verifyDenyAce aceTag' 128
    Assert-MyspeedExactBoolean $Facts.verifyDenyAce.denyAcePresent 'verifyDenyAce denyAcePresent'
    Assert-MyspeedExactBoolean $Facts.verifyDenyAce.denyAceCanonical 'verifyDenyAce canonical position'
    Assert-MyspeedExactBoolean $Facts.verifyDenyAce.installerWriteDenied 'verifyDenyAce effective denial'
    Assert-MyspeedSecurityDescriptor $Facts.verifyDenyAce.originalSecurity 'verifyDenyAce original security'

    Assert-MyspeedExactObject $Facts.removeDenyAce @('targetPath', 'aceTag', 'removed') 'removeDenyAce fact'
    Assert-MyspeedBoundTargetPath $Facts.removeDenyAce.targetPath 'removeDenyAce targetPath'
    Assert-MyspeedExactString $Facts.removeDenyAce.aceTag 'removeDenyAce aceTag' 128
    Assert-MyspeedExactBoolean $Facts.removeDenyAce.removed 'removeDenyAce removed'

    Assert-MyspeedExactObject $Facts.verifyOriginalSecurity @('targetPath', 'aceTag', 'denyAcePresent',
        'originalSecurity', 'ownerRestored', 'groupRestored', 'daclRestored', 'controlRestored',
        'inheritanceRestored') 'security restoration fact'
    Assert-MyspeedBoundTargetPath $Facts.verifyOriginalSecurity.targetPath 'security restoration targetPath'
    Assert-MyspeedExactString $Facts.verifyOriginalSecurity.aceTag 'security restoration aceTag' 128
    Assert-MyspeedExactBoolean $Facts.verifyOriginalSecurity.denyAcePresent 'security restoration denyAcePresent'
    Assert-MyspeedSecurityDescriptor $Facts.verifyOriginalSecurity.originalSecurity 'security restoration descriptor'
    Assert-MyspeedExactBoolean $Facts.verifyOriginalSecurity.ownerRestored 'security restoration ownerRestored'
    Assert-MyspeedExactBoolean $Facts.verifyOriginalSecurity.groupRestored 'security restoration groupRestored'
    Assert-MyspeedExactBoolean $Facts.verifyOriginalSecurity.daclRestored 'security restoration daclRestored'
    Assert-MyspeedExactBoolean $Facts.verifyOriginalSecurity.controlRestored 'security restoration controlRestored'
    Assert-MyspeedExactBoolean $Facts.verifyOriginalSecurity.inheritanceRestored 'security restoration inheritanceRestored'
}

function New-MyspeedRollbackState {
    return [pscustomobject]@{
        phase = 'awaiting-remove-existing-products'
        currentAction = $null
        denyAceMayBeActive = $false
        expectedErrorSeen = $false
        callbackCount = 0
        timeline = @()
        failure = $null
    }
}

function Add-MyspeedTimeline {
    param($State, [string]$Entry)
    $State.timeline = @($State.timeline) + @($Entry)
}

function New-MyspeedCallbackResult {
    param([bool]$Accepted, [string]$Response, $State)
    return [pscustomobject]@{
        accepted = $Accepted
        response = $Response
        phase = $State.phase
        failure = $State.failure
    }
}

function Reject-MyspeedCallback {
    param($State, [string]$Failure, [bool]$DenyAceMayBeActive)
    $State.failure = $Failure
    $State.denyAceMayBeActive = $DenyAceMayBeActive
    $State.phase = if ($DenyAceMayBeActive) { 'cleanup-required' } else { 'failed' }
    return New-MyspeedCallbackResult $false $script:ResponseUnauthorized $State
}

function Test-MyspeedBoundFactIdentity {
    param($Fact, $Request)
    return (Test-MyspeedOrdinalEqual $Fact.targetPath $Request.targetDirectoryPath) -and
        (Test-MyspeedOrdinalEqual $Fact.aceTag $Request.aceTag)
}

function Test-MyspeedActionStartEqual {
    param($Left, $Right)
    return [long]$Left.messageTypeCode -eq [long]$Right.messageTypeCode -and
        (Test-MyspeedOrdinalEqual $Left.actionName $Right.actionName) -and
        (Test-MyspeedOrdinalEqual $Left.description $Right.description) -and
        (Test-MyspeedOrdinalEqual $Left.template $Right.template)
}

function Invoke-MyspeedActionStartCallback {
    param($Request, $State, $Event, $Operations)

    if (Test-MyspeedActionStartEqual $Event $Request.expectedRemoveActionRecord) {
        if (-not (Test-MyspeedOrdinalEqual $State.phase 'awaiting-remove-existing-products')) {
            return Reject-MyspeedCallback $State 'Unexpected or duplicate RemoveExistingProducts ACTIONSTART' $State.denyAceMayBeActive
        }
        $State.currentAction = 'RemoveExistingProducts'
        $State.phase = 'remove-existing-products-started'
        Add-MyspeedTimeline $State 'remove-existing-products-started'
        return New-MyspeedCallbackResult $true $script:ResponseOk $State
    }

    if (Test-MyspeedActionStartEqual $Event $Request.expectedActionRecord) {
        return Invoke-MyspeedInstallFilesCallback $Request $State $Event $Operations
    }

    if ($State.denyAceMayBeActive) {
        return Reject-MyspeedCallback $State 'Unexpected ACTIONSTART while deny ACE may be active' $true
    }
    $State.currentAction = $Event.actionName
    return New-MyspeedCallbackResult $true $script:ResponseOk $State
}

function Invoke-MyspeedActionDataDispatch {
    param($Request, $State, $Event)

    if (Test-MyspeedOrdinalEqual $State.currentAction 'RemoveExistingProducts') {
        Assert-MyspeedRemoveActionDataRecord $Event 'RemoveExistingProducts ACTIONDATA event'
        if (-not (Test-MyspeedOrdinalEqual $State.phase 'remove-existing-products-started') -or
            [long]$Event.messageTypeCode -ne [long]$Request.expectedRemoveActionDataRecord.messageTypeCode -or
            -not (Test-MyspeedOrdinalEqual $Event.productCode $Request.expectedRemoveActionDataRecord.productCode)) {
            return Reject-MyspeedCallback $State 'Unexpected predecessor ProductCode ACTIONDATA' $false
        }
        $State.phase = 'predecessor-removal-observed'
        Add-MyspeedTimeline $State 'predecessor-productcode-observed'
        return New-MyspeedCallbackResult $true $script:ResponseOk $State
    }
    if (Test-MyspeedOrdinalEqual $State.currentAction $script:InstallFilesAction) {
        Assert-MyspeedActionDataEvent $Event
        return Invoke-MyspeedActionDataCallback $Request $State $Event
    }
    Assert-MyspeedGenericActionDataRecord $Event 'Irrelevant ACTIONDATA event'
    return New-MyspeedCallbackResult $true $script:ResponseOk $State
}

function Invoke-MyspeedInstallFilesCallback {
    param($Request, $State, $Event, $Operations)

    if (-not (Test-MyspeedOrdinalEqual $State.phase 'predecessor-removal-observed')) {
        return Reject-MyspeedCallback $State 'Unexpected or duplicate ACTIONSTART record' $State.denyAceMayBeActive
    }
    if ([long]$Event.messageTypeCode -ne [long]$Request.expectedActionRecord.messageTypeCode -or
        -not (Test-MyspeedOrdinalEqual $Event.actionName $Request.expectedActionRecord.actionName) -or
        -not (Test-MyspeedOrdinalEqual $Event.description $Request.expectedActionRecord.description) -or
        -not (Test-MyspeedOrdinalEqual $Event.template $Request.expectedActionRecord.template)) {
        return Reject-MyspeedCallback $State 'Unrecognized ACTIONSTART record' $false
    }

    $observed = & $Operations.observeTarget $Request
    if (-not (Test-MyspeedOrdinalEqual $observed.targetPath $Request.targetDirectoryPath) -or
        $observed.removeExistingProductsCompleted -ne $true -or $observed.targetDirectoryPresent -ne $true -or
        $observed.targetDirectoryOwned -ne $true -or $observed.predecessorPresent -ne $false -or
        $observed.candidatePresent -ne $false -or $observed.nonInheriting -ne $true -or
        -not (Test-MyspeedSecurityDescriptorEqual $observed.originalSecurity $Request.originalSecurity)) {
        return Reject-MyspeedCallback $State 'RemoveExistingProducts or target state was not proven' $false
    }
    Add-MyspeedTimeline $State 'installfiles-verified'
    $State.currentAction = $script:InstallFilesAction

    $State.denyAceMayBeActive = $true
    try {
        $applied = & $Operations.applyDenyAce $Request
    } catch {
        return Reject-MyspeedCallback $State 'Deny ACE application result is unknown' $true
    }
    if (-not (Test-MyspeedBoundFactIdentity $applied $Request) -or $applied.applied -ne $true) {
        return Reject-MyspeedCallback $State 'Deny ACE was not applied exactly' $true
    }

    try {
        $verified = & $Operations.verifyDenyAce $Request
    } catch {
        return Reject-MyspeedCallback $State 'Deny ACE verification failed' $true
    }
    if (-not (Test-MyspeedBoundFactIdentity $verified $Request) -or $verified.denyAcePresent -ne $true -or
        $verified.denyAceCanonical -ne $true -or $verified.installerWriteDenied -ne $true -or
        -not (Test-MyspeedSecurityDescriptorEqual $verified.originalSecurity $Request.originalSecurity)) {
        return Reject-MyspeedCallback $State 'Deny ACE verification did not match' $true
    }

    Add-MyspeedTimeline $State 'deny-applied-and-verified'
    $State.phase = 'deny-active'
    $State.failure = $null
    return New-MyspeedCallbackResult $true $script:ResponseOk $State
}

function Invoke-MyspeedActionDataCallback {
    param($Request, $State, $Event)

    if (-not (Test-MyspeedOrdinalEqual $State.phase 'deny-active')) {
        return Reject-MyspeedCallback $State 'Unexpected or duplicate ACTIONDATA record' $State.denyAceMayBeActive
    }
    if ([long]$Event.messageTypeCode -ne [long]$Request.expectedActionDataRecord.messageTypeCode -or
        -not (Test-MyspeedOrdinalEqual $Event.fileToken $Request.expectedActionDataRecord.fileToken) -or
        -not (Test-MyspeedOrdinalEqual $Event.directoryToken $Request.expectedActionDataRecord.directoryToken) -or
        [long]$Event.sizeBytes -ne [long]$Request.expectedActionDataRecord.sizeBytes) {
        return Reject-MyspeedCallback $State 'Unrecognized ACTIONDATA file, directory, or size' $true
    }
    Add-MyspeedTimeline $State 'actiondata-target-correlated'
    $State.phase = 'write-target-correlated'
    $State.failure = $null
    return New-MyspeedCallbackResult $true $script:ResponseOk $State
}

function Invoke-MyspeedErrorCallback {
    param($Request, $State, $Event, $Operations)

    if (-not (Test-MyspeedOrdinalEqual $State.phase 'write-target-correlated') -or $State.expectedErrorSeen) {
        return Reject-MyspeedCallback $State 'Unexpected or duplicate ERROR record' $State.denyAceMayBeActive
    }
    if ([long]$Event.messageTypeCode -ne [long]$Request.expectedErrorRecord.messageTypeCode -or
        [long]$Event.errorCode -ne [long]$Request.expectedErrorRecord.errorCode -or
        -not (Test-MyspeedOrdinalArrayEqual $Event.parameters $Request.expectedErrorRecord.parameters)) {
        return Reject-MyspeedCallback $State 'Unrecognized ERROR code or parameters' $true
    }
    $messageStyle = [long]$Event.messageTypeCode -band $script:MessageStyleMask
    $cancelResponse = if ($messageStyle -eq $script:AbortRetryIgnoreStyle) {
        $script:ResponseAbort
    } elseif ($messageStyle -eq $script:RetryCancelStyle) {
        $script:ResponseCancel
    } else {
        $null
    }
    if ($null -eq $cancelResponse) {
        return Reject-MyspeedCallback $State 'ERROR message style has no reviewed cancel response' $true
    }

    $State.expectedErrorSeen = $true
    Add-MyspeedTimeline $State 'expected-write-error'
    try {
        $removed = & $Operations.removeDenyAce $Request
    } catch {
        return Reject-MyspeedCallback $State 'Deny ACE removal result is unknown' $true
    }
    if (-not (Test-MyspeedBoundFactIdentity $removed $Request) -or $removed.removed -ne $true) {
        return Reject-MyspeedCallback $State 'Owned deny ACE removal was not proven' $true
    }
    $State.denyAceMayBeActive = $false

    try {
        $restored = & $Operations.verifyOriginalSecurity $Request
    } catch {
        $State.phase = 'cleanup-unproven'
        $State.failure = 'Original security verification failed'
        return New-MyspeedCallbackResult $false $script:ResponseUnauthorized $State
    }
    if (-not (Test-MyspeedBoundFactIdentity $restored $Request) -or $restored.denyAcePresent -ne $false -or
        -not (Test-MyspeedSecurityDescriptorEqual $restored.originalSecurity $Request.originalSecurity) -or
        $restored.ownerRestored -ne $true -or $restored.groupRestored -ne $true -or
        $restored.daclRestored -ne $true -or $restored.controlRestored -ne $true -or
        $restored.inheritanceRestored -ne $true) {
        $State.phase = 'cleanup-unproven'
        $State.failure = 'Original owner, DACL, or inheritance was not restored exactly'
        return New-MyspeedCallbackResult $false $script:ResponseUnauthorized $State
    }

    Add-MyspeedTimeline $State 'original-security-restored'
    $State.phase = 'cancel-requested'
    $State.failure = $null
    return New-MyspeedCallbackResult $true $cancelResponse $State
}

function Invoke-MyspeedRollbackCallback {
    param($Request, $State, $Event, $Operations)

    $State.callbackCount += 1
    Assert-MyspeedMessageCode $Event.messageTypeCode 'Callback messageTypeCode'
    $messageClass = [long]$Event.messageTypeCode -band $script:MessageClassMask
    if ($messageClass -eq $script:ActionStartMessageCode) {
        Assert-MyspeedActionEvent $Event
        return Invoke-MyspeedActionStartCallback $Request $State $Event $Operations
    }
    if ($messageClass -eq $script:ActionDataMessageCode) {
        return Invoke-MyspeedActionDataDispatch $Request $State $Event
    }
    if ($messageClass -eq $script:ErrorMessageCode) {
        Assert-MyspeedErrorEvent $Event
        return Invoke-MyspeedErrorCallback $Request $State $Event $Operations
    }
    throw 'Callback messageTypeCode is invalid'
}

function Assert-MyspeedCompletion {
    param($Completion)
    Assert-MyspeedExactObject $Completion @('msiReturnCode', 'writeFailureObserved', 'controllerCancelIssued',
        'rollbackObserved', 'predecessorRestored', 'candidateAbsent', 'denyAcePresent', 'originalSecurity',
        'manualCancellation') 'Rollback completion'
    if (-not (Test-MyspeedExactInteger $Completion.msiReturnCode)) {
        throw 'Rollback completion msiReturnCode must be an exact integer'
    }
    foreach ($name in @('writeFailureObserved', 'controllerCancelIssued', 'rollbackObserved',
        'predecessorRestored', 'candidateAbsent', 'denyAcePresent', 'manualCancellation')) {
        Assert-MyspeedExactBoolean $Completion.$name "Rollback completion $name"
    }
    Assert-MyspeedSecurityDescriptor $Completion.originalSecurity 'Rollback completion originalSecurity'
}

function Complete-MyspeedRollbackState {
    param($Request, $State, $Completion)
    Assert-MyspeedCompletion $Completion

    $accepted = (Test-MyspeedOrdinalEqual $State.phase 'cancel-requested') -and
        -not $State.denyAceMayBeActive -and $State.expectedErrorSeen -and
        [long]$Completion.msiReturnCode -eq $script:InstallUserExit -and
        $Completion.writeFailureObserved -eq $true -and $Completion.controllerCancelIssued -eq $true -and
        $Completion.rollbackObserved -eq $true -and $Completion.predecessorRestored -eq $true -and
        $Completion.candidateAbsent -eq $true -and $Completion.denyAcePresent -eq $false -and
        (Test-MyspeedSecurityDescriptorEqual $Completion.originalSecurity $Request.originalSecurity) -and
        $Completion.manualCancellation -eq $false
    if ($accepted) {
        Add-MyspeedTimeline $State 'rollback-completion-verified'
        $State.phase = 'completed'
        $State.failure = $null
    } else {
        $State.failure = 'Genuine rollback completion was not proven'
    }
    return [pscustomobject]@{
        accepted = [bool]$accepted
        qualifying = $false
        classification = if ($accepted) { 'controller-cancelled-after-expected-write-error' } else { 'rejected' }
        releaseGatesCleared = @()
    }
}

function Get-MyspeedRollbackStateContract {
    return [pscustomobject]@{
        schemaVersion = $script:RollbackSchemaVersion
        kind = 'myspeed-msi-sacrificial-rollback-state-contract'
        qualifying = $false
        nativeMsiApiInvoked = $false
        filesystemMutationAuthorized = $false
        acceptedResponses = @($script:ResponseOk, $script:ResponseAbort, $script:ResponseCancel)
        errorSignatureCalibrationRequired = $true
        directNativeCallbackSafe = $false
        requiredNativeAdapterProofs = @('bounded-record-c-fill', 'typed-record-field-extraction',
            'rooted-delegate-through-install-return', 'none-ui-and-handler-restoration',
            'same-handle-security-restore-in-finally', 'primary-and-cleanup-error-retention')
        releaseGatesCleared = @()
    }
}

function Invoke-MyspeedRollbackSimulation {
    param($Simulation)
    $simulationKeys = @($Simulation.PSObject.Properties.Name | Sort-Object)
    $withCompletion = @('completion', 'events', 'operationFacts', 'request')
    $withoutCompletion = @('events', 'operationFacts', 'request')
    $matchesSchema = ($simulationKeys.Count -eq $withCompletion.Count -and
        -not (Compare-Object $simulationKeys $withCompletion -CaseSensitive)) -or
        ($simulationKeys.Count -eq $withoutCompletion.Count -and
        -not (Compare-Object $simulationKeys $withoutCompletion -CaseSensitive))
    if (-not $matchesSchema) {
        throw 'Simulation must have exact keys'
    }
    Assert-MyspeedRollbackRequest $Simulation.request
    if ($Simulation.events -isnot [System.Array] -or $Simulation.events.Rank -ne 1 -or
        $Simulation.events.Count -lt 1 -or $Simulation.events.Count -gt 8) {
        throw 'Simulation events must be an exact bounded array'
    }
    Assert-MyspeedOperationFacts $Simulation.operationFacts

    $operationCalls = [Collections.Generic.List[string]]::new()
    $observeTargetFact = $Simulation.operationFacts.observeTarget
    $applyDenyAceFact = $Simulation.operationFacts.applyDenyAce
    $verifyDenyAceFact = $Simulation.operationFacts.verifyDenyAce
    $removeDenyAceFact = $Simulation.operationFacts.removeDenyAce
    $verifyOriginalSecurityFact = $Simulation.operationFacts.verifyOriginalSecurity
    $operations = [pscustomobject]@{
        observeTarget = { param($Ignored) $operationCalls.Add('observeTarget'); return $observeTargetFact }.GetNewClosure()
        applyDenyAce = { param($Ignored) $operationCalls.Add('applyDenyAce'); return $applyDenyAceFact }.GetNewClosure()
        verifyDenyAce = { param($Ignored) $operationCalls.Add('verifyDenyAce'); return $verifyDenyAceFact }.GetNewClosure()
        removeDenyAce = { param($Ignored) $operationCalls.Add('removeDenyAce'); return $removeDenyAceFact }.GetNewClosure()
        verifyOriginalSecurity = {
            param($Ignored)
            $operationCalls.Add('verifyOriginalSecurity')
            return $verifyOriginalSecurityFact
        }.GetNewClosure()
    }

    $state = New-MyspeedRollbackState
    $callbacks = @()
    foreach ($callbackRecord in $Simulation.events) {
        $callbackResult = Invoke-MyspeedRollbackCallback $Simulation.request $state $callbackRecord $operations
        $callbacks += @($callbackResult)
        if ($callbackResult.accepted -ne $true) { break }
    }
    $completion = $null
    if ($Simulation.PSObject.Properties.Name -ccontains 'completion') {
        $completion = Complete-MyspeedRollbackState $Simulation.request $state $Simulation.completion
    }
    return [pscustomobject]@{
        schemaVersion = $script:RollbackSchemaVersion
        kind = 'myspeed-msi-sacrificial-rollback-state-simulation'
        qualifying = $false
        nativeMsiApiInvoked = $false
        filesystemMutationAuthorized = $false
        callbacks = $callbacks
        operationCalls = @($operationCalls)
        state = $state
        completion = $completion
        releaseGatesCleared = @()
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    switch ($Mode) {
        'Library' { return }
        'GetContract' {
            Get-MyspeedRollbackStateContract | ConvertTo-Json -Depth 8 -Compress
            return
        }
        'Simulate' {
            if ([string]::IsNullOrWhiteSpace($InputJson)) {
                throw 'InputJson is required for Simulate mode'
            }
            $inputObject = ConvertFrom-Json -InputObject $InputJson
            Invoke-MyspeedRollbackSimulation $inputObject | ConvertTo-Json -Depth 16 -Compress
            return
        }
    }
}
