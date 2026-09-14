[CmdletBinding()]
param(
    [ValidateSet('Library', 'GetFixtures', 'NormalizeTimeline', 'SimulateCallbackBridge', 'SimulateController')]
    [string]$Mode = 'Library',
    [string]$InputJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:SchemaVersion = 1
$script:FixtureUpgradeCode = '{A86F174D-43A7-4DAA-926E-097E0D0A5141}'
$script:FixtureComponentCode = '{54A3A8A3-3CA6-4975-80BC-BF731DB67675}'
$script:PredecessorProductCode = '{1716C600-7C5B-45CB-89F1-584214207169}'
$script:CandidateProductCode = '{FF93E978-E119-4D48-B37B-248457E950A2}'
$script:PredecessorPackageCode = '{33CF255B-EA8C-4C22-A0B9-E510A390F1A4}'
$script:CandidatePackageCode = '{CF90E40B-AEF1-40D6-8CD6-9E47C5F4485D}'
$script:FixturePayloadFile = 'rollback-payload.txt'
$script:ExpectedRollbackReturnCode = 1602
$script:ErrorSuccess = 0
$script:InstallUiLevelNone = 'INSTALLUILEVEL_NONE'
$script:RequiredProperties = 'REBOOT=ReallySuppress'
$script:RequiredLogModes = @('VERBOSE', 'EXTRADEBUG')
$script:RequiredLogAttributes = @('FLUSHEACHLINE')
$script:RequiredCallbackMessages = @('FATALEXIT', 'ERROR', 'ACTIONSTART', 'ACTIONDATA', 'INSTALLSTART', 'INSTALLEND')
$script:InstallLogModeFatalExit = [uint32](1 -shl 0)
$script:InstallLogModeError = [uint32](1 -shl 1)
$script:InstallLogModeActionStart = [uint32](1 -shl 8)
$script:InstallLogModeActionData = [uint32](1 -shl 9)
$script:InstallLogModeInstallStart = [uint32](1 -shl 26)
$script:InstallLogModeInstallEnd = [uint32](1 -shl 27)
$script:RequiredCallbackMessageFilter = [uint32]($script:InstallLogModeFatalExit -bor $script:InstallLogModeError -bor
    $script:InstallLogModeActionStart -bor $script:InstallLogModeActionData -bor
    $script:InstallLogModeInstallStart -bor $script:InstallLogModeInstallEnd)
$script:CallbackFailureReturn = -1
$script:CallbackSimulationResponse = 2
$script:Repository = 'i7Gamer/MySpeed'
$script:ImageOs = 'win25-vs2026'
$script:ExpectedPowerShellVersion = '5.1'
$script:ClosureKind = 'myspeed-msi-sacrificial-calibration-closure'
$script:CalibrationScriptName = 'windows-msi-rollback-calibration.ps1'
$script:MaximumCallbackRecords = 256
$script:MaximumRecordFields = 16
$script:MaximumRecordFieldCharacters = 4096
$script:MaximumCalibrationScriptBytes = 1048576
$script:MessageClassMask = 0xFF000000
$script:MessageStyleMask = 0x0000000F
$script:InstallMessageFatalExit = [long]0x00000000
$script:InstallMessageError = [long]0x01000000
$script:InstallMessageActionStart = [long]0x08000000
$script:InstallMessageActionData = [long]0x09000000
$script:InstallMessageInstallStart = [long]0x1A000000
$script:InstallMessageInstallEnd = [long]0x1B000000
$script:RelevantMessageClasses = @{}
$script:RelevantMessageClasses[$script:InstallMessageFatalExit] = 'FATALEXIT'
$script:RelevantMessageClasses[$script:InstallMessageError] = 'ERROR'
$script:RelevantMessageClasses[$script:InstallMessageActionStart] = 'ACTIONSTART'
$script:RelevantMessageClasses[$script:InstallMessageActionData] = 'ACTIONDATA'
$script:RelevantMessageClasses[$script:InstallMessageInstallStart] = 'INSTALLSTART'
$script:RelevantMessageClasses[$script:InstallMessageInstallEnd] = 'INSTALLEND'

function Assert-MyspeedMsiCalibrationExactObject {
    param($Value, [string[]]$Keys, [string]$Label)
    if ($null -eq $Value -or $Value -is [System.Array] -or $Value -is [string] -or $Value -is [ValueType]) {
        throw "$Label must be an exact object"
    }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $expected = @($Keys | Sort-Object)
    if ($actual.Count -ne $expected.Count) { throw "$Label must have exact keys" }
    for ($index = 0; $index -lt $expected.Count; $index++) {
        if (-not [string]::Equals($actual[$index], $expected[$index], [StringComparison]::Ordinal)) {
            throw "$Label must have exact keys"
        }
    }
}
function Test-MyspeedMsiCalibrationInteger {
    param($Value)
    return $Value -is [int] -or $Value -is [long]
}

function Assert-MyspeedMsiCalibrationString {
    param($Value, [string]$Label, [int]$Maximum = 4096)
    if ($Value -isnot [string] -or $Value.Length -eq 0 -or $Value.Length -gt $Maximum -or
        $Value -match '[\x00-\x1f\x7f]') {
        throw "$Label must be an exact bounded string"
    }
}

function Get-MyspeedMsiCalibrationSha256 {
    param([byte[]]$Bytes)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($hasher.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $hasher.Dispose()
    }
}

function ConvertTo-MyspeedMsiCalibrationTimeline {
    param($Request)
    Assert-MyspeedMsiCalibrationExactObject $Request @('records') 'Timeline request'
    if ($Request.records -isnot [System.Array] -or $Request.records.Rank -ne 1 -or
        $Request.records.Count -lt 1 -or $Request.records.Count -gt $script:MaximumCallbackRecords) {
        throw 'Timeline records must be an exact bounded array'
    }
    $normalized = for ($sequence = 0; $sequence -lt $Request.records.Count; $sequence++) {
        $record = $Request.records[$sequence]
        Assert-MyspeedMsiCalibrationExactObject $record @('messageTypeCode', 'fieldCount', 'fields',
            'field1Integer') "Timeline record $sequence"
        if (-not (Test-MyspeedMsiCalibrationInteger $record.messageTypeCode) -or
            [long]$record.messageTypeCode -lt 0 -or [long]$record.messageTypeCode -gt [uint32]::MaxValue) {
            throw "Timeline record $sequence messageTypeCode is invalid"
        }
        if (-not (Test-MyspeedMsiCalibrationInteger $record.fieldCount) -or [long]$record.fieldCount -lt 0 -or
            [long]$record.fieldCount -gt $script:MaximumRecordFields -or $record.fields -isnot [System.Array] -or
            $record.fields.Rank -ne 1 -or $record.fields.Count -ne [long]$record.fieldCount) {
            throw "Timeline record $sequence fields are invalid"
        }
        foreach ($field in $record.fields) {
            if ($field -isnot [string] -or $field.Length -gt $script:MaximumRecordFieldCharacters -or
                $field.Contains([char]0)) {
                throw "Timeline record $sequence contains an invalid field"
            }
        }
        if ($null -ne $record.field1Integer -and -not (Test-MyspeedMsiCalibrationInteger $record.field1Integer)) {
            throw "Timeline record $sequence field1Integer is invalid"
        }
        $messageClassCode = [long]$record.messageTypeCode -band $script:MessageClassMask
        $messageClass = $script:RelevantMessageClasses[$messageClassCode]
        if ($null -eq $messageClass) { throw "Timeline record $sequence message class is not retained" }
        [pscustomobject]@{
            sequence = $sequence
            messageTypeCode = [long]$record.messageTypeCode
            messageClass = $messageClass
            messageClassCode = $messageClassCode
            messageStyle = [long]$record.messageTypeCode -band $script:MessageStyleMask
            fieldCount = [long]$record.fieldCount
            fields = @($record.fields)
            field1Integer = if ($null -eq $record.field1Integer) { $null } else { [long]$record.field1Integer }
        }
    }
    return [pscustomobject]@{
        schemaVersion = $script:SchemaVersion
        kind = 'myspeed-msi-sacrificial-callback-timeline'
        qualifying = $false
        nativeExecutionAuthorized = $false
        errorSignatureCalibrated = $false
        records = @($normalized)
        releaseGatesCleared = @()
    }
}

function Get-MyspeedSacrificialMsiFixtures {
    param($Request)
    Assert-MyspeedMsiCalibrationExactObject $Request @('nonce') 'Fixture request'
    if ($Request.nonce -isnot [string] -or $Request.nonce -cnotmatch '\A[0-9a-f]{32}\z') {
        throw 'Fixture nonce is invalid'
    }

    $definitions = @(
        [pscustomobject]@{role='predecessor';version='1.0.0';productCode=$script:PredecessorProductCode;
            packageCode=$script:PredecessorPackageCode;payloadFile=$script:FixturePayloadFile;payloadText="predecessor`n";
            majorUpgrade=''},
        [pscustomobject]@{role='candidate';version='2.0.0';productCode=$script:CandidateProductCode;
            packageCode=$script:CandidatePackageCode;payloadFile=$script:FixturePayloadFile;payloadText="candidate`n";
            majorUpgrade='    <MajorUpgrade Schedule="afterInstallInitialize" DowngradeErrorMessage="A newer fixture is installed." />'}
    )
    $fixtures = foreach ($definition in $definitions) {
        $source = @"
<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="$($definition.productCode)" Name="MySpeed rollback sacrificial $($definition.role)" Language="1033" Version="$($definition.version)" Manufacturer="MySpeed qualification" UpgradeCode="$($script:FixtureUpgradeCode)">
    <Package Id="$($definition.packageCode)" InstallerVersion="500" Compressed="yes" InstallScope="perMachine" />
$($definition.majorUpgrade)
    <MediaTemplate EmbedCab="yes" />
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="CommonAppDataFolder">
        <Directory Id="RollbackRoot" Name="MyspeedRollback-$($Request.nonce)">
          <Component Id="RollbackPayloadComponent" Guid="$($script:FixtureComponentCode)" Win64="yes">
            <File Id="RollbackPayloadFile" Source="$($definition.payloadFile)" KeyPath="yes" />
          </Component>
        </Directory>
      </Directory>
    </Directory>
    <Feature Id="Complete" Level="1">
      <ComponentRef Id="RollbackPayloadComponent" />
    </Feature>
  </Product>
</Wix>
"@
        [pscustomobject]@{
            role = $definition.role
            version = $definition.version
            productCode = $definition.productCode
            packageCode = $definition.packageCode
            upgradeCode = $script:FixtureUpgradeCode
            componentCode = $script:FixtureComponentCode
            wixSource = $source
            wixSourceSha256 = Get-MyspeedMsiCalibrationSha256 ([Text.Encoding]::UTF8.GetBytes($source))
            payload = [pscustomobject]@{fileName=$definition.payloadFile;encoding='utf8';text=$definition.payloadText;
                bytes=[Text.Encoding]::UTF8.GetByteCount($definition.payloadText);
                sha256=Get-MyspeedMsiCalibrationSha256 ([Text.Encoding]::UTF8.GetBytes($definition.payloadText))}
        }
    }
    return [pscustomobject]@{
        schemaVersion = $script:SchemaVersion
        kind = 'myspeed-msi-sacrificial-fixture-definitions'
        qualifying = $false
        nativeExecutionAuthorized = $false
        ownedTarget = [pscustomobject]@{
            relativeDirectory = "MyspeedRollback-$($Request.nonce)"
            sentinelFile = "owner-$($Request.nonce).marker"
            payloadFile = $script:FixturePayloadFile
            requiresPreexistingDirectory = $true
            requiresSentinel = $true
        }
        fixtures = @($fixtures)
        releaseGatesCleared = @()
    }
}

function Assert-MyspeedMsiCalibrationRequest {
    param($Request)
    Assert-MyspeedMsiCalibrationExactObject $Request @('msiPath', 'logPath', 'propertyString') 'Controller request'
    Assert-MyspeedMsiCalibrationString $Request.msiPath 'Controller MSI path'
    Assert-MyspeedMsiCalibrationString $Request.logPath 'Controller log path'
    if (-not [string]::Equals($Request.propertyString, $script:RequiredProperties, [StringComparison]::Ordinal)) {
        throw 'Controller properties do not exactly suppress restart'
    }
}

function Assert-MyspeedMsiCalibrationFacts {
    param($Facts)
    Assert-MyspeedMsiCalibrationExactObject $Facts @('setInternalUiNone', 'setExternalHandler', 'enableLog',
        'installProduct', 'disableLog', 'restoreExternalHandler', 'restoreInternalUi', 'callbackEvidence') 'Controller facts'
    Assert-MyspeedMsiCalibrationExactObject $Facts.setInternalUiNone @('previousLevel', 'previousOwner',
        'noneApplied') 'SetInternalUi fact'
    if (-not (Test-MyspeedMsiCalibrationInteger $Facts.setInternalUiNone.previousLevel) -or
        -not (Test-MyspeedMsiCalibrationInteger $Facts.setInternalUiNone.previousOwner) -or
        $Facts.setInternalUiNone.noneApplied -isnot [bool]) { throw 'SetInternalUi fact is invalid' }
    foreach ($name in @('setExternalHandler', 'enableLog', 'disableLog', 'restoreExternalHandler')) {
        $keys = if ($name -eq 'setExternalHandler') {
            @('errorCode', 'previousHandlerPresent', 'previousHandlerToken')
        } elseif ($name -eq 'restoreExternalHandler') {
            @('errorCode', 'currentHandlerDisabled', 'restoredPreviousContext')
        } else { @('errorCode') }
        Assert-MyspeedMsiCalibrationExactObject $Facts.$name $keys "$name fact"
        if (-not (Test-MyspeedMsiCalibrationInteger $Facts.$name.errorCode)) { throw "$name errorCode is invalid" }
    }
    if ($Facts.setExternalHandler.previousHandlerPresent -isnot [bool]) {
        throw 'setExternalHandler previousHandlerPresent is invalid'
    }
    if (($Facts.setExternalHandler.previousHandlerPresent -eq $false -and
        $null -ne $Facts.setExternalHandler.previousHandlerToken) -or
        ($Facts.setExternalHandler.previousHandlerPresent -eq $true -and
        -not (Test-MyspeedMsiCalibrationInteger $Facts.setExternalHandler.previousHandlerToken))) {
        throw 'setExternalHandler previous handler token is invalid'
    }
    foreach ($name in @('currentHandlerDisabled', 'restoredPreviousContext')) {
        if ($Facts.restoreExternalHandler.$name -isnot [bool]) {
            throw "restoreExternalHandler $name is invalid"
        }
    }
    Assert-MyspeedMsiCalibrationExactObject $Facts.installProduct @('returnCode') 'installProduct fact'
    if (-not (Test-MyspeedMsiCalibrationInteger $Facts.installProduct.returnCode)) {
        throw 'installProduct returnCode is invalid'
    }
    Assert-MyspeedMsiCalibrationExactObject $Facts.restoreInternalUi @('restored') 'restoreInternalUi fact'
    if ($Facts.restoreInternalUi.restored -isnot [bool]) { throw 'restoreInternalUi restored is invalid' }
    Assert-MyspeedMsiCalibrationExactObject $Facts.callbackEvidence @('delegateRetainedThroughInstallCall',
        'msiOwnedRecordCloseAttempted', 'securityRestoredBeforeCancel', 'errorSignatureAssumed',
        'callbackFailure', 'records') 'callbackEvidence fact'
    foreach ($name in @('delegateRetainedThroughInstallCall', 'msiOwnedRecordCloseAttempted',
        'securityRestoredBeforeCancel', 'errorSignatureAssumed')) {
        if ($Facts.callbackEvidence.$name -isnot [bool]) { throw "callbackEvidence $name is invalid" }
    }
    if ($null -ne $Facts.callbackEvidence.callbackFailure -and
        ($Facts.callbackEvidence.callbackFailure -isnot [string] -or
        $Facts.callbackEvidence.callbackFailure -cne 'callback-record-or-observer-failure')) {
        throw 'callbackEvidence callbackFailure is invalid'
    }
    [void](ConvertTo-MyspeedMsiCalibrationTimeline ([pscustomobject]@{records=$Facts.callbackEvidence.records}))
}

function Invoke-MyspeedMsiCalibrationController {
    param($Request, $Operations)
    Assert-MyspeedMsiCalibrationRequest $Request
    $calls = [Collections.Generic.List[string]]::new()
    $cleanupFailures = [Collections.Generic.List[string]]::new()
    $primaryFailure = $null
    $internalSet = $false
    $handlerSet = $false
    $logEnabled = $false
    $installInvoked = $false
    $installReturnCode = $null
    $callbackReferenceRetained = $false
    $previousExternalHandlerCollision = $false
    $calibrationHandlerDisabled = $false
    $externalHandlerRestored = $false
    $callbackRoot = [pscustomobject]@{retained=$true}

    try {
        [void]$calls.Add('set-internal-ui-none')
        $ui = & $Operations.setInternalUiNone
        $internalSet = $true
        if ($ui.noneApplied -ne $true) { throw 'INSTALLUILEVEL_NONE was not applied' }

        [void]$calls.Add('set-external-record-handler')
        $handler = & $Operations.setExternalHandler $callbackRoot $script:RequiredCallbackMessageFilter
        if ([long]$handler.errorCode -ne $script:ErrorSuccess) {
            throw "Set external record handler failed:$($handler.errorCode)"
        }
        $handlerSet = $true
        if ($handler.previousHandlerPresent -eq $true) {
            $previousExternalHandlerCollision = $true
            throw 'A previous external record handler exists'
        }

        [void]$calls.Add('enable-log')
        $enabled = & $Operations.enableLog $Request.logPath $script:RequiredLogModes $script:RequiredLogAttributes
        if ([long]$enabled.errorCode -ne $script:ErrorSuccess) { throw "Enable log failed:$($enabled.errorCode)" }
        $logEnabled = $true

        [void]$calls.Add('install-product')
        $installInvoked = $true
        try {
            $installed = & $Operations.installProduct $Request.msiPath $Request.propertyString
            $installReturnCode = [long]$installed.returnCode
        } finally {
            [GC]::KeepAlive($callbackRoot)
            $callbackReferenceRetained = $true
        }
        if ($installReturnCode -ne $script:ExpectedRollbackReturnCode) {
            throw "Install product returned $installReturnCode"
        }
        if ($Operations.callbackEvidence.delegateRetainedThroughInstallCall -ne $true -or
            $Operations.callbackEvidence.msiOwnedRecordCloseAttempted -ne $false -or
            $Operations.callbackEvidence.securityRestoredBeforeCancel -ne $true -or
            $Operations.callbackEvidence.errorSignatureAssumed -ne $false -or
            $null -ne $Operations.callbackEvidence.callbackFailure) {
            throw 'Callback lifetime, record ownership, or synchronous restoration was not proven'
        }
    } catch {
        $primaryFailure = $_.Exception.Message
    } finally {
        if ($logEnabled) {
            [void]$calls.Add('disable-log')
            try {
                $disabled = & $Operations.disableLog $null 0 0
                if ([long]$disabled.errorCode -ne $script:ErrorSuccess) {
                    [void]$cleanupFailures.Add("disable-log:$($disabled.errorCode)")
                } else { $logEnabled = $false }
            } catch {
                [void]$cleanupFailures.Add('disable-log:exception')
            }
        }
        if ($handlerSet) {
            [void]$calls.Add('restore-external-record-handler')
            try {
                $restoreTarget = if ($previousExternalHandlerCollision) { $null } else { $handler.previousHandlerToken }
                $restoredHandler = & $Operations.restoreExternalHandler $restoreTarget 0
                if ([long]$restoredHandler.errorCode -ne $script:ErrorSuccess) {
                    [void]$cleanupFailures.Add("restore-external-record-handler:$($restoredHandler.errorCode)")
                } elseif ($restoredHandler.currentHandlerDisabled -ne $true -or
                    (-not $previousExternalHandlerCollision -and
                    $restoredHandler.restoredPreviousContext -ne $true)) {
                    [void]$cleanupFailures.Add('restore-external-record-handler:unproven')
                } else {
                    $handlerSet = $false
                    $calibrationHandlerDisabled = $true
                    if (-not $previousExternalHandlerCollision -and
                        $restoredHandler.restoredPreviousContext -eq $true) {
                        $externalHandlerRestored = $true
                    }
                }
            } catch {
                [void]$cleanupFailures.Add('restore-external-record-handler:exception')
            }
        }
        if ($internalSet) {
            [void]$calls.Add('restore-internal-ui')
            try {
                $restoredUi = & $Operations.restoreInternalUi $ui.previousLevel $ui.previousOwner
                if ($restoredUi.restored -ne $true) {
                    [void]$cleanupFailures.Add('restore-internal-ui')
                } else { $internalSet = $false }
            } catch {
                [void]$cleanupFailures.Add('restore-internal-ui:exception')
            }
        }
    }

    return [pscustomobject]@{
        schemaVersion = $script:SchemaVersion
        kind = 'myspeed-msi-sacrificial-calibration-controller-result'
        accepted = $null -eq $primaryFailure -and $cleanupFailures.Count -eq 0
        qualifying = $false
        requestedSemantics = [pscustomobject]@{internalUi=$script:InstallUiLevelNone;
            logModes=$script:RequiredLogModes;logAttributes=$script:RequiredLogAttributes;
            callbackMessages=$script:RequiredCallbackMessages;properties=$script:RequiredProperties}
        operationCalls = @($calls)
        requestedCallbackMessageFilter = $script:RequiredCallbackMessageFilter
        installInvoked = $installInvoked
        installReturnCode = $installReturnCode
        callbackReferenceRetainedThroughInstallCall = $callbackReferenceRetained
        callbackEvidence = $Operations.callbackEvidence
        callbackTimeline = ConvertTo-MyspeedMsiCalibrationTimeline `
            ([pscustomobject]@{records=$Operations.callbackEvidence.records})
        loggingDisabled = -not $logEnabled
        calibrationHandlerDisabled = $calibrationHandlerDisabled
        externalHandlerRestored = $externalHandlerRestored
        previousExternalHandlerCollision = $previousExternalHandlerCollision
        dedicatedProcessExitRequired = $previousExternalHandlerCollision
        internalUiRestored = -not $internalSet
        primaryFailure = $primaryFailure
        cleanupFailures = @($cleanupFailures)
        nativeExecutionAuthorized = $false
        releaseGatesCleared = @()
    }
}

function Assert-MyspeedMsiCalibrationHostedContext {
    param($Expected)
    Assert-MyspeedMsiCalibrationExactObject $Expected @('runId', 'runAttempt', 'eventSha', 'sourceSha',
        'nonce', 'imageVersion', 'manifest') 'Hosted context expectation'
    $patterns = [ordered]@{runId='\A[1-9][0-9]*\z';runAttempt='\A[1-9][0-9]*\z';
        eventSha='\A[0-9a-f]{40}\z';sourceSha='\A[0-9a-f]{40}\z';nonce='\A[0-9a-f]{32}\z';
        imageVersion='\A[0-9A-Za-z._-]{1,128}\z'}
    foreach ($entry in $patterns.GetEnumerator()) {
        if ($Expected.($entry.Key) -isnot [string] -or $Expected.($entry.Key) -cnotmatch $entry.Value) {
            throw 'Native MSI calibration is restricted to its exact fresh hosted context'
        }
    }
    $manifest = $Expected.manifest
    Assert-MyspeedMsiCalibrationExactObject $manifest @('schemaVersion', 'kind', 'expectedRunId',
        'expectedRunAttempt', 'expectedEventSha', 'expectedSourceSha', 'nonce', 'files') 'Calibration manifest'
    if (-not (Test-MyspeedMsiCalibrationInteger $manifest.schemaVersion) -or
        [long]$manifest.schemaVersion -ne $script:SchemaVersion -or $manifest.kind -isnot [string] -or
        -not [string]::Equals($manifest.kind, $script:ClosureKind, [StringComparison]::Ordinal)) {
        throw 'Calibration manifest identity is invalid'
    }
    $bindings = [ordered]@{expectedRunId='runId';expectedRunAttempt='runAttempt';
        expectedEventSha='eventSha';expectedSourceSha='sourceSha';nonce='nonce'}
    foreach ($binding in $bindings.GetEnumerator()) {
        if ($manifest.($binding.Key) -isnot [string] -or
            -not [string]::Equals($manifest.($binding.Key), $Expected.($binding.Value), [StringComparison]::Ordinal)) {
            throw 'Calibration manifest binding differs'
        }
    }
    if ($manifest.files -isnot [System.Array] -or $manifest.files.Rank -ne 1 -or $manifest.files.Count -ne 1) {
        throw 'Calibration manifest membership differs'
    }
    $file = $manifest.files[0]
    Assert-MyspeedMsiCalibrationExactObject $file @('name', 'bytes', 'sha256') 'Calibration manifest file'
    if ($file.name -isnot [string] -or
        -not [string]::Equals($file.name, $script:CalibrationScriptName, [StringComparison]::Ordinal) -or
        -not (Test-MyspeedMsiCalibrationInteger $file.bytes) -or [long]$file.bytes -le 0 -or
        [long]$file.bytes -gt $script:MaximumCalibrationScriptBytes -or
        $file.sha256 -isnot [string] -or $file.sha256 -cnotmatch '\A[0-9a-f]{64}\z') {
        throw 'Calibration manifest file identity is invalid'
    }
    $scriptInfo = [IO.FileInfo]$PSCommandPath
    if (-not $scriptInfo.Exists -or $scriptInfo.Length -gt $script:MaximumCalibrationScriptBytes -or
        ($scriptInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        [long]$file.bytes -ne $scriptInfo.Length -or
        -not [string]::Equals($file.sha256,
        (Get-MyspeedMsiCalibrationSha256 ([IO.File]::ReadAllBytes($PSCommandPath))),
        [StringComparison]::Ordinal)) {
        throw 'Calibration manifest script identity differs'
    }
    $required = [ordered]@{GITHUB_ACTIONS='true';CI='true';GITHUB_REPOSITORY=$script:Repository;
        RUNNER_OS='Windows';RUNNER_ARCH='X64';RUNNER_ENVIRONMENT='github-hosted';ImageOS=$script:ImageOs;
        GITHUB_RUN_ID=$Expected.runId;GITHUB_RUN_ATTEMPT=$Expected.runAttempt;GITHUB_SHA=$Expected.eventSha;
        ImageVersion=$Expected.imageVersion}
    foreach ($entry in $required.GetEnumerator()) {
        if ([Environment]::GetEnvironmentVariable($entry.Key) -cne $entry.Value) {
            throw 'Native MSI calibration is restricted to its exact fresh hosted context'
        }
    }
    $expectedShell = [IO.Path]::Combine($env:SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    $actualShell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    if ($PSVersionTable.PSEdition -cne 'Desktop' -or
        "$($PSVersionTable.PSVersion.Major).$($PSVersionTable.PSVersion.Minor)" -cne $script:ExpectedPowerShellVersion -or
        -not [string]::Equals($actualShell, $expectedShell, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Native MSI calibration is restricted to canonical inbox Windows PowerShell 5.1'
    }
}

function Invoke-MyspeedMsiCalibrationCallbackBridge {
    param($Context, $MessageTypeCode, $RecordHandle, $Operations)
    try {
        $snapshot = & $Operations.snapshotRecord $MessageTypeCode $RecordHandle
        $response = & $Operations.observeRecord $Context $snapshot
        if (-not (Test-MyspeedMsiCalibrationInteger $response) -or [long]$response -lt [int]::MinValue -or
            [long]$response -gt [int]::MaxValue) {
            throw 'Callback observer returned an invalid response'
        }
        return [int]$response
    } catch {
        if ($null -eq $Context.callbackFailure) {
            $Context.callbackFailure = 'callback-record-or-observer-failure'
        }
        return $script:CallbackFailureReturn
    }
}

function Invoke-MyspeedMsiCalibrationCallbackSimulation {
    param($Simulation)
    Assert-MyspeedMsiCalibrationExactObject $Simulation @('failureAt') 'Callback simulation'
    if ($Simulation.failureAt -isnot [string] -or
        $Simulation.failureAt -notin @('none', 'snapshot', 'observer')) {
        throw 'Callback simulation failureAt is invalid'
    }
    $failureAt = $Simulation.failureAt
    $calls = [Collections.Generic.List[string]]::new()
    $context = [pscustomobject]@{callbackFailure=$null}
    $response = $script:CallbackSimulationResponse
    $operations = [pscustomobject]@{
        snapshotRecord = {
            param($MessageTypeCode,$RecordHandle)
            [void]$calls.Add('snapshot')
            if ($failureAt -ceq 'snapshot') { throw 'synthetic snapshot failure' }
            return [pscustomobject]@{messageTypeCode=$MessageTypeCode;recordHandle=$RecordHandle}
        }.GetNewClosure()
        observeRecord = {
            param($IgnoredContext,$IgnoredSnapshot)
            [void]$calls.Add('observer')
            if ($failureAt -ceq 'observer') { throw 'synthetic observer failure' }
            return $response
        }.GetNewClosure()
    }
    $actual = Invoke-MyspeedMsiCalibrationCallbackBridge $context 0 ([uint32]0) $operations
    return [pscustomobject]@{response=$actual;callbackFailure=$context.callbackFailure;calls=@($calls)}
}

function New-MyspeedMsiCalibrationNativeOperations {
    param($Expected)
    Assert-MyspeedMsiCalibrationHostedContext $Expected
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class MyspeedMsiCalibrationNative
{
    internal const uint ErrorSuccess = 0;
    internal const uint ErrorMoreData = 234;
    internal const uint MaximumRecordFields = 16;
    internal const uint MaximumRecordFieldCharacters = 4096;
    internal const int MsiNullInteger = unchecked((int)0x80000000);
    internal const uint InstallLogModeFatalExit = 1u << 0;
    internal const uint InstallLogModeError = 1u << 1;
    internal const uint InstallLogModeActionStart = 1u << 8;
    internal const uint InstallLogModeActionData = 1u << 9;
    internal const uint InstallLogModeInstallStart = 1u << 26;
    internal const uint InstallLogModeInstallEnd = 1u << 27;
    internal const uint RequiredMessageFilter = InstallLogModeFatalExit | InstallLogModeError |
        InstallLogModeActionStart | InstallLogModeActionData | InstallLogModeInstallStart | InstallLogModeInstallEnd;
    internal const int CallbackFailureReturn = -1;

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    public delegate int InstallUiHandlerRecord(IntPtr context, uint messageType, uint recordHandle);
    public delegate int RecordObserver(IntPtr context, RecordSnapshot snapshot);

    public sealed class CallbackState
    {
        private readonly RecordObserver observer;
        public bool Failed { get; private set; }
        public string Failure { get; private set; }

        public CallbackState(RecordObserver observer)
        {
            if (observer == null) throw new ArgumentNullException("observer");
            this.observer = observer;
        }

        internal void LatchFailure()
        {
            if (!Failed)
            {
                Failed = true;
                Failure = "callback-record-or-observer-failure";
            }
        }

        internal int Invoke(IntPtr context, uint messageTypeCode, uint recordHandle)
        {
            try
            {
                return observer(context, SnapshotRecord(messageTypeCode, recordHandle));
            }
            catch
            {
                LatchFailure();
                return CallbackFailureReturn;
            }
        }
    }

    public sealed class RecordSnapshot
    {
        public uint MessageTypeCode { get; private set; }
        public string[] Fields { get; private set; }
        public int? Field1Integer { get; private set; }
        internal RecordSnapshot(uint messageTypeCode, string[] fields, int? field1Integer)
        {
            MessageTypeCode = messageTypeCode;
            Fields = fields;
            Field1Integer = field1Integer;
        }
    }

    [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    internal static extern uint MsiSetExternalUIRecord(InstallUiHandlerRecord handler, uint messageFilter,
        IntPtr context, out IntPtr previousHandler);

    [DllImport("msi.dll", ExactSpelling = true)]
    internal static extern uint MsiSetInternalUI(uint uiLevel, ref IntPtr ownerWindow);

    [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    internal static extern uint MsiEnableLogW(uint logMode, string logFile, uint logAttributes);

    [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    internal static extern uint MsiInstallProductW(string packagePath, string commandLine);

    [DllImport("msi.dll", ExactSpelling = true)]
    internal static extern uint MsiRecordGetFieldCount(uint recordHandle);

    [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    internal static extern uint MsiRecordGetStringW(uint recordHandle, uint field, StringBuilder value,
        ref uint valueCharacters);

    [DllImport("msi.dll", ExactSpelling = true)]
    internal static extern int MsiRecordGetInteger(uint recordHandle, uint field);

    public static RecordSnapshot SnapshotRecord(uint messageTypeCode, uint recordHandle)
    {
        uint fieldCount = MsiRecordGetFieldCount(recordHandle);
        if (fieldCount > MaximumRecordFields) throw new InvalidOperationException("MSI record has too many fields");
        string[] fields = new string[fieldCount];
        for (uint field = 1; field <= fieldCount; field++)
        {
            uint required = 0;
            StringBuilder probe = new StringBuilder(1);
            uint probeResult = MsiRecordGetStringW(recordHandle, field, probe, ref required);
            if (probeResult == ErrorSuccess && required == 0)
            {
                fields[field - 1] = String.Empty;
                continue;
            }
            if (probeResult != ErrorMoreData || required > MaximumRecordFieldCharacters)
                throw new InvalidOperationException("MSI record field is invalid or oversized");
            StringBuilder value = new StringBuilder(checked((int)required + 1));
            uint capacity = required + 1;
            uint result = MsiRecordGetStringW(recordHandle, field, value, ref capacity);
            if (result != ErrorSuccess || capacity != required || value.Length != required)
                throw new InvalidOperationException("MSI record field changed while being read");
            fields[field - 1] = value.ToString();
        }
        int first = fieldCount == 0 ? MsiNullInteger : MsiRecordGetInteger(recordHandle, 1);
        return new RecordSnapshot(messageTypeCode, fields, first == MsiNullInteger ? (int?)null : first);
    }

    public static InstallUiHandlerRecord CreateRecordCallback(CallbackState state)
    {
        if (state == null) throw new ArgumentNullException("state");
        return delegate(IntPtr context, uint messageTypeCode, uint recordHandle)
        {
            return state.Invoke(context, messageTypeCode, recordHandle);
        };
    }

    internal static void RetainCallback(InstallUiHandlerRecord callback)
    {
        GC.KeepAlive(callback);
    }
}
'@ -Language CSharp -ErrorAction Stop
    throw 'Native operations remain gated pending independent hosted calibration integration'
}

function Invoke-MyspeedMsiCalibrationSimulation {
    param($Simulation)
    Assert-MyspeedMsiCalibrationExactObject $Simulation @('request', 'facts') 'Controller simulation'
    Assert-MyspeedMsiCalibrationFacts $Simulation.facts
    $facts = $Simulation.facts
    $requiredCallbackMessageFilter = $script:RequiredCallbackMessageFilter
    $operations = [pscustomobject]@{
        setInternalUiNone = { return $facts.setInternalUiNone }.GetNewClosure()
        setExternalHandler = {
            param($CallbackRoot,$MessageFilter)
            if ($null -eq $CallbackRoot -or [long]$MessageFilter -ne $requiredCallbackMessageFilter) {
                throw 'Callback root or message filter differs'
            }
            return $facts.setExternalHandler
        }.GetNewClosure()
        enableLog = { param($IgnoredPath,$IgnoredModes,$IgnoredAttributes) return $facts.enableLog }.GetNewClosure()
        installProduct = { param($IgnoredPath,$IgnoredProperties) return $facts.installProduct }.GetNewClosure()
        disableLog = { param($IgnoredPath,$IgnoredModes,$IgnoredAttributes) return $facts.disableLog }.GetNewClosure()
        restoreExternalHandler = { param($IgnoredHandler,$IgnoredFilter) return $facts.restoreExternalHandler }.GetNewClosure()
        restoreInternalUi = { param($IgnoredLevel,$IgnoredOwner) return $facts.restoreInternalUi }.GetNewClosure()
        callbackEvidence = $facts.callbackEvidence
    }
    return Invoke-MyspeedMsiCalibrationController $Simulation.request $operations
}

if ($MyInvocation.InvocationName -ne '.') {
    if ([string]::IsNullOrWhiteSpace($InputJson)) { throw 'InputJson is required' }
    $inputValue = ConvertFrom-Json -InputObject $InputJson
    switch ($Mode) {
        'Library' { return }
        'GetFixtures' { Get-MyspeedSacrificialMsiFixtures $inputValue | ConvertTo-Json -Depth 10 -Compress; return }
        'NormalizeTimeline' {
            ConvertTo-MyspeedMsiCalibrationTimeline $inputValue | ConvertTo-Json -Depth 10 -Compress
            return
        }
        'SimulateCallbackBridge' {
            Invoke-MyspeedMsiCalibrationCallbackSimulation $inputValue | ConvertTo-Json -Depth 6 -Compress
            return
        }
        'SimulateController' {
            Invoke-MyspeedMsiCalibrationSimulation $inputValue | ConvertTo-Json -Depth 10 -Compress
            return
        }
    }
}
