const PROFILE = "baseline-cpu";
const RESULT_NAME = "baseline-result.json";
const CPU_RESULT_NAME = "result.json";
const RUNTIME_BUNDLE_NAME = "guest-runtime.json";
const RUNTIME_INSTALLER_NAME = "runtime-installer.ps1";
const REQUEST_NAME = "request.json";
const EXECUTION_NAME = "execution.json";
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 512 * 1024 * 1024;
const MAX_FIXTURE_BYTES = 64 * 1024 * 1024;
const MAX_FAILURE_CHARACTERS = 512;
const EXECUTOR_TIMEOUT_MILLISECONDS = 14_400_000;
const EXECUTOR_CLEANUP_TIMEOUT_MILLISECONDS = 30_000;
const SUCCESS_EXIT_CODE = 0;
const FAILURE_EXIT_CODE = 1;

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactString = (value, pattern, label) => {
    const match = typeof value === "string" ? pattern.exec(value) : null;
    if (match === null || match.index !== 0 || match[0].length !== value.length)
        throw new TypeError(`${label} differs`);
    return value;
};

function validateBindings(value) {
    const names = ["executionSha256", "nonce", "requestSha256", "runtimeBundleSha256", "sourceSha"];
    if (!isObject(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(names))
        throw new TypeError("baseline bootstrap binding schema differs");
    exactString(value.nonce, /^[0-9a-f]{32}$/u, "baseline bootstrap nonce");
    exactString(value.sourceSha, /^[0-9a-f]{40}$/u, "baseline bootstrap source SHA");
    for (const name of ["executionSha256", "requestSha256", "runtimeBundleSha256"])
        exactString(value[name], /^[0-9a-f]{64}$/u, `baseline bootstrap ${name}`);
    return value;
}

export function renderWindowsBaselineGuestBootstrap(bindings) {
    const value = validateBindings(bindings);
    const script = `param([switch]$LibraryMode)\r\n$ErrorActionPreference='Stop'\r\nSet-StrictMode -Version Latest\r\n` +
        `$EXPECTED_NONCE='${value.nonce}'\r\n$EXPECTED_SOURCE_SHA='${value.sourceSha}'\r\n` +
        `$EXPECTED_REQUEST_SHA='${value.requestSha256}'\r\n$EXPECTED_EXECUTION_SHA='${value.executionSha256}'\r\n` +
        `$EXPECTED_RUNTIME_SHA='${value.runtimeBundleSha256}'\r\n$BASELINE_PROFILE='${PROFILE}'\r\n` +
        `$BASELINE_MAX_RESULT_BYTES=${MAX_RESULT_BYTES}\r\n$BASELINE_MAX_STREAM_BYTES=${MAX_STREAM_BYTES}\r\n` +
        `$BASELINE_MAX_CANDIDATE_BYTES=${MAX_CANDIDATE_BYTES}\r\n` +
        `$BASELINE_MAX_FIXTURE_BYTES=${MAX_FIXTURE_BYTES}\r\n` +
        `$BASELINE_MAX_FAILURE_CHARACTERS=${MAX_FAILURE_CHARACTERS}\r\n` +
        `$BASELINE_EXECUTOR_TIMEOUT=${EXECUTOR_TIMEOUT_MILLISECONDS}\r\n` +
        `$BASELINE_EXECUTOR_CLEANUP_TIMEOUT=${EXECUTOR_CLEANUP_TIMEOUT_MILLISECONDS}\r\n` +
        `function Get-MyspeedActualBaselineGuard{` +
        `$seed=@(Get-Volume -FileSystemLabel MYSPEEDSEED -ErrorAction Stop);` +
        `$output=@(Get-Volume -FileSystemLabel MYSPEEDOUT -ErrorAction Stop);` +
        `$physical=@(Get-CimInstance Win32_NetworkAdapter -ErrorAction Stop|Where-Object{$_.PhysicalAdapter -eq $true});` +
        `$enabled=@(Get-NetAdapter -IncludeHidden -ErrorAction Stop|Where-Object{$_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Loopback'});` +
        `$routes=@(Get-NetRoute -ErrorAction Stop|Where-Object{$_.InterfaceAlias -notmatch 'Loopback'});` +
        `if([Environment]::OSVersion.Platform.ToString() -cne 'Win32NT' -or -not [Environment]::Is64BitProcess -or ` +
        `$PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or ` +
        `$seed.Count -ne 1 -or [string]$seed[0].DriveType -cne 'CD-ROM' -or $output.Count -ne 1 -or ` +
        `[string]$output[0].DriveType -cne 'Fixed' -or $physical.Count -ne 0 -or $enabled.Count -ne 0 -or ` +
        `$routes.Count -ne 0){throw 'Baseline guest boundary differs'};` +
        `return [pscustomobject]@{seed=([string]$seed[0].DriveLetter+':\\');output=([string]$output[0].DriveLetter+':\\')}}\r\n` +
        `function Write-MyspeedExclusive([string]$Path,[byte[]]$Bytes){` +
        `$temporary=$Path+'.tmp';$stream=$null;try{$stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,` +
        `[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true);` +
        `$stream.Position=0;$observed=[byte[]]::new($Bytes.Length);$offset=0;while($offset -lt $observed.Length){` +
        `$count=$stream.Read($observed,$offset,$observed.Length-$offset);if($count -lt 1){throw 'Guest publication was truncated'};` +
        `$offset+=$count};if($stream.Length -ne $Bytes.Length -or -not ` +
        `[Collections.StructuralComparisons]::StructuralEqualityComparer.Equals($observed,$Bytes)){` +
        `throw 'Guest publication verification failed'};$stream.Dispose();$stream=$null;[IO.File]::Move($temporary,$Path)}` +
        `finally{if($null -ne $stream){$stream.Dispose()};if([IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)}}}\r\n` +
        `function Get-MyspeedBaselineSha([IO.Stream]$Stream){$sha=[Security.Cryptography.SHA256]::Create();try{` +
        `$hash=$sha.ComputeHash($Stream);return ([BitConverter]::ToString($hash)).Replace('-','').ToLowerInvariant()}` +
        `finally{$sha.Dispose()}}\r\n` +
        `function Read-MyspeedBaselineExecution([string]$Seed,[string]$InputRoot){` +
        `$path=Join-Path $Seed '${EXECUTION_NAME}';$bytes=[IO.File]::ReadAllBytes($path);` +
        `if($bytes.Length -lt 2 -or $bytes.Length -gt $BASELINE_MAX_RESULT_BYTES){throw 'Baseline execution bytes differ'};` +
        `$stream=[IO.MemoryStream]::new($bytes,$false);try{$digest=Get-MyspeedBaselineSha $stream}finally{$stream.Dispose()};` +
        `if($digest -cne $EXPECTED_EXECUTION_SHA){throw 'Baseline execution SHA differs'};try{` +
        `$value=([Text.UTF8Encoding]::new($false,$true).GetString($bytes)|ConvertFrom-Json)}catch{` +
        `throw 'Baseline execution JSON differs'};$expected=@(` +
        `[pscustomobject]@{label='candidate';record=$value.candidateSource;path=(Join-Path $InputRoot 'MySpeed.exe');` +
        `maximum=$BASELINE_MAX_CANDIDATE_BYTES},[pscustomobject]@{label='fixture';record=$value.fixtureBundle;` +
        `path=(Join-Path $InputRoot 'fixture-bundle.json');maximum=$BASELINE_MAX_FIXTURE_BYTES});` +
        `foreach($entry in $expected){$record=$entry.record;$expectedPath=$entry.path;$maximum=[int64]$entry.maximum;` +
        `if($record.path -isnot [string] -or $record.path -cne $expectedPath){` +
        `throw ('Baseline '+$entry.label+' staged input path differs')};if($record.bytes -isnot [string] -or ` +
        `$record.bytes -cnotmatch '\\A[1-9][0-9]*\\z'){throw ('Baseline '+$entry.label+' staged input bytes differ')};` +
        `if($record.sha256 -isnot [string] -or $record.sha256 -cnotmatch '\\A[0-9a-f]{64}\\z'){` +
        `throw ('Baseline '+$entry.label+' staged input SHA differs')};` +
        `try{$size=[Convert]::ToInt64($record.bytes,[Globalization.CultureInfo]::InvariantCulture)}catch{` +
        `throw 'Baseline staged input size differs'};if($size -lt 1 -or $size -gt $maximum){` +
        `throw 'Baseline staged input size differs'}};return $value}\r\n` +
        `function Copy-MyspeedBaselineInput([string]$Source,[string]$Target,[object]$Identity){` +
        `$sourceStream=$null;$targetStream=$null;$created=$false;$completed=$false;try{` +
        `$sourceStream=[IO.File]::Open($Source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);` +
        `$expected=[Convert]::ToInt64($Identity.bytes,[Globalization.CultureInfo]::InvariantCulture);` +
        `if($sourceStream.Length -ne $expected -or (Get-MyspeedBaselineSha $sourceStream) -cne $Identity.sha256){` +
        `throw 'Baseline seed input differs'};$sourceStream.Position=0;` +
        `$targetStream=[IO.File]::Open($Target,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);` +
        `$created=$true;$sourceStream.CopyTo($targetStream,1048576);$targetStream.Flush($true);` +
        `if($sourceStream.Length -ne $expected -or $targetStream.Length -ne $expected){` +
        `throw 'Baseline staged input length differs'};$targetStream.Position=0;` +
        `if((Get-MyspeedBaselineSha $targetStream) -cne $Identity.sha256){throw 'Baseline staged input SHA differs'};` +
        `$completed=$true}` +
        `finally{if($null -ne $targetStream){$targetStream.Dispose()};if($null -ne $sourceStream){$sourceStream.Dispose()};` +
        `if($created -and -not $completed -and [IO.File]::Exists($Target)){[IO.File]::Delete($Target)}}}\r\n` +
        `function Install-MyspeedBaselineInputs([string]$Seed,[string]$Root){` +
        `if([IO.Directory]::Exists($Root)-or[IO.File]::Exists($Root)){throw 'Baseline input root is not fresh'};` +
        `$execution=Read-MyspeedBaselineExecution $Seed $Root;$created=$false;try{` +
        `$null=[IO.Directory]::CreateDirectory($Root);$created=$true;` +
        `Copy-MyspeedBaselineInput (Join-Path $Seed 'MySpeed.exe') (Join-Path $Root 'MySpeed.exe') ` +
        `$execution.candidateSource;Copy-MyspeedBaselineInput (Join-Path $Seed 'fixture-bundle.json') ` +
        `(Join-Path $Root 'fixture-bundle.json') $execution.fixtureBundle;` +
        `return [pscustomobject]@{installed=$true;root=$Root}}catch{if($created){` +
        `foreach($name in @('MySpeed.exe','fixture-bundle.json')){$target=Join-Path $Root $name;` +
        `if([IO.File]::Exists($target)){[IO.File]::Delete($target)}};if([IO.Directory]::Exists($Root)){` +
        `[IO.Directory]::Delete($Root,$false)}};throw}}\r\n` +
        `function Remove-MyspeedBaselineInputs([string]$Seed,[string]$Root){` +
        `if(-not [IO.Directory]::Exists($Root)){return [pscustomobject]@{cleanupProven=$true}};` +
        `$execution=Read-MyspeedBaselineExecution $Seed $Root;$entries=@([IO.Directory]::GetFileSystemEntries($Root));` +
        `if($entries.Count -ne 2){throw 'Baseline input cleanup inventory differs'};` +
        `$names=@($entries|ForEach-Object{[IO.Path]::GetFileName($_)}|Sort-Object -CaseSensitive);` +
        `if($names[0] -cne 'fixture-bundle.json' -or $names[1] -cne 'MySpeed.exe'){` +
        `throw 'Baseline input cleanup inventory differs'};foreach($pair in @(` +
        `[pscustomobject]@{name='MySpeed.exe';identity=$execution.candidateSource},` +
        `[pscustomobject]@{name='fixture-bundle.json';identity=$execution.fixtureBundle})){` +
        `$target=Join-Path $Root $pair.name;if(([IO.File]::GetAttributes($target)-band[IO.FileAttributes]::ReparsePoint)-ne 0){` +
        `throw 'Baseline input cleanup encountered a reparse point'};$stream=[IO.File]::Open($target,[IO.FileMode]::Open,` +
        `[IO.FileAccess]::Read,[IO.FileShare]::None);try{if($stream.Length -ne [Convert]::ToInt64($pair.identity.bytes,` +
        `[Globalization.CultureInfo]::InvariantCulture)-or(Get-MyspeedBaselineSha $stream)-cne $pair.identity.sha256){` +
        `throw 'Baseline input cleanup identity differs'}}finally{$stream.Dispose()}};` +
        `foreach($name in @('MySpeed.exe','fixture-bundle.json')){[IO.File]::Delete((Join-Path $Root $name))};` +
        `[IO.Directory]::Delete($Root,$false);return [pscustomobject]@{cleanupProven=(-not[IO.Directory]::Exists($Root))}}\r\n` +
        `function Invoke-MyspeedBaselineExecutor([string]$RuntimeRoot,[string]$Seed){` +
        `$result=Join-Path $env:SystemRoot 'Temp\\myspeed-baseline-executor-result.json';` +
        `$stdout=Join-Path $env:SystemRoot 'Temp\\myspeed-baseline-executor.stdout';` +
        `$stderr=Join-Path $env:SystemRoot 'Temp\\myspeed-baseline-executor.stderr';` +
        `foreach($target in @($result,$stdout,$stderr)){if([IO.File]::Exists($target)){throw 'Baseline executor path is not fresh'}};` +
        `$executor=Join-Path $RuntimeRoot 'scripts\\qualification\\windows-baseline-guest-executor.mjs';` +
        `$process=Start-Process -FilePath (Join-Path $Seed 'node.exe') -ArgumentList @($executor,'--request',` +
        `(Join-Path $Seed '${REQUEST_NAME}'),'--request-sha256',$EXPECTED_REQUEST_SHA,'--execution',` +
        `(Join-Path $Seed '${EXECUTION_NAME}'),'--execution-sha256',$EXPECTED_EXECUTION_SHA,'--result',$result) ` +
        `-NoNewWindow -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr;` +
        `try{$null=$process.Handle;if(-not $process.WaitForExit($BASELINE_EXECUTOR_TIMEOUT)){` +
        `$process.Kill();if(-not $process.WaitForExit($BASELINE_EXECUTOR_CLEANUP_TIMEOUT)){` +
        `throw 'Baseline executor cleanup exceeded its deadline'};throw 'Baseline executor exceeded its deadline'};` +
        `$exit=$process.ExitCode;if($exit -isnot [int] -or $exit -notin @(${SUCCESS_EXIT_CODE},${FAILURE_EXIT_CODE})){` +
        `throw 'Baseline executor exit differs'};$stdoutBytes=[IO.File]::ReadAllBytes($stdout);` +
        `$stderrBytes=[IO.File]::ReadAllBytes($stderr);if($stdoutBytes.Length -gt $BASELINE_MAX_STREAM_BYTES -or ` +
        `$stderrBytes.Length -gt $BASELINE_MAX_STREAM_BYTES -or $stdoutBytes.Length -ne 0 -or $stderrBytes.Length -ne 0){` +
        `throw 'Baseline executor streams differ'};$bytes=[IO.File]::ReadAllBytes($result);` +
        `if($bytes.Length -lt 2 -or $bytes.Length -gt $BASELINE_MAX_RESULT_BYTES){throw 'Baseline executor result size differs'};` +
        `try{$semantic=([Text.UTF8Encoding]::new($false,$true).GetString($bytes)|ConvertFrom-Json)}catch{` +
        `throw 'Baseline executor result is invalid'};if($semantic.schemaVersion -ne 1 -or ` +
        `$semantic.profile -cne $BASELINE_PROFILE -or $semantic.status -notin @('observed','failed') -or ` +
        `$semantic.cleanupProven -isnot [bool] -or ($semantic.status -ceq 'observed' -and ` +
        `($exit -ne ${SUCCESS_EXIT_CODE} -or -not $semantic.cleanupProven)) -or ($semantic.status -ceq 'failed' -and ` +
        `$exit -ne ${FAILURE_EXIT_CODE})){throw 'Baseline executor result identity differs'};return $bytes}` +
        `finally{$process.Dispose()}}\r\n` +
        `function Invoke-MyspeedBaselineBootstrap(` +
        `[scriptblock]$ObserveGuard={Get-MyspeedActualBaselineGuard},` +
        `[scriptblock]$ResolveInputRoot={'C:\\Windows\\Temp\\myspeed-baseline-input-'+$EXPECTED_NONCE},` +
        `[scriptblock]$StageInputs={param($Seed,$Root)Install-MyspeedBaselineInputs $Seed $Root},` +
        `[scriptblock]$InstallRuntime={param($Seed,$Root). (Join-Path $Seed '${RUNTIME_INSTALLER_NAME}') -Mode Library;` +
        `Install-MyspeedBaselineRuntimeBundle (Join-Path $Seed '${RUNTIME_BUNDLE_NAME}') $EXPECTED_RUNTIME_SHA ` +
        `$EXPECTED_SOURCE_SHA $EXPECTED_NONCE $Root (Join-Path $env:SystemRoot 'Temp')},` +
        `[scriptblock]$LoadCpu={param($Seed). (Join-Path $Seed 'cpu-calibration.ps1') -LibraryMode;` +
        `New-MyspeedGuestNativeOperations},` +
        `[scriptblock]$StartExecutor={param($Root,$Seed)Invoke-MyspeedBaselineExecutor $Root $Seed},` +
        `[scriptblock]$RemoveRuntime={param($Root,$Seed). (Join-Path $Seed '${RUNTIME_INSTALLER_NAME}') -Mode Library;` +
        `Remove-MyspeedBaselineRuntimeBundle $EXPECTED_SOURCE_SHA ` +
        `$EXPECTED_NONCE $Root (Join-Path $env:SystemRoot 'Temp')},` +
        `[scriptblock]$RemoveInputs={param($Seed,$Root)Remove-MyspeedBaselineInputs $Seed $Root},` +
        `[scriptblock]$Publish={param($Path,$Bytes)Write-MyspeedExclusive $Path $Bytes},` +
        `[scriptblock]$Shutdown={Stop-Computer -Force}){` +
        `$failure=$null;$failureStage='guest-bootstrap';$boundary=$null;$cpuOperations=$null;$cpu=$null;` +
        `$baselineBytes=$null;$runtimeRoot=Join-Path $env:SystemRoot ('Temp\\myspeed-baseline-runtime-'+$EXPECTED_NONCE);` +
        `$inputRoot=& $ResolveInputRoot;if($inputRoot -isnot [string] -or $inputRoot.Length -lt 1){` +
        `throw 'Baseline input root differs'};` +
        `$runtimeInstalled=$false;$inputCleanupRequired=$false;$modeChanged=$false;$previousMode=[uint32]0;` +
        `try{$boundary=& $ObserveGuard;$inputs=& $StageInputs $boundary.seed $inputRoot;` +
        `if($inputs.installed -ne $true -or $inputs.root -cne $inputRoot){throw 'Baseline input staging differs'};` +
        `$inputCleanupRequired=$true;` +
        `$runtime=& $InstallRuntime $boundary.seed $runtimeRoot;` +
        `if($runtime.installed -ne $true -or $runtime.root -cne $runtimeRoot){throw 'Baseline runtime installation differs'};` +
        `$runtimeInstalled=$true;$cpuOperations=& $LoadCpu $boundary.seed;` +
        `$previousMode=& $cpuOperations.SetErrorMode 3;if($previousMode -isnot [uint32]){throw 'Previous error mode is invalid'};` +
        `$modeChanged=$true;$cpu=& $cpuOperations.CollectEvidence $boundary.seed;` +
        `$baselineBytes=& $StartExecutor $runtimeRoot $boundary.seed}` +
        `catch{$failure=$_}` +
        `finally{try{if($runtimeInstalled){try{$cleanup=& $RemoveRuntime $runtimeRoot $boundary.seed;` +
        `if($cleanup.cleanupProven -ne $true){throw 'Baseline runtime cleanup is incomplete'}}catch{if($null -eq $failure){` +
        `$failure=$_;$failureStage='runtime-cleanup'}}};if($inputCleanupRequired){try{` +
        `$inputCleanup=& $RemoveInputs $boundary.seed $inputRoot;if($inputCleanup.cleanupProven -ne $true){` +
        `throw 'Baseline input cleanup is incomplete'}}catch{if($null -eq $failure){$failure=$_;` +
        `$failureStage='input-cleanup'}}}}finally{try{if($modeChanged){try{` +
        `$null=& $cpuOperations.SetErrorMode $previousMode}catch{if($null -eq $failure){$failure=$_;$failureStage='error-mode-restore'}}}}` +
        `finally{try{if($null -ne $boundary){if($null -eq $failure){` +
        `& $Publish (Join-Path $boundary.output '${RESULT_NAME}') $baselineBytes;` +
        `$cpuBytes=[Text.UTF8Encoding]::new($false).GetBytes(($cpu|ConvertTo-Json -Compress -Depth 8));` +
        `& $Publish (Join-Path $boundary.output '${CPU_RESULT_NAME}') $cpuBytes}else{` +
        `$message=[regex]::Replace([string]$failure.Exception.Message,'[\\x00-\\x1f\\x7f]+',' ');` +
        `if($message.Length -gt $BASELINE_MAX_FAILURE_CHARACTERS){` +
        `$message=$message.Substring(0,$BASELINE_MAX_FAILURE_CHARACTERS)};` +
        `if($message.Length -eq 0){$message='unspecified failure'};` +
        `$record=[ordered]@{schemaVersion=1;status='failed';nonce=$EXPECTED_NONCE;stage=$failureStage;failure=$message};` +
        `$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($record|ConvertTo-Json -Compress -Depth 4));` +
        `& $Publish (Join-Path $boundary.output '${CPU_RESULT_NAME}') $bytes}}}` +
        `finally{& $Shutdown}}}};if($null -ne $failure){throw $failure}}\r\n` +
        `if(-not $LibraryMode){Invoke-MyspeedBaselineBootstrap}\r\n`;
    return Buffer.from(script, "utf8");
}

export const WINDOWS_BASELINE_BOOTSTRAP_CONSTANTS = Object.freeze({CPU_RESULT_NAME, EXECUTOR_CLEANUP_TIMEOUT_MILLISECONDS,
    EXECUTOR_TIMEOUT_MILLISECONDS, MAX_CANDIDATE_BYTES, MAX_FAILURE_CHARACTERS, MAX_FIXTURE_BYTES, MAX_RESULT_BYTES,
    MAX_STREAM_BYTES, PROFILE, RESULT_NAME});

