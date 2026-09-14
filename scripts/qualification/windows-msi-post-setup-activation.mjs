import {createHash} from "node:crypto";

const SCHEMA_VERSION = 1;
const REPOSITORY = "i7Gamer/MySpeed";
const SCENARIO_COUNT = 14;
const MAX_HANDOFF_BYTES = 65_536;
const MAX_SETUP_STATE_BYTES = 4_096;
const MAX_SETUP_STATE_POLLS = 600;
const SETUP_STATE_POLL_MILLISECONDS = 1_000;
const MAX_FAILURE_CHARACTERS = 256;
const COPY_BUFFER_BYTES = 1_048_576;
const SETUP_COMPLETE_PATH = "C:\\Windows\\Setup\\Scripts\\SetupComplete.cmd";
const DISPATCHER_PATH = "C:\\Windows\\Setup\\Scripts\\myspeed-msi-setupcomplete.ps1";
const INSTALLER_NAME = "install-activation.ps1";
const BASE_HANDOFF_NAME = "myspeed-base-calibration-handoff.json";
const MSI_HANDOFF_NAME = "myspeed-msi-handoff.json";
const BASELINE_HANDOFF_NAME = "myspeed-baseline-cpu-handoff.json";
const STARTUP_TASK_NAME = "MySpeedQualificationGuestDispatcher";
const STARTUP_TASK_PATH = "\\";
const STARTUP_TASK_ARGUMENTS = `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ` +
    `"${DISPATCHER_PATH}" -Worker`;
const ACTIVATION_IDENTITY = Symbol("validated-windows-msi-setupcomplete-activation");
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const NONCE = /^[0-9a-f]{32}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,19}$/u;

