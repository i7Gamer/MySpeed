import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";

import {validateWindowsMsiModernCpuObservation} from "./windows-msi-guest-matrix-row.mjs";

const SUCCESS_EXIT = 0;
const ERROR_CREATING_DESTINATION_FILE = 1310;
const INSTALL_STATE_UNKNOWN = -1;
const INSTALL_STATE_DEFAULT = 5;
const MAX_STREAM_BYTES = 65_536;
const MAX_PROCESS_MILLISECONDS = 900_000;
const MAX_NATIVE_RUNTIME_BYTES = 134_217_728;
const ORACLE_TIMEOUT_MILLISECONDS = 120_000;
const MAX_COMMAND_ARGUMENT_CHARACTERS = 32_768;
const SERVICE_POLL_MILLISECONDS = 100;
const MAX_EVIDENCE_BYTES = 1_048_576;
const STAGE1_PROBE_ARTIFACT_NAME = "windows-cpu-readiness-evidence";
const STAGE1_PROBE_REPOSITORY = "i7Gamer/MySpeed";
const STAGE1_PROBE_ROLES = Object.freeze(["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good",
    "popcnt", "sse42"]);
const SERVICE_NAME = "MySpeed";
const LOOPBACK_ORIGIN = "http://127.0.0.1:5216";
const HANDOFF_SCHEMA_VERSION = 1;
const MAX_FIXTURE_FILES = 64;
const FIXTURE_MARKER = ".myspeed-qualification.json";
const FIXTURE_PING = "123.456";
const FIXTURE_RESULT_ID = "qualification-seed-row";
const PROGRAM_FILES_ROOT = "C:\\Program Files";
const PROGRAM_DATA_ROOT = "C:\\ProgramData";
const INSTALL_ROOT = "C:\\Program Files\\MySpeed";
const INSTALLED_EXE_PATH = "C:\\Program Files\\MySpeed\\MySpeed.exe";
const CONFIGURATION_PATH = "C:\\Program Files\\MySpeed\\MySpeedService.xml";
const SERVICE_WRAPPER_PATH = "C:\\Program Files\\MySpeed\\MySpeedService.exe";
const DATA_ROOT = "C:\\ProgramData\\MySpeed";
const DATABASE_PATH = "C:\\ProgramData\\MySpeed\\data\\storage.db";
const LEGACY_DATA_ROOT = "C:\\Program Files\\MySpeed\\data";
const PRODUCT_BINDINGS = Object.freeze(["candidate-default", "candidate-baseline", "lower-stamp-fixture",
    "safe-rollback-predecessor", "authentic-1.6.0-default-msi", "authentic-1.6.0-baseline-msi",
    "authentic-1.1.0-msi"]);
const OPERATIONS = Object.freeze(["install-candidate", "seed-data", "run-oracle",
    "restart-service-and-run-oracle", "cleanup", "install-source", "install-target",
    "verify-sole-related-product", "install-fixture", "verify-higher-stamp",
    "install-lower-stamp-fixture", "record-product-file-service-and-data-state", "stop-service",
    "damage-owned-executable", "force-repair-executable", "damage-owned-configuration",
    "repair-configuration", "install-predecessor", "inject-post-removal-failure", "verify-rollback",
    "restart-and-run-oracle", "uninstall-source", "verify-product-service-and-program-files-removed",
    "run-oracle-with-preserved-data", "install-contained-predecessor", "remove-containment",
    "run-candidate-oracle", "seed-legacy-data", "verify-one-time-migration",
    "seed-legacy-and-destination-sentinels", "verify-destination-not-overwritten"]);

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys, label) => {
    if (!isObject(value)) throw new Error(`${label} must be an object`);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
        throw new Error(`${label} keys differ`);
    return value;
};
const string = (value, label, pattern = /^.{1,1024}$/u) => {
    if (typeof value !== "string") throw new Error(`${label} differs`);
    const match = pattern.exec(value);
    if (!match || match.index !== 0 || match[0].length !== value.length) throw new Error(`${label} differs`);
    return value;
};
const integer = (value, label, minimum, maximum) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new Error(`${label} differs`);
    return value;
};
const decimal = (value, label) => {
    string(value, label, /^(?:0|[1-9][0-9]{0,23})$/u);
    if (BigInt(value) < 1n) throw new Error(`${label} differs`);
    return value;
};
const hash = (value, label, length = 64) => string(value, label,
    new RegExp(`^[0-9a-f]{${length}}$`, "u"));
const windowsPath = (value, label) => {
    const item = string(value, label, /^[A-Za-z]:\\[^\x00-\x1f\x7f*?]*$/u);
    if (path.win32.normalize(item) !== item || item.slice(2).includes(":")) throw new Error(`${label} differs`);
    return item;
};
const fixtureRelativePath = value => {
    const item = string(value, "MSI guest fixture relative path", /^[A-Za-z0-9._/-]{1,256}$/u);
    if (item.startsWith("/") || item.includes("//") || path.posix.normalize(item) !== item
        || item === ".." || item.startsWith("../")) throw new Error("MSI guest fixture path differs");
    const root = item.split("/", 1)[0];
    if (root !== FIXTURE_MARKER && root !== "data" && root !== "bin")
        throw new Error("MSI guest fixture top-level path differs");
    return item;
};
const fixtureInventory = (value, label) => {
    if (!isObject(value)) throw new Error(`${label} differs`);
    const entries = Object.entries(value);
    if (entries.length < 1 || entries.length > MAX_FIXTURE_FILES) throw new Error(`${label} differs`);
    for (const [relative, digest] of entries) {
        fixtureRelativePath(relative);
        hash(digest, `${label} SHA-256`);
    }
    return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
};
const sha256 = value => createHash("sha256").update(value).digest("hex");
const canonicalBytes = value => Buffer.from(JSON.stringify(value), "utf8");
const bool = (value, label) => {
    if (typeof value !== "boolean") throw new Error(`${label} differs`);
    return value;
};
const productCode = (value, label) => string(value, label,
    /^\{[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$/u);
const sameArguments = (actual, expected, label) => {
    if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index]))
        throw new Error(`${label} arguments differ`);
};
const rollbackArguments = (request, execution, item, predecessor) => ["-NoLogo", "-NoProfile",
    "-NonInteractive", "-File", execution.helpers.rollback.path, "-Mode", "InvokeGuestCandidateRollback",
    "-CandidateMsiPath", item.path, "-CandidateMsiSha256", item.sha256, "-CandidateProductCode",
    item.productCode, "-CandidatePayloadBytes", String(item.exeBytes), "-PredecessorProductCode",
    predecessor.productCode, "-PredecessorPayloadSha256", predecessor.exeSha256, "-EvidenceRoot",
    execution.outputRoot, "-Nonce", request.nonce, "-ExpectedSerial", request.guest.serial,
    "-HelperSha256", execution.helpers.rollback.sha256];
const containmentArguments = (request, execution, action, item) => ["-NoLogo", "-NoProfile",
    "-NonInteractive", "-File", execution.helpers.containment.path, "-Mode", action, "-ProductCode",
    item.productCode, "-MsiPath", item.path, "-MsiSha256", item.sha256, "-EvidenceRoot",
    execution.outputRoot, "-Nonce", request.nonce, "-ExpectedSerial", request.guest.serial,
    "-HelperSha256", execution.helpers.containment.sha256];
