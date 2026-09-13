[CmdletBinding()]
param(
    [ValidateSet('Library', 'EmitCanaryClosureManifest', 'InvokeHostedProbe')]
    [string]$Mode = 'Library',
    [string]$ExpectedRunId,
    [string]$ExpectedRunAttempt,
    [string]$ExpectedSourceSha,
    [string]$ExpectedEventSha,
    [string]$Nonce,
    [string]$ManifestPath,
    [string]$EvidencePath
)

Set-StrictMode -Version Latest

$script:SERVICE_START_DEADLINE_SECONDS = 10
$script:SERVICE_RESULT_DEADLINE_SECONDS = 5
$script:SERVICE_STOP_DEADLINE_SECONDS = 5
$script:COMPILER_DEADLINE_SECONDS = 10
$script:MACHINE_ENVIRONMENT_RESTORE_DEADLINE_SECONDS = 5
$script:POLL_INTERVAL_MILLISECONDS = 100
$script:MILLISECONDS_PER_SECOND = 1000
$script:EXPECTED_LOCALSYSTEM_SID = 'S-1-5-18'
$script:EXPECTED_REPOSITORY = 'i7Gamer/MySpeed'
$script:EXPECTED_IMAGE_OS = 'win25-vs2026'
$script:WORK_DIRECTORY_PREFIX = 'myspeed-service-environment-'
$script:RESULT_FILENAME = 'result.json'
$script:PROBE_SOURCE_FILENAME = 'probe.cs'
$script:PROBE_EXECUTABLE_FILENAME = 'probe.exe'
$script:PROBE_RESULT_FILENAME = 'probe-result.json'
$script:CANARY_SCRIPT_NAME = 'windows-service-environment.ps1'
$script:MAX_SCRIPT_BYTES = 262144
$script:MAX_MANIFEST_BYTES = 4096
$script:MAX_EVIDENCE_BYTES = 32768
$script:MAX_PROBE_RESULT_BYTES = 16384
$script:ENVIRONMENT_REGISTRY_PATH = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
$script:EXPECTED_ENVIRONMENT = [ordered]@{
    SERVER_HOST = '127.0.0.1'
    SERVER_PORT = '43127'
    HTTPS_REDIRECT = 'false'
    DB_TYPE = 'sqlite'
    RUN_TEST_ON_STARTUP = 'false'
    PREVIEW_MODE = 'false'
    ALLOW_NO_PASSWORD = 'false'
    ALLOW_LOCAL_NODES = 'false'
}
$script:FORBIDDEN_EXACT_NAMES = @(
    'ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    'DB_HOST', 'DB_NAME', 'DB_PASS', 'DB_PORT', 'DB_USER',
    'TRUST_PROXY', 'TRUSTED_AUTH_HEADER', 'TRUSTED_AUTH_PROXIES',
    'ALLOWED_NODE_HOSTS', 'PREVIEW_MESSAGE'
)
$script:FORBIDDEN_PREFIXES = @('MYSQL_', 'SMTP_', 'MQTT_', 'INTEGRATION_', 'PROVIDER_')
$script:FORBIDDEN_FRAGMENTS = @('_API_KEY', '_CREDENTIAL', '_PASSWORD', '_SECRET', '_TOKEN')

function Get-MyspeedExpectedEnvironment {
    return [pscustomobject]([ordered]@{
        SERVER_HOST = $script:EXPECTED_ENVIRONMENT.SERVER_HOST
        SERVER_PORT = $script:EXPECTED_ENVIRONMENT.SERVER_PORT
        HTTPS_REDIRECT = $script:EXPECTED_ENVIRONMENT.HTTPS_REDIRECT
        DB_TYPE = $script:EXPECTED_ENVIRONMENT.DB_TYPE
        RUN_TEST_ON_STARTUP = $script:EXPECTED_ENVIRONMENT.RUN_TEST_ON_STARTUP
        PREVIEW_MODE = $script:EXPECTED_ENVIRONMENT.PREVIEW_MODE
        ALLOW_NO_PASSWORD = $script:EXPECTED_ENVIRONMENT.ALLOW_NO_PASSWORD
        ALLOW_LOCAL_NODES = $script:EXPECTED_ENVIRONMENT.ALLOW_LOCAL_NODES
    })
}

function Get-MyspeedEnvironmentIndex {
    param([Parameter(Mandatory)][object[]]$Entries)

    $index = [System.Collections.Generic.Dictionary[string, object]]::new(
        [System.StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $Entries) {
        if ($null -eq $entry -or $entry.PSObject.Properties.Name -notcontains 'Name' -or
            -not ($entry.Name -is [string]) -or [string]::IsNullOrWhiteSpace($entry.Name)) {
            throw 'Machine environment snapshot contains a malformed name'
        }
        if ($index.ContainsKey($entry.Name)) {
            throw "Machine environment snapshot contains a case-insensitive name collision: $($entry.Name)"
        }
        $index.Add($entry.Name, $entry)
    }
    return $index
}

function Assert-MyspeedMachineEnvironmentPrecondition {
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Entries)

    $index = Get-MyspeedEnvironmentIndex -Entries $Entries
    foreach ($name in $script:EXPECTED_ENVIRONMENT.Keys) {
        if ($index.ContainsKey($name)) {
            throw "Machine environment target collision: $name already exists"
        }
    }
    return $true
}

function Test-MyspeedEnvironmentSnapshotsEqual {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Before,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$After
    )

    $beforeIndex = Get-MyspeedEnvironmentIndex -Entries $Before
    $afterIndex = Get-MyspeedEnvironmentIndex -Entries $After
    if ($beforeIndex.Count -ne $afterIndex.Count) { return $false }
    foreach ($name in $beforeIndex.Keys) {
        if (-not $afterIndex.ContainsKey($name)) { return $false }
        $left = $beforeIndex[$name]
        $right = $afterIndex[$name]
        if ($left.Kind -cne $right.Kind -or $left.Fingerprint -cne $right.Fingerprint -or
            $left.Name -cne $right.Name) { return $false }
    }
    return $true
}

function Test-MyspeedUnrelatedEnvironmentUnchanged {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Before,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Current
    )
    $unrelated = @($Current | Where-Object {
        $name = $_.Name
        -not @($script:EXPECTED_ENVIRONMENT.Keys | Where-Object {
            [string]::Equals($name, $_, [StringComparison]::OrdinalIgnoreCase)
        }).Count
    })
    return Test-MyspeedEnvironmentSnapshotsEqual -Before $Before -After $unrelated
}

