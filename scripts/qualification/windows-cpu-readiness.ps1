[CmdletBinding()]
param(
    [ValidateSet('Library','GetContract','AssertContext','ValidateManifest','RenderCommand',
        'ResolveToolPaths','ParseVsWhere','ParsePreflight','ConvertExit','CheckDisassembly','ValidateOperation',
        'ParseProbe','AssessNativeCalibration')]
    [string]$Mode = 'Library',
    [string]$InputJson = '{}'
)

# Deterministic CPU-readiness validation contract. Native execution belongs only to
# the separately guarded readiness controller in the sealed closure.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:SchemaVersion = 1
$script:Repository = 'i7Gamer/MySpeed'
$script:ImageOS = 'win25-vs2026'
$script:Classification = 'windows-native-host-observation-nonqualifying'
$script:ClosureKind = 'myspeed-windows-cpu-readiness-closure'
$script:PositiveDecimal = '^[1-9][0-9]{0,19}$'
$script:Sha40 = '^[a-f0-9]{40}$'
$script:Sha256 = '^[a-f0-9]{64}$'
$script:Nonce = '^[a-f0-9]{32}$'
$script:ImageVersion = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
$script:VcVersion = '^[0-9]+(?:\.[0-9]+){2,3}$'
$script:ToolTimeoutSeconds = 30
$script:ProbeTimeoutSeconds = 10
$script:ToolStreamLimitBytes = 65536
$script:ProbeStreamLimitBytes = 4096
$script:DisassemblyFileLimitBytes = 2097152
$script:ResultJsonLimitBytes = 262144
$script:AggregateArtifactLimitBytes = 33554432
$script:CleanupSeconds = 5
$script:MaximumManifestFileBytes = $script:ResultJsonLimitBytes
$script:MaximumCommandArgumentCount = 64
$script:CompilerEnvironmentFailureExitCode = 71
$script:Unsigned32Modulus = 4294967296L
$script:ControlCharacterMinimum = 0
$script:ControlCharacterMaximum = 31
$script:WindowsPowerShellRelativePath = 'System32\WindowsPowerShell\v1.0\powershell.exe'
$script:MaximumOperationMilliseconds = 30000
$script:MaximumWindowsProcessId = [uint32]::MaxValue
$script:CrLfLength = 2
$script:LfLength = 1
$script:IllegalInstructionExitCode = 3221225501L
$script:Xcr0AvxMask = [uint64]6
$script:CalibrationInputKind = 'myspeed-windows-native-calibration-input'
$script:HexRegister = '^0x[a-f0-9]{8}$'
$script:HexXcr0 = '^0x[a-f0-9]{16}$'
$script:JsonIntegerTypeCodes = @(
    [TypeCode]::SByte, [TypeCode]::Byte, [TypeCode]::Int16, [TypeCode]::UInt16,
    [TypeCode]::Int32, [TypeCode]::UInt32, [TypeCode]::Int64, [TypeCode]::UInt64
)
$script:CompilerInjectionNames = @('CL','_CL_','LINK','_LINK_')
$script:RequiredClosureFiles = @(
    'windows-cpu-floor-probe.c',
    'windows-cpu-readiness.ps1',
    'windows-cpu-readiness-controller.ps1',
    'windows-cpu-tool-child.ps1',
    'windows-cpu-file-identity.ps1',
    'media-job-launcher.ps1'
)
$script:ModeTable = @(
    [pscustomobject]@{ name='cpuid'; macro='PROBE_CPUID'; architecture='/arch:SSE2' },
    [pscustomobject]@{ name='known-good'; macro='PROBE_KNOWN_GOOD'; architecture='/arch:SSE2' },
    [pscustomobject]@{ name='known-bad'; macro='PROBE_KNOWN_BAD'; architecture='/arch:SSE2' },
    [pscustomobject]@{ name='illegal'; macro='PROBE_ILLEGAL'; architecture='/arch:SSE2' },
    [pscustomobject]@{ name='sse42'; macro='PROBE_SSE42'; architecture='/arch:SSE2' },
    [pscustomobject]@{ name='popcnt'; macro='PROBE_POPCNT'; architecture='/arch:SSE2' },
    [pscustomobject]@{ name='avx'; macro='PROBE_AVX'; architecture='/arch:AVX' },
    [pscustomobject]@{ name='avx2'; macro='PROBE_AVX2'; architecture='/arch:AVX2' }
)
$script:FeatureBits = [ordered]@{ sse42=20; popcnt=23; osxsave=27; avx=28; avx2=5 }
$script:ControlTable = [ordered]@{
    'known-good'=[pscustomobject]@{ result=42L; exitCode=0L }
    'known-bad'=[pscustomobject]@{ result=13L; exitCode=19L }
    'sse42'=[pscustomobject]@{ result=2276049685L; exitCode=0L }
    'popcnt'=[pscustomobject]@{ result=32L; exitCode=0L }
    'avx'=[pscustomobject]@{ result=72L; exitCode=0L }
    'avx2'=[pscustomobject]@{ result=72L; exitCode=0L }
}
$script:DisassemblyContract = [ordered]@{
    cpuid = @('cpuid','xgetbv')
    illegal = @('ud2')
    sse42 = @('crc32')
    popcnt = @('popcnt')
    avx = @('vaddps')
    avx2 = @('vpaddd')
}
$script:DisassemblySymbols = @{
    cpuid='main'; illegal='main'; sse42='run_sse42'; popcnt='run_popcnt';
    avx='run_avx'; avx2='run_avx2'
}

