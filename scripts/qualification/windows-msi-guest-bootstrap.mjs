const SCHEMA_VERSION = 1;
const MAX_INPUT_BYTES = 1_048_576;
const MAX_RESULT_BYTES = 1_048_576;
const MAX_SEED_FILES = 128;
const MAX_SEED_FILE_BYTES = 1_073_741_824;
const OPTIONAL_EMPTY_WAL_NAME = "fixture/populated/data/storage.db-wal";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MAX_FAILURE_CHARACTERS = 256;
const SCENARIO_COUNT = 14;
const SEED_MANIFEST_NAME = "seed-manifest.json";
const LAUNCH_REQUEST_NAME = "launch-request.json";
const RESULT_NAME = "result.json";

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, names, label) => {
    if (!isObject(value)) throw new TypeError(`${label} must be an object`);
    const actual = Object.keys(value).sort(); const expected = [...names].sort();
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index]))
        throw new TypeError(`${label} keys differ`);
};
const exactString = (value, pattern, label) => {
    if (typeof value !== "string") throw new TypeError(`${label} differs`);
    const match = pattern.exec(value);
    if (!match || match.index !== 0 || match[0].length !== value.length) throw new TypeError(`${label} differs`);
    return value;
};

const MATRIX_ROW_STAGE = "matrix-row";
const CONTAINMENT_PREFLIGHT_STAGE = "containment-preflight";
const ROW_SEED_KIND = "myspeed-windows-msi-lifecycle-row-seed";
const PREFLIGHT_SEED_KIND = "myspeed-windows-msi-containment-preflight-seed";

const SHARED_BINDINGS = Object.freeze(["nonce", "hostNonce", "sourceSha", "eventSha", "runId",
    "runAttempt", "seedManifestSha256", "launcherRequestSha256"]);

const STAGE_BINDINGS = Object.freeze({
    [MATRIX_ROW_STAGE]: Object.freeze(["scenarioIndex", "scenarioId", "rowRequestSha256",
        "executionManifestSha256"]),
    [CONTAINMENT_PREFLIGHT_STAGE]: Object.freeze(["preflightRequestSha256", "envelopeSha256"])
});

const validateBindings = value => {
    if (!isObject(value)) throw new TypeError("MSI guest bootstrap binding differs");
    const stage = Object.hasOwn(value, "stage") ? value.stage : MATRIX_ROW_STAGE;
    if (typeof stage !== "string" || !Object.hasOwn(STAGE_BINDINGS, stage))
        throw new TypeError("MSI guest bootstrap stage differs");
    exactKeys(value, [...(Object.hasOwn(value, "stage") ? ["stage"] : []), ...SHARED_BINDINGS,
        ...STAGE_BINDINGS[stage]], "MSI guest bootstrap binding");
    exactString(value.nonce, /^[0-9a-f]{32}$/u, "MSI guest bootstrap nonce");
    exactString(value.hostNonce, /^[0-9a-f]{32}$/u, "MSI guest bootstrap host nonce");
    exactString(value.sourceSha, /^[0-9a-f]{40}$/u, "MSI guest bootstrap source SHA");
    exactString(value.eventSha, /^[0-9a-f]{40}$/u, "MSI guest bootstrap event SHA");
    exactString(value.runId, /^[1-9][0-9]{0,19}$/u, "MSI guest bootstrap run ID");
    exactString(value.runAttempt, /^[1-9][0-9]{0,8}$/u, "MSI guest bootstrap run attempt");
    exactString(value.seedManifestSha256, /^[0-9a-f]{64}$/u, "MSI guest bootstrap manifest SHA");
    exactString(value.launcherRequestSha256, /^[0-9a-f]{64}$/u, "MSI guest bootstrap launch SHA");
    if (stage === MATRIX_ROW_STAGE) {
        if (!Number.isSafeInteger(value.scenarioIndex) || value.scenarioIndex < 0
            || value.scenarioIndex >= SCENARIO_COUNT)
            throw new TypeError("MSI guest bootstrap scenario index differs");
        exactString(value.scenarioId, /^[a-z0-9-]{1,96}$/u, "MSI guest bootstrap scenario ID");
        exactString(value.rowRequestSha256, /^[0-9a-f]{64}$/u, "MSI guest bootstrap row request SHA");
        exactString(value.executionManifestSha256, /^[0-9a-f]{64}$/u,
            "MSI guest bootstrap execution manifest SHA");
    } else {
        exactString(value.preflightRequestSha256, /^[0-9a-f]{64}$/u,
            "MSI guest bootstrap preflight request SHA");
        exactString(value.envelopeSha256, /^[0-9a-f]{64}$/u, "MSI guest bootstrap envelope SHA");
    }
    return {...value, stage};
};

