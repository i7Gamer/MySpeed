[CmdletBinding()]
param(
    [ValidateSet('Library','ValidatePath','ValidateObservation','ValidateCollisions','ValidateOutput','InvokeNativeFactory')]
    [string]$Mode = 'Library',
    [string]$InputJson = '{}'
)

# File-identity and provenance boundary for the candidate-neutral Windows CPU
# readiness harness. Importing this file performs no filesystem or native action.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:SchemaVersion = 1
$script:Repository = 'i7Gamer/MySpeed'
$script:ImageOS = 'win25-vs2026'
$script:MaximumFileBytes = 33554432
$script:MaximumParseBytes = 2097152
$script:Base64InputGroupBytes = 3
$script:Base64OutputGroupCharacters = 4
$script:MaximumIdentityCount = 64
$script:MaximumVersionLength = 1024
$script:ControlCharacterMinimum = 0
$script:ControlCharacterMaximum = 31
$script:SingleLinkRoles = @('closure','source','generated-command')
$script:FileRoles = @($script:SingleLinkRoles + 'system-tool')
$script:JsonIntegerTypeCodes = @(
    [TypeCode]::SByte, [TypeCode]::Byte, [TypeCode]::Int16, [TypeCode]::UInt16,
    [TypeCode]::Int32, [TypeCode]::UInt32, [TypeCode]::Int64, [TypeCode]::UInt64
)
$script:Sha40 = '^[a-f0-9]{40}$'
$script:Sha256 = '^[a-f0-9]{64}$'
$script:Nonce = '^[a-f0-9]{32}$'
$script:PositiveDecimal = '^[1-9][0-9]{0,19}$'
$script:ImageVersion = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
$script:VolumeSerial = '^[a-f0-9]{8}$'
$script:FileId = '^[a-f0-9]{16}$'
$script:FileTime = '^[a-f0-9]{16}$'
$script:IdentityName = '^[a-z][a-z0-9._-]{0,63}$'

function Get-MyspeedFileIdentityObjectKeys {
    param([object]$Value)
    if ($null -eq $Value -or $Value -is [string] -or $Value -is [array]) {
        throw 'Value must be an object'
    }
    if ($Value -is [System.Collections.IDictionary]) { return @($Value.Keys) }
    return @($Value.PSObject.Properties.Name)
}

function Assert-MyspeedFileIdentityExactKeys {
    param([object]$Value, [string[]]$Expected, [string]$Label)
    $actual = @(Get-MyspeedFileIdentityObjectKeys $Value | Sort-Object)
    $wanted = @($Expected | Sort-Object)
    if (($actual -join "`n") -cne ($wanted -join "`n")) {
        throw "$Label schema differs"
    }
}

function Assert-MyspeedFileIdentityString {
    param([object]$Value, [string]$Label)
    if ($Value -isnot [string]) { throw "$Label must be a JSON string" }
    return [string]$Value
}

function Assert-MyspeedFileIdentityBoolean {
    param([object]$Value, [string]$Label)
    if ($Value -isnot [bool]) { throw "$Label must be a JSON boolean" }
    return [bool]$Value
}

function Assert-MyspeedFileIdentityInteger {
    param([object]$Value, [string]$Label)
    if ($null -eq $Value -or [Type]::GetTypeCode($Value.GetType()) -notin $script:JsonIntegerTypeCodes) {
        throw "$Label must be a JSON integer"
    }
    try { return [int64]$Value }
    catch { throw "$Label must fit a signed 64-bit integer" }
}

function Assert-MyspeedLexicalLocalPath {
    param([object]$Path, [string]$Label = 'Path')
    $value = Assert-MyspeedFileIdentityString $Path $Label
    if ([string]::IsNullOrWhiteSpace($value) -or $value -cnotmatch '^[A-Za-z]:\\' -or
        $value.IndexOfAny([char[]]($script:ControlCharacterMinimum..$script:ControlCharacterMaximum)) -ge 0 -or
        $value -match '[&|<>^%!"*?\[\]]' -or $value.Substring(2).Contains(':') -or
        $value -match '/' -or $value -match '\\\\') {
        throw "$Label contains a path, control, or metacharacter violation"
    }
    if ($value.Length -eq 3) { return $value }
    foreach ($segment in ($value.Substring(3) -split '\\')) {
        if ($segment -in @('','.', '..') -or $segment -match '[ .]$') {
            throw "$Label is not a normalized Windows path"
        }
        if ($segment -match '^(?i:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)') {
            throw "$Label contains a reserved DOS device segment"
        }
    }
    return $value
}

function Assert-MyspeedStrictPathDescendant {
    param([object]$Path, [object]$Root, [string]$Label = 'Path')
    $candidate = Assert-MyspeedLexicalLocalPath $Path $Label
    $rootPath = Assert-MyspeedLexicalLocalPath $Root "$Label root"
    $prefix = $rootPath.TrimEnd('\') + '\'
    if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label is not a strict descendant of its root"
    }
    return $candidate
}