function Get-MyspeedObjectKeys {
    param([object]$Value)
    if ($null -eq $Value -or $Value -is [string]) {
        throw 'Value must be an object'
    }
    return @($Value.PSObject.Properties.Name)
}

function Assert-MyspeedExactKeys {
    param([object]$Value, [string[]]$Expected, [string]$Label)
    $actual = @(Get-MyspeedObjectKeys $Value | Sort-Object)
    $wanted = @($Expected | Sort-Object)
    if (($actual -join "`n") -cne ($wanted -join "`n")) {
        throw "$Label schema differs (actual=$($actual -join ',')); expected=$($wanted -join ',')"
    }
}

function Get-MyspeedProperty {
    param([object]$Value, [string]$Name)
    $property = $Value.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Assert-MyspeedJsonString {
    param([object]$Value, [string]$Label)
    if ($Value -isnot [string]) { throw "$Label must be a JSON string" }
    return [string]$Value
}

function Assert-MyspeedJsonBoolean {
    param([object]$Value, [string]$Label)
    if ($Value -isnot [bool]) { throw "$Label must be a JSON boolean" }
    return [bool]$Value
}

function Assert-MyspeedJsonInteger {
    param([object]$Value, [string]$Label)
    if ($null -eq $Value -or [Type]::GetTypeCode($Value.GetType()) -notin $script:JsonIntegerTypeCodes) {
        throw "$Label must be a JSON integer"
    }
    try {
        return [int64]$Value
    } catch {
        throw "$Label must fit a signed 64-bit integer"
    }
}

function Assert-MyspeedCompilerEnvironment {
    param([object]$Environment)
    foreach ($name in $script:CompilerInjectionNames) {
        $value = Get-MyspeedProperty $Environment $name
        if ($null -ne $value) {
            $value = Assert-MyspeedJsonString $value "Compiler environment $name"
        }
        if ($null -ne $value -and $value -cne '') {
            throw "Compiler environment injection $name is not allowed"
        }
    }
}

function Assert-MyspeedHostedContext {
    param([object]$Request)
    Assert-MyspeedExactKeys $Request @('environment','expectedRunId','expectedRunAttempt',
        'expectedEventSha','expectedSourceSha','nonce') 'Context input'
    $environment = $Request.environment
    if ($null -eq $environment) { throw 'Hosted context environment is missing' }
    $exact = [ordered]@{
        GITHUB_REPOSITORY=$script:Repository; GITHUB_ACTIONS='true'; CI='true';
        RUNNER_OS='Windows'; RUNNER_ARCH='X64'; RUNNER_ENVIRONMENT='github-hosted';
        ImageOS=$script:ImageOS
    }
    foreach ($entry in $exact.GetEnumerator()) {
        $actual = Assert-MyspeedJsonString (Get-MyspeedProperty $environment $entry.Key) "Hosted context $($entry.Key)"
        if ($actual -cne [string]$entry.Value) {
            throw "Hosted context $($entry.Key) differed"
        }
    }
    $imageVersion = Assert-MyspeedJsonString (Get-MyspeedProperty $environment 'ImageVersion') 'Hosted context ImageVersion'
    if ($imageVersion -cnotmatch $script:ImageVersion) {
        throw 'Hosted context ImageVersion is invalid'
    }
    foreach ($name in @('expectedRunId','expectedRunAttempt')) {
        $expected = Assert-MyspeedJsonString $Request.$name "Hosted context $name"
        if ($expected -cnotmatch $script:PositiveDecimal) { throw "Hosted context $name is invalid" }
    }
    $actualRunId = Assert-MyspeedJsonString (Get-MyspeedProperty $environment 'GITHUB_RUN_ID') 'Hosted context GITHUB_RUN_ID'
    if ($actualRunId -cne $Request.expectedRunId) {
        throw 'Hosted context run ID differed'
    }
    $actualRunAttempt = Assert-MyspeedJsonString (Get-MyspeedProperty $environment 'GITHUB_RUN_ATTEMPT') 'Hosted context GITHUB_RUN_ATTEMPT'
    if ($actualRunAttempt -cne $Request.expectedRunAttempt) {
        throw 'Hosted context run attempt differed'
    }
    foreach ($name in @('expectedEventSha','expectedSourceSha')) {
        $expected = Assert-MyspeedJsonString $Request.$name "Hosted context $name"
        if ($expected -cnotmatch $script:Sha40) { throw "Hosted context $name is invalid" }
    }
    $actualEventSha = Assert-MyspeedJsonString (Get-MyspeedProperty $environment 'GITHUB_SHA') 'Hosted context GITHUB_SHA'
    if ($actualEventSha -cne $Request.expectedEventSha) {
        throw 'Hosted context event SHA differed'
    }
    $nonce = Assert-MyspeedJsonString $Request.nonce 'Hosted context nonce'
    if ($nonce -cnotmatch $script:Nonce) { throw 'Hosted context nonce is invalid' }
    Assert-MyspeedCompilerEnvironment $environment
    return [pscustomobject]@{ accepted=$true }
}

function Test-MyspeedWindowsAbsolutePath {
    param([object]$Path, [string]$Label)
    $Path = Assert-MyspeedJsonString $Path $Label
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path -cnotmatch '^[A-Za-z]:\\' -or
        $Path.IndexOfAny([char[]]($script:ControlCharacterMinimum..$script:ControlCharacterMaximum)) -ge 0 -or
        $Path -match '[&|<>^%!"*?\[\]]' -or $Path.Substring(2).Contains(':') -or
        $Path -match '/' -or $Path -match '\\\\') {
        throw "$Label contains a path or CMD metacharacter violation"
    }
    foreach ($segment in ($Path.Substring(3) -split '\\')) {
        if ($segment -in @('','.', '..') -or $segment -match '[ .]$') {
            throw "$Label is not a normalized Windows path"
        }
        if ($segment -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') {
            throw "$Label contains a reserved DOS device segment"
        }
    }
    return $Path
}