const powershellArguments = script => ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
const snapshotScript = manifest => `$ErrorActionPreference='Stop';Add-Type -Name ProductState -Namespace MySpeedGuest -MemberDefinition '[DllImport("msi.dll",CharSet=CharSet.Unicode)] public static extern int MsiQueryProductState(string product);';$products=@();${manifest.artifacts.map(item => `$products+=@{bindingId='${item.bindingId}';state=[MySpeedGuest.ProductState]::MsiQueryProductState('${item.productCode}')`).join(";")};$services=@(Get-CimInstance Win32_Service -Filter "Name='${SERVICE_NAME}'" -ErrorAction Stop);$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object {$_.LocalPort -eq 5216});$listenerProcess=$null;if($listeners.Count -eq 1){$listenerProcess=@(Get-CimInstance Win32_Process -Filter ("ProcessId="+[string]$listeners[0].OwningProcess) -ErrorAction Stop);if($listenerProcess.Count -ne 1){throw 'Listener process identity differs'};$listenerProcess=$listenerProcess[0]};@{products=@($products);serviceCount=$services.Count;serviceState=if($services.Count -eq 1){[string]$services[0].State}else{$null};servicePath=if($services.Count -eq 1){[string]$services[0].PathName}else{$null};serviceStartName=if($services.Count -eq 1){[string]$services[0].StartName}else{$null};servicePid=if($services.Count -eq 1){[long]$services[0].ProcessId}else{$null};listenerCount=$listeners.Count;listenerPid=if($listeners.Count -eq 1){[long]$listeners[0].OwningProcess}else{$null};listenerParentPid=if($null -ne $listenerProcess){[long]$listenerProcess.ParentProcessId}else{$null};listenerImagePath=if($null -ne $listenerProcess){[string]$listenerProcess.ExecutablePath}else{$null};installRootExists=[IO.Directory]::Exists('${manifest.installRoot.replaceAll("'", "''")}');dataRootExists=[IO.Directory]::Exists('${manifest.dataRoot.replaceAll("'", "''")}')}|ConvertTo-Json -Depth 5 -Compress`;
const boundaryScript = serial => `$bios=Get-CimInstance Win32_BIOS -ErrorAction Stop;$computer=Get-CimInstance Win32_ComputerSystem -ErrorAction Stop;$a=@(Get-NetAdapter -IncludeHidden -ErrorAction Stop|Where-Object HardwareInterface);if($bios.SerialNumber -cne '${serial}' -or $computer.Manufacturer -notmatch 'QEMU'){throw 'MSI guest identity differs'};@{networkAdapters=$a.Count;serial=[string]$bios.SerialNumber;manufacturer=[string]$computer.Manufacturer}|ConvertTo-Json -Compress`;
export const createWindowsMsiGuestSnapshotArguments = execution => powershellArguments(snapshotScript(execution));
export const createWindowsMsiGuestBoundaryArguments = serial => powershellArguments(boundaryScript(serial));

export const validateWindowsMsiGuestExecutionManifest = value => {
    exactKeys(value, ["seedRoot", "outputRoot", "programFilesRoot", "programDataRoot", "installRoot", "installedExePath",
        "configurationPath", "serviceWrapperPath", "dataRoot", "databasePath", "legacyDataRoot", "serviceName",
        "origin", "probeArtifact", "tools", "helpers", "artifacts", "fixture", "limits"],
    "MSI guest execution manifest");
    for (const name of ["seedRoot", "outputRoot", "programFilesRoot", "programDataRoot", "installRoot", "installedExePath",
        "configurationPath", "serviceWrapperPath", "dataRoot", "databasePath", "legacyDataRoot"])
        windowsPath(value[name], `MSI guest ${name}`);
    for (const [name, expected] of Object.entries({programFilesRoot: PROGRAM_FILES_ROOT,
        programDataRoot: PROGRAM_DATA_ROOT, installRoot: INSTALL_ROOT, installedExePath: INSTALLED_EXE_PATH,
        configurationPath: CONFIGURATION_PATH, serviceWrapperPath: SERVICE_WRAPPER_PATH,
        dataRoot: DATA_ROOT, databasePath: DATABASE_PATH, legacyDataRoot: LEGACY_DATA_ROOT}))
        if (value[name].toLowerCase() !== expected.toLowerCase()) throw new Error(`MSI guest ${name} differs`);
    if (value.serviceName !== SERVICE_NAME || value.origin !== LOOPBACK_ORIGIN)
        throw new Error("MSI guest service binding differs");
    exactKeys(value.probeArtifact, ["schemaVersion", "repository", "sourceSha", "runId", "runAttempt",
        "artifactId", "artifactName", "archive", "innerManifest", "files"], "MSI guest probe artifact");
    integer(value.probeArtifact.schemaVersion, "MSI guest probe artifact schema", 1, 1);
    if (value.probeArtifact.repository !== STAGE1_PROBE_REPOSITORY
        || value.probeArtifact.artifactName !== STAGE1_PROBE_ARTIFACT_NAME)
        throw new Error("MSI guest probe artifact header differs");
    hash(value.probeArtifact.sourceSha, "MSI guest probe artifact source SHA-256", 40);
    for (const name of ["runId", "runAttempt", "artifactId"])
        string(value.probeArtifact[name], `MSI guest probe artifact ${name}`, /^[1-9][0-9]{0,19}$/u);
    exactKeys(value.probeArtifact.archive, ["bytes", "sha256"], "MSI guest probe artifact archive");
    decimal(value.probeArtifact.archive.bytes, "MSI guest probe artifact archive bytes");
    hash(value.probeArtifact.archive.sha256, "MSI guest probe artifact archive SHA-256");
    exactKeys(value.probeArtifact.innerManifest, ["name", "bytes", "sha256"],
        "MSI guest probe artifact inner manifest");
    if (value.probeArtifact.innerManifest.name !== "result.json")
        throw new Error("MSI guest probe artifact inner manifest name differs");
    decimal(value.probeArtifact.innerManifest.bytes, "MSI guest probe artifact inner manifest bytes");
    hash(value.probeArtifact.innerManifest.sha256, "MSI guest probe artifact inner manifest SHA-256");
    if (!Array.isArray(value.probeArtifact.files)
        || value.probeArtifact.files.length !== STAGE1_PROBE_ROLES.length)
        throw new Error("MSI guest probe artifact files differ");
    value.probeArtifact.files.forEach((file, index) => {
        exactKeys(file, ["role", "name", "bytes", "sha256"], "MSI guest probe artifact file");
        const expectedRole = STAGE1_PROBE_ROLES[index];
        if (file.role !== expectedRole || file.name !== `${expectedRole.replaceAll("-", "_")}.exe`)
            throw new Error("MSI guest probe artifact file order differs");
        decimal(file.bytes, "MSI guest probe artifact file bytes");
        hash(file.sha256, "MSI guest probe artifact file SHA-256");
    });
    exactKeys(value.tools, ["msiexec", "sc", "powershell", "node", "cpuid"], "MSI guest tools");
    for (const [name, tool] of Object.entries(value.tools)) {
        exactKeys(tool, ["path", "bytes", "sha256"], `MSI guest ${name} tool`);
        windowsPath(tool.path, `MSI guest ${name}`);
        integer(tool.bytes, `MSI guest ${name} bytes`, 1, MAX_NATIVE_RUNTIME_BYTES);
        hash(tool.sha256, `MSI guest ${name} SHA-256`);
    }
    const fixedTools = {msiexec: "C:\\Windows\\System32\\msiexec.exe", sc: "C:\\Windows\\System32\\sc.exe",
        powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"};
    for (const [name, expected] of Object.entries(fixedTools))
        if (value.tools[name].path.toLowerCase() !== expected.toLowerCase()) throw new Error(`MSI guest ${name} differs`);
    if (!value.tools.node.path.toLowerCase().startsWith(`${value.seedRoot.toLowerCase()}\\`))
        throw new Error("MSI guest Node escapes seed root");
    const cpuidArtifact = value.probeArtifact.files.find(file => file.role === "cpuid");
    if (value.tools.cpuid.path.toLowerCase() !== `${value.seedRoot}\\cpuid.exe`.toLowerCase()
        || value.tools.cpuid.bytes !== Number(cpuidArtifact.bytes)
        || value.tools.cpuid.sha256 !== cpuidArtifact.sha256)
        throw new Error("MSI guest cpuid tool differs from the Stage1 probe artifact");
    exactKeys(value.helpers, ["oracle", "sqlite", "rollback", "containment"], "MSI guest helpers");
    for (const [name, helper] of Object.entries(value.helpers)) {
        exactKeys(helper, ["path", "bytes", "sha256"], `MSI guest ${name} helper`);
        windowsPath(helper.path, `MSI guest ${name}`);
        integer(helper.bytes, `MSI guest ${name} bytes`, 1, MAX_EVIDENCE_BYTES);
        hash(helper.sha256, `MSI guest ${name} SHA-256`);
        if (!helper.path.toLowerCase().startsWith(`${value.seedRoot.toLowerCase()}\\`))
            throw new Error(`MSI guest ${name} helper escapes seed root`);
    }
    if (!Array.isArray(value.artifacts) || value.artifacts.length !== PRODUCT_BINDINGS.length)
        throw new Error("MSI guest artifacts differ");
    value.artifacts.forEach((artifact, index) => {
        exactKeys(artifact, ["bindingId", "path", "bytes", "sha256", "productCode", "exeBytes", "exeSha256",
            "configurationSha256", "serviceWrapperSha256"], "MSI guest artifact");
        if (artifact.bindingId !== PRODUCT_BINDINGS[index]) throw new Error("MSI guest artifact order differs");
        windowsPath(artifact.path, "MSI guest artifact path");
        if (!artifact.path.toLowerCase().startsWith(`${value.seedRoot.toLowerCase()}\\`))
            throw new Error("MSI guest artifact escapes seed root");
        integer(artifact.bytes, "MSI guest artifact bytes", 1, 1_073_741_824);
        hash(artifact.sha256, "MSI guest artifact SHA-256");
        productCode(artifact.productCode, "MSI guest artifact ProductCode");
        if (artifact.exeBytes !== null) integer(artifact.exeBytes, "MSI guest artifact executable bytes", 1,
            1_073_741_824);
        for (const name of ["exeSha256", "configurationSha256", "serviceWrapperSha256"])
            if (artifact[name] !== null) hash(artifact[name], `MSI guest artifact ${name}`);
        if ((artifact.exeBytes === null) !== (artifact.exeSha256 === null))
            throw new Error("MSI guest artifact executable identity differs");
    });
    if (new Set(value.artifacts.map(item => item.productCode)).size !== value.artifacts.length)
        throw new Error("MSI guest ProductCodes are duplicated");
    exactKeys(value.fixture, ["sourceSha", "populatedRoot", "manifestPath", "manifestSha256", "legacyRoot",
        "populatedMarkerSha256", "populatedDatabaseSha256", "populatedFilesSha256",
        "destinationSentinelSha256", "legacySentinelSha256", "expected"], "MSI guest fixture");
    windowsPath(value.fixture.populatedRoot, "MSI guest populated fixture");
    windowsPath(value.fixture.manifestPath, "MSI guest fixture manifest");
    windowsPath(value.fixture.legacyRoot, "MSI guest legacy fixture");
    for (const fixturePath of [value.fixture.populatedRoot, value.fixture.manifestPath, value.fixture.legacyRoot])
        if (!fixturePath.toLowerCase().startsWith(`${value.seedRoot.toLowerCase()}\\`))
            throw new Error("MSI guest fixture escapes seed root");
    hash(value.fixture.sourceSha, "MSI guest fixture source SHA", 40);
    for (const name of ["manifestSha256", "populatedMarkerSha256", "populatedDatabaseSha256",
        "destinationSentinelSha256", "legacySentinelSha256"])
        hash(value.fixture[name], `MSI guest fixture ${name}`);
    const populatedFiles = fixtureInventory(value.fixture.populatedFilesSha256,
        "MSI guest populated fixture inventory");
    if (populatedFiles[FIXTURE_MARKER] !== value.fixture.populatedMarkerSha256
        || populatedFiles["data/storage.db"] !== value.fixture.populatedDatabaseSha256)
        throw new Error("MSI guest populated fixture distinguished files differ");
    exactKeys(value.fixture.expected, ["ping", "resultId", "passwordValueSha256"],
        "MSI guest fixture expected values");
    if (value.fixture.expected.ping !== FIXTURE_PING
        || value.fixture.expected.resultId !== FIXTURE_RESULT_ID)
        throw new Error("MSI guest fixture expected values differ");
    hash(value.fixture.expected.passwordValueSha256, "MSI guest fixture password hash");
    exactKeys(value.limits, ["processMilliseconds", "streamBytes", "evidenceBytes"], "MSI guest limits");
    integer(value.limits.processMilliseconds, "MSI guest process deadline", 1, MAX_PROCESS_MILLISECONDS);
    integer(value.limits.streamBytes, "MSI guest stream bytes", 1, MAX_STREAM_BYTES);
    integer(value.limits.evidenceBytes, "MSI guest evidence bytes", 1, MAX_EVIDENCE_BYTES);
    return value;
};

export const validateWindowsMsiGuestMatrixFixtureManifest = (value, executionValue, request, actualInventory) => {
    const execution = validateWindowsMsiGuestExecutionManifest(executionValue);
    exactKeys(value, ["schemaVersion", "source", "populated", "reset", "expected"],
        "MSI guest fixture manifest");
    integer(value.schemaVersion, "MSI guest fixture schema", HANDOFF_SCHEMA_VERSION, HANDOFF_SCHEMA_VERSION);
    exactKeys(value.source, ["commit", "bunLockSha256", "packageSha256"], "MSI guest fixture source");
    if (hash(value.source.commit, "MSI guest fixture source commit", 40) !== execution.fixture.sourceSha)
        throw new Error("MSI guest fixture source differs");
    hash(value.source.bunLockSha256, "MSI guest fixture bun lock SHA-256");
    hash(value.source.packageSha256, "MSI guest fixture package SHA-256");
    for (const [name, entry] of [["populated", value.populated], ["reset", value.reset]]) {
        exactKeys(entry, name === "populated"
            ? ["root", "nonce", "markerSha256", "databaseSha256", "filesSha256"]
            : ["root", "nonce", "markerSha256", "filesSha256"], `MSI guest fixture ${name}`);
        string(entry.root, `MSI guest fixture ${name} root`);
        hash(entry.nonce, `MSI guest fixture ${name} nonce`, 48);
        hash(entry.markerSha256, `MSI guest fixture ${name} marker SHA-256`);
        if (name === "populated") hash(entry.databaseSha256, "MSI guest fixture database SHA-256");
        fixtureInventory(entry.filesSha256, `MSI guest fixture ${name} inventory`);
    }
    exactKeys(value.expected, ["ping", "resultId", "passwordValueSha256"], "MSI guest fixture expected");
    hash(value.expected.passwordValueSha256, "MSI guest fixture password SHA-256");
    if (JSON.stringify(value.expected) !== JSON.stringify(execution.fixture.expected))
        throw new Error("MSI guest fixture expected values differ");
    const retained = fixtureInventory(execution.fixture.populatedFilesSha256,
        "MSI guest retained populated fixture inventory");
    const declared = fixtureInventory(value.populated.filesSha256,
        "MSI guest declared populated fixture inventory");
    const observed = fixtureInventory(actualInventory, "MSI guest observed populated fixture inventory");
    if (JSON.stringify(declared) !== JSON.stringify(retained)
        || JSON.stringify(observed) !== JSON.stringify(retained))
        throw new Error("MSI guest fixture populated inventory differs");
    if (value.populated.markerSha256 !== execution.fixture.populatedMarkerSha256
        || value.populated.databaseSha256 !== execution.fixture.populatedDatabaseSha256
        || declared[FIXTURE_MARKER] !== value.populated.markerSha256
        || declared["data/storage.db"] !== value.populated.databaseSha256)
        throw new Error("MSI guest fixture distinguished files differ");
    return value;
};

const validateProbeArtifactContext = (execution, request) => {
    if (execution.probeArtifact.sourceSha !== request.sourceSha
        || execution.probeArtifact.runId !== request.runId
        || execution.probeArtifact.runAttempt !== request.runAttempt)
        throw new Error("MSI guest Stage1 probe artifact context differs");
};

const runProcess = (executable, arguments_, options) => new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {cwd: options.cwd, windowsHide: true, shell: false,
        stdio: ["ignore", "pipe", "pipe"]});
    const chunks = {stdout: [], stderr: []};
    const sizes = {stdout: 0, stderr: 0};
    let overflow = false;
    for (const name of ["stdout", "stderr"]) child[name].on("data", chunk => {
        sizes[name] += chunk.length;
        if (sizes[name] > options.streamBytes) overflow = true;
        else chunks[name].push(chunk);
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error("MSI guest child deadline expired")); },
        options.processMilliseconds);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
        clearTimeout(timer);
        const result = {exitCode: code, stdout: Buffer.concat(chunks.stdout), stderr: Buffer.concat(chunks.stderr)};
        if (overflow) reject(new Error("MSI guest child stream exceeded its bound"));
        else resolve(result);
    });
});