function Test-MyspeedForbiddenEnvironmentName {
    param([Parameter(Mandatory)][string]$Name)

    foreach ($allowed in $script:EXPECTED_ENVIRONMENT.Keys) {
        if ([string]::Equals($Name, $allowed, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $false
        }
    }
    foreach ($forbidden in $script:FORBIDDEN_EXACT_NAMES) {
        if ([string]::Equals($Name, $forbidden, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    foreach ($prefix in $script:FORBIDDEN_PREFIXES) {
        if ($Name.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    foreach ($fragment in $script:FORBIDDEN_FRAGMENTS) {
        if ($Name.IndexOf($fragment, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    }
    return $false
}

function Get-MyspeedForbiddenEnvironmentNames {
    param([Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Names)

    return @($Names | Where-Object { Test-MyspeedForbiddenEnvironmentName -Name $_ } |
        Sort-Object -Unique)
}

function Get-MyspeedProbeAssessment {
    param([Parameter(Mandatory)][object]$Probe)

    $actual = [ordered]@{}
    $projectionNames = @()
    if ($null -ne $Probe.projection) { $projectionNames = @($Probe.projection.PSObject.Properties.Name) }
    foreach ($name in $script:EXPECTED_ENVIRONMENT.Keys) {
        $property = $Probe.projection.PSObject.Properties[$name]
        $actual[$name] = if ($null -eq $property) { $null } else { $property.Value }
    }

    $expectedNames = @($script:EXPECTED_ENVIRONMENT.Keys)
    $exactNames = $projectionNames.Count -eq $expectedNames.Count
    if ($exactNames) {
        for ($index = 0; $index -lt $expectedNames.Count; $index++) {
            if ($projectionNames[$index] -cne $expectedNames[$index]) { $exactNames = $false; break }
        }
    }

    $valuesMatch = $exactNames
    foreach ($name in $expectedNames) {
        if ($actual[$name] -isnot [string] -or $actual[$name] -cne $script:EXPECTED_ENVIRONMENT[$name]) {
            $valuesMatch = $false
        }
    }

    $forbiddenNames = @()
    if ($null -ne $Probe.forbiddenNames) {
        $forbiddenNames = @($Probe.forbiddenNames | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    }
    $processIdIsInteger = $Probe.processId -is [int] -or $Probe.processId -is [long]
    $observedProcessId = if ($processIdIsInteger -and $Probe.processId -gt 0 -and
        $Probe.processId -le [int]::MaxValue) { [int]$Probe.processId } else { 0 }
    $passed = $Probe.status -ceq 'completed' -and $Probe.sid -ceq $script:EXPECTED_LOCALSYSTEM_SID -and
        $observedProcessId -gt 0 -and $valuesMatch -and
        $forbiddenNames.Count -eq 0

    return [pscustomobject]([ordered]@{
        status = [string]$Probe.status
        environmentPassed = [bool]$passed
        observedSid = [string]$Probe.sid
        observedProcessId = $observedProcessId
        expectedProjection = Get-MyspeedExpectedEnvironment
        actualProjection = [pscustomobject]$actual
        forbiddenNames = $forbiddenNames
    })
}

function Assert-MyspeedHostedContext {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Context,
        [Parameter(Mandatory)][string]$ExpectedRunId,
        [Parameter(Mandatory)][string]$ExpectedRunAttempt,
        [Parameter(Mandatory)][string]$ExpectedSourceSha,
        [Parameter(Mandatory)][string]$ExpectedEventSha,
        [Parameter(Mandatory)][string]$Nonce
    )

    if ($ExpectedRunId -cnotmatch '^[1-9][0-9]{0,19}$') { throw 'Expected run identity is invalid' }
    if ($ExpectedRunAttempt -cnotmatch '^[1-9][0-9]{0,9}$') { throw 'Expected run-attempt identity is invalid' }
    if ($ExpectedSourceSha -cnotmatch '^[a-f0-9]{40}$') { throw 'Expected source identity is invalid' }
    if ($ExpectedEventSha -cnotmatch '^[a-f0-9]{40}$') { throw 'Expected event identity is invalid' }
    if ($Nonce -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') {
        throw 'Experiment nonce must be a canonical lowercase UUIDv4'
    }

    $required = [ordered]@{
        GITHUB_ACTIONS = 'true'
        CI = 'true'
        RUNNER_OS = 'Windows'
        RUNNER_ARCH = 'X64'
        RUNNER_ENVIRONMENT = 'github-hosted'
        GITHUB_REPOSITORY = $script:EXPECTED_REPOSITORY
        GITHUB_RUN_ID = $ExpectedRunId
        GITHUB_RUN_ATTEMPT = $ExpectedRunAttempt
        GITHUB_SHA = $ExpectedEventSha
        ImageOS = $script:EXPECTED_IMAGE_OS
    }
    foreach ($entry in $required.GetEnumerator()) {
        if (-not $Context.Contains($entry.Key) -or [string]$Context[$entry.Key] -cne $entry.Value) {
            throw "Hosted Actions context identity mismatch: $($entry.Key)"
        }
    }
    if (-not $Context.Contains('ImageVersion') -or
        [string]$Context.ImageVersion -cnotmatch '^[0-9]{8}\.[0-9]+\.[0-9]+$') {
        throw 'Hosted Actions image identity is invalid'
    }
    if (-not $Context.Contains('RUNNER_TEMP') -or
        [string]$Context.RUNNER_TEMP -cnotmatch '^[A-Za-z]:\\') {
        throw 'Hosted Actions temporary path is invalid'
    }
    return $true
}

function Assert-MyspeedManifestIdentityInputs {
    param(
        [Parameter(Mandatory)][string]$ExpectedRunId,
        [Parameter(Mandatory)][string]$ExpectedRunAttempt,
        [Parameter(Mandatory)][string]$ExpectedSourceSha,
        [Parameter(Mandatory)][string]$ExpectedEventSha,
        [Parameter(Mandatory)][string]$Nonce
    )
    if ($ExpectedRunId -cnotmatch '^[1-9][0-9]{0,19}$') { throw 'Expected run identity is invalid' }
    if ($ExpectedRunAttempt -cnotmatch '^[1-9][0-9]{0,9}$') { throw 'Expected run-attempt identity is invalid' }
    if ($ExpectedSourceSha -cnotmatch '^[a-f0-9]{40}$') { throw 'Expected source identity is invalid' }
    if ($ExpectedEventSha -cnotmatch '^[a-f0-9]{40}$') { throw 'Expected event identity is invalid' }
    if ($Nonce -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') {
        throw 'Experiment nonce must be a canonical lowercase UUIDv4'
    }
    return $true
}

function Write-MyspeedCreateNewUtf8Json {
    param(
        [Parameter(Mandatory)][object]$Value,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][int]$MaximumBytes
    )
    $json = $Value | ConvertTo-Json -Compress -Depth 12
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
    if ($bytes.Length -le 0 -or $bytes.Length -gt $MaximumBytes) {
        throw "JSON evidence size is outside its bound: $($bytes.Length) bytes"
    }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    return $json
}

function Write-MyspeedCanaryClosureManifest {
    param(
        [Parameter(Mandatory)][string]$ExpectedRunId,
        [Parameter(Mandatory)][string]$ExpectedRunAttempt,
        [Parameter(Mandatory)][string]$ExpectedSourceSha,
        [Parameter(Mandatory)][string]$ExpectedEventSha,
        [Parameter(Mandatory)][string]$Nonce,
        [Parameter(Mandatory)][string]$ManifestPath
    )
    Assert-MyspeedManifestIdentityInputs -ExpectedRunId $ExpectedRunId -ExpectedRunAttempt $ExpectedRunAttempt `
        -ExpectedSourceSha $ExpectedSourceSha `
        -ExpectedEventSha $ExpectedEventSha -Nonce $Nonce | Out-Null
    if ([IO.Path]::GetFileName($PSCommandPath) -cne $script:CANARY_SCRIPT_NAME) {
        throw 'Canary script filename is not canonical'
    }
    $scriptPath = [IO.Path]::GetFullPath($PSCommandPath)
    $manifestFullPath = [IO.Path]::GetFullPath($ManifestPath)
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($scriptPath),
        [IO.Path]::GetDirectoryName($manifestFullPath), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Canary manifest must be beside the copied script'
    }
    if (Test-Path -LiteralPath $manifestFullPath) { throw 'Canary manifest path already exists' }
    $scriptBytes = [IO.File]::ReadAllBytes($scriptPath)
    if ($scriptBytes.Length -le 0 -or $scriptBytes.Length -gt $script:MAX_SCRIPT_BYTES) {
        throw "Canary script size is outside its bound: $($scriptBytes.Length) bytes"
    }
    $manifest = [pscustomobject]([ordered]@{
        schemaVersion = 1
        expectedRunId = $ExpectedRunId
        expectedRunAttempt = $ExpectedRunAttempt
        expectedSourceSha = $ExpectedSourceSha
        expectedEventSha = $ExpectedEventSha
        nonce = $Nonce
        script = [pscustomobject]([ordered]@{
            name = $script:CANARY_SCRIPT_NAME
            bytes = $scriptBytes.Length
            sha256 = Get-MyspeedSha256 -Bytes $scriptBytes
        })
    })
    Write-MyspeedCreateNewUtf8Json -Value $manifest -Path $manifestFullPath `
        -MaximumBytes $script:MAX_MANIFEST_BYTES
}

function Assert-MyspeedCanaryClosure {
    param(
        [Parameter(Mandatory)][string]$ExpectedRunId,
        [Parameter(Mandatory)][string]$ExpectedRunAttempt,
        [Parameter(Mandatory)][string]$ExpectedSourceSha,
        [Parameter(Mandatory)][string]$ExpectedEventSha,
        [Parameter(Mandatory)][string]$Nonce,
        [Parameter(Mandatory)][string]$ManifestPath
    )
    Assert-MyspeedManifestIdentityInputs -ExpectedRunId $ExpectedRunId -ExpectedRunAttempt $ExpectedRunAttempt `
        -ExpectedSourceSha $ExpectedSourceSha `
        -ExpectedEventSha $ExpectedEventSha -Nonce $Nonce | Out-Null
    $scriptPath = [IO.Path]::GetFullPath($PSCommandPath)
    $manifestFullPath = [IO.Path]::GetFullPath($ManifestPath)
    $directory = [IO.Path]::GetDirectoryName($scriptPath)
    if ([IO.Path]::GetFileName($scriptPath) -cne $script:CANARY_SCRIPT_NAME -or
        -not [string]::Equals($directory, [IO.Path]::GetDirectoryName($manifestFullPath),
            [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Canary closure paths are not canonical'
    }
    $files = @(Get-ChildItem -LiteralPath $directory -Force -File)
    $directories = @(Get-ChildItem -LiteralPath $directory -Force -Directory)
    if ($files.Count -ne 2 -or $directories.Count -ne 0 -or
        @($files | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count -ne 0 -or
        @($files.Name | Sort-Object) -join "`n" -cne
            @($script:CANARY_SCRIPT_NAME, [IO.Path]::GetFileName($manifestFullPath) | Sort-Object) -join "`n") {
        throw 'Canary closure membership is not exactly one script and one manifest'
    }
    $manifestBytes = [IO.File]::ReadAllBytes($manifestFullPath)
    if ($manifestBytes.Length -le 0 -or $manifestBytes.Length -gt $script:MAX_MANIFEST_BYTES) {
        throw 'Canary manifest size is outside its bound'
    }
    $manifest = [Text.UTF8Encoding]::new($false, $true).GetString($manifestBytes) | ConvertFrom-Json -Depth 8
    if (@($manifest.PSObject.Properties.Name) -join ',' -cne
        'schemaVersion,expectedRunId,expectedRunAttempt,expectedSourceSha,expectedEventSha,nonce,script' -or
        @($manifest.script.PSObject.Properties.Name) -join ',' -cne 'name,bytes,sha256' -or
        $manifest.schemaVersion -ne 1 -or $manifest.expectedRunId -cne $ExpectedRunId -or
        $manifest.expectedRunAttempt -cne $ExpectedRunAttempt -or
        $manifest.expectedSourceSha -cne $ExpectedSourceSha -or $manifest.expectedEventSha -cne $ExpectedEventSha -or
        $manifest.nonce -cne $Nonce -or $manifest.script.name -cne $script:CANARY_SCRIPT_NAME) {
        throw 'Canary manifest identity or schema differs'
    }
    $scriptBytes = [IO.File]::ReadAllBytes($scriptPath)
    if ($scriptBytes.Length -le 0 -or $scriptBytes.Length -gt $script:MAX_SCRIPT_BYTES -or
        $manifest.script.bytes -ne $scriptBytes.Length -or
        $manifest.script.sha256 -cne (Get-MyspeedSha256 -Bytes $scriptBytes)) {
        throw 'Canary script size or SHA-256 differs from its manifest'
    }
    return $manifest
}

function ConvertTo-MyspeedCSharpLiteral {
    param([Parameter(Mandatory)][string]$Value)
    return '"' + $Value.Replace('\', '\\').Replace('"', '\"').Replace("`r", '\r').Replace("`n", '\n') + '"'
}

function Get-MyspeedProbeSource {
    param(
        [Parameter(Mandatory)][ValidatePattern('^MySpeedQualificationEnv[a-f0-9]{32}$')][string]$ServiceName,
        [Parameter(Mandatory)][string]$OutputPath,
        [Parameter(Mandatory)][string]$Nonce
    )

    if ($Nonce -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') {
        throw 'Probe nonce must be a canonical lowercase UUIDv4'
    }
    if (-not [System.IO.Path]::IsPathFullyQualified($OutputPath)) { throw 'Probe output path must be absolute' }

    $appNames = @($script:EXPECTED_ENVIRONMENT.Keys | ForEach-Object { ConvertTo-MyspeedCSharpLiteral $_ }) -join ', '
    $forbiddenExact = @($script:FORBIDDEN_EXACT_NAMES | ForEach-Object {
        ConvertTo-MyspeedCSharpLiteral $_
    }) -join ', '
    $forbiddenPrefixes = @($script:FORBIDDEN_PREFIXES | ForEach-Object {
        ConvertTo-MyspeedCSharpLiteral $_
    }) -join ', '
    $forbiddenFragments = @($script:FORBIDDEN_FRAGMENTS | ForEach-Object {
        ConvertTo-MyspeedCSharpLiteral $_
    }) -join ', '
    $serviceLiteral = ConvertTo-MyspeedCSharpLiteral $ServiceName
    $pathLiteral = ConvertTo-MyspeedCSharpLiteral $OutputPath
    $nonceLiteral = ConvertTo-MyspeedCSharpLiteral $Nonce

    return @"
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;

internal sealed class EnvironmentProbeService : ServiceBase
{
    private const string OutputPath = $pathLiteral;
    private const string Nonce = $nonceLiteral;
    private static readonly string[] AppNames = new string[] { $appNames };
    private static readonly string[] ForbiddenExact = new string[] { $forbiddenExact };
    private static readonly string[] ForbiddenPrefixes = new string[] { $forbiddenPrefixes };
    private static readonly string[] ForbiddenFragments = new string[] { $forbiddenFragments };

    private EnvironmentProbeService()
    {
        ServiceName = $serviceLiteral;
        AutoLog = false;
        CanStop = true;
    }

    private static string Json(string value)
    {
        if (value == null) return "null";
        StringBuilder result = new StringBuilder("\"");
        foreach (char character in value)
        {
            switch (character)
            {
                case '\\': result.Append("\\\\"); break;
                case '\"': result.Append("\\\""); break;
                case '\b': result.Append("\\b"); break;
                case '\f': result.Append("\\f"); break;
                case '\n': result.Append("\\n"); break;
                case '\r': result.Append("\\r"); break;
                case '\t': result.Append("\\t"); break;
                default:
                    if (character < 32) result.Append("\\u" + ((int)character).ToString("x4"));
                    else result.Append(character);
                    break;
            }
        }
        return result.Append('\"').ToString();
    }

    private static bool IsAppName(string name)
    {
        foreach (string allowed in AppNames)
            if (String.Equals(name, allowed, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static bool IsForbidden(string name)
    {
        if (IsAppName(name)) return false;
        foreach (string exact in ForbiddenExact)
            if (String.Equals(name, exact, StringComparison.OrdinalIgnoreCase)) return true;
        foreach (string prefix in ForbiddenPrefixes)
            if (name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return true;
        foreach (string fragment in ForbiddenFragments)
            if (name.IndexOf(fragment, StringComparison.OrdinalIgnoreCase) >= 0) return true;
        return false;
    }

    private static void Capture()
    {
        IDictionary environment = Environment.GetEnvironmentVariables();
        Dictionary<string, string> projection = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        List<string> forbidden = new List<string>();
        foreach (DictionaryEntry entry in environment)
        {
            string name = Convert.ToString(entry.Key);
            if (IsAppName(name)) projection[name] = Convert.ToString(entry.Value);
            if (IsForbidden(name)) forbidden.Add(name);
        }
        forbidden.Sort(StringComparer.OrdinalIgnoreCase);

        StringBuilder json = new StringBuilder();
        json.Append("{\"status\":\"completed\",\"nonce\":").Append(Json(Nonce));
        json.Append(",\"serviceName\":").Append(Json($serviceLiteral));
        json.Append(",\"sid\":").Append(Json(WindowsIdentity.GetCurrent().User.Value));
        json.Append(",\"processId\":").Append(Process.GetCurrentProcess().Id);
        json.Append(",\"projection\":{");
        for (int index = 0; index < AppNames.Length; index++)
        {
            if (index > 0) json.Append(',');
            string value;
            projection.TryGetValue(AppNames[index], out value);
            json.Append(Json(AppNames[index])).Append(':').Append(Json(value));
        }
        json.Append("},\"forbiddenNames\":[");
        for (int index = 0; index < forbidden.Count; index++)
        {
            if (index > 0) json.Append(',');
            json.Append(Json(forbidden[index]));
        }
        json.Append("]}");

        using (FileStream stream = new FileStream(OutputPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        using (StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false)))
            writer.Write(json.ToString());
    }

    protected override void OnStart(string[] arguments) { Capture(); }
    protected override void OnStop() { }

    public static void Main() { ServiceBase.Run(new EnvironmentProbeService()); }
}
"@
}

function Get-MyspeedSha256 {
    param([Parameter(Mandatory)][byte[]]$Bytes)
    $hash = [System.Security.Cryptography.SHA256]::HashData($Bytes)
    return [Convert]::ToHexString($hash).ToLowerInvariant()
}

function Get-MyspeedMachineEnvironmentEntries {
    $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
        [Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
    try {
        $key = $baseKey.OpenSubKey($script:ENVIRONMENT_REGISTRY_PATH, $false)
        if ($null -eq $key) { throw 'Machine environment registry key is unavailable' }
        try {
            $entries = foreach ($name in $key.GetValueNames()) {
                $kind = [string]$key.GetValueKind($name)
                $value = $key.GetValue($name, $null,
                    [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                $serialized = ConvertTo-Json -Compress -Depth 4 -InputObject @($kind, $value)
                [pscustomobject]@{
                    Name = $name
                    Kind = $kind
                    Fingerprint = Get-MyspeedSha256 -Bytes ([Text.Encoding]::UTF8.GetBytes($serialized))
                }
            }
            return @($entries | Sort-Object Name)
        } finally { $key.Dispose() }
    } finally { $baseKey.Dispose() }
}

function Set-MyspeedMachineEnvironmentValue {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Value)
    if (-not $script:EXPECTED_ENVIRONMENT.Contains($Name) -or $script:EXPECTED_ENVIRONMENT[$Name] -cne $Value) {
        throw "Refusing unowned machine environment value: $Name"
    }
    $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
        [Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
    try {
        $key = $baseKey.OpenSubKey($script:ENVIRONMENT_REGISTRY_PATH, $true)
        if ($null -eq $key) { throw 'Machine environment registry key is unavailable for write' }
        try { $key.SetValue($Name, $Value, [Microsoft.Win32.RegistryValueKind]::String) }
        finally { $key.Dispose() }
    } finally { $baseKey.Dispose() }
}

function Remove-MyspeedMachineEnvironmentValue {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$ExpectedValue)
    if (-not $script:EXPECTED_ENVIRONMENT.Contains($Name) -or
        $script:EXPECTED_ENVIRONMENT[$Name] -cne $ExpectedValue) {
        throw "Refusing to remove unowned machine environment value: $Name"
    }
    $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
        [Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
    try {
        $key = $baseKey.OpenSubKey($script:ENVIRONMENT_REGISTRY_PATH, $true)
        if ($null -eq $key) { throw 'Machine environment registry key is unavailable for cleanup' }
        try {
            $matches = @($key.GetValueNames() | Where-Object {
                [string]::Equals($_, $Name, [StringComparison]::OrdinalIgnoreCase)
            })
            if ($matches.Count -ne 1 -or $matches[0] -cne $Name -or
                $key.GetValueKind($Name) -ne [Microsoft.Win32.RegistryValueKind]::String -or
                [string]$key.GetValue($Name, $null,
                    [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -cne $ExpectedValue) {
                throw "Owned machine environment value drifted before removal: $Name"
            }
            $key.DeleteValue($Name, $true)
        }
        finally { $key.Dispose() }
    } finally { $baseKey.Dispose() }
}

function Get-MyspeedMachineTargetProjection {
    $entries = [System.Environment]::GetEnvironmentVariables(
        [System.EnvironmentVariableTarget]::Machine)
    $projection = [ordered]@{}
    foreach ($name in $script:EXPECTED_ENVIRONMENT.Keys) {
        $projection[$name] = if ($entries.Contains($name)) { [string]$entries[$name] } else { $null }
    }
    return [pscustomobject]$projection
}

function Wait-MyspeedCondition {
    param(
        [Parameter(Mandatory)][scriptblock]$Condition,
        [Parameter(Mandatory)][int]$DeadlineSeconds,
        [Parameter(Mandatory)][string]$FailureMessage
    )
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $value = & $Condition
        if ($null -ne $value -and $value -ne $false) { return $value }
        Start-Sleep -Milliseconds $script:POLL_INTERVAL_MILLISECONDS
    } while ($timer.Elapsed.TotalSeconds -lt $DeadlineSeconds)
    throw $FailureMessage
}

function Assert-MyspeedOwnedService {
    param(
        [Parameter(Mandatory)][string]$ServiceName,
        [Parameter(Mandatory)][string]$ExecutablePath,
        [int]$ExpectedProcessId = 0
    )
    $escaped = $ServiceName.Replace("'", "''")
    $service = Get-CimInstance Win32_Service -Filter "Name='$escaped'" -ErrorAction Stop
    $observedPath = ([string]$service.PathName).Trim().Trim('"')
    if ($service.Name -cne $ServiceName -or
        -not [string]::Equals([IO.Path]::GetFullPath($observedPath), [IO.Path]::GetFullPath($ExecutablePath),
            [StringComparison]::OrdinalIgnoreCase) -or
        [string]$service.StartName -cne 'LocalSystem' -or
        ($ExpectedProcessId -gt 0 -and [int]$service.ProcessId -ne $ExpectedProcessId)) {
        throw "Owned service identity mismatch: $ServiceName"
    }
    return $service
}

function New-MyspeedNativeOperations {
    param(
        [Parameter(Mandatory)][string]$ServiceName,
        [Parameter(Mandatory)][string]$SourcePath,
        [Parameter(Mandatory)][string]$ExecutablePath,
        [Parameter(Mandatory)][string]$ProbeResultPath,
        [Parameter(Mandatory)][string]$ProbeSource,
        [Parameter(Mandatory)][string]$Nonce
    )

    $compilerDeadlineMilliseconds = $script:COMPILER_DEADLINE_SECONDS * $script:MILLISECONDS_PER_SECOND
    $serviceStartDeadlineSeconds = $script:SERVICE_START_DEADLINE_SECONDS
    $serviceResultDeadlineSeconds = $script:SERVICE_RESULT_DEADLINE_SECONDS
    $serviceStopDeadlineSeconds = $script:SERVICE_STOP_DEADLINE_SECONDS
    $maximumProbeResultBytes = $script:MAX_PROBE_RESULT_BYTES

    $compile = {
        $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
        if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
            throw 'Pinned inbox x64 C# compiler is unavailable'
        }
        [IO.File]::WriteAllText($SourcePath, $ProbeSource, [Text.UTF8Encoding]::new($false))
        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $compiler
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        foreach ($argument in @('/nologo', '/target:winexe', '/platform:x64', '/optimize+',
            "/out:$ExecutablePath", '/reference:System.ServiceProcess.dll', $SourcePath)) {
            $startInfo.ArgumentList.Add($argument)
        }
        $compilerProcess = [Diagnostics.Process]::new()
        $compilerProcess.StartInfo = $startInfo
        if (-not $compilerProcess.Start()) { throw 'Inbox C# compiler did not start' }
        $stdout = $compilerProcess.StandardOutput.ReadToEndAsync()
        $stderr = $compilerProcess.StandardError.ReadToEndAsync()
        if (-not $compilerProcess.WaitForExit($compilerDeadlineMilliseconds)) {
            try { $compilerProcess.Kill($true) } catch { }
            throw 'Inbox C# compiler exceeded its deadline'
        }
        $compilerExitCode = $compilerProcess.ExitCode
        $stdout.GetAwaiter().GetResult() | Out-Null
        $stderr.GetAwaiter().GetResult() | Out-Null
        if ($compilerExitCode -ne 0 -or -not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
            throw 'Inbox C# compiler failed to produce the inert service probe'
        }
        return [pscustomobject]@{
            sourceSha256 = (Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
            binarySha256 = (Get-FileHash -LiteralPath $ExecutablePath -Algorithm SHA256).Hash.ToLowerInvariant()
            compilerPath = $compiler
            compilerSha256 = (Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash.ToLowerInvariant()
            compilerVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($compiler).FileVersion
        }
    }.GetNewClosure()

    $escapedServiceName = $ServiceName.Replace("'", "''")
    $serviceExists = {
        $null -ne (Get-CimInstance Win32_Service -Filter "Name='$escapedServiceName'" -ErrorAction Stop)
    }.GetNewClosure()
    $create = {
        if (& $serviceExists) { throw "Owned service name already exists: $ServiceName" }
        New-Service -Name $ServiceName -BinaryPathName ('"{0}"' -f $ExecutablePath) `
            -DisplayName $ServiceName -StartupType Manual -ErrorAction Stop | Out-Null
        Assert-MyspeedOwnedService -ServiceName $ServiceName -ExecutablePath $ExecutablePath | Out-Null
    }.GetNewClosure()
    $start = {
        Assert-MyspeedOwnedService -ServiceName $ServiceName -ExecutablePath $ExecutablePath | Out-Null
        $controller = Get-Service -Name $ServiceName -ErrorAction Stop
        try { $controller.Start() }
        finally { $controller.Dispose() }
        $service = Wait-MyspeedCondition -DeadlineSeconds $serviceStartDeadlineSeconds `
            -FailureMessage "Owned service did not start before its deadline: $ServiceName" -Condition {
                $candidate = Assert-MyspeedOwnedService -ServiceName $ServiceName -ExecutablePath $ExecutablePath
                if ($candidate.State -eq 'Running' -and [int]$candidate.ProcessId -gt 0) { return $candidate }
                return $null
            }
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$service.ProcessId)" -ErrorAction Stop
        if (-not [string]::Equals([IO.Path]::GetFullPath([string]$process.ExecutablePath),
            [IO.Path]::GetFullPath($ExecutablePath), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'LocalSystem probe process image identity mismatch at start'
        }
        return [pscustomobject]@{
            processId = [int]$service.ProcessId
            creationDate = [string]$process.CreationDate
            executablePath = [IO.Path]::GetFullPath([string]$process.ExecutablePath)
        }
    }.GetNewClosure()
    $readProbe = {
        param([object]$ExpectedProcess)
        Wait-MyspeedCondition -DeadlineSeconds $serviceResultDeadlineSeconds `
            -FailureMessage 'LocalSystem probe did not produce its bounded result' -Condition {
                if (Test-Path -LiteralPath $ProbeResultPath -PathType Leaf) { return $true }
                return $false
            } | Out-Null
        $bytes = [IO.File]::ReadAllBytes($ProbeResultPath)
        if ($bytes.Length -le 0 -or $bytes.Length -gt $maximumProbeResultBytes) {
            throw 'LocalSystem probe result size is invalid'
        }
        $probe = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json -Depth 8
        if ($probe.nonce -cne $Nonce -or $probe.serviceName -cne $ServiceName -or
            [int]$probe.processId -ne [int]$ExpectedProcess.processId) {
            throw 'LocalSystem probe result identity mismatch'
        }
        return $probe
    }.GetNewClosure()
    $inspectActivity = {
        param([object]$ExpectedProcess)
        $ExpectedProcessId = [int]$ExpectedProcess.processId
        $service = Assert-MyspeedOwnedService -ServiceName $ServiceName -ExecutablePath $ExecutablePath `
            -ExpectedProcessId $ExpectedProcessId
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedProcessId" -ErrorAction Stop
        if (-not [string]::Equals([IO.Path]::GetFullPath([string]$process.ExecutablePath),
            [IO.Path]::GetFullPath($ExecutablePath), [StringComparison]::OrdinalIgnoreCase) -or
            [string]$process.CreationDate -cne [string]$ExpectedProcess.creationDate) {
            throw 'LocalSystem probe process image identity mismatch'
        }
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ExpectedProcessId" -ErrorAction Stop)
        $tcp = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.OwningProcess -eq $ExpectedProcessId })
        $udp = @(Get-NetUDPEndpoint -ErrorAction Stop | Where-Object { $_.OwningProcess -eq $ExpectedProcessId })
        if ($children.Count -ne 0 -or $tcp.Count -ne 0 -or $udp.Count -ne 0) {
            throw 'Inert LocalSystem probe spawned a child or opened a network endpoint'
        }
        return [pscustomobject]@{ childCount = 0; tcpEndpointCount = 0; udpEndpointCount = 0 }
    }.GetNewClosure()
    $cleanupService = {
        param([object]$ExpectedProcess)
        $ExpectedProcessId = if ($null -eq $ExpectedProcess) { 0 } else { [int]$ExpectedProcess.processId }
        $service = Get-CimInstance Win32_Service -Filter "Name='$escapedServiceName'" -ErrorAction Stop
        $ownedPid = $ExpectedProcessId
        if ($ExpectedProcessId -gt 0) {
            $observedProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedProcessId" `
                -ErrorAction Stop
            if ($null -ne $observedProcess -and
                (-not [string]::Equals([IO.Path]::GetFullPath([string]$observedProcess.ExecutablePath),
                    [IO.Path]::GetFullPath($ExecutablePath), [StringComparison]::OrdinalIgnoreCase) -or
                [string]$observedProcess.CreationDate -cne [string]$ExpectedProcess.creationDate)) {
                throw 'Refusing cleanup after owned process identity drift'
            }
        }
        if ($null -ne $service) {
            $owned = Assert-MyspeedOwnedService -ServiceName $ServiceName -ExecutablePath $ExecutablePath
            $observedPid = [int]$owned.ProcessId
            if ($ExpectedProcessId -gt 0 -and $observedPid -gt 0 -and $observedPid -ne $ExpectedProcessId) {
                throw 'Refusing cleanup after owned service PID drift'
            }
            if ($observedPid -gt 0) { $ownedPid = $observedPid }
            if ($owned.State -ne 'Stopped') {
                $controller = Get-Service -Name $ServiceName -ErrorAction Stop
                try { $controller.Stop() }
                finally { $controller.Dispose() }
                Wait-MyspeedCondition -DeadlineSeconds $serviceStopDeadlineSeconds `
                    -FailureMessage "Owned service did not stop before its deadline: $ServiceName" -Condition {
                        $candidate = Assert-MyspeedOwnedService -ServiceName $ServiceName -ExecutablePath $ExecutablePath
                        if ($candidate.State -eq 'Stopped') { return $true }
                        return $false
                    } | Out-Null
            }
        }
        if ($ownedPid -gt 0) {
            Wait-MyspeedCondition -DeadlineSeconds $serviceStopDeadlineSeconds `
                -FailureMessage 'Owned service process remained after stop' -Condition {
                    return $null -eq (Get-CimInstance Win32_Process -Filter "ProcessId=$ownedPid" `
                        -ErrorAction Stop)
                } | Out-Null
        }
        if ($null -ne (Get-CimInstance Win32_Service -Filter "Name='$escapedServiceName'" -ErrorAction Stop)) {
            Assert-MyspeedOwnedService -ServiceName $ServiceName -ExecutablePath $ExecutablePath | Out-Null
            Remove-Service -Name $ServiceName -ErrorAction Stop
            Wait-MyspeedCondition -DeadlineSeconds $serviceStopDeadlineSeconds `
                -FailureMessage "Owned service remained after delete: $ServiceName" -Condition {
                    return $null -eq (Get-CimInstance Win32_Service -Filter "Name='$escapedServiceName'" `
                        -ErrorAction Stop)
                } | Out-Null
        }
        return [pscustomobject]@{ serviceStopped = $true; serviceDeleted = $true; processGone = $true }
    }.GetNewClosure()

    return @{
        SnapshotMachineEnvironment = { Get-MyspeedMachineEnvironmentEntries }
        ReadMachineProjection = { Get-MyspeedMachineTargetProjection }
        SetMachineEnvironmentValue = { param($name, $value) Set-MyspeedMachineEnvironmentValue $name $value }
        RemoveMachineEnvironmentValue = {
            param($name, $value) Remove-MyspeedMachineEnvironmentValue $name $value
        }
        CompileProbe = $compile
        ServiceExists = $serviceExists
        CreateService = $create
        StartService = $start
        ReadProbe = $readProbe
        InspectProbeActivity = $inspectActivity
        CleanupOwnedService = $cleanupService
    }
}

function Invoke-MyspeedServiceEnvironmentCore {
    param(
        [Parameter(Mandatory)][hashtable]$Operations,
        [Parameter(Mandatory)][string]$ServiceName,
        [Parameter(Mandatory)][string]$Nonce,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][string]$SourceSha,
        [Parameter(Mandatory)][string]$EventSha,
        [Parameter(Mandatory)][string]$RunAttempt
    )

    $before = @()
    $inserted = [System.Collections.Generic.List[object]]::new()
    $serviceOwnershipEligible = $false
    $probeProcess = $null
    $compiler = $null
    $activity = $null
    $assessment = [pscustomobject]@{
        status = 'failed'; environmentPassed = $false; expectedProjection = Get-MyspeedExpectedEnvironment
        actualProjection = [pscustomobject]([ordered]@{
            SERVER_HOST = $null; SERVER_PORT = $null; HTTPS_REDIRECT = $null; DB_TYPE = $null
            RUN_TEST_ON_STARTUP = $null; PREVIEW_MODE = $null; ALLOW_NO_PASSWORD = $null
            ALLOW_LOCAL_NODES = $null
        }); forbiddenNames = @(); observedSid = $null; observedProcessId = 0
    }
    $failures = [System.Collections.Generic.List[string]]::new()
    $cleanup = [ordered]@{
        serviceStopped = $false
        serviceDeleted = $false
        processGone = $false
        machineEnvironmentRestored = $false
        unrelatedStateUnchanged = $false
    }

    try {
        $before = @(& $Operations.SnapshotMachineEnvironment)
        Assert-MyspeedMachineEnvironmentPrecondition -Entries $before | Out-Null
        foreach ($entry in $script:EXPECTED_ENVIRONMENT.GetEnumerator()) {
            & $Operations.SetMachineEnvironmentValue $entry.Key $entry.Value
            $inserted.Add([pscustomobject]@{ Name = $entry.Key; Value = $entry.Value })
        }
        $machineProjection = & $Operations.ReadMachineProjection
        foreach ($entry in $script:EXPECTED_ENVIRONMENT.GetEnumerator()) {
            if ($machineProjection.PSObject.Properties[$entry.Key].Value -cne $entry.Value) {
                throw "Inserted machine environment verification failed: $($entry.Key)"
            }
        }
        if (& $Operations.ServiceExists) { throw "Owned service name already exists: $ServiceName" }
        $serviceOwnershipEligible = $true
        $compiler = & $Operations.CompileProbe
        & $Operations.CreateService
        $probeProcess = & $Operations.StartService
        $probe = & $Operations.ReadProbe $probeProcess
        $activity = & $Operations.InspectProbeActivity $probeProcess
        $assessment = Get-MyspeedProbeAssessment -Probe $probe
    } catch {
        $failures.Add('experiment-operation-failed: ' + $_.Exception.Message)
    } finally {
        try {
            if ($serviceOwnershipEligible) {
                $serviceCleanup = & $Operations.CleanupOwnedService $probeProcess
                $cleanup.serviceStopped = [bool]$serviceCleanup.serviceStopped
                $cleanup.serviceDeleted = [bool]$serviceCleanup.serviceDeleted
                $cleanup.processGone = [bool]$serviceCleanup.processGone
            } else {
                $cleanup.serviceStopped = $true
                $cleanup.serviceDeleted = $true
                $cleanup.processGone = $true
            }
        } catch {
            $failures.Add('owned-service-cleanup-failed: ' + $_.Exception.Message)
        }

        $restoreTimer = [Diagnostics.Stopwatch]::StartNew()
        try {
            $beforeRemoval = @(& $Operations.SnapshotMachineEnvironment)
            $unrelatedEqual = Test-MyspeedUnrelatedEnvironmentUnchanged -Before $before -Current $beforeRemoval
            $cleanup.unrelatedStateUnchanged = [bool]$unrelatedEqual
            if (-not $unrelatedEqual) { $failures.Add('unrelated-machine-environment-drift-detected') }
        } catch {
            $failures.Add('machine-environment-pre-removal-check-failed: ' + $_.Exception.Message)
        }
        for ($index = $inserted.Count - 1; $index -ge 0; $index--) {
            try {
                if ($restoreTimer.Elapsed.TotalSeconds -ge $script:MACHINE_ENVIRONMENT_RESTORE_DEADLINE_SECONDS) {
                    throw 'Machine environment restoration exceeded its deadline'
                }
                & $Operations.RemoveMachineEnvironmentValue $inserted[$index].Name $inserted[$index].Value
            } catch {
                $failures.Add('machine-environment-value-cleanup-failed: ' + $_.Exception.Message)
            }
        }
        try {
            $after = @(& $Operations.SnapshotMachineEnvironment)
            $equal = Test-MyspeedEnvironmentSnapshotsEqual -Before $before -After $after
            $cleanup.machineEnvironmentRestored = [bool]$equal
            if (-not $equal) { $failures.Add('machine-environment-drift-detected') }
        } catch {
            $failures.Add('machine-environment-post-removal-check-failed: ' + $_.Exception.Message)
        }
    }

    $cleanupPassed = -not ($cleanup.Values -contains $false)
    $status = if ($failures.Count -eq 0 -and $cleanupPassed) { 'completed' } else { 'failed' }
    $environmentPassed = $status -ceq 'completed' -and [bool]$assessment.environmentPassed
    return [pscustomobject]([ordered]@{
        schemaVersion = 1
        kind = 'myspeed-windows-service-environment'
        status = $status
        environmentPassed = [bool]$environmentPassed
        runId = $RunId
        runAttempt = $RunAttempt
        sourceSha = $SourceSha
        eventSha = $EventSha
        nonce = $Nonce
        serviceName = $ServiceName
        expectedProjection = $assessment.expectedProjection
        actualProjection = $assessment.actualProjection
        forbiddenNames = @($assessment.forbiddenNames)
        probeSid = $assessment.observedSid
        probeProcessId = $assessment.observedProcessId
        compiler = $compiler
        activity = $activity
        cleanup = [pscustomobject]$cleanup
        failures = @($failures)
    })
}

function Invoke-MyspeedHostedServiceEnvironmentExperiment {
    param(
        [Parameter(Mandatory)][string]$ExpectedRunId,
        [Parameter(Mandatory)][string]$ExpectedRunAttempt,
        [Parameter(Mandatory)][string]$ExpectedSourceSha,
        [Parameter(Mandatory)][string]$ExpectedEventSha,
        [Parameter(Mandatory)][string]$Nonce,
        [Parameter(Mandatory)][string]$ManifestPath,
        [Parameter(Mandatory)][string]$EvidencePath
    )

    $context = @{
        GITHUB_ACTIONS = $env:GITHUB_ACTIONS; CI = $env:CI; RUNNER_OS = $env:RUNNER_OS
        RUNNER_ARCH = $env:RUNNER_ARCH; RUNNER_ENVIRONMENT = $env:RUNNER_ENVIRONMENT
        GITHUB_REPOSITORY = $env:GITHUB_REPOSITORY; GITHUB_RUN_ID = $env:GITHUB_RUN_ID
        GITHUB_RUN_ATTEMPT = $env:GITHUB_RUN_ATTEMPT
        GITHUB_SHA = $env:GITHUB_SHA; ImageOS = $env:ImageOS; ImageVersion = $env:ImageVersion
        RUNNER_TEMP = $env:RUNNER_TEMP
    }
    Assert-MyspeedHostedContext -Context $context -ExpectedRunId $ExpectedRunId `
        -ExpectedRunAttempt $ExpectedRunAttempt -ExpectedSourceSha $ExpectedSourceSha `
        -ExpectedEventSha $ExpectedEventSha -Nonce $Nonce | Out-Null
    Assert-MyspeedCanaryClosure -ExpectedRunId $ExpectedRunId -ExpectedRunAttempt $ExpectedRunAttempt `
        -ExpectedSourceSha $ExpectedSourceSha -ExpectedEventSha $ExpectedEventSha -Nonce $Nonce `
        -ManifestPath $ManifestPath | Out-Null

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or
        $identity.User.Value -ceq $script:EXPECTED_LOCALSYSTEM_SID) {
        throw 'Hosted Actions mutator must run as the non-System administrator'
    }

    $runnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
    $workRoot = [IO.Path]::GetFullPath((Join-Path $runnerTemp ($script:WORK_DIRECTORY_PREFIX + $Nonce)))
    if (-not $workRoot.StartsWith($runnerTemp.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Owned work path escapes RUNNER_TEMP'
    }
    $expectedEvidencePath = [IO.Path]::GetFullPath((Join-Path $workRoot $script:RESULT_FILENAME))
    if (-not [string]::Equals([IO.Path]::GetFullPath($EvidencePath), $expectedEvidencePath,
        [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Evidence path is not the exact owned nonce result path'
    }
    if (Test-Path -LiteralPath $workRoot) { throw 'Owned work path already exists' }
    New-Item -ItemType Directory -Path $workRoot -ErrorAction Stop | Out-Null

    $serviceName = 'MySpeedQualificationEnv' + $Nonce.Replace('-', '')
    $sourcePath = Join-Path $workRoot $script:PROBE_SOURCE_FILENAME
    $executablePath = Join-Path $workRoot $script:PROBE_EXECUTABLE_FILENAME
    $probeResultPath = Join-Path $workRoot $script:PROBE_RESULT_FILENAME
    try {
        $probeSource = Get-MyspeedProbeSource -ServiceName $serviceName -OutputPath $probeResultPath -Nonce $Nonce
        $operations = New-MyspeedNativeOperations -ServiceName $serviceName -SourcePath $sourcePath `
            -ExecutablePath $executablePath -ProbeResultPath $probeResultPath -ProbeSource $probeSource -Nonce $Nonce
        $result = Invoke-MyspeedServiceEnvironmentCore -Operations $operations -ServiceName $serviceName `
            -Nonce $Nonce -RunId $ExpectedRunId -RunAttempt $ExpectedRunAttempt -SourceSha $ExpectedSourceSha `
            -EventSha $ExpectedEventSha
    } catch {
        $result = [pscustomobject]([ordered]@{
            schemaVersion = 1; kind = 'myspeed-windows-service-environment'; status = 'failed'
            environmentPassed = $false; runId = $ExpectedRunId; runAttempt = $ExpectedRunAttempt
            sourceSha = $ExpectedSourceSha; eventSha = $ExpectedEventSha; nonce = $Nonce
            serviceName = $serviceName; expectedProjection = Get-MyspeedExpectedEnvironment
            actualProjection = [pscustomobject]([ordered]@{
                SERVER_HOST = $null; SERVER_PORT = $null; HTTPS_REDIRECT = $null; DB_TYPE = $null
                RUN_TEST_ON_STARTUP = $null; PREVIEW_MODE = $null; ALLOW_NO_PASSWORD = $null
                ALLOW_LOCAL_NODES = $null
            }); forbiddenNames = @(); probeSid = $null; probeProcessId = 0; compiler = $null
            activity = $null; cleanup = $null; failures = @('pre-core-failure: ' + $_.Exception.Message)
        })
    }
    $result | Add-Member -NotePropertyName runner -NotePropertyValue ([pscustomobject]([ordered]@{
        imageOS = $env:ImageOS
        imageVersion = $env:ImageVersion
        osBuild = [Environment]::OSVersion.VersionString
        architecture = $env:RUNNER_ARCH
    }))
    $result | Add-Member -NotePropertyName scriptSha256 -NotePropertyValue `
        ((Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant())

    Write-MyspeedCreateNewUtf8Json -Value $result -Path $expectedEvidencePath `
        -MaximumBytes $script:MAX_EVIDENCE_BYTES | Out-Null
    if ($result.status -cne 'completed') { throw 'Hosted service-environment experiment failed; bounded evidence was retained' }
    return $result
}

if ($MyInvocation.InvocationName -ne '.' -and $Mode -ceq 'EmitCanaryClosureManifest') {
    Write-MyspeedCanaryClosureManifest -ExpectedRunId $ExpectedRunId -ExpectedRunAttempt $ExpectedRunAttempt `
        -ExpectedSourceSha $ExpectedSourceSha -ExpectedEventSha $ExpectedEventSha -Nonce $Nonce `
        -ManifestPath $ManifestPath
}

if ($MyInvocation.InvocationName -ne '.' -and $Mode -ceq 'InvokeHostedProbe') {
    if ([string]::IsNullOrWhiteSpace($ExpectedRunId) -or [string]::IsNullOrWhiteSpace($ExpectedRunAttempt) -or
        [string]::IsNullOrWhiteSpace($ExpectedSourceSha) -or [string]::IsNullOrWhiteSpace($ExpectedEventSha) -or
        [string]::IsNullOrWhiteSpace($Nonce) -or [string]::IsNullOrWhiteSpace($ManifestPath) -or
        [string]::IsNullOrWhiteSpace($EvidencePath)) {
        throw 'InvokeHostedProbe requires explicit run, attempt, source, event, nonce, manifest, and evidence inputs'
    }
    Invoke-MyspeedHostedServiceEnvironmentExperiment -ExpectedRunId $ExpectedRunId `
        -ExpectedRunAttempt $ExpectedRunAttempt -ExpectedSourceSha $ExpectedSourceSha `
        -ExpectedEventSha $ExpectedEventSha -Nonce $Nonce -ManifestPath $ManifestPath `
        -EvidencePath $EvidencePath | ConvertTo-Json -Compress -Depth 12
}