function Test-MyspeedCmdToken {
    param([string]$Value, [string]$Label)
    if ($null -eq $Value -or $Value.IndexOf([char]0) -ge 0 -or $Value -match '[&|<>^%!"\r\n]') {
        throw "$Label contains a CMD metacharacter"
    }
    if ($Value.StartsWith('@', [StringComparison]::Ordinal)) { throw "$Label may not name a response file" }
    return $Value
}

function ConvertTo-MyspeedCmdToken {
    param([string]$Value)
    Test-MyspeedCmdToken $Value 'Command token' | Out-Null
    if ($Value.Length -eq 0 -or $Value -match '[\s\\()]') { return '"' + $Value + '"' }
    return $Value
}

function New-MyspeedVcCommandFile {
    param([object]$Request)
    Assert-MyspeedExactKeys $Request @('vcvarsPath','toolPath','arguments') 'Command input'
    $vcvars = Test-MyspeedWindowsAbsolutePath $Request.vcvarsPath 'vcvars path'
    $tool = Test-MyspeedWindowsAbsolutePath $Request.toolPath 'tool path'
    if ($Request.arguments -isnot [array] -or $Request.arguments.Count -gt $script:MaximumCommandArgumentCount) {
        throw 'Command arguments are invalid'
    }
    $arguments = @($Request.arguments | ForEach-Object {
        $argument = Assert-MyspeedJsonString $_ 'Command argument'
        ConvertTo-MyspeedCmdToken $argument
    })
    $lines = New-Object 'System.Collections.Generic.List[string]'
    [void]$lines.Add('@echo off')
    [void]$lines.Add('setlocal DisableDelayedExpansion')
    foreach ($name in $script:CompilerInjectionNames) {
        [void]$lines.Add("if defined $name exit /b $script:CompilerEnvironmentFailureExitCode")
    }
    [void]$lines.Add(('call "{0}" >nul' -f $vcvars))
    [void]$lines.Add('if errorlevel 1 exit /b %errorlevel%')
    foreach ($name in $script:CompilerInjectionNames) {
        [void]$lines.Add("if defined $name exit /b $script:CompilerEnvironmentFailureExitCode")
        [void]$lines.Add(('set "{0}="' -f $name))
    }
    $invocation = '"' + $tool + '"'
    if ($arguments.Count -gt 0) { $invocation += ' ' + ($arguments -join ' ') }
    [void]$lines.Add($invocation)
    [void]$lines.Add('exit /b %errorlevel%')
    return (($lines -join "`r`n") + "`r`n")
}

function Resolve-MyspeedVcToolPaths {
    param([object]$Request)
    Assert-MyspeedExactKeys $Request @('installationPath','vcToolsVersion') 'Tool path input'
    $root = Test-MyspeedWindowsAbsolutePath $Request.installationPath 'Visual Studio installation path'
    $version = Assert-MyspeedJsonString $Request.vcToolsVersion 'VC tools version'
    if ($version -cnotmatch $script:VcVersion) { throw 'VC tools version is invalid' }
    $toolRoot = "$root\VC\Tools\MSVC\$version\bin\Hostx64\x64"
    return [pscustomobject]@{
        vcvars="$root\VC\Auxiliary\Build\vcvars64.bat"
        cl="$toolRoot\cl.exe"
        link="$toolRoot\link.exe"
        dumpbin="$toolRoot\dumpbin.exe"
    }
}