const createDefaultNative = (manifest, request) => {
    const options = {cwd: manifest.outputRoot, processMilliseconds: manifest.limits.processMilliseconds,
        streamBytes: manifest.limits.streamBytes};
    const runBound = async (tool, arguments_) => {
        assertSeedFile(tool.path, tool.bytes, tool.sha256);
        const result = await runProcess(tool.path, arguments_, options);
        assertSeedFile(tool.path, tool.bytes, tool.sha256);
        return {result, receipt: {toolPath: tool.path, toolSha256: tool.sha256,
            arguments: [...arguments_], workingDirectory: options.cwd, exitCode: result.exitCode,
            stdoutBytes: result.stdout.length, stdoutSha256: sha256(result.stdout),
            stderrBytes: result.stderr.length, stderrSha256: sha256(result.stderr)}};
    };
    const run = async (tool, arguments_, accepted = [SUCCESS_EXIT]) => {
        const completed = await runBound(tool, arguments_);
        if (!accepted.includes(completed.result.exitCode)) throw new Error("MSI guest child exit differs");
        return completed.receipt;
    };
    const powershellJson = async script => {
        const completed = await runBound(manifest.tools.powershell,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
        if (completed.result.exitCode !== SUCCESS_EXIT) throw new Error("MSI guest PowerShell query failed");
        return {command: completed.receipt, value: JSON.parse(completed.result.stdout.toString("utf8"))};
    };
    const artifact = bindingId => manifest.artifacts.find(item => item.bindingId === bindingId);
    let verifiedFixture = null;
    const assertSeedFile = (file, bytes, digest) => {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== bytes
            || sha256(fs.readFileSync(file)) !== digest) throw new Error("MSI guest seed identity differs");
    };
    const snapshot = async () => powershellJson(`$ErrorActionPreference='Stop';Add-Type -Name ProductState -Namespace MySpeedGuest -MemberDefinition '[DllImport("msi.dll",CharSet=CharSet.Unicode)] public static extern int MsiQueryProductState(string product);';$products=@();${manifest.artifacts.map(item => `$products+=@{bindingId='${item.bindingId}';state=[MySpeedGuest.ProductState]::MsiQueryProductState('${item.productCode}')}`).join(";")};$services=@(Get-CimInstance Win32_Service -Filter "Name='${SERVICE_NAME}'" -ErrorAction Stop);$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object {$_.LocalPort -eq 5216});$listenerProcess=$null;if($listeners.Count -eq 1){$listenerProcess=@(Get-CimInstance Win32_Process -Filter ("ProcessId="+[string]$listeners[0].OwningProcess) -ErrorAction Stop);if($listenerProcess.Count -ne 1){throw 'Listener process identity differs'};$listenerProcess=$listenerProcess[0]};@{products=@($products);serviceCount=$services.Count;serviceState=if($services.Count -eq 1){[string]$services[0].State}else{$null};servicePath=if($services.Count -eq 1){[string]$services[0].PathName}else{$null};serviceStartName=if($services.Count -eq 1){[string]$services[0].StartName}else{$null};servicePid=if($services.Count -eq 1){[long]$services[0].ProcessId}else{$null};listenerCount=$listeners.Count;listenerPid=if($listeners.Count -eq 1){[long]$listeners[0].OwningProcess}else{$null};listenerParentPid=if($null -ne $listenerProcess){[long]$listenerProcess.ParentProcessId}else{$null};listenerImagePath=if($null -ne $listenerProcess){[string]$listenerProcess.ExecutablePath}else{$null};installRootExists=[IO.Directory]::Exists('${manifest.installRoot.replaceAll("'", "''")}');dataRootExists=[IO.Directory]::Exists('${manifest.dataRoot.replaceAll("'", "''")}')}|ConvertTo-Json -Depth 5 -Compress`);
    const copyTree = (source, destination) => {
        const verify = directory => {
            const rootStat = fs.lstatSync(directory);
            if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("MSI guest fixture root differs");
            for (const name of fs.readdirSync(directory)) {
                const child = path.win32.join(directory, name); const stat = fs.lstatSync(child);
                if (stat.isSymbolicLink()) throw new Error("MSI guest fixture contains a link");
                if (stat.isDirectory()) verify(child);
                else if (!stat.isFile() || stat.nlink !== 1) throw new Error("MSI guest fixture member differs");
            }
        };
        verify(source);
        if (fs.existsSync(destination)) throw new Error("MSI guest fixture destination collision");
        fs.cpSync(source, destination, {recursive: true, errorOnExist: true, force: false});
    };
    const readFixtureInventory = root => {
        const inventory = {};
        const visit = directory => {
            const rootStat = fs.lstatSync(directory);
            if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
                throw new Error("MSI guest fixture root differs");
            for (const name of fs.readdirSync(directory)) {
                const child = path.win32.join(directory, name);
                const stat = fs.lstatSync(child);
                if (stat.isSymbolicLink()) throw new Error("MSI guest fixture contains a link");
                if (stat.isDirectory()) visit(child);
                else if (!stat.isFile() || stat.nlink !== 1) throw new Error("MSI guest fixture member differs");
                else {
                    const relative = path.win32.relative(root, child).replaceAll("\\", "/");
                    fixtureRelativePath(relative);
                    inventory[relative] = sha256(fs.readFileSync(child));
                    if (Object.keys(inventory).length > MAX_FIXTURE_FILES)
                        throw new Error("MSI guest fixture file count exceeded");
                }
            }
        };
        visit(root);
        return Object.fromEntries(Object.entries(inventory).sort(([left], [right]) => left.localeCompare(right)));
    };
    const removeTree = directory => {
        if (!fs.existsSync(directory)) return;
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("MSI guest cleanup root differs");
        for (const name of fs.readdirSync(directory)) {
            const child = path.win32.join(directory, name); const childStat = fs.lstatSync(child);
            if (childStat.isSymbolicLink()) throw new Error("MSI guest cleanup contains a link");
            if (childStat.isDirectory()) removeTree(child);
            else if (!childStat.isFile() || childStat.nlink !== 1) throw new Error("MSI guest cleanup member differs");
            else fs.unlinkSync(child);
        }
        fs.rmdirSync(directory);
    };
    return {
        assertBoundary: async expected => {
        for (const item of Object.values(manifest.tools)) assertSeedFile(item.path, item.bytes, item.sha256);
        for (const item of manifest.artifacts) assertSeedFile(item.path, item.bytes, item.sha256);
            for (const item of Object.values(manifest.helpers)) assertSeedFile(item.path, item.bytes, item.sha256);
            const fixtureBytes = fs.readFileSync(manifest.fixture.manifestPath);
            if (fixtureBytes.length < 2 || fixtureBytes.length > manifest.limits.evidenceBytes
                || sha256(fixtureBytes) !== manifest.fixture.manifestSha256)
                throw new Error("MSI guest fixture manifest identity differs");
            verifiedFixture = validateWindowsMsiGuestMatrixFixtureManifest(
                JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(fixtureBytes)), manifest, request,
                readFixtureInventory(manifest.fixture.populatedRoot));
            const cpu = await runBound(manifest.tools.cpuid, []);
            if (cpu.result.exitCode !== SUCCESS_EXIT || cpu.result.stderr.length !== 0)
                throw new Error("MSI guest CPU probe differs");
            let cpuObservation;
            if (request.schemaVersion === 1) {
                if (!cpu.result.stdout.equals(Buffer.from(request.guest.cpuProbe.bytesBase64, "base64")))
                    throw new Error("MSI guest CPU probe differs");
            } else {
                const record = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(cpu.result.stdout));
                cpuObservation = {bytesBase64: cpu.result.stdout.toString("base64"),
                    sha256: sha256(cpu.result.stdout), record};
                validateWindowsMsiModernCpuObservation(cpuObservation, request.guest.cpuRequirements);
            }
            return {...await powershellJson(`$bios=Get-CimInstance Win32_BIOS -ErrorAction Stop;$computer=Get-CimInstance Win32_ComputerSystem -ErrorAction Stop;$a=@(Get-NetAdapter -IncludeHidden -ErrorAction Stop|Where-Object HardwareInterface);if($bios.SerialNumber -cne '${expected.serial}' -or $computer.Manufacturer -notmatch 'QEMU'){throw 'MSI guest identity differs'};@{networkAdapters=$a.Count;serial=[string]$bios.SerialNumber;manufacturer=[string]$computer.Manufacturer}|ConvertTo-Json -Compress`),
                cpuCommand: cpu.receipt, ...(cpuObservation ? {cpuObservation} : {})};
        },
        snapshot,
        install: async (item, {diagnostic = false} = {}) => {
            const arguments_ = ["/i", item.path, "/qn", "/norestart", "/L*V!",
                path.win32.join(manifest.outputRoot, `install-${item.bindingId}.log`), "REBOOT=ReallySuppress"];
            if (!diagnostic) return run(manifest.tools.msiexec, arguments_);
            const completed = await runBound(manifest.tools.msiexec, arguments_);
            integer(completed.result.exitCode, "MSI guest diagnostic exit", 0, 4_294_967_295);
            return completed.receipt;
        },
        uninstall: item => run(manifest.tools.msiexec, ["/x", item.productCode, "/qn", "/norestart", "/L*V!",
            path.win32.join(manifest.outputRoot, `uninstall-${item.bindingId}.log`), "REBOOT=ReallySuppress"], [0, 1605]),
        repair: (item, mode) => run(manifest.tools.msiexec, [mode, item.productCode, "/qn", "/norestart",
            "/L*V!", path.win32.join(manifest.outputRoot, `repair-${item.bindingId}.log`), "REBOOT=ReallySuppress"]),
        service: action => run(manifest.tools.sc, [action, SERVICE_NAME]),
        seedPopulated: () => {
            if (verifiedFixture === null) throw new Error("MSI guest fixture was not verified");
            if (!fs.existsSync(manifest.dataRoot)) fs.mkdirSync(manifest.dataRoot, {recursive: false});
            else {
                const rootStat = fs.lstatSync(manifest.dataRoot);
                if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
                    throw new Error("MSI guest data root differs");
            }
            for (const ownedName of ["data", "bin"]) {
                const ownedPath = path.win32.join(manifest.dataRoot, ownedName);
                if (fs.existsSync(ownedPath)) removeTree(ownedPath);
            }
            for (const [relative, digest] of Object.entries(verifiedFixture.populated.filesSha256)) {
                const source = path.win32.join(manifest.fixture.populatedRoot, ...relative.split("/"));
                const destination = path.win32.join(manifest.dataRoot, ...relative.split("/"));
                fs.mkdirSync(path.win32.dirname(destination), {recursive: true});
                fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
                if (sha256(fs.readFileSync(destination)) !== digest)
                    throw new Error("MSI guest copied fixture differs");
            }
        },
        seedLegacy: () => copyTree(manifest.fixture.legacyRoot, manifest.legacyDataRoot),
        seedDestinationSentinel: () => { fs.mkdirSync(manifest.dataRoot, {recursive: false}); fs.copyFileSync(path.win32.join(manifest.fixture.populatedRoot, "destination.sentinel"),
            path.win32.join(manifest.dataRoot, "destination.sentinel"), fs.constants.COPYFILE_EXCL); },
        damage: target => { const stat = fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("MSI guest damage target differs"); fs.writeFileSync(target, Buffer.from("MYSPEED_QUALIFICATION_DAMAGE", "ascii"), {flag: "r+"}); fs.truncateSync(target, Buffer.byteLength("MYSPEED_QUALIFICATION_DAMAGE", "ascii")); },
        oracle: async () => { const module = await import(pathToFileURL(manifest.helpers.oracle.path));
            return module.checkPopulatedInstance(LOOPBACK_ORIGIN); },
        database: async () => { const module = await import(pathToFileURL(manifest.helpers.sqlite.path));
            const fixture = JSON.parse(fs.readFileSync(manifest.fixture.manifestPath, "utf8"));
            if (JSON.stringify(fixture.expected) !== JSON.stringify(manifest.fixture.expected))
                throw new Error("MSI guest fixture expected values differ");
            return module.checkPopulatedDatabase(manifest.databasePath, fixture.expected); },
        rollback: async (item, predecessor) => {
            const arguments_ = rollbackArguments(request, manifest, item, predecessor);
            const completed = await runBound(manifest.tools.powershell, arguments_);
            if (completed.result.exitCode !== SUCCESS_EXIT) throw new Error("MSI guest rollback helper failed");
            return {command: completed.receipt, proof: JSON.parse(completed.result.stdout.toString("utf8"))};
        },
        containment: async (action, item) => {
            const arguments_ = containmentArguments(request, manifest, action, item);
            const completed = await runBound(manifest.tools.powershell, arguments_);
            if (completed.result.exitCode !== SUCCESS_EXIT) throw new Error("MSI guest containment helper failed");
            return {command: completed.receipt, proof: JSON.parse(completed.result.stdout.toString("utf8"))};
        },
        removeOwned: () => { for (const item of [manifest.installRoot, manifest.dataRoot]) removeTree(item);
            return {installRootRemoved: !fs.existsSync(manifest.installRoot),
                dataRootRemoved: !fs.existsSync(manifest.dataRoot)}; },
        hashFile: file => fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null,
        writeEvidence: (index, operation, value) => {
            const bytes = canonicalBytes(value);
            if (bytes.length < 1 || bytes.length > manifest.limits.evidenceBytes) throw new Error("MSI guest evidence exceeds its bound");
            const target = path.win32.join(manifest.outputRoot, `${String(index).padStart(2, "0")}-${operation}.json`);
            fs.writeFileSync(target, bytes, {flag: "wx"});
            return {path: target, bytes: bytes.length, sha256: sha256(bytes)};
        },
        artifact
    };
};

