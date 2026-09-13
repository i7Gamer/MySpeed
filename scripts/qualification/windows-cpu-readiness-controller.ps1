[CmdletBinding()]
param(
    [ValidateSet('Library','EmitClosureManifest','TestValidateClosure','TestModuleDispatch','TestOperationPlan','TestChildEnvelope','TestAggregate','TestNativeLifecycle','TestLifecycle','InvokeHostedReadiness')]
    [string]$Mode = 'Library',
    [string]$ExpectedRunId,
    [string]$ExpectedRunAttempt,
    [string]$ExpectedEventSha,
    [string]$ExpectedSourceSha,
    [string]$Nonce,
    [string]$ClosureRoot,
    [string]$ManifestPath,
    [string]$EvidencePath,
    [string]$InputJson = '{}'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:SchemaVersion = 1
$script:Repository = 'i7Gamer/MySpeed'
$script:ImageOS = 'win25-vs2026'
$script:ClosureKind = 'myspeed-windows-cpu-readiness-closure'
$script:EvidenceKind = 'myspeed-windows-cpu-readiness'
$script:Classification = 'windows-native-host-observation-nonqualifying'
$script:ManifestName = 'closure.json'
$script:MaximumSourceBytes = 262144
$script:MaximumManifestBytes = 8192
$script:MaximumEvidenceBytes = 262144
$script:MaximumAggregateBytes = 33554432
$script:MaximumDisassemblyBytes = 2097152
$script:ToolStreamBytes = 65536
$script:ProbeStreamBytes = 4096
$script:ToolDurationMilliseconds = 30000
$script:ProbeDurationMilliseconds = 10000
$script:WrapperCleanupMilliseconds = 5000
$script:WrapperBootstrapMilliseconds = 15000
$script:MaximumOperationCount = 64
$script:ExpectedOperationCount = 32
$script:CompilerEnvironmentFailureExitCode = 71
$script:FailureExitCode = 1
$script:PositiveDecimal = '^[1-9][0-9]{0,19}$'
$script:Sha40 = '^[a-f0-9]{40}$'
$script:Sha256 = '^[a-f0-9]{64}$'
$script:NoncePattern = '^[a-f0-9]{32}$'
$script:ImageVersionPattern = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
$script:RequiredFiles = @(
    'windows-cpu-floor-probe.c',
    'windows-cpu-readiness.ps1',
    'windows-cpu-readiness-controller.ps1',
    'windows-cpu-tool-child.ps1',
    'windows-cpu-file-identity.ps1',
    'media-job-launcher.ps1'
)
$script:Modes = @(
    [pscustomobject]@{name='cpuid';macro='PROBE_CPUID';arch='/arch:SSE2'},
    [pscustomobject]@{name='known-good';macro='PROBE_KNOWN_GOOD';arch='/arch:SSE2'},
    [pscustomobject]@{name='known-bad';macro='PROBE_KNOWN_BAD';arch='/arch:SSE2'},
    [pscustomobject]@{name='illegal';macro='PROBE_ILLEGAL';arch='/arch:SSE2'},
    [pscustomobject]@{name='sse42';macro='PROBE_SSE42';arch='/arch:SSE2'},
    [pscustomobject]@{name='popcnt';macro='PROBE_POPCNT';arch='/arch:SSE2'},
    [pscustomobject]@{name='avx';macro='PROBE_AVX';arch='/arch:AVX'},
    [pscustomobject]@{name='avx2';macro='PROBE_AVX2';arch='/arch:AVX2'}
)
$script:InstructionModes = @('cpuid','illegal','sse42','popcnt','avx','avx2')
$script:ExpectedProbeExit = [ordered]@{cpuid=0;'known-good'=0;'known-bad'=19;illegal=3221225501L;sse42=0;popcnt=0;avx=0;avx2=0}
$script:VsWhereArguments = @('-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property','installationPath','-format','value','-utf8')
$script:CompileArguments = @('/nologo','/TC','/c','/W4','/WX','/O2','/Oi','/GS','/guard:cf','/MT')
$script:LinkArguments = @('/NOLOGO','/INCREMENTAL:NO','/SUBSYSTEM:CONSOLE','/MACHINE:X64',
    '/DYNAMICBASE','/NXCOMPAT','/HIGHENTROPYVA','/GUARD:CF','/MANIFEST:NO')
$script:ControllerNative = $null
$script:ControllerState = $null

function Assert-MyspeedControllerString {
    param([object]$Value, [string]$Label)
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) { throw "$Label must be a nonempty string" }
    return [string]$Value
}

function Assert-MyspeedControllerBinding {
    param([string]$RunId,[string]$RunAttempt,[string]$EventSha,[string]$SourceSha,[string]$ExpectedNonce)
    if ($RunId -cnotmatch $script:PositiveDecimal -or $RunAttempt -cnotmatch $script:PositiveDecimal) {
        throw 'Run binding is invalid'
    }
    if ($EventSha -cnotmatch $script:Sha40 -or $SourceSha -cnotmatch $script:Sha40) {
        throw 'SHA binding is invalid'
    }
    if ($ExpectedNonce -cnotmatch $script:NoncePattern) { throw 'Nonce binding is invalid' }
}