function Assert-MyspeedClosureManifest {
    param([object]$Manifest)
    Assert-MyspeedExactKeys $Manifest @('schemaVersion','kind','expectedRunId','expectedRunAttempt',
        'expectedSourceSha','expectedEventSha','nonce','files') 'Closure manifest'
    $schemaVersion = Assert-MyspeedJsonInteger $Manifest.schemaVersion 'Closure manifest schema version'
    if ($schemaVersion -ne $script:SchemaVersion) { throw 'Closure manifest schema version differs' }
    $manifestKind = Assert-MyspeedJsonString $Manifest.kind 'Closure manifest kind'
    if ($manifestKind -cne $script:ClosureKind) { throw 'Closure manifest kind differs' }
    foreach ($name in @('expectedRunId','expectedRunAttempt')) {
        $value = Assert-MyspeedJsonString $Manifest.$name "Closure manifest $name"
        if ($value -cnotmatch $script:PositiveDecimal) { throw "Closure manifest $name is invalid" }
    }
    foreach ($name in @('expectedSourceSha','expectedEventSha')) {
        $value = Assert-MyspeedJsonString $Manifest.$name "Closure manifest $name"
        if ($value -cnotmatch $script:Sha40) { throw "Closure manifest $name is invalid" }
    }
    $manifestNonce = Assert-MyspeedJsonString $Manifest.nonce 'Closure manifest nonce'
    if ($manifestNonce -cnotmatch $script:Nonce) { throw 'Closure manifest nonce is invalid' }
    if ($Manifest.files -isnot [array] -or $Manifest.files.Count -ne $script:RequiredClosureFiles.Count) {
        throw 'Closure manifest file count differs'
    }
    for ($index = 0; $index -lt $script:RequiredClosureFiles.Count; $index++) {
        $file = $Manifest.files[$index]
        Assert-MyspeedExactKeys $file @('name','bytes','sha256') 'Closure manifest file'
        $fileName = Assert-MyspeedJsonString $file.name 'Closure manifest file name'
        if ($fileName -cne $script:RequiredClosureFiles[$index]) { throw 'Closure manifest file order differs' }
        $fileBytes = Assert-MyspeedJsonInteger $file.bytes 'Closure manifest file bytes'
        if ($fileBytes -le 0 -or $fileBytes -gt $script:MaximumManifestFileBytes) { throw 'Closure manifest file bytes are invalid' }
        $fileHash = Assert-MyspeedJsonString $file.sha256 'Closure manifest file hash'
        if ($fileHash -cnotmatch $script:Sha256) { throw 'Closure manifest file hash is invalid' }
    }
    return [pscustomobject]@{ accepted=$true }
}

function Remove-MyspeedSingleTerminalNewline {
    param([string]$Text)
    if ($Text.EndsWith("`r`n", [StringComparison]::Ordinal)) {
        return $Text.Substring(0, $Text.Length - $script:CrLfLength)
    }
    if ($Text.EndsWith("`n", [StringComparison]::Ordinal)) {
        return $Text.Substring(0, $Text.Length - $script:LfLength)
    }
    return $Text
}

function ConvertFrom-MyspeedVsWhereOutput {
    param([object]$Text)
    $Text = Assert-MyspeedJsonString $Text 'vswhere output'
    if ([Text.Encoding]::UTF8.GetByteCount($Text) -gt $script:ToolStreamLimitBytes -or
        $Text.IndexOf([char]0) -ge 0) {
        throw 'vswhere output is invalid'
    }
    $trimmed = Remove-MyspeedSingleTerminalNewline $Text
    if ([string]::IsNullOrWhiteSpace($trimmed) -or ($trimmed -split "`r?`n").Count -ne 1) {
        throw 'vswhere output must contain exactly one line'
    }
    return (Test-MyspeedWindowsAbsolutePath $trimmed 'vswhere output')
}

function ConvertFrom-MyspeedPreflightOutput {
    param([object]$Text)
    $Text = Assert-MyspeedJsonString $Text 'Environment frame'
    if ([Text.Encoding]::UTF8.GetByteCount($Text) -gt $script:ToolStreamLimitBytes -or
        $Text.IndexOf([char]0) -ge 0) {
        throw 'Environment frame is invalid'
    }
    $frame = Remove-MyspeedSingleTerminalNewline $Text
    $lines = @($frame -split "`r?`n")
    if ($lines.Count -ne 6 -or $lines[0] -cne 'MYSPEED_ENV_BEGIN' -or $lines[5] -cne 'MYSPEED_ENV_END') {
        throw 'Environment frame differs'
    }
    $names = @('VCToolsVersion','VCToolsInstallDir','WindowsSdkDir','WindowsSDKVersion')
    $result = [ordered]@{}
    for ($index = 0; $index -lt $names.Count; $index++) {
        $prefix = $names[$index] + '='
        if (-not $lines[$index + 1].StartsWith($prefix, [StringComparison]::Ordinal)) { throw 'Environment frame order differs' }
        $value = $lines[$index + 1].Substring($prefix.Length)
        if ([string]::IsNullOrWhiteSpace($value)) { throw 'Environment frame value is empty' }
        $result[$names[$index]] = $value
    }
    if ([string]$result.VCToolsVersion -cnotmatch $script:VcVersion) { throw 'Environment frame VC version is invalid' }
    return [pscustomobject]$result
}