const fail = message => { throw new TypeError(`Invalid MSI post-setup activation: ${message}`); };
const exactKeys = (value, keys, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
        fail(`${label} keys differ`);
};
const exactString = (value, pattern, label) => {
    if (typeof value !== "string") fail(`${label} must be a string`);
    const match = pattern.exec(value);
    if (!match || match.index !== 0 || match[0].length !== value.length) fail(`${label} differs`);
    return value;
};
const deepFreeze = value => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
};
const document = (path, bytes) => ({path, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), bytesBase64: bytes.toString("base64")});
const seedDocument = (name, bytes) => ({name, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), bytesBase64: bytes.toString("base64")});
const startupTask = () => ({name: STARTUP_TASK_NAME, path: STARTUP_TASK_PATH, trigger: "boot",
    principal: "SYSTEM", runLevel: "Highest", executable:
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", arguments: STARTUP_TASK_ARGUMENTS});

const validateContext = value => {
    exactKeys(value, ["repository", "sourceSha", "eventSha", "runId", "runAttempt", "nonce"],
        "host context");
    if (value.repository !== REPOSITORY) fail("host identity differs");
    exactString(value.sourceSha, COMMIT_SHA, "host source SHA");
    exactString(value.eventSha, COMMIT_SHA, "host event SHA");
    exactString(value.runId, POSITIVE_DECIMAL, "host run ID");
    exactString(value.runAttempt, /^[1-9][0-9]{0,9}$/u, "host run attempt");
    exactString(value.nonce, NONCE, "host nonce");
    return structuredClone(value);
};

const renderSetupComplete = () => Buffer.from(`@echo off\r\n` +
    `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile ` +
    `-NonInteractive -ExecutionPolicy Bypass -File "${DISPATCHER_PATH}"\r\n` +
    `exit /b %ERRORLEVEL%\r\n`, "utf8");

const renderInstaller = files => Buffer.from(`$ErrorActionPreference='Stop'\r\n` +
    `Set-StrictMode -Version Latest\r\n` +
    `function Get-MyspeedActivationSha([IO.Stream]$Stream){` +
    `$sha=[Security.Cryptography.SHA256]::Create();try{return ` +
    `([BitConverter]::ToString($sha.ComputeHash($Stream))).Replace('-','').ToLowerInvariant()}` +
    `finally{$sha.Dispose()}}\r\n` +
    `$seed=@(Get-Volume -FileSystemLabel 'MYSPEEDSEED' -ErrorAction Stop);if($seed.Count-ne 1-or` +
    `[string]$seed[0].DriveType-cne'CD-ROM'){throw 'MSI activation seed differs'};` +
    `$seedRoot=[string]$seed[0].DriveLetter+':\\';$targetRoot=Join-Path $env:SystemRoot 'Setup\\Scripts';` +
    `if(-not[IO.Directory]::Exists($targetRoot)){[void][IO.Directory]::CreateDirectory($targetRoot)};` +
    `$root=Get-Item -LiteralPath $targetRoot -Force -ErrorAction Stop;if($root-isnot[IO.DirectoryInfo]-or` +
    `($root.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'MSI activation target differs'};` +
    `$expected=@(` + Object.values(files).map(file =>
        `[pscustomobject]@{name='${file.path.split("\\").at(-1)}';bytes=${file.bytes};sha='${file.sha256}'}`)
        .join(",") + `);foreach($item in $expected){$source=Join-Path $seedRoot $item.name;` +
    `$target=Join-Path $targetRoot $item.name;$sourceItem=Get-Item -LiteralPath $source -Force -ErrorAction Stop;` +
    `if($sourceItem-isnot[IO.FileInfo]-or($sourceItem.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0-or` +
    `$sourceItem.Length-ne[int64]$item.bytes-or[IO.File]::Exists($target)-or[IO.Directory]::Exists($target)){` +
    `throw 'MSI activation file differs'};$sourceStream=$null;$output=$null;$created=$false;$complete=$false;try{` +
    `$sourceStream=[IO.File]::Open($source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);` +
    `if($sourceStream.Length-ne[int64]$item.bytes-or(Get-MyspeedActivationSha $sourceStream)-cne$item.sha){` +
    `throw 'MSI activation source identity differs'};$sourceStream.Position=0;` +
    `$output=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);` +
    `$created=$true;$sourceStream.CopyTo($output,${COPY_BUFFER_BYTES});$output.Flush($true);$output.Position=0;` +
    `if($output.Length-ne[int64]$item.bytes-or(Get-MyspeedActivationSha $output)-cne$item.sha){` +
    `throw 'MSI activation installed identity differs'};$complete=$true}finally{if($output){$output.Dispose()};` +
    `if($sourceStream){$sourceStream.Dispose()};if($created-and-not$complete-and[IO.File]::Exists($target)){` +
    `[IO.File]::Delete($target)}}}\r\n`, "utf8");

const renderDispatcher = context => Buffer.from(`param([switch]$LibraryMode,[switch]$Worker)\r\n` +
    `$ErrorActionPreference='Stop'\r\n` +
    `Set-StrictMode -Version Latest\r\n` +
    `$EXPECTED_REPOSITORY='${context.repository}'\r\n` +
    `$EXPECTED_SOURCE_SHA='${context.sourceSha}'\r\n` +
    `$EXPECTED_EVENT_SHA='${context.eventSha}'\r\n` +
    `$EXPECTED_RUN_ID='${context.runId}'\r\n` +
    `$EXPECTED_RUN_ATTEMPT='${context.runAttempt}'\r\n` +
    `$EXPECTED_HOST_NONCE='${context.nonce}'\r\n` +
    `$MAX_HANDOFF_BYTES=${MAX_HANDOFF_BYTES}\r\n` +
    `$MAX_SETUP_STATE_BYTES=${MAX_SETUP_STATE_BYTES}\r\n` +
    `$MAX_SETUP_STATE_POLLS=${MAX_SETUP_STATE_POLLS}\r\n` +
    `$SETUP_STATE_POLL_MILLISECONDS=${SETUP_STATE_POLL_MILLISECONDS}\r\n` +
    `$MAX_FAILURE_CHARACTERS=${MAX_FAILURE_CHARACTERS}\r\n` +
    `$COMPLETE_SETUP_STATE='IMAGE_STATE_COMPLETE'\r\n` +
    `function Get-MyspeedSetupCompleteSha([IO.Stream]$Stream){` +
    `$sha=[Security.Cryptography.SHA256]::Create();try{return ` +
    `([BitConverter]::ToString($sha.ComputeHash($Stream))).Replace('-','').ToLowerInvariant()}` +
    `finally{$sha.Dispose()}}\r\n` +
    `function Assert-MyspeedSetupCompleteKeys($Value,[string[]]$Expected,[string]$Label){` +
    `$actual=@($Value.PSObject.Properties.Name|Sort-Object);$wanted=@($Expected|Sort-Object);` +
    `if($actual.Count-ne$wanted.Count){throw ($Label+' keys differ')};for($i=0;$i-lt$actual.Count;$i++){` +
    `if(-not[string]::Equals($actual[$i],$wanted[$i],[StringComparison]::Ordinal)){` +
    `throw ($Label+' keys differ')}}}\r\n` +
    `function Read-MyspeedSetupCompleteHandoff([string]$Path){` +
    `$item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop;if($item.PSIsContainer-or` +
    `($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0-or$item.Length-lt 2-or` +
    `$item.Length-gt$MAX_HANDOFF_BYTES){throw 'MSI handoff file differs'};` +
    `$stream=[IO.File]::Open($item.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{` +
    `$bytes=[byte[]]::new($stream.Length);$offset=0;while($offset-lt$bytes.Length){` +
    `$read=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($read-lt 1){throw 'MSI handoff truncated'};` +
    `$offset+=$read};$text=[Text.UTF8Encoding]::new($false,$true).GetString($bytes);` +
    `return ($text|ConvertFrom-Json -ErrorAction Stop)}finally{$stream.Dispose()}}\r\n` +
    `function Get-MyspeedWindowsSetupState{` +
    `$registryPath='Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Setup\\State';` +
    `$registry=Get-ItemProperty -LiteralPath $registryPath -Name ImageState -ErrorAction Stop;` +
    `if($registry.ImageState-isnot[string]){throw 'MSI registry setup state differs'};` +
    `$statePath=Join-Path $env:SystemRoot 'Setup\\State\\State.ini';` +
    `$item=Get-Item -LiteralPath $statePath -Force -ErrorAction Stop;if($item.PSIsContainer-or` +
    `($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0-or$item.Length-lt 2-or` +
    `$item.Length-gt$MAX_SETUP_STATE_BYTES){throw 'MSI file setup state differs'};` +
    `$stream=[IO.File]::Open($item.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{` +
    `$reader=[IO.StreamReader]::new($stream,[Text.UTF8Encoding]::new($false,$true),$true,1024,$true);try{` +
    `$text=$reader.ReadToEnd()}finally{$reader.Dispose()}}finally{$stream.Dispose()};` +
    `$matches=[regex]::Matches($text,'(?m)^\\s*ImageState\\s*=\\s*(?:"(?<quoted>IMAGE_STATE_[A-Z_]+)"|` +
    `(?<plain>IMAGE_STATE_[A-Z_]+))\\s*\\r?$');if($matches.Count-ne 1){` +
    `throw 'MSI file setup state differs'};$fileState=[string]$matches[0].Groups['quoted'].Value;` +
    `if($fileState.Length-eq 0){$fileState=[string]$matches[0].Groups['plain'].Value};` +
    `return [pscustomobject]@{registry=[string]$registry.ImageState;file=$fileState}}\r\n` +
    `function Wait-MyspeedWindowsSetupComplete{param(` +
    `[scriptblock]$ReadState={Get-MyspeedWindowsSetupState},` +
    `[scriptblock]$Sleep={param($Milliseconds) Start-Sleep -Milliseconds $Milliseconds},` +
    `[int]$MaximumPolls=$MAX_SETUP_STATE_POLLS);if($MaximumPolls-lt 1-or` +
    `$MaximumPolls-gt$MAX_SETUP_STATE_POLLS){throw 'MSI setup state poll bound differs'};` +
    `for($poll=0;$poll-lt$MaximumPolls;$poll++){` +
    `$state=& $ReadState;Assert-MyspeedSetupCompleteKeys $state @('registry','file') 'MSI setup state';` +
    `if($state.registry-isnot[string]-or$state.file-isnot[string]){throw 'MSI setup state differs'};` +
    `if($state.registry-ceq$COMPLETE_SETUP_STATE-and$state.file-ceq$COMPLETE_SETUP_STATE){return};` +
    `if($poll+1-lt$MaximumPolls){& $Sleep $SETUP_STATE_POLL_MILLISECONDS}};` +
    `throw 'Windows setup did not complete within the bounded observation interval'}\r\n` +
    `function Get-MyspeedStartupTaskIdentity{` +
    `$tasks=@(Get-ScheduledTask -TaskName '${STARTUP_TASK_NAME}' -TaskPath '${STARTUP_TASK_PATH}' ` +
    `-ErrorAction SilentlyContinue);if($tasks.Count-ne 1){throw 'MSI startup task count differs'};` +
    `$task=$tasks[0];$actions=@($task.Actions);$triggers=@($task.Triggers);if($actions.Count-ne 1-or` +
    `$triggers.Count-ne 1-or[string]$actions[0].Execute-cne` +
    `'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'-or` +
    `[string]$actions[0].Arguments-cne'${STARTUP_TASK_ARGUMENTS}'-or` +
    `[string]$task.Principal.UserId-cne'SYSTEM'-or[string]$task.Principal.RunLevel-cne'Highest'-or` +
    `[string]$triggers[0].CimClass.CimClassName-cne'MSFT_TaskBootTrigger'-or` +
    `$triggers[0].Enabled-ne$true){throw 'MSI startup task identity differs'};return [pscustomobject][ordered]@{` +
    `name='${STARTUP_TASK_NAME}';path='${STARTUP_TASK_PATH}';trigger='boot';principal='SYSTEM';` +
    `runLevel='Highest';executable='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';` +
    `arguments='${STARTUP_TASK_ARGUMENTS}'}}\r\n` +
    `function Install-MyspeedStartupTask{` +
    `$existing=@(Get-ScheduledTask -TaskName '${STARTUP_TASK_NAME}' -TaskPath '${STARTUP_TASK_PATH}' ` +
    `-ErrorAction SilentlyContinue);if($existing.Count-eq 0){` +
    `$action=New-ScheduledTaskAction -Execute ` +
    `'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' ` +
    `-Argument '${STARTUP_TASK_ARGUMENTS}';$trigger=New-ScheduledTaskTrigger -AtStartup;` +
    `$null=Register-ScheduledTask -TaskName '${STARTUP_TASK_NAME}' -TaskPath '${STARTUP_TASK_PATH}' ` +
    `-Action $action -Trigger $trigger -User 'SYSTEM' -RunLevel Highest -Force}` +
    `elseif($existing.Count-ne 1){throw 'MSI startup task count differs'};return Get-MyspeedStartupTaskIdentity}\r\n` +
    `function Write-MyspeedPostSetupFailure($Failure){` +
    `$output=@(Get-Volume -FileSystemLabel 'MYSPEEDOUT' -ErrorAction Stop);if($output.Count-ne 1-or` +
    `[string]$output[0].DriveType-cne'Fixed'){throw 'MSI failure output volume differs'};` +
    `$message=[regex]::Replace([string]$Failure.Exception.Message,'[\\x00-\\x1f\\x7f]+',' ');` +
    `if($message.Length-gt$MAX_FAILURE_CHARACTERS){$message=$message.Substring(0,$MAX_FAILURE_CHARACTERS)};` +
    `$record=[ordered]@{schemaVersion=1;status='failed';hostNonce=$EXPECTED_HOST_NONCE;` +
    `stage='post-setup-completion';failure=$message};` +
    `$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($record|ConvertTo-Json -Compress -Depth 4));` +
    `$path=Join-Path ([string]$output[0].DriveLetter+':\\') 'result.json';` +
    `$stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{` +
    `$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}}\r\n` +
    `function Invoke-MyspeedSetupCompleteDispatch{param($Activation)` +
    `Assert-MyspeedSetupCompleteKeys $Activation @('name','path','trigger','principal','runLevel','executable',` +
    `'arguments') 'MSI startup task';if($Activation.name-cne'${STARTUP_TASK_NAME}'-or` +
    `$Activation.path-cne'${STARTUP_TASK_PATH}'-or$Activation.trigger-cne'boot'-or` +
    `$Activation.principal-cne'SYSTEM'-or$Activation.runLevel-cne'Highest'-or` +
    `$Activation.executable-cne'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'-or` +
    `$Activation.arguments-cne'${STARTUP_TASK_ARGUMENTS}'){throw 'MSI startup task receipt differs'};` +
    `$seed=@(Get-Volume -FileSystemLabel 'MYSPEEDSEED' -ErrorAction Stop);` +
    `$output=@(Get-Volume -FileSystemLabel 'MYSPEEDOUT' -ErrorAction Stop);` +
    `if($seed.Count-ne 1-or[string]$seed[0].DriveType -cne 'CD-ROM'-or$output.Count-ne 1-or` +
    `[string]$output[0].DriveType -cne 'Fixed'){throw 'MSI SetupComplete volumes differ'};` +
    `$seedRoot=[string]$seed[0].DriveLetter+':\\';$outputRoot=[string]$output[0].DriveLetter+':\\';` +
    `$handoffNames=@('${BASE_HANDOFF_NAME}','${MSI_HANDOFF_NAME}','${BASELINE_HANDOFF_NAME}');` +
    `$present=@($handoffNames|Where-Object{[IO.File]::Exists((Join-Path $seedRoot $_))});` +
    `if($present.Count-ne 1){throw 'MSI handoff count differs'};$handoffPath=Join-Path $seedRoot $present[0];` +
    `$handoff=Read-MyspeedSetupCompleteHandoff $handoffPath;` +
    `$isMsi=$handoff.kind-ceq'myspeed-windows-msi-setupcomplete-handoff';` +
    `Assert-MyspeedSetupCompleteKeys $handoff $(if($isMsi){@('schemaVersion','kind','host','row','bootstrap')}` +
    `else{@('schemaVersion','kind','host','bootstrap')}) 'MSI handoff';` +
    `Assert-MyspeedSetupCompleteKeys $handoff.host @('repository','sourceSha','eventSha','runId','runAttempt','nonce') ` +
    `'MSI handoff host';Assert-MyspeedSetupCompleteKeys $handoff.bootstrap @('name','bytes','sha256') ` +
    `'MSI handoff bootstrap';if($handoff.schemaVersion-ne 1-or` +
    `$handoff.kind-notin @('myspeed-windows-base-calibration-handoff',` +
    `'myspeed-windows-msi-setupcomplete-handoff','myspeed-windows-baseline-cpu-handoff')-or` +
    `$handoff.host.repository-cne$EXPECTED_REPOSITORY-or$handoff.host.sourceSha-cne$EXPECTED_SOURCE_SHA-or` +
    `$handoff.host.eventSha-cne$EXPECTED_EVENT_SHA-or$handoff.host.runId-cne$EXPECTED_RUN_ID-or` +
    `$handoff.host.runAttempt-cne$EXPECTED_RUN_ATTEMPT-or$handoff.host.nonce-cne$EXPECTED_HOST_NONCE-or` +
    `($handoff.kind-ceq'myspeed-windows-base-calibration-handoff'-and` +
    `($present[0]-cne'${BASE_HANDOFF_NAME}'-or$handoff.bootstrap.name-cne'bootstrap.ps1'))-or` +
    `($handoff.kind-ceq'myspeed-windows-msi-setupcomplete-handoff'-and$present[0]-cne'${MSI_HANDOFF_NAME}')-or` +
    `($handoff.kind-ceq'myspeed-windows-baseline-cpu-handoff'-and` +
    `($present[0]-cne'${BASELINE_HANDOFF_NAME}'-or$handoff.bootstrap.name-cne'baseline-bootstrap.ps1'))-or` +
    `$handoff.bootstrap.name-isnot[string]-or` +
    `($isMsi-and$handoff.bootstrap.name-cne'bootstrap.ps1')-or` +
    `($handoff.bootstrap.bytes-isnot[int]-and$handoff.bootstrap.bytes-isnot[long])-or` +
    `[int64]$handoff.bootstrap.bytes-lt 1-or[int64]$handoff.bootstrap.bytes-gt 1048576-or` +
    `$handoff.bootstrap.sha256-isnot[string]-or$handoff.bootstrap.sha256-cnotmatch'\\A[0-9a-f]{64}\\z'){` +
    `throw 'MSI handoff identity differs'};if($isMsi){` +
    `Assert-MyspeedSetupCompleteKeys $handoff.row @('nonce','scenarioIndex','scenarioId') 'MSI handoff row';` +
    `if($handoff.row.nonce-isnot[string]-or$handoff.row.nonce-cnotmatch'\\A[0-9a-f]{32}\\z'-or` +
    `$handoff.row.nonce-ceq$EXPECTED_HOST_NONCE-or` +
    `($handoff.row.scenarioIndex-isnot[int]-and$handoff.row.scenarioIndex-isnot[long])-or` +
    `[int64]$handoff.row.scenarioIndex-lt 0-or[int64]$handoff.row.scenarioIndex-ge ${SCENARIO_COUNT}-or` +
    `$handoff.row.scenarioId-isnot[string]-or$handoff.row.scenarioId-cnotmatch'\\A[a-z0-9-]{1,96}\\z'){` +
    `throw 'MSI handoff row identity differs'}};` +
    `$bootstrapPath=Join-Path $seedRoot $handoff.bootstrap.name;$bootstrap=Get-Item -LiteralPath $bootstrapPath ` +
    `-Force -ErrorAction Stop;if($bootstrap.PSIsContainer-or` +
    `($bootstrap.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0-or` +
    `$bootstrap.Length-ne[int64]$handoff.bootstrap.bytes){throw 'MSI bootstrap file differs'};` +
    `$stream=[IO.File]::Open($bootstrap.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);` +
    `try{if((Get-MyspeedSetupCompleteSha $stream)-cne$handoff.bootstrap.sha256){` +
    `throw 'MSI bootstrap SHA differs'}}finally{$stream.Dispose()};` +
    `. $bootstrapPath -LibraryMode;if($handoff.kind-ceq'myspeed-windows-base-calibration-handoff'){` +
    `$command=Get-Command Invoke-MyspeedGuestBootstrap -CommandType Function -ErrorAction Stop;` +
    `if($command.Name-cne'Invoke-MyspeedGuestBootstrap'){throw 'MSI base bootstrap entrypoint differs'};` +
    `Invoke-MyspeedGuestBootstrap}elseif($isMsi){` +
    `$command=Get-Command Invoke-MyspeedMsiGuestBootstrap -CommandType Function -ErrorAction Stop;` +
    `if($command.Name-cne'Invoke-MyspeedMsiGuestBootstrap'){throw 'MSI bootstrap entrypoint differs'};` +
    `Invoke-MyspeedMsiGuestBootstrap}else{` +
    `$command=Get-Command Invoke-MyspeedBaselineBootstrap -CommandType Function -ErrorAction Stop;` +
    `if($command.Name-cne'Invoke-MyspeedBaselineBootstrap'){throw 'Baseline bootstrap entrypoint differs'};` +
    `Invoke-MyspeedBaselineBootstrap};` +
    `$result=Join-Path $outputRoot 'result.json';if(-not[IO.File]::Exists($result)){` +
    `throw 'MSI bootstrap result is absent'}}\r\n` +
    `function Invoke-MyspeedPostSetupWorker{param(` +
    `[scriptblock]$ReadState={Get-MyspeedWindowsSetupState},` +
    `[scriptblock]$Sleep={param($Milliseconds) Start-Sleep -Milliseconds $Milliseconds},` +
    `[scriptblock]$EnsureStartupTask={Install-MyspeedStartupTask},` +
    `[scriptblock]$Dispatch={param($Activation) Invoke-MyspeedSetupCompleteDispatch $Activation},` +
    `[scriptblock]$WriteFailure={param($Failure) Write-MyspeedPostSetupFailure $Failure},` +
    `[int]$MaximumPolls=$MAX_SETUP_STATE_POLLS);try{` +
    `Wait-MyspeedWindowsSetupComplete -ReadState $ReadState -Sleep $Sleep -MaximumPolls $MaximumPolls;` +
    `$activation=& $EnsureStartupTask;return & $Dispatch $activation` +
    `}catch{$workerFailure=$_;try{& $WriteFailure $workerFailure}catch{` +
    `throw [AggregateException]::new('MSI post-setup worker and failure recording failed',` +
    `[Exception[]]@($workerFailure.Exception,$_.Exception))};throw $workerFailure};` +
    `}\r\n` +
    `function Start-MyspeedPostSetupWorker{` +
    `$expectedPath='${DISPATCHER_PATH}';if($PSCommandPath-cne$expectedPath){` +
    `throw 'MSI SetupComplete dispatcher path differs'};` +
    `$powerShell=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe';` +
    `$arguments=@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',` +
    `$expectedPath,'-Worker');Start-Process -FilePath $powerShell -ArgumentList $arguments -WindowStyle Hidden}\r\n` +
    `if($LibraryMode-and$Worker){throw 'MSI dispatcher mode differs'};if(-not$LibraryMode){` +
    `if($Worker){Invoke-MyspeedPostSetupWorker}else{Start-MyspeedPostSetupWorker}}\r\n`,
"utf8");

export const buildWindowsMsiSetupCompleteActivation = input => {
    const context = validateContext(input);
    const files = {setupComplete: document(SETUP_COMPLETE_PATH, renderSetupComplete()),
        dispatcher: document(DISPATCHER_PATH, renderDispatcher(context))};
    const value = {schemaVersion: SCHEMA_VERSION, kind: "myspeed-windows-msi-setupcomplete-activation",
        state: "specialize-installer-prepared", setupCompleted: false, startupTaskInstalled: false,
        nativeMsiExecutionStarted: false, context, files,
        seedInstaller: seedDocument(INSTALLER_NAME, renderInstaller(files)), startupTask: startupTask()};
    Object.defineProperty(value, ACTIVATION_IDENTITY, {value: true});
    return deepFreeze(value);
};

const assertActivation = activation => {
    if (!activation || !Object.isFrozen(activation) || activation[ACTIVATION_IDENTITY] !== true)
        fail("activation must come from the authenticated builder");
};

const validateBootstrap = (bootstrap, expectedName) => {
    exactKeys(bootstrap, ["name", "bytes", "sha256"], "bootstrap identity");
    if (bootstrap.name !== expectedName || !Number.isSafeInteger(bootstrap.bytes)
        || bootstrap.bytes < 1 || bootstrap.bytes > 1_048_576) fail("bootstrap identity differs");
    exactString(bootstrap.sha256, SHA256, "bootstrap SHA-256");
    return structuredClone(bootstrap);
};

export const getCompletedWindowsMsiActivationEvidence = activation => {
    assertActivation(activation);
    const identity = value => ({path: value.path, bytes: value.bytes, sha256: value.sha256});
    return deepFreeze({state: "windows-setup-complete-startup-dispatch-ready", setupCompleted: true,
        startupTaskInstalled: true, nativeMsiExecutionStarted: false,
        files: {setupComplete: identity(activation.files.setupComplete),
            dispatcher: identity(activation.files.dispatcher)}, startupTask: structuredClone(activation.startupTask)});
};

const simpleHandoff = (activation, bootstrap, kind, expectedName) => {
    assertActivation(activation);
    return deepFreeze({schemaVersion: SCHEMA_VERSION, kind, host: structuredClone(activation.context),
        bootstrap: validateBootstrap(bootstrap, expectedName)});
};

export const createWindowsBaseCalibrationHandoff = (activation, bootstrap) => simpleHandoff(activation, bootstrap,
    "myspeed-windows-base-calibration-handoff", "bootstrap.ps1");

export const createWindowsBaselineCpuHandoff = (activation, bootstrap) => simpleHandoff(activation, bootstrap,
    "myspeed-windows-baseline-cpu-handoff", "baseline-bootstrap.ps1");

export const createWindowsMsiSetupCompleteHandoff = (activation, input) => {
    assertActivation(activation);
    exactKeys(input, ["rowNonce", "scenarioIndex", "scenarioId", "bootstrap"], "row handoff");
    exactString(input.rowNonce, NONCE, "row nonce");
    if (input.rowNonce === activation.context.nonce) fail("row nonce reuses the host nonce");
    if (!Number.isSafeInteger(input.scenarioIndex) || input.scenarioIndex < 0
        || input.scenarioIndex >= SCENARIO_COUNT) fail("scenario index differs");
    exactString(input.scenarioId, /^[a-z0-9-]{1,96}$/u, "scenario ID");
    const bootstrap = validateBootstrap(input.bootstrap, "bootstrap.ps1");
    return deepFreeze({schemaVersion: SCHEMA_VERSION, kind: "myspeed-windows-msi-setupcomplete-handoff",
        host: structuredClone(activation.context), row: {nonce: input.rowNonce,
            scenarioIndex: input.scenarioIndex, scenarioId: input.scenarioId},
        bootstrap});
};