const exactCommand = (value, execution, toolName, label, acceptedExitCodes = [SUCCESS_EXIT], allowEmpty = false) => {
    exactKeys(value, ["toolPath", "toolSha256", "arguments", "workingDirectory", "exitCode",
        "stdoutBytes", "stdoutSha256", "stderrBytes", "stderrSha256"], label);
    const tool = execution.tools[toolName];
    if (value.toolPath.toLowerCase() !== tool.path.toLowerCase() || value.toolSha256 !== tool.sha256
        || value.workingDirectory.toLowerCase() !== execution.outputRoot.toLowerCase())
        throw new Error(`${label} tool binding differs`);
    if (!Array.isArray(value.arguments) || (!allowEmpty && value.arguments.length < 1)
        || value.arguments.length > 64)
        throw new Error(`${label} arguments differ`);
    for (const argument of value.arguments)
        if (typeof argument !== "string" || argument.length < 1
            || argument.length > MAX_COMMAND_ARGUMENT_CHARACTERS || argument.includes("\0"))
            throw new Error(`${label} argument differs`);
    integer(value.exitCode, `${label} exit code`, 0, 4_294_967_295);
    if (!acceptedExitCodes.includes(value.exitCode)) throw new Error(`${label} exit code differs`);
    for (const stream of ["stdout", "stderr"]) {
        integer(value[`${stream}Bytes`], `${label} ${stream} bytes`, 0, execution.limits.streamBytes);
        hash(value[`${stream}Sha256`], `${label} ${stream} SHA-256`);
    }
    return value;
};