function ConvertTo-MyspeedUnsignedExitCode {
    param([object]$ExitCode)
    try {
        $value = Assert-MyspeedJsonInteger $ExitCode 'Exit code'
    } catch {
        throw 'Exit code must be a 32-bit value'
    }
    if ($value -lt [int32]::MinValue -or $value -gt [uint32]::MaxValue) { throw 'Exit code must be a 32-bit value' }
    if ($value -lt 0) { $value += $script:Unsigned32Modulus }
    return [uint64]$value
}

function Assert-MyspeedDisassembly {
    param([object]$ModeName, [object]$Text)
    $ModeName = Assert-MyspeedJsonString $ModeName 'Disassembly mode'
    $Text = Assert-MyspeedJsonString $Text 'Disassembly text'
    if (-not $script:DisassemblyContract.Contains($ModeName)) { throw 'Disassembly mode is unsupported' }
    if ([Text.Encoding]::UTF8.GetByteCount($Text) -gt $script:DisassemblyFileLimitBytes -or
        $Text.IndexOf([char]0) -ge 0) {
        throw 'Disassembly is invalid or oversized'
    }
    $symbol = $script:DisassemblySymbols[$ModeName]
    $lines = @($Text -split "`r?`n")
    $symbolMatches = @()
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -cmatch ('^\s*' + [regex]::Escape($symbol) + ':\s*$')) { $symbolMatches += $index }
    }
    if ($symbolMatches.Count -ne 1) { throw "Disassembly requires one unique $symbol region" }
    $start = $symbolMatches[0] + 1
    $end = $lines.Count
    for ($index = $start; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -cmatch '^\s*(?!\$LN)[A-Za-z_?@$][A-Za-z0-9_?@$]*:\s*$') { $end = $index; break }
    }
    $region = @($lines[$start..([Math]::Max($start, $end - 1))])
    $mnemonics = @($region | ForEach-Object {
        if ($_ -cmatch '^\s*[0-9A-Fa-f]{8,16}:\s+(?:[0-9A-Fa-f]{2}\s+)+([A-Za-z][A-Za-z0-9]*)\b') {
            $Matches[1].ToLowerInvariant()
        }
    })
    foreach ($instruction in $script:DisassemblyContract[$ModeName]) {
        if ($mnemonics -cnotcontains $instruction) {
            throw "Disassembly $symbol region lacks $instruction"
        }
    }
    return [pscustomobject]@{ accepted=$true; symbol=$symbol }
}

function Assert-MyspeedProbeText {
    param([object]$Value, [string]$Label, [bool]$AllowEmpty)
    $text = Assert-MyspeedJsonString $Value $Label
    $bytes = [Text.Encoding]::UTF8.GetByteCount($text)
    if ((-not $AllowEmpty -and $bytes -eq 0) -or $bytes -gt $script:ProbeStreamLimitBytes -or
        $text.IndexOf([char]0) -ge 0) {
        throw "$Label is empty, oversized, or contains NUL"
    }
    return $text
}