function Assert-MyspeedFileIdentityPathRequest {
    param([object]$Request)
    $keys = @(Get-MyspeedFileIdentityObjectKeys $Request | Sort-Object)
    if (($keys -join "`n") -ceq 'path') {
        return Assert-MyspeedLexicalLocalPath $Request.path 'Path'
    }
    Assert-MyspeedFileIdentityExactKeys $Request @('path','root') 'Path request'
    return Assert-MyspeedStrictPathDescendant $Request.path $Request.root 'Path'
}

function Get-MyspeedExpectedPathChain {
    param([object]$Path)
    $value = Assert-MyspeedLexicalLocalPath $Path 'Path chain target'
    $result = [System.Collections.Generic.List[string]]::new()
    $current = $value.Substring(0, 3)
    $result.Add($current)
    if ($value.Length -gt 3) {
        foreach ($segment in ($value.Substring(3) -split '\\')) {
            $current = if ($current.Length -eq 3) { $current + $segment } else { $current + '\' + $segment }
            $result.Add($current)
        }
    }
    return @($result)
}

function Assert-MyspeedPathObservation {
    param(
        [object]$Observation,
        [object]$Path,
        [ValidateSet('file','directory')][string]$LeafKind
    )
    $target = Assert-MyspeedLexicalLocalPath $Path 'Observed path'
    Assert-MyspeedFileIdentityExactKeys $Observation @('volumeRoot','driveType','entries') 'Path observation'
    $volumeRoot = Assert-MyspeedFileIdentityString $Observation.volumeRoot 'Path observation volume root'
    $driveType = Assert-MyspeedFileIdentityString $Observation.driveType 'Path observation drive type'
    if ($volumeRoot -cne $target.Substring(0, 3) -or $driveType -cne 'Fixed') {
        throw 'Path observation is not on the expected fixed local drive'
    }
    if ($Observation.entries -isnot [array]) { throw 'Path observation entries must be an array' }
    $expected = @(Get-MyspeedExpectedPathChain $target)
    if ($Observation.entries.Count -ne $expected.Count) { throw 'Path observation chain length differs' }
    for ($index = 0; $index -lt $expected.Count; $index++) {
        $entry = $Observation.entries[$index]
        Assert-MyspeedFileIdentityExactKeys $entry @('path','kind','reparsePoint') 'Path observation entry'
        $entryPath = Assert-MyspeedFileIdentityString $entry.path 'Path observation entry path'
        $entryKind = Assert-MyspeedFileIdentityString $entry.kind 'Path observation entry kind'
        $entryReparse = Assert-MyspeedFileIdentityBoolean $entry.reparsePoint 'Path observation reparse proof'
        $expectedKind = if ($index -eq $expected.Count - 1) { $LeafKind } else { 'directory' }
        if ($entryPath -cne $expected[$index] -or $entryKind -cne $expectedKind) {
            throw 'Path observation chain or leaf kind differs'
        }
        if ($entryReparse) { throw "Path observation contains a reparse point: $entryPath" }
    }
    return $true
}

function Assert-MyspeedPathObservationsEqual {
    param([object]$Before, [object]$After)
    foreach ($name in @('volumeRoot','driveType')) {
        if ($Before.$name -cne $After.$name) { throw 'Path observation drifted while the handle was open' }
    }
    if ($Before.entries.Count -ne $After.entries.Count) { throw 'Path observation drifted while the handle was open' }
    for ($index = 0; $index -lt $Before.entries.Count; $index++) {
        foreach ($name in @('path','kind','reparsePoint')) {
            if ($Before.entries[$index].$name -cne $After.entries[$index].$name) {
                throw 'Path observation drifted while the handle was open'
            }
        }
    }
}

function Assert-MyspeedNullableVersion {
    param([object]$Value, [string]$Label)
    if ($null -eq $Value) { return $null }
    $version = Assert-MyspeedFileIdentityString $Value $Label
    if ($version.Length -gt $script:MaximumVersionLength -or
        $version.IndexOfAny([char[]]($script:ControlCharacterMinimum..$script:ControlCharacterMaximum)) -ge 0) {
        throw "$Label is invalid"
    }
    return $version
}

function Assert-MyspeedHandleFacts {
    param([object]$Facts, [string]$ExpectedPath, [int64]$MaximumBytes, [string]$Role, [string]$Label)
    Assert-MyspeedFileIdentityExactKeys $Facts @('canonicalPath','finalPath','volumeSerial','fileId','bytes',
        'lastWriteFileTime','linkCount','isRegular','reparsePoint','fileVersion','productVersion') $Label
    $canonicalPath = Assert-MyspeedFileIdentityString $Facts.canonicalPath "$Label canonical path"
    $finalPath = Assert-MyspeedFileIdentityString $Facts.finalPath "$Label final path"
    Assert-MyspeedLexicalLocalPath $canonicalPath "$Label canonical path" | Out-Null
    Assert-MyspeedLexicalLocalPath $finalPath "$Label final path" | Out-Null
    if ($canonicalPath -cne $ExpectedPath -or $finalPath -cne $ExpectedPath) {
        throw "$Label final-path handle binding differs"
    }
    $volumeSerial = Assert-MyspeedFileIdentityString $Facts.volumeSerial "$Label volume serial"
    $fileId = Assert-MyspeedFileIdentityString $Facts.fileId "$Label file ID"
    if ($volumeSerial -cnotmatch $script:VolumeSerial -or $fileId -cnotmatch $script:FileId) {
        throw "$Label stable identity is malformed"
    }
    $bytes = Assert-MyspeedFileIdentityInteger $Facts.bytes "$Label bytes"
    $lastWrite = Assert-MyspeedFileIdentityString $Facts.lastWriteFileTime "$Label last-write time"
    $linkCount = Assert-MyspeedFileIdentityInteger $Facts.linkCount "$Label link count"
    $isRegular = Assert-MyspeedFileIdentityBoolean $Facts.isRegular "$Label regular-file proof"
    $isReparse = Assert-MyspeedFileIdentityBoolean $Facts.reparsePoint "$Label reparse proof"
    if ($bytes -le 0 -or $bytes -gt $MaximumBytes) { throw "$Label size exceeds its bound" }
    if ($lastWrite -cnotmatch $script:FileTime -or $linkCount -le 0) { throw "$Label metadata is invalid" }
    if (-not $isRegular) { throw "$Label leaf is not a regular file" }
    if ($isReparse) { throw "$Label leaf is a reparse point" }
    if ($Role -in $script:SingleLinkRoles -and $linkCount -ne 1) {
        throw "$Label owned input must have exactly one link"
    }
    $fileVersion = Assert-MyspeedNullableVersion $Facts.fileVersion "$Label file version"
    $productVersion = Assert-MyspeedNullableVersion $Facts.productVersion "$Label product version"
    return [pscustomobject]([ordered]@{
        canonicalPath=$canonicalPath; finalPath=$finalPath; volumeSerial=$volumeSerial; fileId=$fileId
        bytes=$bytes; lastWriteFileTime=$lastWrite; linkCount=$linkCount; isRegular=$isRegular
        reparsePoint=$isReparse; fileVersion=$fileVersion; productVersion=$productVersion
    })
}

function Assert-MyspeedHandleFactsEqual {
    param([object]$Before, [object]$After)
    foreach ($name in @('canonicalPath','finalPath','volumeSerial','fileId','bytes','lastWriteFileTime',
        'linkCount','isRegular','reparsePoint','fileVersion','productVersion')) {
        if ($Before.$name -cne $After.$name) { throw "Stable handle identity drifted: $name" }
    }
}

function Assert-MyspeedFileIdentityRequest {
    param([object]$Request)
    Assert-MyspeedFileIdentityExactKeys $Request @('name','path','allowedRoot','maximumBytes','role') 'File request'
    $name = Assert-MyspeedFileIdentityString $Request.name 'File request name'
    if ($name -cnotmatch $script:IdentityName) { throw 'File request name is invalid' }
    $path = Assert-MyspeedStrictPathDescendant $Request.path $Request.allowedRoot 'File request path'
    $root = Assert-MyspeedLexicalLocalPath $Request.allowedRoot 'File request root'
    $maximumBytes = Assert-MyspeedFileIdentityInteger $Request.maximumBytes 'File request maximum bytes'
    if ($maximumBytes -le 0 -or $maximumBytes -gt $script:MaximumFileBytes) {
        throw 'File request byte bound is invalid'
    }
    $role = Assert-MyspeedFileIdentityString $Request.role 'File request role'
    if ($role -cnotin $script:FileRoles) { throw 'File request role is unsupported' }
    return [pscustomobject]@{name=$name;path=$path;allowedRoot=$root;maximumBytes=$maximumBytes;role=$role}
}

function Assert-MyspeedFileIdentityObservation {
    param([object]$Observation)
    Assert-MyspeedFileIdentityExactKeys $Observation @('request','pathBefore','before','hash','after','pathAfter') `
        'File identity observation'
    $request = Assert-MyspeedFileIdentityRequest $Observation.request
    Assert-MyspeedPathObservation $Observation.pathBefore $request.path 'file' | Out-Null
    $before = Assert-MyspeedHandleFacts $Observation.before $request.path $request.maximumBytes $request.role 'Before-hash handle'
    Assert-MyspeedFileIdentityExactKeys $Observation.hash @('sha256','bytesRead') 'Handle hash result'
    $hash = Assert-MyspeedFileIdentityString $Observation.hash.sha256 'Handle SHA-256'
    $bytesRead = Assert-MyspeedFileIdentityInteger $Observation.hash.bytesRead 'Handle bytes read'
    if ($hash -cnotmatch $script:Sha256) { throw 'Handle SHA-256 is invalid' }
    if ($bytesRead -ne $before.bytes) { throw 'Handle hash byte count differs from stable size' }
    $after = Assert-MyspeedHandleFacts $Observation.after $request.path $request.maximumBytes $request.role 'After-hash handle'
    Assert-MyspeedHandleFactsEqual $before $after
    Assert-MyspeedPathObservation $Observation.pathAfter $request.path 'file' | Out-Null
    Assert-MyspeedPathObservationsEqual $Observation.pathBefore $Observation.pathAfter
    return [pscustomobject]([ordered]@{
        schemaVersion=$script:SchemaVersion; name=$request.name; role=$request.role; path=$request.path
        finalPath=$before.finalPath; volumeSerial=$before.volumeSerial; fileId=$before.fileId
        bytes=$before.bytes; lastWriteFileTime=$before.lastWriteFileTime; linkCount=$before.linkCount
        sha256=$hash; fileVersion=$before.fileVersion; productVersion=$before.productVersion
    })
}

function Get-MyspeedVerifiedFileIdentity {
    param(
        [Parameter(Mandatory)][object]$Request,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Operations
    )
    $operationKeys = @('GetPathObservation','OpenStableRead','GetHandleFacts','ReadHandleSha256','CloseStableRead')
    if ($Operations.Contains('ReadHandleBytes')) { $operationKeys += 'ReadHandleBytes' }
    Assert-MyspeedFileIdentityExactKeys $Operations $operationKeys 'File identity operations'
    $validatedRequest = Assert-MyspeedFileIdentityRequest $Request
    $pathBefore = & $Operations.GetPathObservation $validatedRequest.path
    Assert-MyspeedPathObservation $pathBefore $validatedRequest.path 'file' | Out-Null
    $handle = $null
    $opened = $false
    $primaryFailure = $null
    $closeFailure = $null
    $result = $null
    try {
        $handle = & $Operations.OpenStableRead $validatedRequest.path
        if ($null -eq $handle) { throw 'Stable read handle was not returned' }
        $opened = $true
        $before = & $Operations.GetHandleFacts $handle
        $hash = & $Operations.ReadHandleSha256 $handle $validatedRequest.maximumBytes
        $after = & $Operations.GetHandleFacts $handle
        $pathAfter = & $Operations.GetPathObservation $validatedRequest.path
        $result = Assert-MyspeedFileIdentityObservation ([pscustomobject]@{
            request=$validatedRequest; pathBefore=$pathBefore; before=$before; hash=$hash; after=$after; pathAfter=$pathAfter
        })
    } catch {
        $primaryFailure = $_.Exception.Message
    } finally {
        if ($opened) {
            try { & $Operations.CloseStableRead $handle }
            catch { $closeFailure = $_.Exception.Message }
        }
    }
    if ($null -ne $primaryFailure -and $null -ne $closeFailure) {
        throw "File identity verification failed: $primaryFailure; stable handle cleanup failed: $closeFailure"
    }
    if ($null -ne $primaryFailure) { throw $primaryFailure }
    if ($null -ne $closeFailure) { throw "Stable handle cleanup failed: $closeFailure" }
    return $result
}

function Read-MyspeedVerifiedFileBytes {
    param(
        [Parameter(Mandatory)][object]$Request,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Operations
    )
    Assert-MyspeedFileIdentityExactKeys $Operations @('GetPathObservation','OpenStableRead','GetHandleFacts',
        'ReadHandleSha256','ReadHandleBytes','CloseStableRead') 'Bounded file read operations'
    $validatedRequest = Assert-MyspeedFileIdentityRequest $Request
    if ($validatedRequest.maximumBytes -gt $script:MaximumParseBytes) { throw 'Parsed file maximum exceeds its bound' }
    $pathBefore = & $Operations.GetPathObservation $validatedRequest.path
    Assert-MyspeedPathObservation $pathBefore $validatedRequest.path 'file' | Out-Null
    $handle = $null
    $opened = $false
    $primaryFailure = $null
    $closeFailure = $null
    $result = $null
    try {
        $handle = & $Operations.OpenStableRead $validatedRequest.path
        if ($null -eq $handle) { throw 'Bounded read handle was not returned' }
        $opened = $true
        $before = & $Operations.GetHandleFacts $handle
        Assert-MyspeedHandleFacts $before $validatedRequest.path $validatedRequest.maximumBytes $validatedRequest.role 'Before-read handle' | Out-Null
        $read = & $Operations.ReadHandleBytes $handle $validatedRequest.maximumBytes
        Assert-MyspeedFileIdentityExactKeys $read @('bytesBase64','sha256','bytesRead') 'Bounded handle bytes'
        $base64 = Assert-MyspeedFileIdentityString $read.bytesBase64 'Bounded handle byte encoding'
        $maximumEncodedCharacters = [Math]::Ceiling($validatedRequest.maximumBytes / $script:Base64InputGroupBytes) * $script:Base64OutputGroupCharacters
        if ($base64.Length -gt $maximumEncodedCharacters) { throw 'Encoded file bytes exceed their bound' }
        try { $bytes = [Convert]::FromBase64String($base64) } catch { throw 'Bounded file byte encoding is malformed' }
        if ($bytes.Length -le 0 -or $bytes.Length -gt $validatedRequest.maximumBytes -or
            [Convert]::ToBase64String($bytes) -cne $base64) { throw 'Bounded file byte encoding is noncanonical or oversized' }
        $bytesRead = Assert-MyspeedFileIdentityInteger $read.bytesRead 'Bounded handle bytes read'
        $reportedHash = Assert-MyspeedFileIdentityString $read.sha256 'Bounded handle SHA-256'
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try { $actualHash = ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() }
        finally { $algorithm.Dispose() }
        if ($bytesRead -ne $bytes.Length -or $actualHash -cne $reportedHash) { throw 'Read bytes differ from their hash or count' }
        $after = & $Operations.GetHandleFacts $handle
        $pathAfter = & $Operations.GetPathObservation $validatedRequest.path
        $identity = Assert-MyspeedFileIdentityObservation ([pscustomobject]@{
            request=$validatedRequest;pathBefore=$pathBefore;before=$before
            hash=[pscustomobject]@{sha256=$actualHash;bytesRead=$bytesRead};after=$after;pathAfter=$pathAfter
        })
        $result = [pscustomobject]@{identity=$identity;bytesBase64=$base64}
    } catch { $primaryFailure = $_.Exception.Message }
    finally {
        if ($opened) { try { & $Operations.CloseStableRead $handle } catch { $closeFailure = $_.Exception.Message } }
    }
    if ($null -ne $primaryFailure -and $null -ne $closeFailure) {
        throw "Bounded read failed: $primaryFailure; stable handle cleanup failed: $closeFailure"
    }
    if ($null -ne $primaryFailure) { throw $primaryFailure }
    if ($null -ne $closeFailure) { throw "Stable handle cleanup failed: $closeFailure" }
    return $result
}

function Assert-MyspeedFileIdentityRecord {
    param([object]$Record)
    Assert-MyspeedFileIdentityExactKeys $Record @('schemaVersion','name','role','path','finalPath','volumeSerial',
        'fileId','bytes','lastWriteFileTime','linkCount','sha256','fileVersion','productVersion') 'Identity record'
    $schemaVersion = Assert-MyspeedFileIdentityInteger $Record.schemaVersion 'Identity schema version'
    $name = Assert-MyspeedFileIdentityString $Record.name 'Identity name'
    $role = Assert-MyspeedFileIdentityString $Record.role 'Identity role'
    $path = Assert-MyspeedLexicalLocalPath $Record.path 'Identity path'
    $finalPath = Assert-MyspeedLexicalLocalPath $Record.finalPath 'Identity final path'
    $volumeSerial = Assert-MyspeedFileIdentityString $Record.volumeSerial 'Identity volume serial'
    $fileId = Assert-MyspeedFileIdentityString $Record.fileId 'Identity file ID'
    $bytes = Assert-MyspeedFileIdentityInteger $Record.bytes 'Identity bytes'
    $lastWrite = Assert-MyspeedFileIdentityString $Record.lastWriteFileTime 'Identity last-write time'
    $linkCount = Assert-MyspeedFileIdentityInteger $Record.linkCount 'Identity link count'
    $hash = Assert-MyspeedFileIdentityString $Record.sha256 'Identity SHA-256'
    Assert-MyspeedNullableVersion $Record.fileVersion 'Identity file version' | Out-Null
    Assert-MyspeedNullableVersion $Record.productVersion 'Identity product version' | Out-Null
    if ($schemaVersion -ne $script:SchemaVersion -or $name -cnotmatch $script:IdentityName -or
        $role -cnotin $script:FileRoles -or $path -cne $finalPath -or
        $volumeSerial -cnotmatch $script:VolumeSerial -or $fileId -cnotmatch $script:FileId -or
        $bytes -le 0 -or $bytes -gt $script:MaximumFileBytes -or $lastWrite -cnotmatch $script:FileTime -or
        $linkCount -le 0 -or
        $hash -cnotmatch $script:Sha256) { throw 'Identity record is invalid' }
    if ($role -in $script:SingleLinkRoles -and $linkCount -ne 1) { throw 'Identity record link count is invalid' }
    return $true
}

function Assert-MyspeedNoFileIdentityCollisions {
    param([object]$Request)
    Assert-MyspeedFileIdentityExactKeys $Request @('files') 'Identity set'
    if ($Request.files -isnot [array] -or $Request.files.Count -le 0 -or
        $Request.files.Count -gt $script:MaximumIdentityCount) { throw 'Identity set count is invalid' }
    $names = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $identities = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($file in $Request.files) {
        Assert-MyspeedFileIdentityRecord $file | Out-Null
        if (-not $names.Add([string]$file.name)) { throw 'Identity name collision detected' }
        $identity = [string]$file.volumeSerial + ':' + [string]$file.fileId
        if (-not $identities.Add($identity)) { throw 'File identity collision detected' }
    }
    return [pscustomobject]@{accepted=$true}
}

function Assert-MyspeedOwnedCreateNewOutput {
    param([object]$Request)
    Assert-MyspeedFileIdentityExactKeys $Request @('path','ownedRoot','maximumBytes','leafExists','pathObservation') `
        'Create-new output'
    $path = Assert-MyspeedStrictPathDescendant $Request.path $Request.ownedRoot 'Create-new output path'
    $root = Assert-MyspeedLexicalLocalPath $Request.ownedRoot 'Create-new owned root'
    $maximumBytes = Assert-MyspeedFileIdentityInteger $Request.maximumBytes 'Create-new maximum bytes'
    $leafExists = Assert-MyspeedFileIdentityBoolean $Request.leafExists 'Create-new leaf-existence proof'
    if ($maximumBytes -le 0 -or $maximumBytes -gt $script:MaximumFileBytes) {
        throw 'Create-new output byte bound is invalid'
    }
    if ($leafExists) { throw 'Create-new output leaf already exists' }
    $separator = $path.LastIndexOf('\')
    if ($separator -le 2) { throw 'Create-new output has no owned parent' }
    $parent = $path.Substring(0, $separator)
    Assert-MyspeedPathObservation $Request.pathObservation $parent 'directory' | Out-Null
    $expected = @(Get-MyspeedExpectedPathChain $parent)
    if ($expected -cnotcontains $root) { throw 'Create-new owned root is absent from its observed chain' }
    return [pscustomobject]@{accepted=$true;filesystemMutationAuthorized=$false;createMode='create-new'}
}

function Assert-MyspeedFileIdentityHostedContext {
    param([object]$Expected)
    Assert-MyspeedFileIdentityExactKeys $Expected @('expectedRunId','expectedRunAttempt','expectedEventSha',
        'expectedSourceSha','nonce') 'Hosted file-identity request'
    $runId = Assert-MyspeedFileIdentityString $Expected.expectedRunId 'Expected run ID'
    $runAttempt = Assert-MyspeedFileIdentityString $Expected.expectedRunAttempt 'Expected run attempt'
    $eventSha = Assert-MyspeedFileIdentityString $Expected.expectedEventSha 'Expected event SHA'
    $sourceSha = Assert-MyspeedFileIdentityString $Expected.expectedSourceSha 'Expected source SHA'
    $nonce = Assert-MyspeedFileIdentityString $Expected.nonce 'Expected nonce'
    if ($runId -cnotmatch $script:PositiveDecimal -or $runAttempt -cnotmatch $script:PositiveDecimal -or
        $eventSha -cnotmatch $script:Sha40 -or $sourceSha -cnotmatch $script:Sha40 -or $nonce -cnotmatch $script:Nonce) {
        throw 'Hosted file-identity request identity is invalid'
    }
    $required = [ordered]@{
        GITHUB_REPOSITORY=$script:Repository; GITHUB_ACTIONS='true'; CI='true'; RUNNER_OS='Windows';
        RUNNER_ARCH='X64'; RUNNER_ENVIRONMENT='github-hosted'; ImageOS=$script:ImageOS;
        GITHUB_RUN_ID=$runId; GITHUB_RUN_ATTEMPT=$runAttempt; GITHUB_SHA=$eventSha
    }
    foreach ($entry in $required.GetEnumerator()) {
        if ([string][Environment]::GetEnvironmentVariable($entry.Key) -cne $entry.Value) {
            throw "Hosted file-identity context differed: $($entry.Key)"
        }
    }
    $imageVersion = [string][Environment]::GetEnvironmentVariable('ImageVersion')
    if ($imageVersion -cnotmatch $script:ImageVersion) { throw 'Hosted file-identity ImageVersion is invalid' }
    if (-not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -cne 'Desktop' -or
        $PSVersionTable.PSVersion.Major -ne 5) { throw 'Hosted file-identity process must be x64 Windows PowerShell 5.1' }
    $expectedPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $actualPowerShell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    if (-not [string]::Equals([IO.Path]::GetFullPath($actualPowerShell), [IO.Path]::GetFullPath($expectedPowerShell),
        [StringComparison]::OrdinalIgnoreCase)) { throw 'Hosted file-identity PowerShell path differs' }
    return $true
}

function New-MyspeedNativeFileIdentityOperations {
    param([Parameter(Mandatory)][object]$Expected)
    Assert-MyspeedFileIdentityHostedContext $Expected | Out-Null

    if ($null -ne ('MyspeedFileIdentityNative' -as [type])) {
        throw 'Native file-identity type already exists before trusted construction'
    }
    $nativeSource = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

public sealed class MyspeedStableReadHandle : IDisposable
{
    internal readonly FileStream Stream;
    internal readonly string CanonicalPath;
    internal MyspeedStableReadHandle(FileStream stream, string path) { Stream = stream; CanonicalPath = path; }
    public void Dispose() { Stream.Dispose(); }
}

public sealed class MyspeedNativeFileFacts
{
    public string canonicalPath { get; set; }
    public string finalPath { get; set; }
    public string volumeSerial { get; set; }
    public string fileId { get; set; }
    public long bytes { get; set; }
    public string lastWriteFileTime { get; set; }
    public long linkCount { get; set; }
    public bool isRegular { get; set; }
    public bool reparsePoint { get; set; }
    public string fileVersion { get; set; }
    public string productVersion { get; set; }
}

public sealed class MyspeedNativeHashResult
{
    public string sha256 { get; set; }
    public long bytesRead { get; set; }
}

public sealed class MyspeedNativeBytesResult
{
    public string bytesBase64 { get; set; }
    public string sha256 { get; set; }
    public long bytesRead { get; set; }
}

public static class MyspeedFileIdentityNative
{
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const uint FILE_TYPE_DISK = 0x0001;
    private const int BUFFER_BYTES = 65536;
    private const int FINAL_PATH_CHARACTERS = 32768;
    private const int MAXIMUM_PARSE_BYTES = 2097152;

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME { public uint Low; public uint High; }
    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
        public uint Attributes;
        public FILETIME CreationTime;
        public FILETIME LastAccessTime;
        public FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint sharing, IntPtr security,
        uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path,
        uint characters, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetFileType(SafeFileHandle handle);

    public static MyspeedStableReadHandle Open(string path)
    {
        SafeFileHandle handle = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, IntPtr.Zero,
            OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
        if (handle.IsInvalid) { throw new Win32Exception(Marshal.GetLastWin32Error(), "Stable file open failed"); }
        try { return new MyspeedStableReadHandle(new FileStream(handle, FileAccess.Read, BUFFER_BYTES, false), Path.GetFullPath(path)); }
        catch { handle.Dispose(); throw; }
    }

    private static string FinalPath(SafeFileHandle handle)
    {
        StringBuilder value = new StringBuilder(FINAL_PATH_CHARACTERS);
        uint length = GetFinalPathNameByHandleW(handle, value, (uint)value.Capacity, 0);
        if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Final handle path failed");
        if (length >= value.Capacity) throw new InvalidDataException("Final handle path exceeded its bound");
        string result = value.ToString();
        const string Prefix = @"\\?\";
        if (result.StartsWith(Prefix, StringComparison.Ordinal)) result = result.Substring(Prefix.Length);
        return result;
    }

    private static long Combine(uint high, uint low)
    {
        ulong value = ((ulong)high << 32) | low;
        if (value > long.MaxValue) throw new InvalidDataException("Native file integer exceeded Int64");
        return (long)value;
    }

    private static string LowerHex(byte[] value)
    {
        StringBuilder result = new StringBuilder(value.Length * 2);
        foreach (byte item in value) result.Append(item.ToString("x2"));
        return result.ToString();
    }

    public static MyspeedNativeFileFacts Facts(MyspeedStableReadHandle stable)
    {
        BY_HANDLE_FILE_INFORMATION info;
        if (!GetFileInformationByHandle(stable.Stream.SafeFileHandle, out info))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Stable file metadata failed");
        string finalPath = FinalPath(stable.Stream.SafeFileHandle);
        FileVersionInfo version = null;
        if (String.Equals(Path.GetExtension(finalPath), ".exe", StringComparison.OrdinalIgnoreCase))
            version = FileVersionInfo.GetVersionInfo(finalPath);
        return new MyspeedNativeFileFacts {
            canonicalPath = stable.CanonicalPath,
            finalPath = finalPath,
            volumeSerial = info.VolumeSerialNumber.ToString("x8"),
            fileId = info.FileIndexHigh.ToString("x8") + info.FileIndexLow.ToString("x8"),
            bytes = Combine(info.FileSizeHigh, info.FileSizeLow),
            lastWriteFileTime = info.LastWriteTime.High.ToString("x8") + info.LastWriteTime.Low.ToString("x8"),
            linkCount = info.NumberOfLinks,
            isRegular = GetFileType(stable.Stream.SafeFileHandle) == FILE_TYPE_DISK &&
                (info.Attributes & FILE_ATTRIBUTE_DIRECTORY) == 0,
            reparsePoint = (info.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0,
            fileVersion = version == null ? null : version.FileVersion,
            productVersion = version == null ? null : version.ProductVersion
        };
    }

    public static MyspeedNativeHashResult Hash(MyspeedStableReadHandle stable, long maximumBytes)
    {
        if (maximumBytes <= 0) throw new ArgumentOutOfRangeException("maximumBytes");
        long originalPosition = stable.Stream.Position;
        try {
            stable.Stream.Position = 0;
            long total = 0;
            byte[] buffer = new byte[BUFFER_BYTES];
            using (SHA256 algorithm = SHA256.Create()) {
                int read;
                while ((read = stable.Stream.Read(buffer, 0, buffer.Length)) > 0) {
                    total += read;
                    if (total > maximumBytes) throw new InvalidDataException("Stable file exceeded its hash bound");
                    algorithm.TransformBlock(buffer, 0, read, buffer, 0);
                }
                algorithm.TransformFinalBlock(new byte[0], 0, 0);
                return new MyspeedNativeHashResult { sha256 = LowerHex(algorithm.Hash), bytesRead = total };
            }
        } finally { stable.Stream.Position = originalPosition; }
    }

    public static MyspeedNativeBytesResult ReadBytes(MyspeedStableReadHandle stable, long maximumBytes)
    {
        if (maximumBytes <= 0 || maximumBytes > MAXIMUM_PARSE_BYTES) throw new ArgumentOutOfRangeException("maximumBytes");
        long originalPosition = stable.Stream.Position;
        try {
            long length = stable.Stream.Length;
            if (length <= 0 || length > maximumBytes) throw new InvalidDataException("Stable parsed file exceeds its bound");
            stable.Stream.Position = 0;
            byte[] bytes = new byte[(int)length];
            int offset = 0;
            while (offset < bytes.Length) {
                int read = stable.Stream.Read(bytes, offset, bytes.Length - offset);
                if (read <= 0) throw new EndOfStreamException("Stable parsed file ended early");
                offset += read;
            }
            if (stable.Stream.ReadByte() != -1) throw new InvalidDataException("Stable parsed file grew while reading");
            using (SHA256 algorithm = SHA256.Create()) {
                return new MyspeedNativeBytesResult {
                    bytesBase64 = Convert.ToBase64String(bytes), sha256 = LowerHex(algorithm.ComputeHash(bytes)), bytesRead = bytes.Length
                };
            }
        } finally { stable.Stream.Position = originalPosition; }
    }
}
'@
    Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop

    $getPathObservation = {
        param([string]$Path)
        # Keep the returned native callback independent of this script's function
        # scope. The public pure validator rechecks the emitted chain later.
        $paths = [System.Collections.Generic.List[string]]::new()
        $current = $Path.Substring(0, 3)
        $paths.Add($current)
        if ($Path.Length -gt 3) {
            foreach ($segment in ($Path.Substring(3) -split '\\')) {
                $current = if ($current.Length -eq 3) { $current + $segment } else { $current + '\' + $segment }
                $paths.Add($current)
            }
        }
        $entries = [System.Collections.Generic.List[object]]::new()
        for ($index = 0; $index -lt $paths.Count; $index++) {
            $item = Get-Item -LiteralPath $paths[$index] -Force -ErrorAction Stop
            $kind = if ($item.PSIsContainer) { 'directory' } else { 'file' }
            $entries.Add([pscustomobject]@{
                path=[IO.Path]::GetFullPath([string]$item.FullName); kind=$kind
                reparsePoint=[bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
            })
        }
        $volumeRoot = $paths[0]
        $drive = [IO.DriveInfo]::new($volumeRoot)
        return [pscustomobject]@{volumeRoot=$volumeRoot;driveType=[string]$drive.DriveType;entries=@($entries)}
    }.GetNewClosure()
    return @{
        GetPathObservation=$getPathObservation
        OpenStableRead={ param($path) [MyspeedFileIdentityNative]::Open($path) }
        GetHandleFacts={ param($handle) [MyspeedFileIdentityNative]::Facts($handle) }
        ReadHandleSha256={ param($handle,$maximumBytes) [MyspeedFileIdentityNative]::Hash($handle,$maximumBytes) }
        ReadHandleBytes={ param($handle,$maximumBytes) [MyspeedFileIdentityNative]::ReadBytes($handle,$maximumBytes) }
        CloseStableRead={ param($handle) $handle.Dispose() }
    }
}

function Write-MyspeedFileIdentityJson {
    param([object]$Value)
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 20))
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $request = $InputJson | ConvertFrom-Json
        switch ($Mode) {
            'Library' { }
            'ValidatePath' {
                $path = Assert-MyspeedFileIdentityPathRequest $request
                Write-MyspeedFileIdentityJson ([pscustomobject]@{path=$path})
            }
            'ValidateObservation' { Write-MyspeedFileIdentityJson (Assert-MyspeedFileIdentityObservation $request) }
            'ValidateCollisions' { Write-MyspeedFileIdentityJson (Assert-MyspeedNoFileIdentityCollisions $request) }
            'ValidateOutput' { Write-MyspeedFileIdentityJson (Assert-MyspeedOwnedCreateNewOutput $request) }
            'InvokeNativeFactory' { New-MyspeedNativeFileIdentityOperations $request | Out-Null }
        }
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
}