const exactSnapshot = (value, execution) => {
    exactKeys(value, ["products", "serviceCount", "serviceState", "servicePath", "serviceStartName",
        "servicePid", "listenerCount", "listenerPid", "listenerParentPid", "listenerImagePath",
        "installRootExists", "dataRootExists", "observationCommand"], "MSI guest state snapshot");
    if (!Array.isArray(value.products) || value.products.length !== PRODUCT_BINDINGS.length)
        throw new Error("MSI guest product snapshot differs");
    value.products.forEach((entry, index) => {
        exactKeys(entry, ["bindingId", "state"], "MSI guest product state");
        if (entry.bindingId !== PRODUCT_BINDINGS[index]) throw new Error("MSI guest product order differs");
        integer(entry.state, "MSI guest product state", INSTALL_STATE_UNKNOWN, INSTALL_STATE_DEFAULT);
    });
    integer(value.serviceCount, "MSI guest service count", 0, 1);
    integer(value.listenerCount, "MSI guest listener count", 0, 1);
    for (const name of ["servicePid", "listenerPid", "listenerParentPid"])
        if (value[name] !== null) integer(value[name], `MSI guest ${name}`, 0, 4_294_967_295);
    for (const name of ["serviceState", "servicePath", "serviceStartName", "listenerImagePath"])
        if (value[name] !== null) string(value[name], `MSI guest ${name}`);
    if (typeof value.installRootExists !== "boolean" || typeof value.dataRootExists !== "boolean")
        throw new Error("MSI guest path state differs");
    exactCommand(value.observationCommand, execution, "powershell", "MSI guest state observation");
    sameArguments(value.observationCommand.arguments, createWindowsMsiGuestSnapshotArguments(execution),
        "MSI guest state observation");
    return value;
};

const scenarioBinding = (name, candidateAlias) => {
    if (name === "empty") return null;
    if (name.startsWith("candidate-default")) return "candidate-default";
    if (name.startsWith("candidate-baseline")) return "candidate-baseline";
    if (name === "authentic-1.1.0-msi-with-destination-data") return "authentic-1.1.0-msi";
    if (name === "candidate") return `candidate-${candidateAlias}`;
    return name;
};

const installed = (snapshot, bindingId) => snapshot.products.find(item => item.bindingId === bindingId)?.state === INSTALL_STATE_DEFAULT;
const absent = (snapshot, bindingId) => snapshot.products.find(item => item.bindingId === bindingId)?.state === INSTALL_STATE_UNKNOWN;

const exactOracle = value => {
    exactKeys(value, ["elapsedMs"], "MSI guest HTTP oracle");
    integer(value.elapsedMs, "MSI guest HTTP oracle elapsed", 0, ORACLE_TIMEOUT_MILLISECONDS);
    return value;
};

const exactDatabase = (value, execution) => {
    exactKeys(value, ["ping", "resultId", "passwordValueSha256"], "MSI guest database oracle");
    if (value.ping !== execution.fixture.expected.ping
        || value.resultId !== execution.fixture.expected.resultId
        || value.passwordValueSha256 !== execution.fixture.expected.passwordValueSha256)
        throw new Error("MSI guest database oracle differs");
    return value;
};

const exactMsiCommand = (value, execution, action, item, accepted = [SUCCESS_EXIT]) => {
    exactCommand(value, execution, "msiexec", "MSI guest MSI command", accepted);
    const logKind = action === "/i" ? "install" : action === "/x" ? "uninstall" : "repair";
    const target = action === "/i" ? item.path : item.productCode;
    const expected = [action, target, "/qn", "/norestart", "/L*V!",
        path.win32.join(execution.outputRoot, `${logKind}-${item.bindingId}.log`), "REBOOT=ReallySuppress"];
    if (value.arguments.length !== expected.length
        || value.arguments.some((argument, index) => argument !== expected[index]))
        throw new Error("MSI guest MSI command arguments differ");
    return value;
};

const exactServiceCommand = (value, execution, action) => {
    exactCommand(value, execution, "sc", "MSI guest service command");
    if (value.arguments.length !== 2 || value.arguments[0] !== action || value.arguments[1] !== SERVICE_NAME)
        throw new Error("MSI guest service command arguments differ");
    return value;
};

const exactRollbackProof = value => {
    exactKeys(value, ["accepted", "errorCode", "installContextBalanced", "securityRestored",
        "predecessorRestored", "candidateAbsent", "recordsSha256"], "MSI rollback proof");
    hash(value.recordsSha256, "MSI rollback records SHA-256");
    if (value.accepted !== true || value.errorCode !== ERROR_CREATING_DESTINATION_FILE
        || value.installContextBalanced !== true || value.securityRestored !== true
        || value.predecessorRestored !== true || value.candidateAbsent !== true)
        throw new Error("MSI rollback proof differs");
    return value;
};

const exactContainmentProof = (value, item, mode) => {
    exactKeys(value, ["status", "mode", "productCode", "ifeoActive", "oldPayloadExecutionCount",
        "registryRestored", "launchInventorySha256"], "MSI containment proof");
    hash(value.launchInventorySha256, "MSI containment inventory SHA-256");
    if (value.status !== "completed" || value.mode !== mode || value.productCode !== item.productCode
        || value.ifeoActive !== (mode === "Install") || value.oldPayloadExecutionCount !== 0
        || value.registryRestored !== (mode === "Remove")) throw new Error("MSI containment proof differs");
    return value;
};

const assertStoppedState = state => {
    if (state.serviceCount !== 1 || state.serviceState !== "Stopped" || state.listenerCount !== 0)
        throw new Error("MSI guest stopped service state differs");
};

const assertRunningState = (state, execution) => {
    const normalize = value => path.win32.normalize(value).toLowerCase();
    const servicePath = typeof state.servicePath === "string" && state.servicePath.startsWith('"')
        && state.servicePath.endsWith('"') ? state.servicePath.slice(1, -1) : state.servicePath;
    if (state.serviceCount !== 1 || state.serviceState !== "Running" || state.serviceStartName !== "LocalSystem"
        || state.servicePid < 1 || normalize(servicePath) !== normalize(execution.serviceWrapperPath)
        || state.listenerCount !== 1 || state.listenerPid < 1 || state.listenerParentPid !== state.servicePid
        || normalize(state.listenerImagePath) !== normalize(execution.installedExePath))
        throw new Error("MSI guest running service state differs");
};

const artifactForOperation = (scenario, operation, execution) => {
    const id = operation === "install-candidate"
        ? scenarioBinding(scenario.to.startsWith("candidate-") ? scenario.to : scenario.from)
        : operation === "install-source" || operation === "install-fixture"
        || operation === "install-predecessor" || operation === "uninstall-source"
        || operation === "install-contained-predecessor" || operation === "remove-containment"
        ? scenarioBinding(scenario.from) : scenarioBinding(scenario.to);
    return execution.artifacts.find(item => item.bindingId === id);
};