function ConvertFrom-MyspeedProbeJson {
    param([object]$ExpectedKind, [object]$Text)
    $ExpectedKind = Assert-MyspeedJsonString $ExpectedKind 'Expected probe kind'
    $Text = Assert-MyspeedProbeText $Text 'Probe JSON' $false
    if ($ExpectedKind -cne 'cpuid' -and -not $script:ControlTable.Contains($ExpectedKind)) {
        throw 'Expected probe kind is unsupported'
    }
    try {
        $value = $Text | ConvertFrom-Json
    } catch {
        throw 'Probe JSON is malformed'
    }
    if ($ExpectedKind -ceq 'cpuid') {
        Assert-MyspeedExactKeys $value @('schemaVersion','kind','maxBasicLeaf','leaf1','leaf7Subleaf0','xcr0','features') 'CPUID probe'
        $schemaVersion = Assert-MyspeedJsonInteger $value.schemaVersion 'CPUID schema version'
        $kind = Assert-MyspeedJsonString $value.kind 'CPUID kind'
        $maximumLeaf = Assert-MyspeedJsonInteger $value.maxBasicLeaf 'CPUID maximum basic leaf'
        if ($schemaVersion -ne $script:SchemaVersion -or $kind -cne 'cpuid' -or
            $maximumLeaf -lt 1 -or $maximumLeaf -gt [uint32]::MaxValue) {
            throw 'CPUID header differs'
        }
        foreach ($leafName in @('leaf1','leaf7Subleaf0')) {
            $leaf = $value.$leafName
            Assert-MyspeedExactKeys $leaf @('eax','ebx','ecx','edx') "CPUID $leafName"
            foreach ($registerName in @('eax','ebx','ecx','edx')) {
                $register = Assert-MyspeedJsonString $leaf.$registerName "CPUID $leafName $registerName"
                if ($register -cnotmatch $script:HexRegister) { throw "CPUID $leafName register is invalid" }
            }
        }
        if ($maximumLeaf -lt 7) {
            foreach ($registerName in @('eax','ebx','ecx','edx')) {
                if ($value.leaf7Subleaf0.$registerName -cne '0x00000000') {
                    throw 'CPUID leaf 7 must be zero when unavailable'
                }
            }
        }
        Assert-MyspeedExactKeys $value.features @('sse42','popcnt','osxsave','avx','avx2') 'CPUID features'
        $leafOneEcx = [Convert]::ToUInt32($value.leaf1.ecx.Substring(2), 16)
        $leafSevenEbx = [Convert]::ToUInt32($value.leaf7Subleaf0.ebx.Substring(2), 16)
        foreach ($featureName in @('sse42','popcnt','osxsave','avx','avx2')) {
            $feature = Assert-MyspeedJsonBoolean $value.features.$featureName "CPUID feature $featureName"
            $register = if ($featureName -ceq 'avx2') { $leafSevenEbx } else { $leafOneEcx }
            $mask = [uint32](1 -shl $script:FeatureBits[$featureName])
            $raw = ($register -band $mask) -ne 0
            if ($feature -ne $raw) { throw "CPUID feature $featureName raw bit differed" }
        }
        if ($value.features.osxsave) {
            $xcr0 = Assert-MyspeedJsonString $value.xcr0 'CPUID XCR0'
            if ($xcr0 -cnotmatch $script:HexXcr0) { throw 'CPUID XCR0 is invalid' }
        } elseif ($null -ne $value.xcr0) {
            throw 'CPUID XCR0 must be null without OSXSAVE'
        }
        return $value
    }
    Assert-MyspeedExactKeys $value @('schemaVersion','kind','result') 'Control probe'
    $schemaVersion = Assert-MyspeedJsonInteger $value.schemaVersion 'Control schema version'
    $kind = Assert-MyspeedJsonString $value.kind 'Control kind'
    $result = Assert-MyspeedJsonInteger $value.result 'Control result'
    if ($schemaVersion -ne $script:SchemaVersion -or $kind -cne $ExpectedKind -or $result -lt 0) {
        throw 'Control probe differs'
    }
    return $value
}

function Test-MyspeedNativeCalibration {
    param([object]$Request)
    Assert-MyspeedExactKeys $Request @('schemaVersion','kind','runs') 'Native calibration input'
    $schemaVersion = Assert-MyspeedJsonInteger $Request.schemaVersion 'Native calibration schema version'
    $kind = Assert-MyspeedJsonString $Request.kind 'Native calibration kind'
    if ($schemaVersion -ne $script:SchemaVersion -or $kind -cne $script:CalibrationInputKind) {
        throw 'Native calibration header differs'
    }
    if ($Request.runs -isnot [array] -or $Request.runs.Count -ne $script:ModeTable.Count) {
        throw 'Native calibration run count differs'
    }
    $reasons = New-Object 'System.Collections.Generic.List[string]'
    $cpuid = $null
    for ($index = 0; $index -lt $script:ModeTable.Count; $index++) {
        $mode = $script:ModeTable[$index].name
        $run = $Request.runs[$index]
        Assert-MyspeedExactKeys $run @('mode','exitCode','stdout','stderr') 'Native calibration run'
        $runMode = Assert-MyspeedJsonString $run.mode 'Native calibration run mode'
        if ($runMode -cne $mode) { throw 'Native calibration run order differs' }
        $exitCode = ConvertTo-MyspeedUnsignedExitCode $run.exitCode
        $stdout = Assert-MyspeedProbeText $run.stdout 'Native calibration stdout' $true
        $stderr = Assert-MyspeedProbeText $run.stderr 'Native calibration stderr' $true
        if ($stderr.Length -ne 0) { [void]$reasons.Add("$mode-stderr-not-empty") }
        if ($mode -ceq 'illegal') {
            if ($exitCode -ne $script:IllegalInstructionExitCode -or $stdout.Length -ne 0) {
                [void]$reasons.Add('illegal-control-differed')
            }
            continue
        }
        try {
            $record = ConvertFrom-MyspeedProbeJson $mode $stdout
            if ($mode -ceq 'cpuid') { $cpuid = $record }
        } catch {
            [void]$reasons.Add("$mode-output-invalid:$($_.Exception.Message)")
            continue
        }
        if ($mode -ceq 'cpuid') {
            if ($exitCode -ne 0) { [void]$reasons.Add('cpuid-exit-differed') }
            continue
        }
        $expected = $script:ControlTable[$mode]
        if ($exitCode -ne $expected.exitCode -or [int64]$record.result -ne $expected.result) {
            [void]$reasons.Add("$mode-control-differed")
        }
    }
    if ($null -eq $cpuid) {
        [void]$reasons.Add('cpuid-record-missing')
    } else {
        foreach ($featureName in @('sse42','popcnt','osxsave','avx','avx2')) {
            if ($cpuid.features.$featureName -ne $true) { [void]$reasons.Add("cpuid-$featureName-not-present") }
        }
        if ($cpuid.xcr0 -isnot [string] -or
            ([Convert]::ToUInt64($cpuid.xcr0.Substring(2), 16) -band $script:Xcr0AvxMask) -ne $script:Xcr0AvxMask) {
            [void]$reasons.Add('xcr0-xmm-ymm-not-enabled')
        }
    }
    return [pscustomobject]@{
        schemaVersion=$script:SchemaVersion
        kind='myspeed-windows-native-calibration'
        status='completed'
        calibrationPassed=($reasons.Count -eq 0)
        qualifying=$false
        classification=$script:Classification
        sequence=@($script:ModeTable | ForEach-Object { $_.name })
        reasons=@($reasons)
        cpuid=$cpuid
    }
}