/*
 * Each stage's bindings, seed kind, manifest key set and manifest checks. The row stage's text is
 * assembled exactly as it was written inline before, so the script fourteen rows run is unchanged.
 */
const stageText = value => value.stage === MATRIX_ROW_STAGE
    ? {seedKind: ROW_SEED_KIND,
        leading: `$EXPECTED_SCENARIO_INDEX=${value.scenarioIndex}\r\n$EXPECTED_SCENARIO_ID='${value.scenarioId}'\r\n`,
        trailing: `$EXPECTED_ROW_REQUEST_SHA='${value.rowRequestSha256}'\r\n`
            + `$EXPECTED_EXECUTION_MANIFEST_SHA='${value.executionManifestSha256}'\r\n`,
        manifestKeys: `'rowNonce','rowRequestSha256','executionManifestSha256','runAttempt','runId','scenarioId','scenarioIndex',`
            + `'schemaVersion','sourceSha'`,
        manifestChecks: `$manifest.rowNonce -isnot [string] -or $manifest.rowNonce -cne $EXPECTED_NONCE -or `
            + `($manifest.scenarioIndex -isnot [int] -and $manifest.scenarioIndex -isnot [long]) -or `
            + `[int64]$manifest.scenarioIndex -ne $EXPECTED_SCENARIO_INDEX -or `
            + `$manifest.scenarioId -isnot [string] -or $manifest.scenarioId -cne $EXPECTED_SCENARIO_ID -or `
            + `$manifest.rowRequestSha256 -isnot [string] -or `
            + `$manifest.rowRequestSha256 -cne $EXPECTED_ROW_REQUEST_SHA -or `
            + `$manifest.executionManifestSha256 -isnot [string] -or `
            + `$manifest.executionManifestSha256 -cne $EXPECTED_EXECUTION_MANIFEST_SHA -or `}
    : {seedKind: PREFLIGHT_SEED_KIND, leading: "",
        trailing: `$EXPECTED_PREFLIGHT_REQUEST_SHA='${value.preflightRequestSha256}'\r\n`
            + `$EXPECTED_ENVELOPE_SHA='${value.envelopeSha256}'\r\n`,
        manifestKeys: `'guestNonce','preflightRequestSha256','envelopeSha256','runAttempt','runId',`
            + `'schemaVersion','sourceSha'`,
        manifestChecks: `$manifest.guestNonce -isnot [string] -or $manifest.guestNonce -cne $EXPECTED_NONCE -or `
            + `$manifest.preflightRequestSha256 -isnot [string] -or `
            + `$manifest.preflightRequestSha256 -cne $EXPECTED_PREFLIGHT_REQUEST_SHA -or `
            + `$manifest.envelopeSha256 -isnot [string] -or `
            + `$manifest.envelopeSha256 -cne $EXPECTED_ENVELOPE_SHA -or `};