export const validateWindowsMsiGuestOperationDetails = (operation, value, scenario, execution, request) => {
    const stateOnly = ["verify-sole-related-product", "verify-higher-stamp", "verify-rollback",
        "verify-product-service-and-program-files-removed"];
    if (stateOnly.includes(operation)) exactKeys(value, ["state"], "MSI guest operation details");
    else if (["install-candidate", "install-target", "install-source", "install-fixture",
        "install-predecessor", "uninstall-source"].includes(operation)) {
        const keys = operation === "install-candidate" && Object.hasOwn(value, "containmentKeptPayloadInert")
            ? ["command", "state", "containmentKeptPayloadInert"] : ["command", "state"];
        exactKeys(value, keys, "MSI guest install details");
        if (Object.hasOwn(value, "containmentKeptPayloadInert")) bool(value.containmentKeptPayloadInert,
            "MSI guest containment inert proof");
        const item = artifactForOperation(scenario, operation, execution);
        exactMsiCommand(value.command, execution, operation === "uninstall-source" ? "/x" : "/i", item,
            operation === "uninstall-source" ? [SUCCESS_EXIT, 1605] : [SUCCESS_EXIT]);
    } else if (operation === "install-lower-stamp-fixture") {
        exactKeys(value, ["command", "state", "diagnostic"], "MSI guest diagnostic install details");
        if (value.diagnostic !== true) throw new Error("MSI guest diagnostic proof differs");
        exactMsiCommand(value.command, execution, "/i", artifactForOperation(scenario, operation, execution),
            [value.command.exitCode]);
    } else if (["run-oracle", "run-candidate-oracle", "run-oracle-with-preserved-data"].includes(operation)) {
        exactKeys(value, ["state", "oracle", "database"], "MSI guest oracle details");
        exactOracle(value.oracle); exactDatabase(value.database, execution);
    } else if (["restart-service-and-run-oracle", "restart-and-run-oracle"].includes(operation)) {
        exactKeys(value, ["stopCommand", "startCommand", "state", "oracle", "database"],
            "MSI guest restart oracle details");
        exactServiceCommand(value.stopCommand, execution, "stop");
        exactServiceCommand(value.startCommand, execution, "start");
        exactOracle(value.oracle); exactDatabase(value.database, execution);
    } else if (operation === "stop-service") {
        exactKeys(value, ["command", "state"], "MSI guest stop details");
        exactServiceCommand(value.command, execution, "stop");
    } else if (["damage-owned-executable", "damage-owned-configuration"].includes(operation)) {
        exactKeys(value, ["state", "damagedSha256"], "MSI guest damage details");
        hash(value.damagedSha256, "MSI guest damaged SHA-256");
    } else if (["force-repair-executable", "repair-configuration"].includes(operation)) {
        exactKeys(value, ["command", "state", "repairedSha256"], "MSI guest repair details");
        const mode = operation === "force-repair-executable" ? "/fa" : "/famus";
        exactMsiCommand(value.command, execution, mode, artifactForOperation(scenario, operation, execution));
        hash(value.repairedSha256, "MSI guest repaired SHA-256");
    } else if (operation === "record-product-file-service-and-data-state") {
        exactKeys(value, ["state", "databaseSha256"], "MSI guest recorded state details");
        hash(value.databaseSha256, "MSI guest recorded database SHA-256");
    } else if (operation === "inject-post-removal-failure") {
        exactKeys(value, ["calibration", "state"], "MSI guest rollback details");
        exactKeys(value.calibration, ["command", "proof"], "MSI guest rollback invocation");
        exactCommand(value.calibration.command, execution, "powershell", "MSI guest rollback command");
        sameArguments(value.calibration.command.arguments, rollbackArguments(request, execution,
            artifactForOperation(scenario, operation, execution),
            execution.artifacts.find(candidate => candidate.bindingId === scenarioBinding(scenario.from))),
        "MSI guest rollback command");
        exactRollbackProof(value.calibration.proof);
    } else if (["install-contained-predecessor", "remove-containment"].includes(operation)) {
        const remove = operation === "remove-containment";
        exactKeys(value, remove ? ["containment", "startCommand", "state"] : ["containment", "state"],
            "MSI guest containment details");
        exactKeys(value.containment, ["command", "proof"], "MSI guest containment invocation");
        exactCommand(value.containment.command, execution, "powershell", "MSI guest containment command");
        const containmentItem = artifactForOperation(scenario, operation, execution);
        sameArguments(value.containment.command.arguments,
            containmentArguments(request, execution, remove ? "Remove" : "Install", containmentItem),
        "MSI guest containment command");
        exactContainmentProof(value.containment.proof, containmentItem, remove ? "Remove" : "Install");
        if (remove) exactServiceCommand(value.startCommand, execution, "start");
    } else if (operation === "seed-data") {
        const contained = Object.hasOwn(value, "predecessorPayloadInert");
        exactKeys(value, contained ? ["state", "databaseSha256", "predecessorPayloadInert"]
            : ["stopCommand", "startCommand", "state", "databaseSha256"], "MSI guest seed details");
        if (hash(value.databaseSha256, "MSI guest seeded database SHA-256")
            !== execution.fixture.populatedDatabaseSha256)
            throw new Error("MSI guest seeded database differs");
        if (contained) {
            if (value.predecessorPayloadInert !== true) throw new Error("MSI guest inert payload proof differs");
        } else {
            exactServiceCommand(value.stopCommand, execution, "stop");
            exactServiceCommand(value.startCommand, execution, "start");
        }
    } else if (operation === "seed-legacy-data") {
        exactKeys(value, ["state", "legacySentinelSha256"], "MSI guest legacy seed details");
        hash(value.legacySentinelSha256, "MSI guest legacy sentinel SHA-256");
    } else if (operation === "seed-legacy-and-destination-sentinels") {
        exactKeys(value, ["state", "legacySentinelSha256", "destinationSentinelSha256"],
            "MSI guest sentinel seed details");
        hash(value.legacySentinelSha256, "MSI guest legacy sentinel SHA-256");
        hash(value.destinationSentinelSha256, "MSI guest destination sentinel SHA-256");
    } else if (operation === "verify-one-time-migration") {
        exactKeys(value, ["state", "migratedSha256", "sourceSha256"], "MSI guest migration details");
        hash(value.migratedSha256, "MSI guest migrated SHA-256"); hash(value.sourceSha256, "MSI guest source SHA-256");
    } else if (operation === "verify-destination-not-overwritten") {
        exactKeys(value, ["state", "destinationSentinelSha256"], "MSI guest destination details");
        hash(value.destinationSentinelSha256, "MSI guest destination sentinel SHA-256");
    } else if (operation === "cleanup") {
        exactKeys(value, ["uninstallCommands", "ownedRemoval", "state"], "MSI guest cleanup details");
        if (!Array.isArray(value.uninstallCommands) || value.uninstallCommands.length !== execution.artifacts.length)
            throw new Error("MSI guest cleanup commands differ");
        value.uninstallCommands.forEach((command, index) => exactMsiCommand(command, execution, "/x",
            execution.artifacts[index], [SUCCESS_EXIT, 1605]));
        exactKeys(value.ownedRemoval, ["installRootRemoved", "dataRootRemoved"], "MSI guest owned removal");
        if (value.ownedRemoval.installRootRemoved !== true || value.ownedRemoval.dataRootRemoved !== true)
            throw new Error("MSI guest owned removal differs");
    } else throw new Error("MSI guest operation details are unresolved");
    const state = exactSnapshot(value.state, execution);
    const item = artifactForOperation(scenario, operation, execution);
    if (["install-candidate", "install-target"].includes(operation)) {
        if (!installed(state, item.bindingId)) throw new Error("MSI guest installed product state differs");
        if (value.containmentKeptPayloadInert === true) assertStoppedState(state);
        else assertRunningState(state, execution);
    } else if (["install-source", "install-fixture", "install-predecessor",
        "install-contained-predecessor"].includes(operation)) {
        if (!installed(state, item.bindingId)) throw new Error("MSI guest source product state differs");
        if (operation === "install-contained-predecessor") assertStoppedState(state);
    } else if (operation === "uninstall-source") {
        if (!absent(state, item.bindingId)) throw new Error("MSI guest uninstalled product state differs");
    } else if (["run-oracle", "run-candidate-oracle", "run-oracle-with-preserved-data",
        "restart-service-and-run-oracle", "restart-and-run-oracle", "remove-containment"].includes(operation))
        assertRunningState(state, execution);
    else if (operation === "seed-data") {
        if (value.predecessorPayloadInert === true) assertStoppedState(state);
        else assertRunningState(state, execution);
    } else if (operation === "stop-service") assertStoppedState(state);
    else if (["verify-sole-related-product", "verify-higher-stamp"].includes(operation)) {
        const sourceId = scenarioBinding(scenario.from); const targetId = scenarioBinding(scenario.to);
        if (!installed(state, targetId) || (sourceId && sourceId !== targetId && !absent(state, sourceId)))
            throw new Error("MSI guest related product state differs");
    } else if (["inject-post-removal-failure", "verify-rollback"].includes(operation)) {
        if (!installed(state, scenarioBinding(scenario.from)) || !absent(state, scenarioBinding(scenario.to)))
            throw new Error("MSI guest rollback product state differs");
    } else if (operation === "verify-product-service-and-program-files-removed") {
        if (state.serviceCount !== 0 || state.listenerCount !== 0 || state.installRootExists)
            throw new Error("MSI guest removed product state differs");
    } else if (operation === "cleanup") {
        if (state.products.some(entry => entry.state !== INSTALL_STATE_UNKNOWN) || state.serviceCount !== 0
            || state.listenerCount !== 0 || state.installRootExists || state.dataRootExists)
            throw new Error("MSI guest cleanup product state differs");
    }
    if (operation === "force-repair-executable" && value.repairedSha256 !== item.exeSha256)
        throw new Error("MSI guest repaired executable differs");
    if (operation === "repair-configuration" && value.repairedSha256 !== item.configurationSha256)
        throw new Error("MSI guest repaired configuration differs");
    if (operation === "verify-one-time-migration"
        && (value.migratedSha256 !== execution.fixture.legacySentinelSha256
            || value.sourceSha256 !== execution.fixture.legacySentinelSha256))
        throw new Error("MSI guest migration evidence differs");
    if (operation === "verify-destination-not-overwritten"
        && value.destinationSentinelSha256 !== execution.fixture.destinationSentinelSha256)
        throw new Error("MSI guest destination evidence differs");
    if (operation === "seed-legacy-data" && value.legacySentinelSha256 !== execution.fixture.legacySentinelSha256)
        throw new Error("MSI guest legacy seed evidence differs");
    if (operation === "seed-legacy-and-destination-sentinels"
        && (value.legacySentinelSha256 !== execution.fixture.legacySentinelSha256
            || value.destinationSentinelSha256 !== execution.fixture.destinationSentinelSha256))
        throw new Error("MSI guest sentinel seed evidence differs");
    return value;
};