function Assert-MyspeedOwnedOperation {
    param([object]$Request)
    Assert-MyspeedExactKeys $Request @('streamLimitBytes','maximumDurationMilliseconds','expectedExitCode','launcher','wrapper') 'Operation'
    $limit = Assert-MyspeedJsonInteger $Request.streamLimitBytes 'Operation output limit'
    if ($limit -le 0 -or $limit -gt $script:ToolStreamLimitBytes) { throw 'Operation output limit is invalid' }
    $durationLimit = Assert-MyspeedJsonInteger $Request.maximumDurationMilliseconds 'Operation duration limit'
    if ($durationLimit -le 0 -or $durationLimit -gt $script:MaximumOperationMilliseconds) {
        throw 'Operation duration limit is invalid'
    }
    Assert-MyspeedExactKeys $Request.launcher @('schemaVersion','authorizesTransfer','processId','exitCode',
        'timedOut','processTreeExitProven') 'Launcher operation'
    Assert-MyspeedExactKeys $Request.wrapper @('schemaVersion','status','childProcessId','exitCode','timedOut','durationMilliseconds',
        'stdoutBytes','stderrBytes','outputDrainProven','childJobMembershipProven','errorModeRestored') 'Wrapper operation'
    $launcherSchema = Assert-MyspeedJsonInteger $Request.launcher.schemaVersion 'Launcher schema version'
    $launcherAuthorizesTransfer = Assert-MyspeedJsonBoolean $Request.launcher.authorizesTransfer 'Launcher transfer authorization'
    $launcherProcessId = Assert-MyspeedJsonInteger $Request.launcher.processId 'Launcher process ID'
    $launcherExitCode = Assert-MyspeedJsonInteger $Request.launcher.exitCode 'Launcher exit code'
    $launcherTimedOut = Assert-MyspeedJsonBoolean $Request.launcher.timedOut 'Launcher timeout proof'
    $launcherTreeExit = Assert-MyspeedJsonBoolean $Request.launcher.processTreeExitProven 'Launcher process-tree proof'
    if ($launcherSchema -ne $script:SchemaVersion -or $launcherAuthorizesTransfer -ne $false -or
        $launcherProcessId -le 0 -or $launcherProcessId -gt $script:MaximumWindowsProcessId -or
        $launcherExitCode -ne 0 -or
        $launcherTimedOut -ne $false -or $launcherTreeExit -ne $true) {
        throw 'Operation outer Job proof failed'
    }
    $wrapperSchema = Assert-MyspeedJsonInteger $Request.wrapper.schemaVersion 'Wrapper schema version'
    $wrapperStatus = Assert-MyspeedJsonString $Request.wrapper.status 'Wrapper status'
    $wrapperProcessId = Assert-MyspeedJsonInteger $Request.wrapper.childProcessId 'Wrapper child process ID'
    $wrapperTimedOut = Assert-MyspeedJsonBoolean $Request.wrapper.timedOut 'Wrapper timeout proof'
    $wrapperOutputDrain = Assert-MyspeedJsonBoolean $Request.wrapper.outputDrainProven 'Wrapper output-drain proof'
    $wrapperJobMembership = Assert-MyspeedJsonBoolean $Request.wrapper.childJobMembershipProven 'Wrapper Job-membership proof'
    if ($wrapperSchema -ne $script:SchemaVersion -or $wrapperStatus -cne 'completed' -or
        $wrapperProcessId -le 0 -or $wrapperProcessId -gt $script:MaximumWindowsProcessId -or
        $wrapperTimedOut -ne $false -or
        $wrapperOutputDrain -ne $true -or $wrapperJobMembership -ne $true) {
        throw 'Operation wrapper proof failed'
    }
    $errorModeRestored = Assert-MyspeedJsonBoolean $Request.wrapper.errorModeRestored 'Wrapper error-mode proof'
    if ($errorModeRestored -ne $true) { throw 'Operation error mode was not restored' }
    $duration = Assert-MyspeedJsonInteger $Request.wrapper.durationMilliseconds 'Operation duration'
    if ($duration -lt 0 -or $duration -gt $durationLimit) {
        throw 'Operation duration exceeded its limit'
    }
    foreach ($name in @('stdoutBytes','stderrBytes')) {
        $byteCount = Assert-MyspeedJsonInteger $Request.wrapper.$name "Operation $name"
        if ($byteCount -lt 0 -or $byteCount -gt $limit) { throw 'Operation output exceeded its limit' }
    }
    $actualExit = ConvertTo-MyspeedUnsignedExitCode $Request.wrapper.exitCode
    $expectedExit = ConvertTo-MyspeedUnsignedExitCode $Request.expectedExitCode
    if ($actualExit -ne $expectedExit) { throw 'Operation exit code differed' }
    return [pscustomobject]@{ accepted=$true }
}