export const renderWindowsMsiGuestBootstrap = bindings => {
    const value = validateBindings(bindings);
    const stage = stageText(value);
    const script = `param([switch]$LibraryMode)\r\n$ErrorActionPreference='Stop'\r\nSet-StrictMode -Version Latest\r\n` +
        `$EXPECTED_NONCE='${value.nonce}'\r\n$EXPECTED_SOURCE_SHA='${value.sourceSha}'\r\n` +
        `$EXPECTED_HOST_NONCE='${value.hostNonce}'\r\n$EXPECTED_EVENT_SHA='${value.eventSha}'\r\n` +
        `$EXPECTED_RUN_ID='${value.runId}'\r\n$EXPECTED_RUN_ATTEMPT='${value.runAttempt}'\r\n` +
        stage.leading +
        `$EXPECTED_SEED_MANIFEST_SHA='${value.seedManifestSha256}'\r\n` +
        `$EXPECTED_LAUNCH_REQUEST_SHA='${value.launcherRequestSha256}'\r\n` +
        stage.trailing +
        `$MAX_INPUT_BYTES=${MAX_INPUT_BYTES}\r\n$MAX_RESULT_BYTES=${MAX_RESULT_BYTES}\r\n` +
        `$MAX_SEED_FILES=${MAX_SEED_FILES}\r\n$MAX_SEED_FILE_BYTES=${MAX_SEED_FILE_BYTES}\r\n` +
        `$OPTIONAL_EMPTY_WAL_NAME='${OPTIONAL_EMPTY_WAL_NAME}'\r\n$EMPTY_SHA256='${EMPTY_SHA256}'\r\n` +
        `$MAX_FAILURE_CHARACTERS=${MAX_FAILURE_CHARACTERS}\r\n` +
        `function Get-MyspeedMsiBootstrapSha([IO.Stream]$Stream){$sha=[Security.Cryptography.SHA256]::Create();` +
        `try{return ([BitConverter]::ToString($sha.ComputeHash($Stream))).Replace('-','').ToLowerInvariant()}` +
        `finally{$sha.Dispose()}}\r\n` +
        `function Get-MyspeedMsiGuestBoundary{` +
        `$seed=@(Get-Volume -FileSystemLabel MYSPEEDSEED -ErrorAction Stop);` +
        `$output=@(Get-Volume -FileSystemLabel MYSPEEDOUT -ErrorAction Stop);` +
        `$physical=@(Get-CimInstance Win32_NetworkAdapter -ErrorAction Stop|Where-Object{$_.PhysicalAdapter -eq $true});` +
        `$enabled=@(Get-NetAdapter -IncludeHidden -ErrorAction Stop|Where-Object{$_.Status -eq 'Up' -and ` +
        `$_.InterfaceDescription -notmatch 'Loopback'});` +
        `$routes=@(Get-NetRoute -ErrorAction Stop|Where-Object{$_.InterfaceAlias -notmatch 'Loopback'});` +
        `if($env:GITHUB_ACTIONS -eq 'true' -or [Environment]::OSVersion.Platform.ToString() -cne 'Win32NT' -or ` +
        `-not [Environment]::Is64BitProcess -or $PSVersionTable.PSVersion.Major -ne 5 -or ` +
        `$PSVersionTable.PSVersion.Minor -ne 1 -or $seed.Count -ne 1 -or ` +
        `[string]$seed[0].DriveType -cne 'CD-ROM' -or $output.Count -ne 1 -or ` +
        `[string]$output[0].DriveType -cne 'Fixed' -or $physical.Count -ne 0 -or $enabled.Count -ne 0 -or ` +
        `$routes.Count -ne 0){throw 'MSI guest bootstrap boundary differs'};` +
        `return [pscustomobject]@{seed=([string]$seed[0].DriveLetter+':\\');` +
        `output=([string]$output[0].DriveLetter+':\\')}}\r\n` +
        `function Read-MyspeedMsiBootstrapJson([string]$Path,[int64]$Maximum,[string]$ExpectedSha){` +
        `$stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{` +
        `if($stream.Length -lt 2 -or $stream.Length -gt $Maximum){throw 'MSI guest bootstrap JSON size differs'};` +
        `$bytes=[byte[]]::new($stream.Length);$offset=0;while($offset -lt $bytes.Length){` +
        `$count=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($count -lt 1){throw 'MSI guest bootstrap JSON truncated'};` +
        `$offset+=$count};$stream.Position=0;if((Get-MyspeedMsiBootstrapSha $stream) -cne $ExpectedSha){` +
        `throw 'MSI guest bootstrap JSON SHA differs'};try{$text=[Text.UTF8Encoding]::new($false,$true).GetString($bytes);` +
        `return [pscustomobject]@{value=($text|ConvertFrom-Json -ErrorAction Stop);bytes=$bytes}}catch{` +
        `throw 'MSI guest bootstrap JSON differs'}}finally{$stream.Dispose()}}\r\n` +
        `function Copy-MyspeedMsiSeedFile([string]$Source,[string]$Target,[int64]$Bytes,[string]$Sha){` +
        `$sourceStream=$null;$targetStream=$null;$created=$false;$complete=$false;try{` +
        `$sourceStream=[IO.File]::Open($Source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);` +
        `if($sourceStream.Length -ne $Bytes -or (Get-MyspeedMsiBootstrapSha $sourceStream) -cne $Sha){` +
        `throw 'MSI guest seed source differs'};$sourceStream.Position=0;` +
        `$targetStream=[IO.File]::Open($Target,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);` +
        `$created=$true;$sourceStream.CopyTo($targetStream,1048576);$targetStream.Flush($true);` +
        `if($targetStream.Length -ne $Bytes){throw 'MSI guest staged input size differs'};$targetStream.Position=0;` +
        `if((Get-MyspeedMsiBootstrapSha $targetStream) -cne $Sha){throw 'MSI guest staged input SHA differs'};` +
        `$complete=$true}finally{if($null -ne $targetStream){$targetStream.Dispose()};` +
        `if($null -ne $sourceStream){$sourceStream.Dispose()};if($created -and -not $complete -and ` +
        `[IO.File]::Exists($Target)){[IO.File]::Delete($Target)}}}\r\n` +
        `function Install-MyspeedMsiGuestInputs([string]$Seed,[string]$InputRoot,[string]$OutputRoot){` +
        `if([IO.Directory]::Exists($InputRoot)-or[IO.File]::Exists($InputRoot)-or` +
        `[IO.Directory]::Exists($OutputRoot)-or[IO.File]::Exists($OutputRoot)){throw 'MSI guest owned root is not fresh'};` +
        `$loaded=Read-MyspeedMsiBootstrapJson (Join-Path $Seed '${SEED_MANIFEST_NAME}') ` +
        `$MAX_INPUT_BYTES $EXPECTED_SEED_MANIFEST_SHA;$manifest=$loaded.value;` +
        `$names=@($manifest.PSObject.Properties.Name|Sort-Object);$expected=@('eventSha','files','hostNonce','kind',` +
        stage.manifestKeys + `|Sort-Object);` +
        `if($names.Count -ne $expected.Count){throw 'MSI guest seed manifest keys differ'};for($i=0;$i -lt $names.Count;$i++){` +
        `if(-not [string]::Equals($names[$i],$expected[$i],[StringComparison]::Ordinal)){` +
        `throw 'MSI guest seed manifest keys differ'}};if($manifest.schemaVersion -ne ${SCHEMA_VERSION} -or ` +
        `$manifest.kind -cne '${stage.seedKind}' -or ` +
        `$manifest.sourceSha -isnot [string] -or $manifest.sourceSha -cne $EXPECTED_SOURCE_SHA -or ` +
        `$manifest.eventSha -isnot [string] -or $manifest.eventSha -cne $EXPECTED_EVENT_SHA -or ` +
        `$manifest.runId -isnot [string] -or $manifest.runId -cne $EXPECTED_RUN_ID -or ` +
        `$manifest.runAttempt -isnot [string] -or $manifest.runAttempt -cne $EXPECTED_RUN_ATTEMPT -or ` +
        `$manifest.hostNonce -isnot [string] -or $manifest.hostNonce -cne $EXPECTED_HOST_NONCE -or ` +
        stage.manifestChecks +
        `$manifest.files -isnot [array] -or $manifest.files.Count -lt 1 -or ` +
        `$manifest.files.Count -gt $MAX_SEED_FILES){throw 'MSI guest seed manifest differs'};` +
        `[void][IO.Directory]::CreateDirectory($InputRoot);[void][IO.Directory]::CreateDirectory($OutputRoot);` +
        `$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal);foreach($file in $manifest.files){` +
        `$fileNames=@($file.PSObject.Properties.Name|Sort-Object);if($fileNames.Count -ne 3 -or ` +
        `$fileNames[0] -cne 'bytes' -or $fileNames[1] -cne 'name' -or $fileNames[2] -cne 'sha256' -or ` +
        `$file.name -isnot [string] -or $file.name -cnotmatch '\\A(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+\\z' -or ` +
        `-not $seen.Add([string]$file.name) -or ($file.bytes -isnot [int] -and $file.bytes -isnot [long]) -or ` +
        `[int64]$file.bytes -lt 0 -or [int64]$file.bytes -gt $MAX_SEED_FILE_BYTES -or ` +
        `$file.sha256 -isnot [string] -or $file.sha256 -cnotmatch '\\A[0-9a-f]{64}\\z'){` +
        `throw 'MSI guest seed file record differs'};$isEmptyWal=([int64]$file.bytes -eq 0 -and ` +
        `$file.name -ceq $OPTIONAL_EMPTY_WAL_NAME -and $file.sha256 -ceq $EMPTY_SHA256);` +
        `if([int64]$file.bytes -eq 0 -and -not $isEmptyWal){throw 'MSI guest empty seed file differs'};` +
        `$target=Join-Path $InputRoot $file.name;` +
        `$parent=[IO.Path]::GetDirectoryName($target);if(-not[IO.Directory]::Exists($parent)){` +
        `[void][IO.Directory]::CreateDirectory($parent)};Copy-MyspeedMsiSeedFile (Join-Path $Seed $file.name) ` +
        `$target ([int64]$file.bytes) ([string]$file.sha256)};` +
        `return [pscustomobject]@{manifest=$manifest;names=@($seen)}}\r\n` +
        `function Remove-MyspeedMsiGuestInputs([string]$Root,$Names){if(-not[IO.Directory]::Exists($Root)){` +
        `return [pscustomobject]@{cleanupProven=$true}};$actual=@([IO.Directory]::GetFiles($Root,'*',` +
        `[IO.SearchOption]::AllDirectories));if($actual.Count -ne $Names.Count){throw 'MSI guest input cleanup inventory differs'};` +
        `foreach($target in $actual){$relative=$target.Substring($Root.Length+1).Replace('\\','/');` +
        `if(([IO.File]::GetAttributes($target)-band[IO.FileAttributes]::ReparsePoint)-ne 0 -or ` +
        `-not $Names.Contains($relative)){throw 'MSI guest input cleanup identity differs'};` +
        `[IO.File]::Delete($target)};$directories=@([IO.Directory]::GetDirectories($Root,'*',` +
        `[IO.SearchOption]::AllDirectories)|Sort-Object {$_.Length} -Descending);foreach($directory in $directories){` +
        `if(([IO.File]::GetAttributes($directory)-band[IO.FileAttributes]::ReparsePoint)-ne 0){` +
        `throw 'MSI guest input cleanup encountered a reparse directory'};[IO.Directory]::Delete($directory,$false)};` +
        `[IO.Directory]::Delete($Root,$false);return ` +
        `[pscustomobject]@{cleanupProven=(-not[IO.Directory]::Exists($Root))}}\r\n` +
        `function Write-MyspeedMsiGuestResult([string]$Path,[byte[]]$Bytes){$stream=[IO.File]::Open($Path,` +
        `[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{` +
        `$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}}\r\n` +
        `function Invoke-MyspeedMsiGuestBootstrap([scriptblock]$Observe={Get-MyspeedMsiGuestBoundary},` +
        `[scriptblock]$Launch={param($Root,$Request). (Join-Path $Root 'windows-msi-guest-runner.ps1') ` +
        `-Mode Library;Invoke-MyspeedMsiGuest $Request},[scriptblock]$Shutdown={Stop-Computer -Force}){` +
        `$failure=$null;$boundary=$null;$inputRoot='C:\\Windows\\Temp\\myspeed-msi-input-'+$EXPECTED_NONCE;` +
        `$outputRoot='C:\\Windows\\Temp\\myspeed-msi-output-'+$EXPECTED_NONCE;$installed=$null;$resultBytes=$null;` +
        `try{$boundary=& $Observe;$installed=Install-MyspeedMsiGuestInputs $boundary.seed $inputRoot $outputRoot;` +
        `$launchLoaded=Read-MyspeedMsiBootstrapJson (Join-Path $inputRoot '${LAUNCH_REQUEST_NAME}') ` +
        `$MAX_INPUT_BYTES $EXPECTED_LAUNCH_REQUEST_SHA;$launch=$launchLoaded.value;if(` +
        `$launch.sourceSha -isnot [string] -or $launch.sourceSha -cne $EXPECTED_SOURCE_SHA -or ` +
        `$launch.eventSha -isnot [string] -or $launch.eventSha -cne $EXPECTED_EVENT_SHA -or ` +
        `$launch.runId -isnot [string] -or $launch.runId -cne $EXPECTED_RUN_ID -or ` +
        `$launch.runAttempt -isnot [string] -or $launch.runAttempt -cne $EXPECTED_RUN_ATTEMPT -or ` +
        `$launch.nonce -isnot [string] -or $launch.nonce -cne $EXPECTED_NONCE){` +
        `throw 'MSI guest launch identity differs'};$launchResult=& $Launch $inputRoot $launch;` +
        `if($launchResult.status -cne 'completed' -or $launchResult.guestRunnerPassed -ne $true -or ` +
        `$launchResult.semanticOutput.path -cne (Join-Path $outputRoot '${RESULT_NAME}')){` +
        `throw 'MSI guest launch result differs'};$semantic=[IO.File]::Open($launchResult.semanticOutput.path,` +
        `[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);try{if($semantic.Length -ne ` +
        `[int64]$launchResult.semanticOutput.bytes -or $semantic.Length -lt 2 -or $semantic.Length -gt $MAX_RESULT_BYTES -or ` +
        `(Get-MyspeedMsiBootstrapSha $semantic) -cne $launchResult.semanticOutput.sha256){` +
        `throw 'MSI guest semantic result differs'};$semantic.Position=0;$resultBytes=[byte[]]::new($semantic.Length);` +
        `$offset=0;while($offset -lt $resultBytes.Length){$count=$semantic.Read($resultBytes,$offset,` +
        `$resultBytes.Length-$offset);if($count -lt 1){throw 'MSI guest semantic result truncated'};$offset+=$count}}` +
        `finally{$semantic.Dispose()}}catch{$failure=$_}finally{try{if($null -ne $installed){` +
        `$cleanup=Remove-MyspeedMsiGuestInputs $inputRoot $installed.names;if($cleanup.cleanupProven -ne $true){` +
        `throw 'MSI guest input cleanup differs'}}}catch{if($null -eq $failure){$failure=$_}};try{` +
        `if($null -ne $boundary){if($null -eq $failure){Write-MyspeedMsiGuestResult ` +
        `(Join-Path $boundary.output '${RESULT_NAME}') $resultBytes}else{` +
        `$message=[regex]::Replace([string]$failure.Exception.Message,'[\\x00-\\x1f\\x7f]+',' ');` +
        `if($message.Length -gt $MAX_FAILURE_CHARACTERS){$message=$message.Substring(0,$MAX_FAILURE_CHARACTERS)};` +
        `$record=[ordered]@{schemaVersion=1;status='failed';nonce=$EXPECTED_NONCE;stage='guest-bootstrap';failure=$message};` +
        `$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($record|ConvertTo-Json -Compress -Depth 4));` +
        `Write-MyspeedMsiGuestResult (Join-Path $boundary.output '${RESULT_NAME}') $bytes}}}` +
        `finally{& $Shutdown}};if($null -ne $failure){throw $failure}}\r\n` +
        `if(-not $LibraryMode){Invoke-MyspeedMsiGuestBootstrap}\r\n`;
    return Buffer.from(script, "utf8");
};

export const WINDOWS_MSI_GUEST_BOOTSTRAP_STAGES = Object.freeze({matrixRow: MATRIX_ROW_STAGE,
    containmentPreflight: CONTAINMENT_PREFLIGHT_STAGE, rowSeedKind: ROW_SEED_KIND,
    preflightSeedKind: PREFLIGHT_SEED_KIND});

export const WINDOWS_MSI_GUEST_BOOTSTRAP_CONSTANTS = Object.freeze({LAUNCH_REQUEST_NAME, MAX_INPUT_BYTES,
    MAX_RESULT_BYTES, MAX_SEED_FILES, MAX_SEED_FILE_BYTES, RESULT_NAME, SEED_MANIFEST_NAME});