export const validateWindowsMsiGuestLifecycleReceipts = (rowResult, request, execution) => {
    validateProbeArtifactContext(execution, request);
    const boundary = rowResult.boundaryReceipt;
    exactCommand(boundary.observationCommand, execution, "powershell", "MSI guest boundary command");
    sameArguments(boundary.observationCommand.arguments,
        createWindowsMsiGuestBoundaryArguments(request.guest.serial), "MSI guest boundary");
    exactCommand(boundary.cpuProbeCommand, execution, "cpuid", "MSI guest CPU probe command", [SUCCESS_EXIT], true);
    sameArguments(boundary.cpuProbeCommand.arguments, [], "MSI guest CPU probe");
    const cpuBytes = request.schemaVersion === 1 ? Buffer.from(request.guest.cpuProbe.bytesBase64, "base64")
        : Buffer.from(boundary.cpuObservation.bytesBase64, "base64");
    const cpuSha256 = request.schemaVersion === 1 ? request.guest.cpuProbe.sha256 : boundary.cpuObservation.sha256;
    if (boundary.cpuProbeCommand.stdoutBytes !== cpuBytes.length
        || boundary.cpuProbeCommand.stdoutSha256 !== cpuSha256
        || boundary.cpuProbeCommand.stderrBytes !== 0
        || boundary.cpuProbeCommand.stderrSha256 !== sha256(Buffer.alloc(0)))
        throw new Error("MSI guest CPU probe command streams differ");
    if (boundary.networkAdapters !== 0 || boundary.cpuEvidenceSha256 !== request.guest.cpuEvidenceSha256
        || boundary.qemuLaunchSha256 !== request.guest.qemuLaunchSha256)
        throw new Error("MSI guest boundary receipt differs");
    if (boundary.serial !== request.guest.serial || !/^QEMU(?: |$)/u.test(boundary.manufacturer))
        throw new Error("MSI guest boundary identity differs");
    const fresh = exactSnapshot(rowResult.freshReceipt.state, execution);
    if (fresh.products.some(item => item.state !== INSTALL_STATE_UNKNOWN) || fresh.serviceCount !== 0
        || fresh.listenerCount !== 0 || fresh.installRootExists || fresh.dataRootExists)
        throw new Error("MSI guest fresh receipt differs");
    const cleanup = rowResult.cleanupReceipt;
    if (cleanup.containmentCleanup !== null) throw new Error("MSI guest completed containment cleanup differs");
    if (cleanup.uninstallCommands.length !== execution.artifacts.length)
        throw new Error("MSI guest cleanup command count differs");
    cleanup.uninstallCommands.forEach((command, index) => exactMsiCommand(command, execution, "/x",
        execution.artifacts[index], [SUCCESS_EXIT, 1605]));
    if (cleanup.ownedRemoval.installRootRemoved !== true || cleanup.ownedRemoval.dataRootRemoved !== true)
        throw new Error("MSI guest cleanup removal differs");
    const finalState = exactSnapshot(cleanup.state, execution);
    if (finalState.products.some(item => item.state !== INSTALL_STATE_UNKNOWN) || finalState.serviceCount !== 0
        || finalState.listenerCount !== 0 || finalState.installRootExists || finalState.dataRootExists)
        throw new Error("MSI guest cleanup state differs");
    return rowResult;
};