function Get-MyspeedCpuReadinessContract {
    return [pscustomobject]@{
        schemaVersion=$script:SchemaVersion
        modes=$script:ModeTable
        sequence=@($script:ModeTable | ForEach-Object { $_.name })
        wrapperRelativePath=$script:WindowsPowerShellRelativePath
        qualifying=$false
        classification=$script:Classification
        limits=[pscustomobject]@{
            toolTimeoutSeconds=$script:ToolTimeoutSeconds
            probeTimeoutSeconds=$script:ProbeTimeoutSeconds
            toolStreamBytes=$script:ToolStreamLimitBytes
            probeStreamBytes=$script:ProbeStreamLimitBytes
            disassemblyFileBytes=$script:DisassemblyFileLimitBytes
            resultJsonBytes=$script:ResultJsonLimitBytes
            aggregateArtifactBytes=$script:AggregateArtifactLimitBytes
            cleanupSeconds=$script:CleanupSeconds
        }
        vswhereArguments=@('-latest','-products','*','-requires',
            'Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath','-format','value','-utf8')
        compileArguments=@('/nologo','/TC','/c','/W4','/WX','/O2','/Oi','/GS','/guard:cf','/MT')
        linkArguments=@('/NOLOGO','/INCREMENTAL:NO','/SUBSYSTEM:CONSOLE','/MACHINE:X64',
            '/DYNAMICBASE','/NXCOMPAT','/HIGHENTROPYVA','/GUARD:CF','/MANIFEST:NO')
        dumpbinArguments=@('/NOLOGO','/DISASM:BYTES')
        disassembly=[pscustomobject]$script:DisassemblyContract
    }
}

function Write-MyspeedJson {
    param([object]$Value)
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 20))
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $request = $InputJson | ConvertFrom-Json
        switch ($Mode) {
            'Library' { }
            'GetContract' { Write-MyspeedJson (Get-MyspeedCpuReadinessContract) }
            'AssertContext' { Write-MyspeedJson (Assert-MyspeedHostedContext $request) }
            'ValidateManifest' { Write-MyspeedJson (Assert-MyspeedClosureManifest $request) }
            'RenderCommand' { Write-MyspeedJson ([pscustomobject]@{ text=(New-MyspeedVcCommandFile $request) }) }
            'ResolveToolPaths' { Write-MyspeedJson (Resolve-MyspeedVcToolPaths $request) }
            'ParseVsWhere' {
                Assert-MyspeedExactKeys $request @('text') 'vswhere input'
                Write-MyspeedJson ([pscustomobject]@{ value=(ConvertFrom-MyspeedVsWhereOutput $request.text) })
            }
            'ParsePreflight' {
                Assert-MyspeedExactKeys $request @('text') 'Preflight input'
                Write-MyspeedJson ([pscustomobject]@{ value=(ConvertFrom-MyspeedPreflightOutput $request.text) })
            }
            'ConvertExit' {
                Assert-MyspeedExactKeys $request @('exitCode') 'Exit input'
                Write-MyspeedJson ([pscustomobject]@{ value=(ConvertTo-MyspeedUnsignedExitCode $request.exitCode) })
            }
            'CheckDisassembly' {
                Assert-MyspeedExactKeys $request @('mode','text') 'Disassembly input'
                Write-MyspeedJson (Assert-MyspeedDisassembly $request.mode $request.text)
            }
            'ParseProbe' {
                Assert-MyspeedExactKeys $request @('expectedKind','text') 'Probe parser input'
                Write-MyspeedJson ([pscustomobject]@{
                    accepted=$true
                    record=(ConvertFrom-MyspeedProbeJson $request.expectedKind $request.text)
                })
            }
            'AssessNativeCalibration' { Write-MyspeedJson (Test-MyspeedNativeCalibration $request) }
            'ValidateOperation' { Write-MyspeedJson (Assert-MyspeedOwnedOperation $request) }
        }
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
}