function Assert-MyspeedControllerPath {
    param([object]$Value,[string]$Label)
    $path = Assert-MyspeedControllerString $Value $Label
    if ($path -cnotmatch '^[A-Za-z]:\\' -or $path.IndexOf([char]0) -ge 0 -or
        $path -match '[\x00-\x1f<>"|?*]' -or $path.Substring(2).Contains(':')) {
        throw "$Label must be a canonical absolute local path"
    }
    $canonical = [IO.Path]::GetFullPath($path)
    if (-not [string]::Equals($canonical.TrimEnd('\'), $path.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must be a canonical absolute local path"
    }
    return $canonical.TrimEnd('\')
}

function Get-MyspeedControllerSha256 {
    param([string]$Path)
    $stream = [IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
        finally { $algorithm.Dispose() }
    } finally { $stream.Dispose() }
}

function Write-MyspeedControllerCreateNewJson {
    param([string]$Path,[object]$Value,[int64]$MaximumBytes)
    $json = $Value | ConvertTo-Json -Compress -Depth 30
    $encoding = New-Object Text.UTF8Encoding($false,$true)
    $bytes = $encoding.GetBytes($json)
    if ($bytes.Length -le 0 -or $bytes.Length -gt $MaximumBytes) { throw 'JSON output exceeds its byte bound' }
    $stream = [IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
}

function Assert-MyspeedControllerExactKeys {
    param([object]$Value,[string[]]$Expected,[string]$Label)
    if ($null -eq $Value -or $Value -is [string]) { throw "$Label must be an object" }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $wanted = @($Expected | Sort-Object)
    if (($actual -join "`n") -cne ($wanted -join "`n")) { throw "$Label schema differs" }
}

function Assert-MyspeedControllerInteger {
    param([object]$Value,[string]$Label)
    if ($Value -isnot [int] -and $Value -isnot [long]) { throw "$Label must be an integer" }
    return [int64]$Value
}

function Read-MyspeedControllerJsonRecord {
    param([string]$Path,[int64]$MaximumBytes)
    $stream = [IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        $length=$stream.Length
        if ($length -le 0 -or $length -gt $MaximumBytes -or $length -gt [int]::MaxValue) { throw 'JSON input file is invalid' }
        $bytes=New-Object byte[] ([int]$length)
        $offset=0
        while ($offset -lt $bytes.Length) {
            $read=$stream.Read($bytes,$offset,$bytes.Length-$offset)
            if ($read -le 0) { throw 'JSON input ended early' }
            $offset+=$read
        }
        if ($stream.ReadByte() -ne -1 -or $stream.Length -ne $length) { throw 'JSON input changed while read' }
    } finally { $stream.Dispose() }
    $encoding = New-Object Text.UTF8Encoding($false,$true)
    $text = $encoding.GetString($bytes)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xfeff) { throw 'JSON input must not contain a byte-order mark' }
    $algorithm=[Security.Cryptography.SHA256]::Create()
    try {$sha=([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}
    finally {$algorithm.Dispose()}
    return [pscustomobject]@{value=($text | ConvertFrom-Json -ErrorAction Stop);bytes=[int64]$bytes.Length;sha256=$sha}
}

function Assert-MyspeedClosure {
    param([string]$Root,[string]$Path)
    Assert-MyspeedControllerBinding $ExpectedRunId $ExpectedRunAttempt $ExpectedEventSha $ExpectedSourceSha $Nonce
    $rootPath = Assert-MyspeedControllerPath $Root 'Closure root'
    $manifestPath = Assert-MyspeedControllerPath $Path 'Manifest path'
    if (-not [string]::Equals($manifestPath,[IO.Path]::Combine($rootPath,$script:ManifestName),
        [StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest path differs from closure root' }
    $actualNames = @([IO.Directory]::GetFileSystemEntries($rootPath) | ForEach-Object {
        [IO.Path]::GetFileName($_)
    } | Sort-Object)
    $expectedNames = @(@($script:RequiredFiles) + $script:ManifestName | Sort-Object)
    if (($actualNames -join "`n") -cne ($expectedNames -join "`n")) { throw 'Closure membership differs' }
    $manifestRecord = Read-MyspeedControllerJsonRecord $manifestPath $script:MaximumManifestBytes
    $manifest = $manifestRecord.value
    Assert-MyspeedControllerExactKeys $manifest @('schemaVersion','kind','expectedRunId','expectedRunAttempt',
        'expectedSourceSha','expectedEventSha','nonce','files') 'Closure manifest'
    if ((Assert-MyspeedControllerInteger $manifest.schemaVersion 'Closure schema version') -ne $script:SchemaVersion -or
        (Assert-MyspeedControllerString $manifest.kind 'Closure kind') -cne $script:ClosureKind) {
        throw 'Closure manifest header differs'
    }
    $bindings = [ordered]@{
        expectedRunId=$ExpectedRunId;expectedRunAttempt=$ExpectedRunAttempt;expectedSourceSha=$ExpectedSourceSha
        expectedEventSha=$ExpectedEventSha;nonce=$Nonce
    }
    foreach ($entry in $bindings.GetEnumerator()) {
        if ((Assert-MyspeedControllerString $manifest.($entry.Key) "Closure $($entry.Key)") -cne $entry.Value) {
            throw 'Closure manifest binding differs'
        }
    }
    if ($manifest.files -isnot [array] -or $manifest.files.Count -ne $script:RequiredFiles.Count) {
        throw 'Closure manifest file count differs'
    }
    $files = @()
    for ($index = 0; $index -lt $script:RequiredFiles.Count; $index++) {
        $entry = $manifest.files[$index]
        Assert-MyspeedControllerExactKeys $entry @('name','bytes','sha256') 'Closure file'
        $name = Assert-MyspeedControllerString $entry.name 'Closure file name'
        $bytes = Assert-MyspeedControllerInteger $entry.bytes 'Closure file bytes'
        $sha = Assert-MyspeedControllerString $entry.sha256 'Closure file hash'
        if ($name -cne $script:RequiredFiles[$index] -or $bytes -le 0 -or $bytes -gt $script:MaximumSourceBytes -or
            $sha -cnotmatch $script:Sha256) { throw 'Closure file record differs' }
        $member = [IO.Path]::Combine($rootPath,$name)
        $info = New-Object IO.FileInfo($member)
        if (-not $info.Exists -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            $info.Length -ne $bytes -or (Get-MyspeedControllerSha256 $member) -cne $sha) {
            throw "Closure file identity differs: $name"
        }
        $files += $entry
    }
    return [pscustomobject][ordered]@{accepted=$true;root=$rootPath;manifestPath=$manifestPath;manifest=$manifest
        manifestBytes=$manifestRecord.bytes;manifestSha256=$manifestRecord.sha256;files=$files}
}

function Invoke-MyspeedControllerModuleCommand {
    param([object]$Module,[string]$Command,[object[]]$Arguments=@())
    $call = [pscustomobject]@{name=$Command;arguments=$Arguments}
    return & $Module {
        param($request)
        $moduleArguments = [object[]]$request.arguments
        & $request.name @moduleArguments
    } $call
}

function Invoke-MyspeedTestModuleDispatch {
    $module = New-Module -Name 'MyspeedControllerDispatchTest' -ScriptBlock {
        function Get-MyspeedControllerPair {
            param([string]$First,[string]$Second)
            return [pscustomobject][ordered]@{first=$First;second=$Second}
        }
    }
    return Invoke-MyspeedControllerModuleCommand $module 'Get-MyspeedControllerPair' @('alpha','beta')
}

function New-MyspeedControllerModule {
    param([string]$Path,[string]$Name)
    return New-Module -Name $Name -ScriptBlock { param($sourcePath) . $sourcePath } -ArgumentList $Path
}

function New-MyspeedControllerOwnedRoot {
    param([string]$Path)
    $runnerTemp = Assert-MyspeedControllerPath $env:RUNNER_TEMP 'RUNNER_TEMP'
    $expected = [IO.Path]::Combine($runnerTemp,"myspeed-cpu-readiness-$Nonce")
    if (-not [string]::Equals($Path,$expected,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'Owned root differs from the exact nonce runner-temp root'
    }
    $cursor = New-Object IO.DirectoryInfo($runnerTemp)
    while ($null -ne $cursor) {
        if (-not $cursor.Exists -or ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Owned root ancestor is not a plain directory'
        }
        $cursor = $cursor.Parent
    }
    if ([IO.Directory]::Exists($Path) -or [IO.File]::Exists($Path)) { throw 'Nonce task root already exists' }
    [IO.Directory]::CreateDirectory($Path) | Out-Null
    return $Path
}

function Write-MyspeedControllerCreateNewText {
    param([string]$Path,[string]$Text,[Text.Encoding]$Encoding,[int64]$MaximumBytes)
    $bytes = $Encoding.GetBytes($Text)
    if ($bytes.Length -le 0 -or $bytes.Length -gt $MaximumBytes) { throw 'Text output exceeds its byte bound' }
    $stream = [IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true) } finally { $stream.Dispose() }
}

function ConvertFrom-MyspeedControllerUtf8 {
    param([string]$Base64,[int64]$MaximumBytes,[string]$Label)
    try { $bytes = [Convert]::FromBase64String($Base64) } catch { throw "$Label base64 is invalid" }
    if ($bytes.Length -gt $MaximumBytes) { throw "$Label exceeds its byte bound" }
    $encoding = New-Object Text.UTF8Encoding($false,$true)
    try { return $encoding.GetString($bytes) } catch { throw "$Label is not strict UTF-8" }
}

function Assert-MyspeedControllerIdentityEqual {
    param([object]$Before,[object]$After)
    foreach ($name in @('path','finalPath','volumeSerial','fileId','bytes','lastWriteFileTime','linkCount','sha256',
        'fileVersion','productVersion')) {
        if ($Before.$name -cne $After.$name) { throw "File identity drifted: $($Before.name)" }
    }
}

function Assert-MyspeedControllerFileIdentityUnchanged {
    param([object]$Identity,[string]$AllowedRoot,[int64]$MaximumBytes)
    $after = Get-MyspeedControllerFileIdentity $Identity.name $Identity.path $AllowedRoot $MaximumBytes $Identity.role
    Assert-MyspeedControllerIdentityEqual $Identity $after
}

function New-MyspeedPreflightCommand {
    param([string]$VcvarsPath)
    $vcvars = Invoke-MyspeedControllerModuleCommand $script:ControllerNative.core 'Test-MyspeedWindowsAbsolutePath' @($VcvarsPath,'vcvars path')
    $lines = New-Object 'System.Collections.Generic.List[string]'
    [void]$lines.Add('@echo off');[void]$lines.Add('setlocal DisableDelayedExpansion')
    foreach ($name in @('CL','_CL_','LINK','_LINK_')) {
        [void]$lines.Add("if defined $name exit /b $script:CompilerEnvironmentFailureExitCode")
    }
    [void]$lines.Add(('call "{0}" >nul' -f $vcvars));[void]$lines.Add('if errorlevel 1 exit /b %errorlevel%')
    foreach ($name in @('CL','_CL_','LINK','_LINK_')) {
        [void]$lines.Add("if defined $name exit /b $script:CompilerEnvironmentFailureExitCode")
        [void]$lines.Add(('set "{0}="' -f $name))
    }
    [void]$lines.Add('echo MYSPEED_ENV_BEGIN')
    foreach ($name in @('VCToolsVersion','VCToolsInstallDir','WindowsSdkDir','WindowsSDKVersion')) {
        [void]$lines.Add(('echo {0}=%{0}%' -f $name))
    }
    [void]$lines.Add('echo MYSPEED_ENV_END');[void]$lines.Add('exit /b 0')
    return (($lines -join "`r`n") + "`r`n")
}

function New-MyspeedClosureManifest {
    param([string]$Root,[string]$Path)
    Assert-MyspeedControllerBinding $ExpectedRunId $ExpectedRunAttempt $ExpectedEventSha $ExpectedSourceSha $Nonce
    $rootPath = Assert-MyspeedControllerPath $Root 'Closure root'
    $manifest = Assert-MyspeedControllerPath $Path 'Manifest path'
    $expectedManifest = [IO.Path]::Combine($rootPath,$script:ManifestName)
    if (-not [string]::Equals($manifest,$expectedManifest,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'Manifest path must be the exact closure manifest leaf'
    }
    if (-not [IO.Directory]::Exists($rootPath)) { throw 'Closure root is missing' }
    if ([IO.File]::Exists($manifest)) { throw 'Manifest already exists; create-new output is required' }
    $actualNames = @([IO.Directory]::GetFileSystemEntries($rootPath) | ForEach-Object { [IO.Path]::GetFileName($_) } | Sort-Object)
    $expectedNames = @($script:RequiredFiles | Sort-Object)
    if (($actualNames -join "`n") -cne ($expectedNames -join "`n")) { throw 'Closure membership differs' }
    $files = @()
    foreach ($name in $script:RequiredFiles) {
        $member = [IO.Path]::Combine($rootPath,$name)
        if (-not [IO.File]::Exists($member)) { throw "Closure member is not a file: $name" }
        $info = New-Object IO.FileInfo($member)
        if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            $info.Length -le 0 -or $info.Length -gt $script:MaximumSourceBytes) {
            throw "Closure member is invalid: $name"
        }
        $files += [pscustomobject][ordered]@{name=$name;bytes=[int64]$info.Length;sha256=(Get-MyspeedControllerSha256 $member)}
    }
    $value = [pscustomobject][ordered]@{
        schemaVersion=$script:SchemaVersion;kind=$script:ClosureKind;expectedRunId=$ExpectedRunId
        expectedRunAttempt=$ExpectedRunAttempt;expectedSourceSha=$ExpectedSourceSha;expectedEventSha=$ExpectedEventSha
        nonce=$Nonce;files=$files
    }
    Write-MyspeedControllerCreateNewJson $manifest $value $script:MaximumManifestBytes
    return $value
}

function Assert-MyspeedControllerHostedContext {
    Assert-MyspeedControllerBinding $ExpectedRunId $ExpectedRunAttempt $ExpectedEventSha $ExpectedSourceSha $Nonce
    $expected = [ordered]@{
        GITHUB_REPOSITORY=$script:Repository;GITHUB_ACTIONS='true';CI='true';RUNNER_OS='Windows';RUNNER_ARCH='X64'
        RUNNER_ENVIRONMENT='github-hosted';ImageOS=$script:ImageOS;GITHUB_RUN_ID=$ExpectedRunId
        GITHUB_RUN_ATTEMPT=$ExpectedRunAttempt;GITHUB_SHA=$ExpectedEventSha
    }
    foreach ($entry in $expected.GetEnumerator()) {
        $actual = [Environment]::GetEnvironmentVariable($entry.Key)
        if ($actual -cne $entry.Value) { throw "Hosted context $($entry.Key) differed" }
    }
    if ($env:ImageVersion -cnotmatch $script:ImageVersionPattern) { throw 'Hosted context ImageVersion is invalid' }
    foreach ($name in @('CL','_CL_','LINK','_LINK_')) {
        if (-not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($name))) {
            throw "Hosted context compiler environment $name is not empty"
        }
    }
}

function Get-MyspeedNativeControllerOperations {
    param([string]$Root)
    $corePath = [IO.Path]::Combine($Root,'windows-cpu-readiness.ps1')
    $identityPath = [IO.Path]::Combine($Root,'windows-cpu-file-identity.ps1')
    $launcherPath = [IO.Path]::Combine($Root,'media-job-launcher.ps1')
    $core = New-MyspeedControllerModule $corePath 'MyspeedCpuReadinessCore'
    $identity = New-MyspeedControllerModule $identityPath 'MyspeedCpuFileIdentity'
    $launcher = New-MyspeedControllerModule $launcherPath 'MyspeedCpuJobLauncher'
    $expected = [pscustomobject][ordered]@{
        expectedRunId=$ExpectedRunId;expectedRunAttempt=$ExpectedRunAttempt;expectedEventSha=$ExpectedEventSha
        expectedSourceSha=$ExpectedSourceSha;nonce=$Nonce
    }
    $identityOperations = Invoke-MyspeedControllerModuleCommand $identity 'New-MyspeedNativeFileIdentityOperations' @($expected)
    return [ordered]@{core=$core;identity=$identity;launcher=$launcher;identityOperations=$identityOperations}
}

function Get-MyspeedControllerFileIdentity {
    param([string]$Name,[string]$Path,[string]$AllowedRoot,[int64]$MaximumBytes,[string]$Role)
    $request = [pscustomobject][ordered]@{name=$Name;path=$Path;allowedRoot=$AllowedRoot;maximumBytes=$MaximumBytes;role=$Role}
    return Invoke-MyspeedControllerModuleCommand $script:ControllerNative.identity 'Get-MyspeedVerifiedFileIdentity' `
        @($request,$script:ControllerNative.identityOperations)
}

function Read-MyspeedControllerVerifiedFileBytes {
    param([string]$Name,[string]$Path,[string]$AllowedRoot,[int64]$MaximumBytes,[string]$Role)
    $request=[pscustomobject][ordered]@{name=$Name;path=$Path;allowedRoot=$AllowedRoot;maximumBytes=$MaximumBytes;role=$Role}
    $read=Invoke-MyspeedControllerModuleCommand $script:ControllerNative.identity 'Read-MyspeedVerifiedFileBytes' `
        @($request,$script:ControllerNative.identityOperations)
    try {$bytes=[Convert]::FromBase64String($read.bytesBase64)} catch {throw 'Verified file bytes are malformed'}
    if ($bytes.Length -le 0 -or $bytes.Length -gt $MaximumBytes -or
        [Convert]::ToBase64String($bytes) -cne $read.bytesBase64) {throw 'Verified file bytes are noncanonical or oversized'}
    return [pscustomobject]@{identity=$read.identity;bytes=$bytes}
}

function ConvertFrom-MyspeedControllerVerifiedJson {
    param([object]$Read,[string]$Label)
    $encoding=New-Object Text.UTF8Encoding($false,$true)
    try {$text=$encoding.GetString($Read.bytes)} catch {throw "$Label is not strict UTF-8"}
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xfeff) {throw "$Label contains a byte-order mark"}
    try {return $text | ConvertFrom-Json -ErrorAction Stop} catch {throw "$Label is malformed"}
}

function Assert-MyspeedControllerIdentitySet {
    param([object[]]$Files)
    $request = [pscustomobject]@{files=@($Files)}
    Invoke-MyspeedControllerModuleCommand $script:ControllerNative.identity 'Assert-MyspeedNoFileIdentityCollisions' @($request) | Out-Null
}

function New-MyspeedControllerOwnedTextFile {
    param([string]$Name,[string]$Path,[string]$Text,[Text.Encoding]$Encoding,[int64]$MaximumBytes)
    if ([IO.File]::Exists($Path)) { throw "Owned output already exists: $Name" }
    $parent = [IO.Path]::GetDirectoryName($Path)
    $observation = & $script:ControllerNative.identityOperations.GetPathObservation $parent
    $request = [pscustomobject][ordered]@{path=$Path;ownedRoot=$script:ControllerState.taskRoot;maximumBytes=$MaximumBytes
        leafExists=$false;pathObservation=$observation}
    Invoke-MyspeedControllerModuleCommand $script:ControllerNative.identity 'Assert-MyspeedOwnedCreateNewOutput' @($request) | Out-Null
    if ($script:ControllerState.Contains('ownedPaths') -and -not $script:ControllerState.ownedPaths.Add($Path)) {
        throw 'Owned output was already authorized'
    }
    Write-MyspeedControllerCreateNewText $Path $Text $Encoding $MaximumBytes
    return Get-MyspeedControllerFileIdentity $Name $Path $script:ControllerState.taskRoot $MaximumBytes 'generated-command'
}

function New-MyspeedControllerOwnedJsonFile {
    param([string]$Name,[string]$Path,[object]$Value,[int64]$MaximumBytes)
    if ([IO.File]::Exists($Path)) { throw "Owned output already exists: $Name" }
    $parent = [IO.Path]::GetDirectoryName($Path)
    $observation = & $script:ControllerNative.identityOperations.GetPathObservation $parent
    $request = [pscustomobject][ordered]@{path=$Path;ownedRoot=$script:ControllerState.taskRoot;maximumBytes=$MaximumBytes
        leafExists=$false;pathObservation=$observation}
    Invoke-MyspeedControllerModuleCommand $script:ControllerNative.identity 'Assert-MyspeedOwnedCreateNewOutput' @($request) | Out-Null
    if ($script:ControllerState.Contains('ownedPaths') -and -not $script:ControllerState.ownedPaths.Add($Path)) {
        throw 'Owned output was already authorized'
    }
    Write-MyspeedControllerCreateNewJson $Path $Value $MaximumBytes
    return Get-MyspeedControllerFileIdentity $Name $Path $script:ControllerState.taskRoot $MaximumBytes 'generated-command'
}

function Assert-MyspeedControllerOwnedOutput {
    param([string]$Path,[int64]$MaximumBytes)
    if ([IO.File]::Exists($Path)) { throw 'Owned output leaf already exists' }
    $parent = [IO.Path]::GetDirectoryName($Path)
    $observation = & $script:ControllerNative.identityOperations.GetPathObservation $parent
    $request = [pscustomobject][ordered]@{path=$Path;ownedRoot=$script:ControllerState.taskRoot;maximumBytes=$MaximumBytes
        leafExists=$false;pathObservation=$observation}
    Invoke-MyspeedControllerModuleCommand $script:ControllerNative.identity 'Assert-MyspeedOwnedCreateNewOutput' @($request) | Out-Null
    if ($script:ControllerState.Contains('ownedPaths') -and -not $script:ControllerState.ownedPaths.Add($Path)) {
        throw 'Owned output was already authorized'
    }
}

function Assert-MyspeedControllerChildEnvelope {
    param([object]$Request)
    Assert-MyspeedControllerExactKeys $Request @('isProbe','arguments','result') 'Child envelope request'
    if ($Request.isProbe -isnot [bool] -or $Request.arguments -isnot [array]) { throw 'Child envelope request types differ' }
    Assert-MyspeedControllerExactKeys $Request.result @('classification','bindings','errorMode') 'Child envelope result'
    if ($Request.result.classification -isnot [string] -or
        $Request.result.classification -cne $script:Classification) { throw 'Child classification differs' }
    Assert-MyspeedControllerExactKeys $Request.result.bindings @('arguments') 'Child envelope bindings'
    if ($Request.result.bindings.arguments -isnot [array] -or
        $Request.result.bindings.arguments.Count -ne $Request.arguments.Count) { throw 'Child argument count differs' }
    for ($index=0;$index -lt $Request.arguments.Count;$index++) {
        if ($Request.arguments[$index] -isnot [string] -or $Request.result.bindings.arguments[$index] -isnot [string] -or
            $Request.arguments[$index] -cne $Request.result.bindings.arguments[$index]) { throw 'Child argument vector differs' }
    }
    $mode=$Request.result.errorMode
    Assert-MyspeedControllerExactKeys $mode @('required','requiredFlags','before','during','after','restored') 'Child error mode'
    if ($mode.required -isnot [bool] -or $mode.restored -isnot [bool] -or -not $mode.restored -or
        $mode.required -ne $Request.isProbe) { throw 'Child error-mode booleans differ' }
    $flags=Assert-MyspeedControllerInteger $mode.requiredFlags 'Child error-mode flags'
    if ($Request.isProbe) {
        $before=Assert-MyspeedControllerInteger $mode.before 'Child prior error mode'
        $during=Assert-MyspeedControllerInteger $mode.during 'Child applied error mode'
        $after=Assert-MyspeedControllerInteger $mode.after 'Child restored error mode'
        if ($flags -ne 3 -or $before -lt 0 -or $before -gt [uint32]::MaxValue -or
            $during -ne ($before -bor 3) -or $after -ne $before) { throw 'Child probe error-mode proof differs' }
    } elseif ($flags -ne 0 -or $null -ne $mode.before -or $null -ne $mode.during -or $null -ne $mode.after) {
        throw 'Child tool error-mode proof differs'
    }
    return [pscustomobject]@{accepted=$true}
}

function Invoke-MyspeedBoundedNativeOperation {
    param([string]$OperationId,[object]$ToolIdentity,[string[]]$Arguments,[bool]$IsProbe,[int64]$ExpectedExitCode)
    if ($script:ControllerState.operationIds.Contains($OperationId) -or
        $script:ControllerState.operationIds.Count -ge $script:MaximumOperationCount) { throw 'Operation ID is duplicate or over limit' }
    [void]$script:ControllerState.operationIds.Add($OperationId)
    $allowedRoot = if ($script:ControllerState.toolRoots.Contains($ToolIdentity.name)) {
        $script:ControllerState.toolRoots[$ToolIdentity.name]
    } elseif ($ToolIdentity.role -ceq 'generated-command') { $script:ControllerState.taskRoot } else {
        throw "Tool root is unavailable: $($ToolIdentity.name)"
    }
    $toolAfter = Get-MyspeedControllerFileIdentity $ToolIdentity.name $ToolIdentity.path `
        $allowedRoot $script:MaximumAggregateBytes $ToolIdentity.role
    Assert-MyspeedControllerIdentityEqual $ToolIdentity $toolAfter
    Assert-MyspeedControllerFileIdentityUnchanged $script:ControllerState.powerShellIdentity `
        $script:ControllerState.toolRoots.powershell $script:MaximumAggregateBytes
    Assert-MyspeedControllerFileIdentityUnchanged $script:ControllerState.childIdentity `
        $script:ControllerState.closure.root $script:MaximumSourceBytes
    $requestPath = [IO.Path]::Combine($script:ControllerState.taskRoot,"$OperationId.request.json")
    $resultPath = [IO.Path]::Combine($script:ControllerState.taskRoot,"$OperationId.result.json")
    Assert-MyspeedControllerOwnedOutput $resultPath $script:MaximumEvidenceBytes
    $streamLimit = if ($IsProbe) { $script:ProbeStreamBytes } else { $script:ToolStreamBytes }
    $duration = if ($IsProbe) { $script:ProbeDurationMilliseconds } else { $script:ToolDurationMilliseconds }
    $request = [pscustomobject][ordered]@{
        schemaVersion=$script:SchemaVersion;expectedRunId=$ExpectedRunId;expectedRunAttempt=$ExpectedRunAttempt
        expectedEventSha=$ExpectedEventSha;expectedSourceSha=$ExpectedSourceSha;nonce=$Nonce;operationId=$OperationId
        toolPath=$ToolIdentity.path;toolSha256=$ToolIdentity.sha256;arguments=@($Arguments)
        workingDirectory=$script:ControllerState.taskRoot;streamLimitBytes=$streamLimit
        maximumDurationMilliseconds=$duration;isProbe=$IsProbe;resultPath=$resultPath
    }
    $requestIdentity = New-MyspeedControllerOwnedJsonFile "$OperationId-request" $requestPath $request $script:ToolStreamBytes
    $wrapperArguments = @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
        $script:ControllerState.childPath,'-Mode','InvokeHostedToolChild','-RequestPath',$requestPath,
        '-ExpectedRequestSha256',$requestIdentity.sha256)
    $outerDuration = $duration + $script:WrapperCleanupMilliseconds + $script:WrapperBootstrapMilliseconds
    $deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $outerDuration
    $launcher = Invoke-MyspeedControllerModuleCommand $script:ControllerNative.launcher 'Invoke-OwnedJobProcess' `
        @($script:ControllerState.powerShellIdentity.path,$wrapperArguments,$script:ControllerState.taskRoot,$deadline,$outerDuration)
    $resultRead=Read-MyspeedControllerVerifiedFileBytes "$OperationId-result" $resultPath `
        $script:ControllerState.taskRoot $script:MaximumEvidenceBytes 'generated-command'
    $resultIdentity=$resultRead.identity
    $result=ConvertFrom-MyspeedControllerVerifiedJson $resultRead 'Tool child result'
    Assert-MyspeedControllerExactKeys $result @('schemaVersion','status','classification','bindings','parentJobMembershipProven',
        'childExitProven','handlesClosedProven','errorMode','wrapper','stdoutBase64','stderrBase64','failures') 'Tool child result'
    if ((Assert-MyspeedControllerInteger $result.schemaVersion 'Tool child schema version') -ne $script:SchemaVersion -or
        (Assert-MyspeedControllerString $result.status 'Tool child status') -cne 'completed' -or
        $result.parentJobMembershipProven -isnot [bool] -or -not $result.parentJobMembershipProven -or
        $result.childExitProven -isnot [bool] -or -not $result.childExitProven -or
        $result.handlesClosedProven -isnot [bool] -or -not $result.handlesClosedProven) {
        throw "Tool child proof failed: $OperationId"
    }
    Assert-MyspeedControllerChildEnvelope ([pscustomobject][ordered]@{isProbe=$IsProbe;arguments=@($Arguments)
        result=[pscustomobject][ordered]@{classification=$result.classification
            bindings=[pscustomobject]@{arguments=$result.bindings.arguments};errorMode=$result.errorMode}}) | Out-Null
    Assert-MyspeedControllerExactKeys $result.bindings @('requestPath','requestSha256','expectedRunId','expectedRunAttempt',
        'expectedEventSha','expectedSourceSha','nonce','operationId','toolPath','toolSha256','toolSha256Before','toolSha256After',
        'arguments','workingDirectory','streamLimitBytes','maximumDurationMilliseconds','isProbe','resultPath') 'Tool child bindings'
    $expectedBindings = [ordered]@{requestPath=$requestPath;requestSha256=$requestIdentity.sha256;expectedRunId=$ExpectedRunId
        expectedRunAttempt=$ExpectedRunAttempt;expectedEventSha=$ExpectedEventSha;expectedSourceSha=$ExpectedSourceSha
        nonce=$Nonce;operationId=$OperationId;toolPath=$ToolIdentity.path;toolSha256=$ToolIdentity.sha256
        toolSha256Before=$ToolIdentity.sha256;toolSha256After=$ToolIdentity.sha256;workingDirectory=$script:ControllerState.taskRoot
        resultPath=$resultPath}
    foreach ($entry in $expectedBindings.GetEnumerator()) {
        if ($result.bindings.($entry.Key) -isnot [string] -or $result.bindings.($entry.Key) -cne $entry.Value) {
            throw "Tool child binding differed: $OperationId/$($entry.Key)"
        }
    }
    if ((Assert-MyspeedControllerInteger $result.bindings.streamLimitBytes 'Child stream limit') -ne $streamLimit -or
        (Assert-MyspeedControllerInteger $result.bindings.maximumDurationMilliseconds 'Child duration limit') -ne $duration -or
        $result.bindings.isProbe -isnot [bool] -or $result.bindings.isProbe -ne $IsProbe -or
        $result.failures -isnot [array] -or $result.failures.Count -ne 0) { throw "Tool child request proof differed: $OperationId" }
    $proof = [pscustomobject][ordered]@{streamLimitBytes=$streamLimit;maximumDurationMilliseconds=$duration
        expectedExitCode=$ExpectedExitCode;launcher=$launcher;wrapper=$result.wrapper}
    Invoke-MyspeedControllerModuleCommand $script:ControllerNative.core 'Assert-MyspeedOwnedOperation' @($proof) | Out-Null
    if ($result.stdoutBase64 -isnot [string] -or $result.stderrBase64 -isnot [string]) {
        throw 'Tool child stream encodings must be strings'
    }
    $stdout64 = [string]$result.stdoutBase64;$stderr64 = [string]$result.stderrBase64
    $stdout = ConvertFrom-MyspeedControllerUtf8 $stdout64 $streamLimit 'Tool child stdout'
    $stderr = ConvertFrom-MyspeedControllerUtf8 $stderr64 $streamLimit 'Tool child stderr'
    if ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($stdout)) -cne $stdout64 -or
        [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($stderr)) -cne $stderr64) { throw 'Tool child base64 is noncanonical' }
    $summary = [pscustomobject][ordered]@{operationId=$OperationId;tool=$ToolIdentity.name;toolSha256=$ToolIdentity.sha256
        arguments=@($Arguments);isProbe=$IsProbe;classification=$result.classification;launcher=$launcher;wrapper=$result.wrapper
        childProofs=[pscustomobject][ordered]@{parentJobMembershipProven=$result.parentJobMembershipProven
            childExitProven=$result.childExitProven;handlesClosedProven=$result.handlesClosedProven}
        errorMode=$result.errorMode;request=$requestIdentity;result=$resultIdentity}
    [void]$script:ControllerState.operations.Add($summary)
    return [pscustomobject][ordered]@{stdout=$stdout;stderr=$stderr;exitCode=$result.wrapper.exitCode;summary=$summary}
}

function Invoke-MyspeedVcCommandOperation {
    param([string]$OperationId,[object]$InnerTool,[string[]]$Arguments)
    $toolAfter = Get-MyspeedControllerFileIdentity $InnerTool.name $InnerTool.path `
        $script:ControllerState.toolRoots[$InnerTool.name] $script:MaximumAggregateBytes $InnerTool.role
    Assert-MyspeedControllerIdentityEqual $InnerTool $toolAfter
    Assert-MyspeedControllerFileIdentityUnchanged $script:ControllerState.tools.vcvars `
        $script:ControllerState.toolRoots.vcvars $script:MaximumAggregateBytes
    $commandRequest = [pscustomobject][ordered]@{vcvarsPath=$script:ControllerState.tools.vcvars.path
        toolPath=$InnerTool.path;arguments=@($Arguments)}
    $text = Invoke-MyspeedControllerModuleCommand $script:ControllerNative.core 'New-MyspeedVcCommandFile' @($commandRequest)
    $commandPath = [IO.Path]::Combine($script:ControllerState.taskRoot,"$OperationId.cmd")
    $commandIdentity = New-MyspeedControllerOwnedTextFile "$OperationId-command" $commandPath $text `
        (New-Object Text.ASCIIEncoding) $script:ToolStreamBytes
    $script:ControllerState.generated[$OperationId] = $commandIdentity
    $commandAfter = Get-MyspeedControllerFileIdentity $commandIdentity.name $commandPath `
        $script:ControllerState.taskRoot $script:ToolStreamBytes 'generated-command'
    Assert-MyspeedControllerIdentityEqual $commandIdentity $commandAfter
    return Invoke-MyspeedBoundedNativeOperation $OperationId $script:ControllerState.tools.cmd `
        @('/d','/s','/c',('"' + $commandPath + '"')) $false 0
}

function Initialize-MyspeedNativeControllerState {
    param([object]$Closure)
    $runnerTemp = Assert-MyspeedControllerPath $env:RUNNER_TEMP 'RUNNER_TEMP'
    $expectedClosure = [IO.Path]::Combine($runnerTemp,'windows-cpu-readiness-closure')
    if (-not [string]::Equals($Closure.root,$expectedClosure,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'Closure root differs from the exact runner-temp root'
    }
    $taskRoot = [IO.Path]::Combine($runnerTemp,"myspeed-cpu-readiness-$Nonce")
    $expectedEvidence = [IO.Path]::Combine($taskRoot,'result.json')
    if (-not [string]::Equals($EvidencePath,$expectedEvidence,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'Evidence path differs from the exact nonce task root'
    }
    if (-not [IO.Directory]::Exists($taskRoot)) { throw 'Nonce task root was not created by the guarded entry point' }
    $script:ControllerNative = Get-MyspeedNativeControllerOperations $Closure.root
    $closureIdentities = New-Object 'System.Collections.Generic.List[object]'
    for ($index = 0;$index -lt $script:RequiredFiles.Count;$index++) {
        $name = $script:RequiredFiles[$index]
        $identity = Get-MyspeedControllerFileIdentity ("closure-$index") ([IO.Path]::Combine($Closure.root,$name)) `
            $Closure.root $script:MaximumSourceBytes $(if ($name -ceq 'windows-cpu-floor-probe.c') {'source'} else {'closure'})
        if ($identity.bytes -ne $Closure.manifest.files[$index].bytes -or
            $identity.sha256 -cne $Closure.manifest.files[$index].sha256) { throw "Stable closure identity differs: $name" }
        [void]$closureIdentities.Add($identity)
        if ($name -ceq 'windows-cpu-floor-probe.c') { $sourceIdentity=$identity }
        if ($name -ceq 'windows-cpu-tool-child.ps1') { $childIdentity=$identity }
    }
    $manifestIdentity = Get-MyspeedControllerFileIdentity 'closure-manifest' $Closure.manifestPath `
        $Closure.root $script:MaximumManifestBytes 'closure'
    if ($manifestIdentity.bytes -ne $Closure.manifestBytes -or $manifestIdentity.sha256 -cne $Closure.manifestSha256) {
        throw 'Closure manifest changed after validation'
    }
    [void]$closureIdentities.Add($manifestIdentity)
    Assert-MyspeedControllerIdentitySet ([object[]]$closureIdentities)
    $state = [ordered]@{taskRoot=$taskRoot;closure=$Closure;closureIdentities=([object[]]$closureIdentities)
        operationIds=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        operations=(New-Object 'System.Collections.Generic.List[object]');generated=[ordered]@{};products=[ordered]@{}
        ownedPaths=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        toolRoots=[ordered]@{};tools=[ordered]@{};sourceIdentity=$sourceIdentity;childIdentity=$childIdentity
        childPath=[IO.Path]::Combine($Closure.root,'windows-cpu-tool-child.ps1')}
    $script:ControllerState = $state
    $rootObservation = & $script:ControllerNative.identityOperations.GetPathObservation $taskRoot
    Invoke-MyspeedControllerModuleCommand $script:ControllerNative.identity 'Assert-MyspeedPathObservation' `
        @($rootObservation,$taskRoot,'directory') | Out-Null
    $systemRoot = Assert-MyspeedControllerPath $env:SystemRoot 'SystemRoot'
    $programFilesX86 = Assert-MyspeedControllerPath ([Environment]::GetFolderPath('ProgramFilesX86')) 'ProgramFilesX86'
    $powershellPath = [IO.Path]::Combine($systemRoot,'System32\WindowsPowerShell\v1.0\powershell.exe')
    $cmdPath = [IO.Path]::Combine($systemRoot,'System32\cmd.exe')
    $vswherePath = [IO.Path]::Combine($programFilesX86,'Microsoft Visual Studio\Installer\vswhere.exe')
    $state.tools.powershell = Get-MyspeedControllerFileIdentity 'powershell' $powershellPath $systemRoot $script:MaximumAggregateBytes 'system-tool'
    $state.powerShellIdentity = $state.tools.powershell;$state.toolRoots.powershell=$systemRoot
    $state.tools.cmd = Get-MyspeedControllerFileIdentity 'cmd' $cmdPath $systemRoot $script:MaximumAggregateBytes 'system-tool'
    $state.toolRoots.cmd=$systemRoot
    $state.tools.vswhere = Get-MyspeedControllerFileIdentity 'vswhere' $vswherePath $programFilesX86 $script:MaximumAggregateBytes 'system-tool'
    $state.toolRoots.vswhere=$programFilesX86
    return $state
}

function Invoke-MyspeedDiscoverTools {
    $result = Invoke-MyspeedBoundedNativeOperation 'discover-vswhere' $script:ControllerState.tools.vswhere `
        $script:VsWhereArguments $false 0
    if ($result.stderr.Length -ne 0) { throw 'vswhere stderr is not empty' }
    $installation = Invoke-MyspeedControllerModuleCommand $script:ControllerNative.core `
        'ConvertFrom-MyspeedVsWhereOutput' @($result.stdout)
    $versionPath = [IO.Path]::Combine($installation,'VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt')
    $versionRead=Read-MyspeedControllerVerifiedFileBytes 'vc-version' $versionPath $installation 4096 'system-tool'
    $versionIdentity=$versionRead.identity;$versionBytes=$versionRead.bytes
    if ($versionBytes.Length -le 0 -or $versionBytes.Length -gt 4096 -or @($versionBytes | Where-Object { $_ -gt 127 }).Count -gt 0) {
        throw 'VC tools version file is not bounded ASCII'
    }
    $versionText = [Text.Encoding]::ASCII.GetString($versionBytes)
    if (($versionText -split "`r?`n").Count -gt 2) { throw 'VC tools version file contains extra records' }
    $version = $versionText.Trim()
    $paths = Invoke-MyspeedControllerModuleCommand $script:ControllerNative.core 'Resolve-MyspeedVcToolPaths' `
        @([pscustomobject]@{installationPath=$installation;vcToolsVersion=$version})
    foreach ($name in @('vcvars','cl','link','dumpbin')) {
        $identity = Get-MyspeedControllerFileIdentity $name $paths.$name $installation $script:MaximumAggregateBytes 'system-tool'
        $script:ControllerState.tools[$name]=$identity;$script:ControllerState.toolRoots[$name]=$installation
    }
    $script:ControllerState.toolRoots['vc-version']=$installation
    Assert-MyspeedControllerIdentitySet (@($script:ControllerState.tools.Values) + @($versionIdentity))
    return [pscustomobject]@{installationPath=$installation;vcToolsVersion=$version;versionFile=$versionIdentity
        tools=[pscustomobject]$script:ControllerState.tools}
}

function Invoke-MyspeedPreflight {
    $vcvars = $script:ControllerState.tools.vcvars
    $vcvarsAfter = Get-MyspeedControllerFileIdentity $vcvars.name $vcvars.path `
        $script:ControllerState.toolRoots.vcvars $script:MaximumAggregateBytes 'system-tool'
    Assert-MyspeedControllerIdentityEqual $vcvars $vcvarsAfter
    $operationId = 'environment-preflight'
    $commandPath = [IO.Path]::Combine($script:ControllerState.taskRoot,"$operationId.cmd")
    $commandIdentity = New-MyspeedControllerOwnedTextFile "$operationId-command" $commandPath `
        (New-MyspeedPreflightCommand $vcvars.path) (New-Object Text.ASCIIEncoding) $script:ToolStreamBytes
    $script:ControllerState.generated[$operationId]=$commandIdentity
    Assert-MyspeedControllerFileIdentityUnchanged $commandIdentity $script:ControllerState.taskRoot $script:ToolStreamBytes
    $result = Invoke-MyspeedBoundedNativeOperation $operationId $script:ControllerState.tools.cmd `
        @('/d','/s','/c',('"' + $commandPath + '"')) $false 0
    if ($result.stderr.Length -ne 0) { throw 'Preflight stderr is not empty' }
    $projection = Invoke-MyspeedControllerModuleCommand $script:ControllerNative.core `
        'ConvertFrom-MyspeedPreflightOutput' @($result.stdout)
    if ($projection.VCToolsVersion -cne $script:ControllerState.discovery.vcToolsVersion) {
        throw 'Preflight VC tools version differs'
    }
    $expectedVcRoot = [IO.Path]::Combine($script:ControllerState.discovery.installationPath,
        "VC\Tools\MSVC\$($script:ControllerState.discovery.vcToolsVersion)").TrimEnd('\')
    $actualVcRoot = (Invoke-MyspeedControllerModuleCommand $script:ControllerNative.core `
        'Test-MyspeedWindowsAbsolutePath' @($projection.VCToolsInstallDir.TrimEnd('\'),'VCToolsInstallDir')).TrimEnd('\')
    if (-not [string]::Equals($actualVcRoot,$expectedVcRoot,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'Preflight VC tools root differs'
    }
    $sdkRoot = Invoke-MyspeedControllerModuleCommand $script:ControllerNative.core `
        'Test-MyspeedWindowsAbsolutePath' @($projection.WindowsSdkDir.TrimEnd('\'),'WindowsSdkDir')
    if ($projection.WindowsSDKVersion -cnotmatch '^[0-9]+(?:\.[0-9]+){2,3}\\?$') {
        throw 'Preflight Windows SDK version is invalid'
    }
    return $projection
}

function Invoke-MyspeedBuildMatrix {
    $sourcePath = [IO.Path]::Combine($script:ControllerState.closure.root,'windows-cpu-floor-probe.c')
    $products = New-Object 'System.Collections.Generic.List[object]'
    foreach ($mode in $script:Modes) {
        $stem = $mode.name.Replace('-','_')
        $objectPath = [IO.Path]::Combine($script:ControllerState.taskRoot,"$stem.obj")
        $executablePath = [IO.Path]::Combine($script:ControllerState.taskRoot,"$stem.exe")
        Assert-MyspeedControllerOwnedOutput $objectPath $script:MaximumAggregateBytes
        Assert-MyspeedControllerFileIdentityUnchanged $script:ControllerState.sourceIdentity `
            $script:ControllerState.closure.root $script:MaximumSourceBytes
        $compile = @($script:CompileArguments) + @("/Fo$objectPath","/D$($mode.macro)",$sourcePath,$mode.arch)
        Invoke-MyspeedVcCommandOperation "compile-$($mode.name)" $script:ControllerState.tools.cl $compile | Out-Null
        $objectIdentity = Get-MyspeedControllerFileIdentity "$stem-object" $objectPath `
            $script:ControllerState.taskRoot $script:MaximumAggregateBytes 'generated-command'
        Assert-MyspeedControllerFileIdentityUnchanged $objectIdentity $script:ControllerState.taskRoot `
            $script:MaximumAggregateBytes
        Assert-MyspeedControllerOwnedOutput $executablePath $script:MaximumAggregateBytes
        $link = @($script:LinkArguments) + @("/OUT:$executablePath",$objectPath)
        Invoke-MyspeedVcCommandOperation "link-$($mode.name)" $script:ControllerState.tools.link $link | Out-Null
        $executableIdentity = Get-MyspeedControllerFileIdentity "$stem-executable" $executablePath `
            $script:ControllerState.taskRoot $script:MaximumAggregateBytes 'generated-command'
        $product = [pscustomobject][ordered]@{mode=$mode.name;macro=$mode.macro;architecture=$mode.arch
            compileArguments=$compile;linkArguments=$link;object=$objectIdentity;executable=$executableIdentity}
        $script:ControllerState.products[$mode.name]=$product;[void]$products.Add($product)
    }
    return [object[]]$products
}

function Invoke-MyspeedDisassemblyMatrix {
    $results = New-Object 'System.Collections.Generic.List[object]'
    foreach ($modeName in $script:InstructionModes) {
        $product = $script:ControllerState.products[$modeName]
        Assert-MyspeedControllerFileIdentityUnchanged $product.object $script:ControllerState.taskRoot `
            $script:MaximumAggregateBytes
        $stem = $modeName.Replace('-','_')
        $path = [IO.Path]::Combine($script:ControllerState.taskRoot,"$stem.disasm")
        Assert-MyspeedControllerOwnedOutput $path $script:MaximumDisassemblyBytes
        $arguments = @('/NOLOGO','/DISASM:BYTES',"/OUT:$path",$product.object.path)
        Invoke-MyspeedVcCommandOperation "disassemble-$modeName" $script:ControllerState.tools.dumpbin $arguments | Out-Null
        $read=Read-MyspeedControllerVerifiedFileBytes "$stem-disassembly" $path `
            $script:ControllerState.taskRoot $script:MaximumDisassemblyBytes 'generated-command'
        $identity=$read.identity;$bytes=$read.bytes
        $encoding = New-Object Text.UTF8Encoding($false,$true)
        try { $text = $encoding.GetString($bytes) } catch { throw "Disassembly is not strict UTF-8: $modeName" }
        $parsed = Invoke-MyspeedControllerModuleCommand $script:ControllerNative.core 'Assert-MyspeedDisassembly' @($modeName,$text)
        [void]$results.Add([pscustomobject][ordered]@{mode=$modeName;arguments=$arguments;file=$identity;contract=$parsed})
    }
    return [object[]]$results
}

function Assert-MyspeedAvxLaunchGate {
    param([object]$Cpuid)
    foreach ($name in @('sse42','popcnt','osxsave','avx','avx2')) {
        if ($Cpuid.features.$name -ne $true) { throw "Native host lacks required capability: $name" }
    }
    if ($Cpuid.xcr0 -isnot [string] -or
        ([Convert]::ToUInt64($Cpuid.xcr0.Substring(2),16) -band [uint64]6) -ne [uint64]6) {
        throw 'Native host XCR0 does not enable XMM and YMM state'
    }
}

function Invoke-MyspeedNativeCalibration {
    $runs = New-Object 'System.Collections.Generic.List[object]'
    $records = New-Object 'System.Collections.Generic.List[object]'
    foreach ($mode in $script:Modes) {
        if ($mode.name -ceq 'avx') { Assert-MyspeedAvxLaunchGate $script:ControllerState.cpuid }
        $product = $script:ControllerState.products[$mode.name]
        $exeAfter = Get-MyspeedControllerFileIdentity $product.executable.name $product.executable.path `
            $script:ControllerState.taskRoot $script:MaximumAggregateBytes 'generated-command'
        Assert-MyspeedControllerIdentityEqual $product.executable $exeAfter
        $operation = Invoke-MyspeedBoundedNativeOperation "probe-$($mode.name)" $product.executable @() $true `
            $script:ExpectedProbeExit[$mode.name]
        if ($mode.name -ceq 'cpuid') {
            $script:ControllerState.cpuid = Invoke-MyspeedControllerModuleCommand $script:ControllerNative.core `
                'ConvertFrom-MyspeedProbeJson' @('cpuid',$operation.stdout)
            Assert-MyspeedAvxLaunchGate $script:ControllerState.cpuid
        }
        [void]$runs.Add([pscustomobject][ordered]@{mode=$mode.name;exitCode=$operation.exitCode
            stdout=$operation.stdout;stderr=$operation.stderr})
        [void]$records.Add([pscustomobject][ordered]@{mode=$mode.name;exitCode=$operation.exitCode
            stdout=$operation.stdout;stderr=$operation.stderr;operation=$operation.summary})
    }
    $assessmentInput = [pscustomobject][ordered]@{schemaVersion=$script:SchemaVersion
        kind='myspeed-windows-native-calibration-input';runs=([object[]]$runs)}
    $assessment = Invoke-MyspeedControllerModuleCommand $script:ControllerNative.core `
        'Test-MyspeedNativeCalibration' @($assessmentInput)
    if ($assessment.calibrationPassed -ne $true) { throw ('Native calibration differed: ' + ($assessment.reasons -join ',')) }
    return [pscustomobject][ordered]@{calibrationPassed=$true;assessment=$assessment;runs=([object[]]$records)}
}

function Get-MyspeedExpectedOperationIds {
    $ids=New-Object 'System.Collections.Generic.List[string]'
    [void]$ids.Add('discover-vswhere');[void]$ids.Add('environment-preflight')
    foreach($mode in $script:Modes){[void]$ids.Add("compile-$($mode.name)");[void]$ids.Add("link-$($mode.name)")}
    foreach($mode in $script:InstructionModes){[void]$ids.Add("disassemble-$mode")}
    foreach($mode in $script:Modes){[void]$ids.Add("probe-$($mode.name)")}
    return [string[]]$ids
}

function Assert-MyspeedAggregateEvidenceBound {
    param([string]$Root)
    $entries = @([IO.Directory]::GetFileSystemEntries($Root))
    if ($entries.Count -gt 256) { throw 'Evidence file count exceeds its bound' }
    $total = [int64]0
    $fileCount = 0
    foreach ($path in $entries) {
        $info = New-Object IO.FileInfo($path)
        if ([IO.Directory]::Exists($path) -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Evidence contains a directory or reparse point'
        }
        if ($script:ControllerState.Contains('ownedPaths') -and -not $script:ControllerState.ownedPaths.Contains($path)) {
            throw 'Evidence contains an unowned file'
        }
        $fileCount++
        $total += $info.Length
        if ($total -gt $script:MaximumAggregateBytes) { throw 'Aggregate evidence exceeds its byte bound' }
    }
    return [pscustomobject]@{files=$fileCount;bytes=$total;accepted=$true}
}

function Complete-MyspeedNativeCleanup {
    $hasOperations = $script:ControllerState.Contains('operations')
    $operationCount = if ($hasOperations) { $script:ControllerState.operations.Count } else { 0 }
    $aggregate = Assert-MyspeedAggregateEvidenceBound $script:ControllerState.taskRoot
    $expected=Get-MyspeedExpectedOperationIds
    $actual=if($hasOperations){[string[]]@($script:ControllerState.operations|ForEach-Object{$_.operationId})}else{@()}
    $ordered=($actual -join "`n") -ceq ($expected -join "`n")
    return [pscustomobject][ordered]@{allOperationProofsPassed=($operationCount -eq $script:ExpectedOperationCount -and $ordered)
        operationCount=$operationCount;aggregate=$aggregate}
}

function Invoke-MyspeedInjectedAggregate {
    param([object]$Request)
    Assert-MyspeedControllerExactKeys $Request @('root','ownedPaths') 'Injected aggregate'
    $root=Assert-MyspeedControllerPath $Request.root 'Injected aggregate root'
    if ($Request.ownedPaths -isnot [array]) {throw 'Injected aggregate paths must be an array'}
    $owned=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($path in $Request.ownedPaths) {
        $validated=Assert-MyspeedControllerPath $path 'Injected aggregate owned path'
        if (-not $owned.Add($validated)) {throw 'Injected aggregate path is duplicated'}
    }
    $script:ControllerState=[ordered]@{taskRoot=$root;ownedPaths=$owned}
    return Assert-MyspeedAggregateEvidenceBound $root
}

function Invoke-MyspeedNativePhaseSequence {
    param([object]$Closure,[System.Collections.IDictionary]$Operations)
    $failures = New-Object 'System.Collections.Generic.List[string]'
    $observations = [ordered]@{}
    $calibrationPassed = $false
    try {
        $state = Invoke-MyspeedControllerOperation $Operations 'Initialize' @($Closure)
        $observations.closureFiles=$state.closureIdentities
        $observations.discovery=Invoke-MyspeedControllerOperation $Operations 'DiscoverTools'
        $observations.preflight=Invoke-MyspeedControllerOperation $Operations 'Preflight'
        $observations.build=Invoke-MyspeedControllerOperation $Operations 'Build'
        $observations.disassembly=Invoke-MyspeedControllerOperation $Operations 'Disassemble'
        $observations.calibration=Invoke-MyspeedControllerOperation $Operations 'Calibrate'
        $calibrationPassed=$observations.calibration.calibrationPassed -eq $true
        if (-not $calibrationPassed) { [void]$failures.Add('Native calibration did not pass') }
    } catch { [void]$failures.Add($_.Exception.Message) }
    finally {
        try {
            $hasOperations = $null -ne $script:ControllerState -and $script:ControllerState.Contains('operations')
            $observations.operations=if ($hasOperations) { [object[]]$script:ControllerState.operations } else { @() }
            $observations.cleanup=Invoke-MyspeedControllerOperation $Operations 'Cleanup'
            if ($failures.Count -gt 0 -or -not $calibrationPassed) {
                $observations.cleanup.allOperationProofsPassed=$false
            }
            if ($calibrationPassed -and (-not $observations.cleanup.allOperationProofsPassed -or
                $observations.cleanup.operationCount -ne $script:ExpectedOperationCount)) {
                [void]$failures.Add('Completed operation cleanup proof differs')
            }
        } catch { [void]$failures.Add("Cleanup failed: $($_.Exception.Message)") }
    }
    return [pscustomobject][ordered]@{calibrationPassed=($calibrationPassed -and $failures.Count -eq 0)
        failures=([string[]]$failures);observations=[pscustomobject]$observations}
}

function Invoke-MyspeedNativeController {
    param([object]$Closure)
    $operations = [ordered]@{
        Initialize={param($value) Initialize-MyspeedNativeControllerState $value}
        DiscoverTools={
            $script:ControllerState.discovery=Invoke-MyspeedDiscoverTools
            return $script:ControllerState.discovery
        }
        Preflight={Invoke-MyspeedPreflight};Build={Invoke-MyspeedBuildMatrix}
        Disassemble={Invoke-MyspeedDisassemblyMatrix};Calibrate={Invoke-MyspeedNativeCalibration}
        Cleanup={Complete-MyspeedNativeCleanup}
    }
    $phase = Invoke-MyspeedNativePhaseSequence $Closure $operations
    $passed = $phase.calibrationPassed -and $phase.failures.Count -eq 0
    $evidence = [pscustomobject][ordered]@{schemaVersion=$script:SchemaVersion;kind=$script:EvidenceKind
        status=if($passed){'completed'}else{'failed'};qualifying=$false;calibrationPassed=$passed
        classification=$script:Classification;sourceSha=$ExpectedSourceSha;eventSha=$ExpectedEventSha
        runId=$ExpectedRunId;runAttempt=$ExpectedRunAttempt;nonce=$Nonce;imageVersion=$env:ImageVersion
        failures=@($phase.failures);observations=$phase.observations}
    try { Write-MyspeedControllerCreateNewJson $EvidencePath $evidence $script:MaximumEvidenceBytes }
    catch { throw ('Evidence write failed: ' + $_.Exception.Message + '; primary=' + ($phase.failures -join '; ')) }
    return $evidence
}

function Invoke-MyspeedInjectedNativeLifecycle {
    param([object]$Request)
    Assert-MyspeedControllerExactKeys $Request @('failAt') 'Injected native lifecycle'
    if ($null -ne $Request.failAt -and $Request.failAt -isnot [string]) { throw 'Injected failure point is invalid' }
    $failAt=$Request.failAt
    $expectedOperationCount=$script:ExpectedOperationCount
    $events=New-Object 'System.Collections.Generic.List[string]'
    $step={
        param([string]$Name)
        [void]$events.Add($Name)
        if ($failAt -ceq $Name) { throw "Synthetic $Name failure" }
    }.GetNewClosure()
    $script:ControllerState=[ordered]@{operations=(New-Object 'System.Collections.Generic.List[object]')}
    $operations=[ordered]@{
        Initialize={param($unused)& $step 'initialize';[pscustomobject]@{closureIdentities=@()}}.GetNewClosure()
        DiscoverTools={& $step 'discover-tools';[pscustomobject]@{accepted=$true}}.GetNewClosure()
        Preflight={& $step 'preflight';[pscustomobject]@{accepted=$true}}.GetNewClosure()
        Build={& $step 'build';@([pscustomobject]@{accepted=$true})}.GetNewClosure()
        Disassemble={& $step 'disassemble';@([pscustomobject]@{accepted=$true})}.GetNewClosure()
        Calibrate={& $step 'calibrate';[pscustomobject]@{calibrationPassed=$true}}.GetNewClosure()
        Cleanup={& $step 'cleanup';[pscustomobject]@{allOperationProofsPassed=$true;operationCount=$expectedOperationCount}}.GetNewClosure()
    }
    $result=Invoke-MyspeedNativePhaseSequence ([pscustomobject]@{}) $operations
    return [pscustomobject][ordered]@{calibrationPassed=$result.calibrationPassed;failures=$result.failures;events=([string[]]$events)}
}

function Invoke-MyspeedControllerOperation {
    param([System.Collections.IDictionary]$Operations,[string]$Name,[object[]]$Arguments=@())
    if (-not $Operations.Contains($Name) -or $Operations[$Name] -isnot [scriptblock]) {
        throw "Controller operation is missing: $Name"
    }
    return & $Operations[$Name] @Arguments
}

function Invoke-MyspeedControllerCore {
    param([object]$Bindings,[System.Collections.IDictionary]$Operations)
    $failures = New-Object 'System.Collections.Generic.List[string]'
    $calibrationPassed = $false
    $observations = [ordered]@{}
    try {
        foreach ($step in @('ValidateClosure','ValidateInputs','DiscoverTools','Preflight','Build','Disassemble')) {
            $observations[$step] = Invoke-MyspeedControllerOperation $Operations $step @($observations)
        }
        $calibration = Invoke-MyspeedControllerOperation $Operations 'Calibrate' @($observations)
        $observations.Calibrate = $calibration
        $calibrationPassed = $calibration.calibrationPassed -eq $true
        if (-not $calibrationPassed) { [void]$failures.Add('Native calibration did not pass') }
    } catch {
        [void]$failures.Add($_.Exception.Message)
    } finally {
        try { $observations.Cleanup = Invoke-MyspeedControllerOperation $Operations 'Cleanup' @($observations) }
        catch { [void]$failures.Add("Cleanup failed: $($_.Exception.Message)") }
    }
    $evidence = [pscustomobject][ordered]@{
        schemaVersion=$script:SchemaVersion;kind=$script:EvidenceKind
        status=if ($failures.Count -eq 0 -and $calibrationPassed) { 'completed' } else { 'failed' }
        qualifying=$false;calibrationPassed=($failures.Count -eq 0 -and $calibrationPassed)
        classification=$script:Classification;sourceSha=$Bindings.sourceSha;eventSha=$Bindings.eventSha
        runId=$Bindings.runId;runAttempt=$Bindings.runAttempt;nonce=$Bindings.nonce
        failures=@($failures);observations=[pscustomobject]$observations
    }
    try { Invoke-MyspeedControllerOperation $Operations 'WriteEvidence' @($evidence) | Out-Null }
    catch {
        [void]$failures.Add("Evidence write failed: $($_.Exception.Message)")
        $evidence.status = 'failed'
        $evidence.calibrationPassed = $false
        $evidence.failures = @($failures)
    }
    return $evidence
}

function Invoke-MyspeedInjectedLifecycle {
    param([object]$Request)
    $properties = @($Request.PSObject.Properties.Name)
    if (($properties -join "`n") -cne 'failAt') { throw 'Injected lifecycle schema differs' }
    if ($null -ne $Request.failAt -and $Request.failAt -isnot [string]) { throw 'Injected failure point is invalid' }
    $failAt = $Request.failAt
    $events = New-Object 'System.Collections.Generic.List[string]'
    $operation = {
        param([string]$eventName,[string]$failureName)
        [void]$events.Add($eventName)
        if ($failAt -ceq $failureName) { throw "Synthetic $failureName failure" }
        return [pscustomobject]@{accepted=$true}
    }.GetNewClosure()
    $operations = [ordered]@{
        ValidateClosure={ & $operation 'validate-closure' 'validate-closure' }.GetNewClosure()
        ValidateInputs={
            & $operation 'validate-inputs' $(if ($failAt -ceq 'identity-drift') { 'identity-drift' } else { 'validate-inputs' })
        }.GetNewClosure()
        DiscoverTools={ & $operation 'discover-tools' 'discover-tools' }.GetNewClosure()
        Preflight={ & $operation 'preflight' 'preflight' }.GetNewClosure()
        Build={ & $operation 'build' $(if ($failAt -ceq 'overflow') { 'overflow' } else { 'build' }) }.GetNewClosure()
        Disassemble={ & $operation 'disassemble' 'disassemble' }.GetNewClosure()
        Calibrate={
            & $operation 'calibrate' 'calibrate' | Out-Null
            [pscustomobject]@{calibrationPassed=$true}
        }.GetNewClosure()
        Cleanup={ & $operation 'cleanup' 'cleanup' }.GetNewClosure()
        WriteEvidence={
            [void]$events.Add('write-evidence')
            if ($failAt -in @('write-evidence','result-collision')) { throw "Synthetic $failAt failure" }
        }.GetNewClosure()
    }
    $bindings = [pscustomobject]@{sourceSha=('2' * 40);eventSha=('1' * 40);runId='123456789';runAttempt='2';nonce=('3' * 32)}
    $result = Invoke-MyspeedControllerCore $bindings $operations
    $result | Add-Member -NotePropertyName events -NotePropertyValue @($events)
    return $result
}

function Invoke-MyspeedHostedReadiness {
    Assert-MyspeedControllerHostedContext
    $root = Assert-MyspeedControllerPath $ClosureRoot 'Closure root'
    $manifest = Assert-MyspeedControllerPath $ManifestPath 'Manifest path'
    [void](Assert-MyspeedControllerPath $EvidencePath 'Evidence path')
    $expectedManifest = [IO.Path]::Combine($root,$script:ManifestName)
    if (-not [string]::Equals($manifest,$expectedManifest,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'Manifest path differs from closure root'
    }
    $closure = Assert-MyspeedClosure $root $manifest
    $taskRoot = [IO.Path]::GetDirectoryName($EvidencePath)
    [void](New-MyspeedControllerOwnedRoot $taskRoot)
    $script:ControllerState=[ordered]@{taskRoot=$taskRoot}
    $result = Invoke-MyspeedNativeController $closure
    $result | ConvertTo-Json -Compress -Depth 30
    if ($result.status -cne 'completed' -or $result.calibrationPassed -ne $true) { exit $script:FailureExitCode }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        switch ($Mode) {
            'Library' { }
            'EmitClosureManifest' { New-MyspeedClosureManifest $ClosureRoot $ManifestPath | ConvertTo-Json -Compress -Depth 20 }
            'TestValidateClosure' { Assert-MyspeedClosure $ClosureRoot $ManifestPath | ConvertTo-Json -Compress -Depth 20 }
            'TestModuleDispatch' { Invoke-MyspeedTestModuleDispatch | ConvertTo-Json -Compress }
            'TestOperationPlan' { [pscustomobject]@{operationIds=(Get-MyspeedExpectedOperationIds)} | ConvertTo-Json -Compress }
            'TestChildEnvelope' { Assert-MyspeedControllerChildEnvelope ($InputJson | ConvertFrom-Json) | ConvertTo-Json -Compress }
            'TestAggregate' { Invoke-MyspeedInjectedAggregate ($InputJson | ConvertFrom-Json) | ConvertTo-Json -Compress }
            'TestNativeLifecycle' { Invoke-MyspeedInjectedNativeLifecycle ($InputJson | ConvertFrom-Json) | ConvertTo-Json -Compress -Depth 20 }
            'TestLifecycle' { Invoke-MyspeedInjectedLifecycle ($InputJson | ConvertFrom-Json) | ConvertTo-Json -Compress -Depth 30 }
            'InvokeHostedReadiness' { Invoke-MyspeedHostedReadiness }
        }
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
}