export const createWindowsMsiGuestMatrixOperations = ({request, execution, native}) => {
    validateWindowsMsiGuestExecutionManifest(execution);
    validateProbeArtifactContext(execution, request);
    if (execution.outputRoot.toLowerCase() !== request.guest.evidenceRoot.toLowerCase())
        throw new Error("MSI guest evidence root binding differs");
    const api = native ?? createDefaultNative(execution, request);
    const known = new Set(PRODUCT_BINDINGS);
    let containmentActive = false;
    let rollbackObserved = false;
    const binding = name => {
        const id = scenarioBinding(name);
        if (!id || !known.has(id)) throw new Error(`MSI guest binding is unresolved: ${name}`);
        const item = execution.artifacts.find(entry => entry.bindingId === id);
        if (!item) throw new Error("MSI guest artifact is absent");
        return item;
    };
    const snapshot = async () => {
        const observed = await api.snapshot();
        exactKeys(observed, ["command", "value"], "MSI guest state observation envelope");
        return exactSnapshot({...observed.value, observationCommand: observed.command}, execution);
    };
    const waitSnapshot = async predicate => {
        const deadline = Date.now() + execution.limits.processMilliseconds;
        do {
            const state = await snapshot();
            if (predicate(state)) return state;
            await new Promise(resolve => setTimeout(resolve, SERVICE_POLL_MILLISECONDS));
        } while (Date.now() < deadline);
        throw new Error("MSI guest state deadline expired");
    };
    const evidence = async (scenario, operation, operationIndex, details) => {
        validateWindowsMsiGuestOperationDetails(operation, details, scenario, execution, request);
        const record = {schemaVersion: 1, kind: "myspeed-windows-msi-guest-operation-evidence",
            sourceSha: request.sourceSha, eventSha: request.eventSha, runId: request.runId,
            runAttempt: request.runAttempt, nonce: request.nonce, scenarioId: scenario.id, operation,
            operationIndex, details};
        const identity = await api.writeEvidence(operationIndex, operation, record);
        exactKeys(identity, ["path", "bytes", "sha256"], "MSI guest written evidence");
        windowsPath(identity.path, "MSI guest written evidence path");
        integer(identity.bytes, "MSI guest written evidence bytes", 1, execution.limits.evidenceBytes);
        hash(identity.sha256, "MSI guest written evidence SHA-256");
        return {stage: "matrix-operation", passed: true, scenarioId: scenario.id, operation,
            operationIndex, actualHandler: `actual-${operation}`, evidence: identity,
            stateProofSha256: identity.sha256};
    };
    const installAndObserve = async item => { const command = await api.install(item); return {command,
        state: await waitSnapshot(value => installed(value, item.bindingId))}; };
    const uninstallAndObserve = async item => { const command = await api.uninstall(item); return {command,
        state: await waitSnapshot(value => absent(value, item.bindingId))}; };
    const ensureCandidateRunning = state => {
        const normalize = value => path.win32.normalize(value).toLowerCase();
        const servicePath = typeof state.servicePath === "string" && state.servicePath.startsWith('"')
            && state.servicePath.endsWith('"') ? state.servicePath.slice(1, -1) : state.servicePath;
        if (state.serviceCount !== 1 || state.serviceState !== "Running" || state.serviceStartName !== "LocalSystem"
            || state.servicePid < 1 || normalize(servicePath) !== normalize(execution.serviceWrapperPath)
            || state.listenerCount !== 1 || state.listenerPid < 1 || state.listenerParentPid !== state.servicePid
            || normalize(state.listenerImagePath) !== normalize(execution.installedExePath))
            throw new Error("MSI guest candidate service differs");
    };
    const assertCandidatePayload = async item => {
        if (item.exeSha256 === null || item.configurationSha256 === null || item.serviceWrapperSha256 === null
            || await api.hashFile(execution.installedExePath) !== item.exeSha256
            || await api.hashFile(execution.configurationPath) !== item.configurationSha256
            || await api.hashFile(execution.serviceWrapperPath) !== item.serviceWrapperSha256)
            throw new Error("MSI guest installed payload differs");
    };
    const candidateForScenario = scenario => scenario.to.startsWith("candidate-")
        ? binding(scenario.to) : binding(scenario.from);
    return {
        assertGuestBoundary: async ({request: input}) => {
            const observed = await api.assertBoundary({serial: input.guest.serial, nonce: input.nonce,
                profile: input.guest.profile});
            exactKeys(observed, ["command", "value", "cpuCommand",
                ...(input.schemaVersion === 2 ? ["cpuObservation"] : [])],
            "MSI guest boundary observation envelope");
            const value = {...observed.value, observationCommand: observed.command};
            exactKeys(value, ["networkAdapters", "serial", "manufacturer", "observationCommand"],
                "MSI guest boundary observation");
            exactCommand(value.observationCommand, execution, "powershell", "MSI guest boundary command");
            integer(value.networkAdapters, "MSI guest boundary adapters", 0, 0);
            if (value.serial !== input.guest.serial || !/^QEMU(?: |$)/u.test(value.manufacturer))
                throw new Error("MSI guest boundary identity differs");
            return {stage: "guest-boundary", passed: true, cpuEvidenceSha256: input.guest.cpuEvidenceSha256,
                qemuLaunchSha256: input.guest.qemuLaunchSha256, networkAdapters: 0,
                serial: value.serial, manufacturer: value.manufacturer,
                observationCommand: value.observationCommand, cpuProbeCommand: observed.cpuCommand,
                ...(input.schemaVersion === 2 ? {cpuObservation: observed.cpuObservation} : {})};
        },
        inspectFreshScenario: async () => {
            const state = await snapshot();
            if (state.products.some(item => item.state !== INSTALL_STATE_UNKNOWN) || state.serviceCount !== 0
                || state.listenerCount !== 0 || state.installRootExists || state.dataRootExists)
                throw new Error("MSI guest scenario is not fresh");
            return {stage: "fresh-scenario", passed: true, products: 0, services: 0, listeners: 0,
                ownedPaths: 0, state};
        },
        executeOperation: async ({scenario, operation, operationIndex}) => {
            if (!OPERATIONS.includes(operation)) throw new Error("MSI guest operation is unresolved");
            let details;
            const sourceId = scenarioBinding(scenario.from);
            const targetId = scenarioBinding(scenario.to);
            switch (operation) {
            case "install-candidate": case "install-target": {
                const item = operation === "install-target" ? binding(scenario.to) : candidateForScenario(scenario);
                details = await installAndObserve(item); if (!installed(details.state, item.bindingId)) throw new Error("MSI install failed");
                if (containmentActive) {
                    details.state = await waitSnapshot(value => value.serviceState === "Stopped"
                        && value.listenerCount === 0);
                    details.containmentKeptPayloadInert = true;
                } else ensureCandidateRunning(details.state);
                await assertCandidatePayload(item); break;
            }
            case "install-source": case "install-fixture": case "install-predecessor": {
                const item = binding(scenario.from); details = await installAndObserve(item); if (!installed(details.state, item.bindingId)) throw new Error("MSI source install failed"); break;
            }
            case "install-lower-stamp-fixture": {
                const item = binding(scenario.to); const command = await api.install(item, {diagnostic: true}); details = {command, state: await snapshot(), diagnostic: true}; break;
            }
            case "seed-data": { let stopCommand; let startCommand;
                if (!containmentActive) { stopCommand = await api.service("stop"); await waitSnapshot(value => value.serviceState === "Stopped" && value.listenerCount === 0); }
                await api.seedPopulated();
                if (!containmentActive) { startCommand = await api.service("start"); details = {stopCommand, startCommand,
                    state: await waitSnapshot(value => value.serviceState === "Running" && value.listenerCount === 1),
                    databaseSha256: await api.hashFile(execution.databasePath)}; ensureCandidateRunning(details.state); }
                else { details = {state: await waitSnapshot(value => value.serviceState === "Stopped" && value.listenerCount === 0),
                    databaseSha256: await api.hashFile(execution.databasePath), predecessorPayloadInert: true}; }
                break; }
            case "seed-legacy-data": await api.seedLegacy(); details = {state: await snapshot(), legacySentinelSha256: await api.hashFile(path.win32.join(execution.legacyDataRoot, "legacy.sentinel"))}; break;
            case "seed-legacy-and-destination-sentinels": await api.seedLegacy(); await api.seedDestinationSentinel(); details = {state: await snapshot(), legacySentinelSha256: await api.hashFile(path.win32.join(execution.legacyDataRoot, "legacy.sentinel")), destinationSentinelSha256: await api.hashFile(path.win32.join(execution.dataRoot, "destination.sentinel"))}; break;
            case "run-oracle": case "run-candidate-oracle": case "run-oracle-with-preserved-data": {
                const oracle = await api.oracle(); const database = await api.database();
                details = {state: await snapshot(), oracle, database}; ensureCandidateRunning(details.state); break; }
            case "restart-service-and-run-oracle": case "restart-and-run-oracle": {
                const stopCommand = await api.service("stop"); await waitSnapshot(value => value.serviceState === "Stopped" && value.listenerCount === 0);
                const database = await api.database(); const startCommand = await api.service("start");
                const state = await waitSnapshot(value => value.serviceState === "Running" && value.listenerCount === 1);
                const oracle = await api.oracle(); details = {stopCommand, startCommand, state, oracle, database};
                ensureCandidateRunning(details.state); break; }
            case "stop-service": details = {command: await api.service("stop"), state: await waitSnapshot(value => value.serviceState === "Stopped" && value.listenerCount === 0)}; break;
            case "damage-owned-executable": await api.damage(execution.installedExePath); details = {state: await snapshot(), damagedSha256: await api.hashFile(execution.installedExePath)}; break;
            case "damage-owned-configuration": await api.damage(execution.configurationPath); details = {state: await snapshot(), damagedSha256: await api.hashFile(execution.configurationPath)}; break;
            case "force-repair-executable": case "repair-configuration": {
                const item = binding(scenario.to); const mode = operation === "force-repair-executable" ? "/fa" : "/famus"; const command = await api.repair(item, mode); details = {command, state: await snapshot(), repairedSha256: await api.hashFile(operation === "force-repair-executable" ? execution.installedExePath : execution.configurationPath)}; const expected = operation === "force-repair-executable" ? item.exeSha256 : item.configurationSha256; if (details.repairedSha256 !== expected) throw new Error("MSI repair hash differs"); break;
            }
            case "verify-sole-related-product": case "verify-higher-stamp": {
                details = {state: await snapshot()}; if (!installed(details.state, targetId) || (sourceId && sourceId !== targetId && !absent(details.state, sourceId))) throw new Error("MSI related product state differs"); break;
            }
            case "record-product-file-service-and-data-state": details = {state: await snapshot(), databaseSha256: await api.hashFile(execution.databasePath)}; break;
            case "inject-post-removal-failure": { const item = binding(scenario.to); const predecessor = binding(scenario.from);
                const calibration = await api.rollback(item, predecessor);
                exactKeys(calibration, ["command", "proof"], "MSI rollback invocation");
                exactRollbackProof(calibration.proof); rollbackObserved = true;
                details = {calibration, state: await snapshot()}; break; }
            case "verify-rollback": details = {state: await snapshot()}; if (!rollbackObserved || !installed(details.state, sourceId) || !absent(details.state, targetId)) throw new Error("MSI rollback state differs"); break;
            case "uninstall-source": { const item = binding(scenario.from); details = await uninstallAndObserve(item); if (!absent(details.state, item.bindingId)) throw new Error("MSI uninstall failed"); break; }
            case "verify-product-service-and-program-files-removed": details = {state: await snapshot()}; if (details.state.serviceCount !== 0 || details.state.listenerCount !== 0 || details.state.installRootExists) throw new Error("MSI removal state differs"); break;
            case "install-contained-predecessor": { const item = binding(scenario.from); const containment = await api.containment("Install", item);
                exactKeys(containment, ["command", "proof"], "MSI containment invocation");
                exactContainmentProof(containment.proof, item, "Install"); containmentActive = true;
                details = {containment, state: await snapshot()}; if (!installed(details.state, item.bindingId)) throw new Error("Contained predecessor install failed"); break; }
            case "remove-containment": { if (!containmentActive) throw new Error("MSI containment was not active"); const item = binding(scenario.from);
                const containment = await api.containment("Remove", item); exactKeys(containment, ["command", "proof"], "MSI containment invocation");
                exactContainmentProof(containment.proof, item, "Remove"); containmentActive = false;
                const startCommand = await api.service("start"); details = {containment, startCommand,
                    state: await waitSnapshot(value => value.serviceState === "Running" && value.listenerCount === 1)};
                ensureCandidateRunning(details.state); break; }
            case "verify-one-time-migration": details = {state: await snapshot(), migratedSha256: await api.hashFile(path.win32.join(execution.dataRoot, "legacy.sentinel")), sourceSha256: await api.hashFile(path.win32.join(execution.legacyDataRoot, "legacy.sentinel"))}; if (details.migratedSha256 !== execution.fixture.legacySentinelSha256 || details.sourceSha256 !== execution.fixture.legacySentinelSha256) throw new Error("MSI migration differs"); break;
            case "verify-destination-not-overwritten": details = {state: await snapshot(), destinationSentinelSha256: await api.hashFile(path.win32.join(execution.dataRoot, "destination.sentinel"))}; if (details.destinationSentinelSha256 !== execution.fixture.destinationSentinelSha256) throw new Error("MSI destination sentinel differs"); break;
            case "cleanup": { const uninstallCommands = [];
                for (const item of execution.artifacts) uninstallCommands.push(await api.uninstall(item));
                const ownedRemoval = await api.removeOwned(); details = {uninstallCommands, ownedRemoval,
                    state: await waitSnapshot(value => value.products.every(item => item.state === INSTALL_STATE_UNKNOWN)
                        && value.serviceCount === 0 && value.listenerCount === 0
                        && !value.installRootExists && !value.dataRootExists)}; break; }
            default: throw new Error("MSI guest operation is unresolved");
            }
            return evidence(scenario, operation, operationIndex, details);
        },
        cleanupScenario: async () => {
            let containmentCleanup = null;
            if (containmentActive) { const source = execution.artifacts.find(item => item.bindingId === scenarioBinding(request.matrix.scenarios[request.scenarioIndex].from)); containmentCleanup = await api.containment("Remove", source); containmentActive = false; }
            const uninstallCommands = [];
            for (const item of execution.artifacts) uninstallCommands.push(await api.uninstall(item));
            const ownedRemoval = await api.removeOwned();
            const state = await waitSnapshot(value => value.products.every(item => item.state === INSTALL_STATE_UNKNOWN)
                && value.serviceCount === 0 && value.listenerCount === 0 && !value.installRootExists
                && !value.dataRootExists);
            return {stage: "scenario-cleanup", passed: true, products: 0, services: 0, listeners: 0,
                ownedPaths: 0, qemuPoweroffRequired: true, containmentCleanup, uninstallCommands,
                ownedRemoval, state};
        }
    };
};

export const WINDOWS_MSI_GUEST_PRODUCT_BINDINGS = PRODUCT_BINDINGS;
