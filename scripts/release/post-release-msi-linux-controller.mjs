import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {isDeepStrictEqual} from "node:util";

import {validateHostedContext} from "../qualification/linux-kvm-capability.mjs";
import {deriveActualHostedContext} from
    "../qualification/linux-windows-cpu-floor-stage2-controller.mjs";
import {sealSameJobInstalledBase} from "../qualification/windows-msi-installed-base.mjs";
import {prepareHostedInstalledBaseOperations} from
    "../qualification/windows-msi-installed-base-hosted.mjs";
import {buildV161PostReleaseMsiAcquisitionPlan, validateV161PostReleaseMsiAcquisitionRecord} from
    "./post-release-msi-acquisition.mjs";
import {validateV161PostReleaseMsiWindowsPreparation} from
    "./post-release-msi-hosted-prepare.mjs";
import {buildV161PostReleaseMsiFixturePlan, validateV161PostReleaseMsiFixturePreparation} from
    "./post-release-msi-fixture-preparation.mjs";
import {validateV161PostReleaseBaselineInputPreparation} from
    "./post-release-msi-baseline-input-preparation.mjs";
import {bindV161PostReleaseTarget} from "./post-release-target.mjs";
import {WINDOWS_MSI_GUEST_PRODUCT_BINDINGS} from "../qualification/windows-msi-guest-matrix-operations.mjs";
import {createWindowsMsiLifecycleHostOperations, runWindowsMsiLifecycleHost,
    WindowsMsiLifecycleRunError} from "../qualification/linux-windows-msi-lifecycle-host.mjs";
import {createV161PostReleaseMsiHostBinding} from "./post-release-msi-host-bridge.mjs";
import {prepareV161PostReleaseMsiLinuxFixture, validateV161PostReleaseMsiLinuxFixturePreparation} from
    "./post-release-msi-linux-fixture.mjs";
import {buildV161PostReleaseMsiHostRequest, buildV161PostReleaseMsiScenario0CalibrationHostRequest,
    resolveV161PostReleaseMsiQemuLaunchSha256} from
    "./post-release-msi-host-request.mjs";
import {createWindowsMsiScenario0CalibrationBudget, createWindowsMsiScenario0CalibrationOperations,
    runWindowsMsiScenario0Calibration,
    WindowsMsiScenario0CalibrationRunError, SCENARIO0_CALIBRATION_MAX_JOB_MILLISECONDS,
    SCENARIO0_CALIBRATION_MAX_EXECUTION_MILLISECONDS} from
    "../qualification/windows-msi-scenario0-calibration.mjs";
import {buildWindowsMsiContainmentPreflightRequest, runWindowsMsiContainmentPreflight} from
    "../qualification/windows-msi-containment-preflight.mjs";
import {buildWindowsMsiContainmentPreflightGuestRequest,
    createWindowsMsiContainmentPreflightOperations, windowsMsiContainmentPreflightQemuLaunchSha256,
    WINDOWS_MSI_CONTAINMENT_PREFLIGHT_HOST} from
    "../qualification/windows-msi-containment-preflight-host.mjs";
import {buildWindowsMsiGuestPreflightSeedDocuments} from
    "../qualification/windows-msi-guest-seed-documents.mjs";
import {chargeWindowsMsiContainmentPreflight,
    createWindowsMsiContainmentPreflightReservation} from
    "../qualification/windows-msi-lifecycle-budget.mjs";

const ARTIFACT_NAME = "post-release-v1.6.1-msi-appassets";
const RESULT_KIND = "myspeed-v1.6.1-post-release-msi-prepare-result";
const TRANSPORT_KIND = "myspeed-v1.6.1-post-release-msi-preparation-transport";
const TASK_ROOT_PREFIX = "/home/runner/work/_temp/myspeed-windows-msi-";
const SHA256 = /^[0-9a-f]{64}$/u;
const DECIMAL = /^[1-9][0-9]{0,19}$/u;
const MAX_ARTIFACT_BYTES = 1_073_741_824;
const MAX_DOCUMENT_BYTES = 1_048_576;
const MAX_FILE_BYTES = 1_073_741_824;
const READ_BUFFER_BYTES = 1_048_576;
const MAX_CONTROLLER_DOCUMENT_BYTES = 67_108_864;
const CLOSURE_ROOT_PREFIX = "/home/runner/work/_temp/myspeed-msi-closure-";
const CLOSURE_FILES = Object.freeze([
    ["matrixRunner", "scripts/qualification/windows-msi-guest-matrix-executor.mjs"],
    ["matrixOperations", "scripts/qualification/windows-msi-guest-matrix-operations.mjs"],
    ["matrixRow", "scripts/qualification/windows-msi-guest-matrix-row.mjs"],
    ["matrixContract", "scripts/qualification/windows-msi-matrix-contract.mjs"],
    ["launcher", "scripts/qualification/media-job-launcher.ps1"],
    ["runner", "scripts/qualification/windows-msi-guest-runner.ps1"],
    ["oracle", "scripts/qualification/check-artifact.mjs"],
    ["oracleSafety", "scripts/qualification/safety.mjs"],
    ["oracleFixture", "scripts/qualification/fixture.mjs"],
    ["sqlite", "scripts/qualification/sqlite-check.mjs"],
    ["rollback", "scripts/qualification/windows-msi-guest-rollback.ps1"],
    ["containment", "scripts/qualification/windows-msi-guest-containment.ps1"],
    ["preflightRunner",
        "scripts/qualification/windows-msi-guest-containment-preflight-executor.mjs"]
]);
const SOURCE_NAMES = Object.freeze(["node", "cpuid", ...CLOSURE_FILES.map(([name]) => name)]);
/*
 * The preflight executor is observed like any other closure member, but no matrix row ever runs it -
 * it is staged into the one preflight guest and nowhere else. Seeding it into fourteen rows would put
 * a file in their closure digest that none of them executes, so it is projected out of the row
 * sources before the host request is built.
 */
const PREFLIGHT_ONLY_SOURCES = Object.freeze(["preflightRunner"]);
const PORTABLE_QEMU_SUFFIX = "/usr/bin/qemu-system-x86_64";
const PRIVILEGE_MODE = "reviewed-sudo-kvm";

/*
 * A containment preflight that fails throws an ordinary Error, or an AggregateError carrying both
 * the failure and the cleanup failure that followed it - neither of which the lifecycle host's own
 * typed progress knows anything about. Without this the run would retain nothing at all: no stage,
 * no cause, and no record that a guest was ever started.
 *
 * What it retains is failure evidence and only that. There is no row here to report as completed and
 * no matrix to report as accepted, so it says so in its own shape rather than borrowing one that a
 * consumer could read as a truncated matrix.
 */
const PREFLIGHT_PROGRESS_KIND = "myspeed-windows-msi-containment-preflight-progress";
const PREFLIGHT_PROGRESS_STATUS = "preflight-failure";
const PREFLIGHT_STAGES = Object.freeze(["inspectBase", "createOverlay", "prepareMedia",
    "launchPreflight", "readGuestResult", "cleanupOverlay"]);
const MAX_FAILURE_CHARACTERS = 512;
const MAX_RETAINED_STAGES = 2 * PREFLIGHT_STAGES.length;

const defaultMonotonicMilliseconds = () => Number(process.hrtime.bigint() / 1_000_000n);

const boundedText = value => String(value ?? "").slice(0, MAX_FAILURE_CHARACTERS);

const failureEntry = error => Object.freeze({
    category: boundedText(error instanceof Error ? error.name : "Error"),
    detail: boundedText(error instanceof Error ? error.message : error)});

export class WindowsMsiContainmentPreflightRunError extends Error {
    constructor(progress, cause) {
        super(`MSI containment preflight failed at ${progress.stage ?? "start"}: `
            + `${progress.failure.primary.detail}`);
        this.name = "WindowsMsiContainmentPreflightRunError";
        this.progress = progress;
        this.cause = cause;
    }
}

/*
 * Which operation was running when it stopped. The operations are wrapped rather than asked, so the
 * stage a failure names is the one that actually ran, and `stageCompleted` separates a failure
 * inside an operation from one raised between two of them.
 */
const traceWindowsMsiContainmentPreflightStages = operations => {
    const trace = {stage: null, stageCompleted: false, completed: []};
    const traced = {};
    for (const stage of PREFLIGHT_STAGES)
        traced[stage] = async value => {
            trace.stage = stage;
            trace.stageCompleted = false;
            const observed = await operations[stage](value);
            trace.stageCompleted = true;
            if (trace.completed.length < MAX_RETAINED_STAGES) trace.completed.push(stage);
            return observed;
        };
    return {trace, traced};
};

const buildV161PostReleaseMsiPreflightProgress = ({request, trace, reservation, error}) => {
    const causes = error instanceof AggregateError && Array.isArray(error.errors) ? error.errors : [];
    let sealed = null;
    if (reservation !== null) {
        try { sealed = reservation.seal(); } catch { sealed = null; }
    }
    return deepFreeze({schemaVersion: 1, kind: PREFLIGHT_PROGRESS_KIND,
        status: PREFLIGHT_PROGRESS_STATUS, qualifying: false, sourceSha: request.sourceSha,
        eventSha: request.eventSha, runId: request.runId, runAttempt: request.runAttempt,
        nonce: request.nonce, guestSerial: request.guestSerial, stage: trace.stage,
        stageCompleted: trace.stageCompleted, stagesCompleted: [...trace.completed],
        failure: {...failureEntry(error),
            primary: failureEntry(causes.length > 0 ? causes[0] : error),
            cleanup: causes.length > 1 ? failureEntry(causes[1]) : null},
        reservation: sealed,
        /* Said in the document itself, so nothing downstream has to infer it from an absence. */
        matrixLaunched: false, completedRows: [], releaseGatesCleared: []});
};

const fail = message => { throw new Error(`Post-release MSI Linux controller: ${message}`); };
const exactKeys = (value, keys, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) fail(`${label} keys differ`);
};
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const deepFreeze = value => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
};
const same = (actual, expected, label) => {
    if (!isDeepStrictEqual(actual, expected)) fail(`${label} differs`);
};

export function inspectV161PostReleaseMsiLinuxFile({path: target, maximumBytes = MAX_FILE_BYTES,
    allowEmpty = false, includeBytes = false}, filesystem = fs) {
    if (typeof target !== "string" || !path.posix.isAbsolute(target) || path.posix.normalize(target) !== target
        || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_FILE_BYTES)
        fail("file inspection request differs");
    const descriptor = filesystem.openSync(target, filesystem.constants.O_RDONLY
        | filesystem.constants.O_NOFOLLOW);
    let before; let retained = includeBytes ? [] : null; const digest = createHash("sha256");
    try {
        before = filesystem.fstatSync(descriptor, {bigint: true});
        const minimum = allowEmpty ? 0n : 1n;
        if (!before.isFile() || before.nlink !== 1n || before.size < minimum
            || before.size > BigInt(maximumBytes)) fail("file identity differs");
        const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES); let offset = 0n;
        while (offset < before.size) {
            const remaining = before.size - offset;
            const count = filesystem.readSync(descriptor, buffer, 0,
                Number(remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining), offset);
            if (count < 1) fail("file read was truncated");
            const chunk = Buffer.from(buffer.subarray(0, count)); digest.update(chunk);
            if (includeBytes) retained.push(chunk);
            offset += BigInt(count);
        }
        const after = filesystem.fstatSync(descriptor, {bigint: true});
        const canonical = filesystem.realpathSync(`/proc/self/fd/${descriptor}`);
        if (canonical !== target || before.dev !== after.dev || before.ino !== after.ino
            || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
            || after.nlink !== 1n) fail("file changed while hashing");
    } finally { filesystem.closeSync(descriptor); }
    return {path: target, bytes: Number(before.size), sha256: digest.digest("hex"),
        ...(includeBytes ? {content: Buffer.concat(retained)} : {})};
}

const parseDocument = (observation, expectedPath, label) => {
    exactKeys(observation, ["path", "bytes", "sha256", "content"], label);
    if (observation.path !== expectedPath || !Buffer.isBuffer(observation.content)
        || observation.bytes !== observation.content.length || observation.bytes < 3
        || observation.bytes > MAX_DOCUMENT_BYTES || observation.sha256 !== hash(observation.content))
        fail(`${label} identity differs`);
    let value;
    try { value = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(observation.content)); }
    catch { fail(`${label} JSON differs`); }
    if (!observation.content.equals(Buffer.from(`${JSON.stringify(value)}\n`, "utf8")))
        fail(`${label} serialization differs`);
    return {value, document: {path: expectedPath, bytes: observation.bytes,
        sha256: observation.sha256, bytesBase64: observation.content.toString("base64")}};
};

const bindTarget = targetInput => {
    exactKeys(targetInput, ["harnessSourceSha", "manifestBytesBase64", "observedAt", "qualificationArchive",
        "qualificationRun", "release", "tag"], "target input");
    if (typeof targetInput.manifestBytesBase64 !== "string") fail("target manifest differs");
    const manifestBytes = Buffer.from(targetInput.manifestBytesBase64, "base64");
    if (manifestBytes.toString("base64") !== targetInput.manifestBytesBase64) fail("target manifest differs");
    const input = structuredClone(targetInput);
    delete input.manifestBytesBase64;
    return bindV161PostReleaseTarget({...input, manifestBytes});
};

const inspectIdentity = async (inspectFile, expectedPath, expected, label) => {
    const value = await inspectFile({path: expectedPath, maximumBytes: MAX_FILE_BYTES});
    exactKeys(value, ["path", "bytes", "sha256"], label);
    if (value.path !== expectedPath || value.bytes !== expected.bytes || value.sha256 !== expected.sha256
        || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || !SHA256.test(value.sha256))
        fail(`${label} differs`);
    return value;
};

const observedSource = (value, expectedPath, label) => {
    exactKeys(value, ["path", "bytes", "sha256"], label);
    const byteCount = typeof value.bytes === "string" && /^[1-9][0-9]{0,15}$/u.test(value.bytes)
        ? Number(value.bytes) : value.bytes;
    if (value.path !== expectedPath || !Number.isSafeInteger(byteCount) || byteCount < 1
        || byteCount > MAX_FILE_BYTES || !SHA256.test(value.sha256)) fail(`${label} differs`);
    return {path: expectedPath, bytes: byteCount, sha256: value.sha256};
};

const lifecycleToolIdentity = (value, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} differs`);
    return {path: value.path, bytes: value.bytes, sha256: value.sha256,
        ownership: structuredClone(value.ownership)};
};

const defaultLinuxFixtureOperations = taskRoot => {
    const generatedRoot = `${taskRoot}/generated-fixture`;
    const allowed = new Set([`${generatedRoot}/populated/destination.sentinel`,
        `${generatedRoot}/legacy/legacy.sentinel`]);
    const assertDirectory = target => {
        const identity = fs.lstatSync(target);
        if (!identity.isDirectory() || identity.isSymbolicLink() || fs.realpathSync(target) !== target)
            fail("generated fixture directory differs");
    };
    assertDirectory(taskRoot);
    if (fs.existsSync(generatedRoot)) fail("generated fixture root already exists");
    fs.mkdirSync(generatedRoot, {recursive: false, mode: 0o700});
    for (const child of ["populated", "legacy"])
        fs.mkdirSync(`${generatedRoot}/${child}`, {recursive: false, mode: 0o700});
    for (const target of [generatedRoot, `${generatedRoot}/populated`, `${generatedRoot}/legacy`])
        assertDirectory(target);
    return {
        readExact(request) {
            const observed = inspectV161PostReleaseMsiLinuxFile({path: request.path,
                maximumBytes: MAX_FILE_BYTES, allowEmpty: request.allowEmpty === true, includeBytes: true});
            return {path: observed.path, bytes: observed.content,
                identity: {path: observed.path, bytes: observed.bytes, sha256: observed.sha256}};
        },
        createExact(request) {
            if (!allowed.delete(request.path) || !Buffer.isBuffer(request.bytes))
                fail("generated fixture request differs");
            const handle = fs.openSync(request.path, fs.constants.O_WRONLY | fs.constants.O_CREAT
                | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
            try { fs.writeFileSync(handle, request.bytes); fs.fsyncSync(handle); }
            finally { fs.closeSync(handle); }
            const observed = inspectV161PostReleaseMsiLinuxFile({path: request.path,
                maximumBytes: MAX_FILE_BYTES, includeBytes: true});
            return {path: observed.path, bytes: observed.content,
                identity: {path: observed.path, bytes: observed.bytes, sha256: observed.sha256}};
        }
    };
};

export function buildV161PostReleaseMsiLifecycleToolchain(stage2Result) {
    if (!stage2Result || stage2Result.status !== "observed" || stage2Result.stage !== "complete"
        || stage2Result.cpuCalibrationAccepted !== true) fail("Stage 2 result differs");
    const value = stage2Result.toolchain;
    if (!value?.qemu?.path?.endsWith(PORTABLE_QEMU_SUFFIX)) fail("Stage 2 QEMU path differs");
    const portableRoot = value.qemu.path.slice(0, -PORTABLE_QEMU_SUFFIX.length);
    const result = {portableRoot, runtimeLoader: lifecycleToolIdentity(value.runtime?.loader,
        "runtime loader"), libraryPath: structuredClone(value.runtime?.libraryPath),
    firmware: {searchPath: value.firmware?.searchPath,
        kvmvapic: lifecycleToolIdentity(value.firmware?.kvmvapic, "kvmvapic firmware"),
        vga: lifecycleToolIdentity(value.firmware?.vga, "VGA firmware")},
    qemu: lifecycleToolIdentity(value.qemu, "QEMU"), qemuImg: lifecycleToolIdentity(value.qemuImg, "qemu-img"),
    genisoimage: lifecycleToolIdentity(value.genisoimage, "genisoimage"),
    mformat: lifecycleToolIdentity(value.mformat, "mformat"),
    mcopy: lifecycleToolIdentity(value.mcopy, "mcopy"),
    ovmfCode: lifecycleToolIdentity(value.ovmfCode, "OVMF code"),
    ovmfVarsTemplate: lifecycleToolIdentity(value.ovmfVarsTemplate, "OVMF variables")};
    return deepFreeze(result);
}

export async function observeV161PostReleaseMsiHostSources(input, operations = {}) {
    exactKeys(input, ["context", "closureRoot", "observedPreparation", "stage2Result"],
        "host source input");
    const context = validateHostedContext(input.context);
    if (input.closureRoot !== `${CLOSURE_ROOT_PREFIX}${context.nonce}`) fail("closure root differs");
    if (!input.stage2Result || !isDeepStrictEqual(input.stage2Result.context, context)
        || input.stage2Result.status !== "observed" || input.stage2Result.stage !== "complete"
        || input.stage2Result.cpuCalibrationAccepted !== true) fail("Stage 2 source differs");
    const node = input.observedPreparation?.execution?.runtime;
    const checkedNode = observedSource(node, node?.path, "Node source");
    if (!path.posix.isAbsolute(checkedNode.path) || path.posix.normalize(checkedNode.path) !== checkedNode.path)
        fail("Node source path differs");
    const expectedCpuid = input.stage2Result.probeArtifact?.files?.find(item => item.role === "cpuid");
    const cpuid = input.stage2Result.probes?.files?.find(item => item.role === "cpuid");
    if (!expectedCpuid || !cpuid || cpuid.name !== expectedCpuid.name || cpuid.bytes !== expectedCpuid.bytes
        || cpuid.sha256 !== expectedCpuid.sha256) fail("CPUID source differs");
    const checkedCpuid = observedSource({path: cpuid.path, bytes: cpuid.bytes, sha256: cpuid.sha256},
        cpuid.path, "CPUID source");
    const inspectFile = operations.inspectFile ?? (request => inspectV161PostReleaseMsiLinuxFile(request));
    const entries = [];
    for (const [name, relativePath] of CLOSURE_FILES) {
        const expectedPath = `${input.closureRoot}/${relativePath}`;
        entries.push([name, observedSource(await inspectFile({path: expectedPath, maximumBytes: MAX_FILE_BYTES}),
            expectedPath, "closure source")]);
    }
    return deepFreeze({node: checkedNode, cpuid: checkedCpuid, ...Object.fromEntries(entries)});
}

const validateHostSources = (value, {context, closureRoot, observedPreparation, stage2Result}) => {
    exactKeys(value, SOURCE_NAMES, "host sources");
    if (closureRoot !== `${CLOSURE_ROOT_PREFIX}${context.nonce}`) fail("host source closure root differs");
    const expectedNode = observedPreparation?.execution?.runtime;
    same(observedSource(value.node, expectedNode?.path, "Node source"), expectedNode, "Node source");
    const cpuid = stage2Result.probes?.files?.find(item => item.role === "cpuid");
    same(observedSource(value.cpuid, cpuid?.path, "CPUID source"),
        {path: cpuid?.path, bytes: Number(cpuid?.bytes), sha256: cpuid?.sha256}, "CPUID source");
    for (const [name, relativePath] of CLOSURE_FILES)
        observedSource(value[name], `${closureRoot}/${relativePath}`, `closure source ${name}`);
    return value;
};

export async function observeV161PostReleaseMsiPreparation(input, operations = {}) {
    exactKeys(input, ["artifact", "artifactRoot", "context", "taskRoot"], "controller input");
    const context = validateHostedContext(input.context);
    if (input.taskRoot !== `${TASK_ROOT_PREFIX}${context.nonce}`
        || input.artifactRoot !== `${input.taskRoot}/appassets`) fail("controller roots differ");
    exactKeys(input.artifact, ["repository", "id", "name", "bytes", "digest", "runId", "runAttempt",
        "headSha"], "artifact metadata");
    const artifact = input.artifact;
    if (artifact.repository !== context.repository || artifact.name !== ARTIFACT_NAME
        || artifact.runId !== context.runId || artifact.runAttempt !== context.runAttempt
        || artifact.headSha !== context.sourceSha || !DECIMAL.test(artifact.id) || !DECIMAL.test(artifact.bytes)
        || BigInt(artifact.bytes) > BigInt(MAX_ARTIFACT_BYTES)
        || typeof artifact.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(artifact.digest))
        fail("artifact metadata differs");
    const inspectFile = operations.inspectFile ?? (request => inspectV161PostReleaseMsiLinuxFile(request));
    const readDocument = operations.readDocument ?? (request => inspectV161PostReleaseMsiLinuxFile(
        {...request, maximumBytes: MAX_DOCUMENT_BYTES, includeBytes: true}));
    const read = async name => parseDocument(await readDocument({path: `${input.artifactRoot}/${name}`}),
        `${input.artifactRoot}/${name}`, name);
    const resultRead = await read("result.json"); const result = resultRead.value;
    exactKeys(result, ["schemaVersion", "kind", "status", "qualifying", "installerExecution",
        "releaseGatesCleared", "targetInput", "target", "envelope", "acquisition", "windowsPreparation",
        "inspections", "fixturePreparation", "baselinePreparation", "pending"], "preparation result");
    if (result.schemaVersion !== 1 || result.kind !== RESULT_KIND || result.status !== "prepared"
        || result.qualifying !== false || result.installerExecution !== false
        || !isDeepStrictEqual(result.releaseGatesCleared, [])
        || !isDeepStrictEqual(result.pending, ["linux-transport-reobservation"])) fail("preparation result differs");
    const target = bindTarget(result.targetInput); same(result.target, target, "preparation target");
    const harness = result.envelope?.harness;
    if (!harness || harness.repository !== context.repository || harness.sourceSha !== context.sourceSha
        || harness.eventSha !== context.eventSha || harness.runId !== context.runId
        || harness.runAttempt !== context.runAttempt || harness.nonce === context.nonce)
        fail("cross-job harness differs");
    const acquisitionRoot = path.win32.dirname(result.acquisition?.files?.[0]?.local?.path ?? "");
    const plan = buildV161PostReleaseMsiAcquisitionPlan(result.envelope, harness, acquisitionRoot);
    validateV161PostReleaseMsiAcquisitionRecord(result.acquisition, plan);
    validateV161PostReleaseMsiWindowsPreparation(result.windowsPreparation, plan);
    same(result.inspections, result.windowsPreparation.inspections, "preparation inspections");
    const fixturePlan = buildV161PostReleaseMsiFixturePlan({acquisitionPlan: plan,
        windowsPreparation: result.windowsPreparation,
        outputRoot: path.win32.dirname(result.fixturePreparation?.fixtures?.[0]?.path ?? "")});
    validateV161PostReleaseMsiFixturePreparation(result.fixturePreparation, fixturePlan);
    const baseline = validateV161PostReleaseBaselineInputPreparation(result.baselinePreparation);
    if (baseline.candidateSourceSha !== target.candidate.sourceSha
        || baseline.harnessSourceSha !== context.sourceSha) fail("baseline source binding differs");
    const fixtureProof = await read("fixture-proof.json");
    const baselineProof = await read("baseline-proof.json");
    same(fixtureProof.value, result.fixturePreparation, "fixture proof");
    same(baselineProof.value, baseline, "baseline proof");
    const files = [];
    for (const expected of plan.files) {
        const targetPath = `${input.artifactRoot}/files/${path.win32.basename(expected.destinationPath)}`;
        const observed = await inspectIdentity(inspectFile, targetPath, expected.source, "acquired file");
        files.push({bindingId: expected.bindingId, role: expected.role, ...observed});
    }
    const fixtures = [];
    for (const expected of result.fixturePreparation.fixtures) {
        const name = expected.bindingId === "lower-stamp-fixture" ? "lower-stamp.msi"
            : "safe-rollback-predecessor.msi";
        const observed = await inspectIdentity(inspectFile, `${input.artifactRoot}/files/fixtures/${name}`,
            expected, "prepared fixture");
        fixtures.push({bindingId: expected.bindingId, role: "msi", ...observed});
    }
    const runtimePath = `${input.artifactRoot}/files/node-v22.19.0-win-x64/node.exe`;
    const runtime = await inspectIdentity(inspectFile, runtimePath,
        {bytes: result.acquisition.runtime.local.bytes, sha256: plan.runtime.sha256}, "Node runtime");
    const transport = {schemaVersion: 1, kind: TRANSPORT_KIND, artifact: structuredClone(artifact),
        result: resultRead.document, fixtureProof: fixtureProof.document, baselineProof: baselineProof.document};
    const execution = {root: input.artifactRoot, transportArchiveSha256: artifact.digest.slice(7), files,
        fixtures, runtime};
    return deepFreeze({target, harness: structuredClone(harness), envelope: structuredClone(result.envelope),
        acquisitionPlan: plan, acquisitionRecord: structuredClone(result.acquisition),
        preparation: structuredClone(result.windowsPreparation),
        fixturePreparation: structuredClone(result.fixturePreparation), baselinePreparation: baseline,
        transport, execution});
}

export function buildV161PostReleaseMsiArtifactInputs(observed) {
    exactKeys(observed, ["target", "harness", "envelope", "acquisitionPlan", "acquisitionRecord",
        "preparation", "fixturePreparation", "baselinePreparation", "transport", "execution"],
    "observed preparation");
    const msiFiles = new Map(observed.execution.files.filter(file => file.role === "msi")
        .map(file => [file.bindingId, file]));
    const inspections = new Map(observed.preparation.inspections.map(item => [item.bindingId, item]));
    const fixtures = new Map(observed.fixturePreparation.fixtures.map(item => [item.bindingId, item]));
    const payloads = new Map(observed.fixturePreparation.authenticPayloads.map(item =>
        [item.bindingId, item.payload]));
    payloads.set("candidate-default", observed.fixturePreparation.candidatePayload);
    payloads.set("candidate-baseline", observed.fixturePreparation.candidateBaselinePayload);
    return deepFreeze(WINDOWS_MSI_GUEST_PRODUCT_BINDINGS.map(bindingId => {
        const fixture = fixtures.get(bindingId);
        const file = fixture ? observed.execution.fixtures.find(item => item.bindingId === bindingId)
            : msiFiles.get(bindingId);
        const payload = fixture ?? payloads.get(bindingId);
        const productCode = fixture?.productCode ?? inspections.get(bindingId)?.properties?.ProductCode;
        if (!file || !payload || typeof productCode !== "string") fail(`artifact ${bindingId} is incomplete`);
        const exe = fixture ? {bytes: fixture.exeBytes, sha256: fixture.exeSha256} : payload.exe;
        return {bindingId, sourcePath: file.path, bytes: file.bytes, sha256: file.sha256, productCode,
            exeBytes: exe.bytes, exeSha256: exe.sha256,
            configurationSha256: fixture?.configurationSha256 ?? payload.configuration.sha256,
            serviceWrapperSha256: fixture?.serviceWrapperSha256 ?? payload.wrapper.sha256};
    }));
}

export async function buildV161PostReleaseMsiLifecycleHostBinding(input) {
    exactKeys(input, ["context", "taskRoot", "closureRoot", "observedPreparation", "linuxFixture", "installedBaseSeal",
        "stage2Result", "sources", "prerequisiteEvidence", "budget",
        "wallDeadlineUnixMilliseconds"], "lifecycle binding input");
    const context = validateHostedContext(input.context);
    if (!input.stage2Result || !isDeepStrictEqual(input.stage2Result.context, context)
        || input.stage2Result.status !== "observed" || input.stage2Result.stage !== "complete"
        || input.stage2Result.cpuCalibrationAccepted !== true) fail("lifecycle Stage 2 result differs");
    const observed = input.observedPreparation;
    const sources = validateHostSources(input.sources, {context, closureRoot: input.closureRoot,
        observedPreparation: observed, stage2Result: input.stage2Result});
    const fixture = validateV161PostReleaseMsiLinuxFixturePreparation(input.linuxFixture, {context,
        taskRoot: input.taskRoot, artifactRoot: observed?.execution?.root,
        baselinePreparation: observed?.baselinePreparation});
    const request = await buildV161PostReleaseMsiHostRequest({context, taskRoot: input.taskRoot,
        toolchain: buildV161PostReleaseMsiLifecycleToolchain(input.stage2Result),
        installedBaseSeal: input.installedBaseSeal,
        candidateManifestSha256: observed?.target?.originalQualification?.manifest?.sha256,
        probeArtifact: input.stage2Result.probeArtifact,
        prerequisiteEvidence: input.prerequisiteEvidence, budget: input.budget,
        artifacts: buildV161PostReleaseMsiArtifactInputs(observed), fixture: fixture.hostFixture,
        sources: Object.fromEntries(Object.entries(sources)
            .filter(([name]) => !PREFLIGHT_ONLY_SOURCES.includes(name))),
        wallDeadlineUnixMilliseconds: input.wallDeadlineUnixMilliseconds},
    resolveV161PostReleaseMsiQemuLaunchSha256);
    return createV161PostReleaseMsiHostBinding({target: observed.target, harnessContext: observed.harness,
        envelope: observed.envelope, acquisitionPlan: observed.acquisitionPlan,
        acquisitionRecord: observed.acquisitionRecord, preparation: observed.preparation,
        fixturePreparation: observed.fixturePreparation, baselinePreparation: observed.baselinePreparation,
        transport: observed.transport, execution: observed.execution,
        installedBaseSeal: input.installedBaseSeal, hostRequest: request});
}

const AUTHENTIC_OLD_BINDING = "authentic-1.6.0-default-msi";
const CONTAINMENT_HELPER_PATH = "scripts/qualification/windows-msi-guest-containment.ps1";
const PREFLIGHT_OUTPUT_DISK_BYTES = 268_435_456;
const PREFLIGHT_SEED_NAMES = Object.freeze({node: "node.exe", launcher: "media-job-launcher.ps1",
    preflightRunner: "windows-msi-guest-containment-preflight-executor.mjs",
    containment: "windows-msi-guest-containment.ps1"});

/*
 * The containment prerequisite, produced rather than assumed.
 *
 * Rows eleven to fourteen name an `authentic-old-ifeo-containment` calibration, and the helper that
 * produces one had only ever run inside those same rows - which is to say, never before the rows that
 * need it. This runs it once, first, on a disposable overlay of the sealed installed base.
 *
 * The two identities the guest is not allowed to choose come from elsewhere and are passed in: the
 * MSI digest from the observed preparation artifact, the helper digest from the sealed closure. A
 * calibration carrying digests of its own choosing would prove nothing about which MSI was contained.
 */
export async function runV161PostReleaseMsiContainmentPreflight(input, dependencies = {}) {
    exactKeys(input, ["context", "taskRoot", "observedPreparation", "installedBaseSeal", "sources",
        "stage2Result", "budget", "wallDeadlineUnixMilliseconds"], "containment preflight input");
    const context = validateHostedContext(input.context);
    const toolchain = buildV161PostReleaseMsiLifecycleToolchain(input.stage2Result);
    const artifacts = buildV161PostReleaseMsiArtifactInputs(input.observedPreparation);
    const authentic = artifacts.find(item => item.bindingId === AUTHENTIC_OLD_BINDING);
    if (!authentic) fail("containment preflight authentic predecessor is absent");
    const helper = input.sources.containment;
    const request = buildWindowsMsiContainmentPreflightRequest({context, taskRoot: input.taskRoot,
        guestSerial: WINDOWS_MSI_CONTAINMENT_PREFLIGHT_HOST.deriveGuestNonce(context.nonce),
        expected: {productCode: authentic.productCode,
            msi: {source: "observed-preparation", path: authentic.sourcePath,
                bytes: String(authentic.bytes), sha256: authentic.sha256},
            helper: {source: "sealed-closure", path: CONTAINMENT_HELPER_PATH,
                bytes: String(helper.bytes), sha256: helper.sha256}}});
    /*
     * The guest is told which QEMU vector will carry it before that vector exists, which is only
     * honest because the vector is a function of paths this request already fixes.
     */
    const guestRequest = buildWindowsMsiContainmentPreflightGuestRequest({context, request,
        powershell: systemTool(input.installedBaseSeal, "powershell"),
        qemuLaunchSha256: windowsMsiContainmentPreflightQemuLaunchSha256({toolchain, request})});
    const seedRoot = guestRequest.guest.seedRoot;
    const guestFile = (name, observed) => ({path: `${seedRoot}\\${name}`,
        bytes: Number(observed.bytes), sha256: observed.sha256});
    const documents = buildWindowsMsiGuestPreflightSeedDocuments({preflightRequest: guestRequest,
        preflightRunner: guestFile(PREFLIGHT_SEED_NAMES.preflightRunner, input.sources.preflightRunner),
        launcher: guestFile(PREFLIGHT_SEED_NAMES.launcher, input.sources.launcher),
        node: guestFile(PREFLIGHT_SEED_NAMES.node, input.sources.node),
        observerSha256: input.sources.launcher.sha256,
        wallDeadlineUnixMilliseconds: input.wallDeadlineUnixMilliseconds});
    const staged = (name, observed) => ({name, sourcePath: observed.path,
        bytes: String(observed.bytes), sha256: observed.sha256});
    const seed = {documents, request, files: [
        staged(PREFLIGHT_SEED_NAMES.node, input.sources.node),
        staged(PREFLIGHT_SEED_NAMES.launcher, input.sources.launcher),
        staged(PREFLIGHT_SEED_NAMES.preflightRunner, input.sources.preflightRunner),
        staged(PREFLIGHT_SEED_NAMES.containment, helper),
        staged(`${AUTHENTIC_OLD_BINDING}.msi`,
            {path: authentic.sourcePath, bytes: authentic.bytes, sha256: authentic.sha256})]};
    const {limits, monotonicMilliseconds, unixMilliseconds, ...operationDependencies} = dependencies;
    let reservation = null;
    let trace = {stage: null, stageCompleted: false, completed: []};
    try {
        /*
         * The preflight boots before the matrix budget has admitted anything, so its cost is reserved
     * against the same allowances here. Without this the shared launcher gives it the generic
     * per-row deadline and a whole job can be spent before a row is constructed.
     */
        reservation = createWindowsMsiContainmentPreflightReservation({limits: input.budget,
        monotonicMilliseconds: monotonicMilliseconds ?? defaultMonotonicMilliseconds,
        unixMilliseconds: unixMilliseconds ?? Date.now,
        wallDeadlineUnixMilliseconds: input.wallDeadlineUnixMilliseconds});
        const operations = createWindowsMsiContainmentPreflightOperations({request, seed, reservation,
        host: {context, privilegeMode: PRIVILEGE_MODE, toolchain,
            baseImage: {path: input.installedBaseSeal.image.path,
                bytes: input.installedBaseSeal.image.bytes,
                sha256: input.installedBaseSeal.image.sha256,
                ownership: structuredClone(input.installedBaseSeal.image.ownership)},
            limits: limits ?? {outputDiskBytes: PREFLIGHT_OUTPUT_DISK_BYTES}},
        dependencies: operationDependencies});
        const tracedOperations = traceWindowsMsiContainmentPreflightStages(operations);
        trace = tracedOperations.trace;
        const observed = await runWindowsMsiContainmentPreflight({request}, tracedOperations.traced);
        return Object.freeze({...observed, reservation: reservation.seal()});
    } catch (error) {
        throw new WindowsMsiContainmentPreflightRunError(
            buildV161PostReleaseMsiPreflightProgress({request, trace, reservation, error}), error);
    }
}

const systemTool = (seal, role) => {
    const value = seal?.source?.systemTools?.find(item => item.role === role);
    if (!value) fail(`containment preflight ${role} tool is absent`);
    return {path: value.path, bytes: value.bytes, sha256: value.sha256};
};

export async function sealV161PostReleaseMsiInstalledBase(input) {
    exactKeys(input, ["context", "paths", "stage2Result", "helperSource"], "installed base input");
    const operations = await prepareHostedInstalledBaseOperations(input);
    return sealSameJobInstalledBase({expectedContext: input.context, paths: input.paths,
        stage2Result: input.stage2Result}, operations);
}

/*
 * The final host request, written before anything launches.
 *
 * `msi-lifecycle-request.json` is the controller's own input: it exists before the installed base is
 * sealed, before the Linux fixture is prepared and before any source is observed, so it is not the
 * document a result can be replayed against. The document
 * `validateCompletedWindowsMsiLifecycleHostResult` needs is this one, and it otherwise exists only in
 * memory for the moment between the binding being built and the matrix starting. Gemini's consumer
 * requires it under this exact name, so it is written exclusively - never appended to, never
 * overwritten - and its raw bytes are the ones the retained inventory hashes.
 */
export const V161_POST_RELEASE_MSI_HOST_REQUEST_NAME = "msi-host-request.json";

export const writeV161PostReleaseMsiHostRequest = (target, value) => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    if (bytes.length < 3 || bytes.length > MAX_CONTROLLER_DOCUMENT_BYTES) fail("host request size differs");
    const handle = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(handle, bytes); fs.fsyncSync(handle); }
    finally { fs.closeSync(handle); }
    return {name: V161_POST_RELEASE_MSI_HOST_REQUEST_NAME, bytes: String(bytes.length),
        sha256: createHash("sha256").update(bytes).digest("hex")};
};

export async function runV161PostReleaseMsiLifecycleHost(binding, dependencies = {}) {
    exactKeys(binding, ["provenance", "hostRequest", "nativeExecutionStarted", "releaseGatesCleared"],
        "lifecycle host binding");
    if (binding.nativeExecutionStarted !== false || !isDeepStrictEqual(binding.releaseGatesCleared, []))
        fail("lifecycle host binding state differs");
    /*
     * Retention comes first and is not guarded: a run that cannot retain the request nobody could
     * replay it against must not start a matrix whose evidence would be unverifiable.
     */
    if (dependencies.retainHostRequest !== undefined) dependencies.retainHostRequest(binding.hostRequest);
    const run = dependencies.runHost ?? (request =>
        runWindowsMsiLifecycleHost(request, createWindowsMsiLifecycleHostOperations({request})));
    return run(binding.hostRequest);
}

/*
 * The order below is the whole of it.
 *
 * The artifact is observed, the Linux fixture prepared, the installed base sealed - and only then is
 * the containment preflight run, on a disposable overlay of that base. Its calibration goes through
 * the production prerequisite inspector, and the record that inspection produced is what binds the
 * fourteen-row request. The rollback prerequisite arrives from outside, because its producer ran in
 * another run at another commit; the containment prerequisite cannot, because it only means anything
 * if this run's guest produced it.
 */
export async function runV161PostReleaseMsiLinuxController(input, dependencies = {}) {
    const isCalibration = input?.mode === "scenario0-calibration";
    if (input?.mode !== undefined && input.mode !== "full-matrix" && input.mode !== "scenario0-calibration") {
        fail("unsupported controller mode");
    }
    const expectedKeys = isCalibration
        ? ["mode", "context", "taskRoot", "artifactRoot", "artifact", "closureRoot", "stage2Paths",
            "stage2Result", "installedBaseHelperSource", "budget", "wallDeadlineUnixMilliseconds",
            "hostRequestPath", ...(input.prerequisiteEvidence !== undefined ? ["prerequisiteEvidence"] : [])]
        : ["context", "taskRoot", "artifactRoot", "artifact", "closureRoot", "stage2Paths",
            "stage2Result", "installedBaseHelperSource", "prerequisiteEvidence", "budget",
            "wallDeadlineUnixMilliseconds", "hostRequestPath", ...(input.mode !== undefined ? ["mode"] : [])];
    exactKeys(input, expectedKeys, "Linux lifecycle controller input");
    if (!isCalibration) {
        exactKeys(input.prerequisiteEvidence, ["rollbackCalibration"],
            "Linux lifecycle controller prerequisite evidence");
    } else {
        if (input.budget.jobBudgetMilliseconds > SCENARIO0_CALIBRATION_MAX_JOB_MILLISECONDS) {
            fail("scenario0 calibration job budget exceeds ceiling");
        }
        const rowAllowance = input.budget.rowAllowanceMilliseconds ?? input.budget.maxExecutionMilliseconds;
        if (rowAllowance && rowAllowance > SCENARIO0_CALIBRATION_MAX_EXECUTION_MILLISECONDS) {
            fail("scenario0 calibration execution allowance exceeds ceiling");
        }
    }
    const context = validateHostedContext(input.context);
    const observePreparation = dependencies.observePreparation ?? observeV161PostReleaseMsiPreparation;
    const observedPreparation = await observePreparation({context,
        taskRoot: input.taskRoot, artifactRoot: input.artifactRoot, artifact: input.artifact});
    const prepareFixture = dependencies.prepareLinuxFixture
        ?? (value => prepareV161PostReleaseMsiLinuxFixture(value,
            defaultLinuxFixtureOperations(input.taskRoot)));
    const linuxFixture = await prepareFixture({context, taskRoot: input.taskRoot,
        artifactRoot: input.artifactRoot,
        baselinePreparation: observedPreparation.baselinePreparation});
    const sealBase = dependencies.sealInstalledBase ?? sealV161PostReleaseMsiInstalledBase;
    const installedBaseSeal = await sealBase({context, paths: input.stage2Paths,
        stage2Result: input.stage2Result, helperSource: input.installedBaseHelperSource});
    const observeSources = dependencies.observeSources ?? observeV161PostReleaseMsiHostSources;
    const sources = await observeSources({context, closureRoot: input.closureRoot,
        observedPreparation, stage2Result: input.stage2Result});

    if (isCalibration) {
        const fixture = validateV161PostReleaseMsiLinuxFixturePreparation(linuxFixture, {context,
            taskRoot: input.taskRoot, artifactRoot: observedPreparation?.execution?.root,
            baselinePreparation: observedPreparation?.baselinePreparation});
        const buildCalRequest = dependencies.buildCalibrationRequest ?? buildV161PostReleaseMsiScenario0CalibrationHostRequest;
        const calibrationRequest = await buildCalRequest({
            context,
            taskRoot: input.taskRoot,
            toolchain: buildV161PostReleaseMsiLifecycleToolchain(input.stage2Result),
            installedBaseSeal,
            candidateManifestSha256: observedPreparation?.target?.originalQualification?.manifest?.sha256,
            probeArtifact: input.stage2Result.probeArtifact,
            budget: input.budget,
            artifacts: buildV161PostReleaseMsiArtifactInputs(observedPreparation),
            fixture: fixture.hostFixture,
            sources: Object.fromEntries(Object.entries(sources).filter(([name]) => !PREFLIGHT_ONLY_SOURCES.includes(name))),
            wallDeadlineUnixMilliseconds: input.wallDeadlineUnixMilliseconds,
            candidateProvenance: observedPreparation.target,
            ...(input.prerequisiteEvidence ? {prerequisiteEvidence: input.prerequisiteEvidence} : {})
        });
        if (dependencies.retainHostRequest !== undefined) {
            dependencies.retainHostRequest(calibrationRequest);
        } else {
            writeV161PostReleaseMsiHostRequest(input.hostRequestPath, calibrationRequest);
        }
        /*
         * One budget for the whole path. It is built here, before the operations that spend it, and
         * handed to the runner through the operations themselves, so nothing downstream can start a
         * second clock and hand the calibration back time this job has already spent. Its two bounds
         * are the request's remaining job budget and the wall deadline fixed before setup began.
         */
        const runCal = dependencies.runCalibration ?? (request => {
            const operations = createWindowsMsiScenario0CalibrationOperations({request,
                dependencies: {budget: createWindowsMsiScenario0CalibrationBudget({request})}});
            return runWindowsMsiScenario0Calibration(request, operations);
        });
        return runCal(calibrationRequest);
    }

    const preflight = await runV161PostReleaseMsiContainmentPreflight({context,
        taskRoot: input.taskRoot, observedPreparation, installedBaseSeal, sources,
        stage2Result: input.stage2Result, budget: input.budget,
        wallDeadlineUnixMilliseconds: input.wallDeadlineUnixMilliseconds},
    dependencies.preflightDependencies);
    if (dependencies.onPreflight) dependencies.onPreflight(preflight);
    const binding = await buildV161PostReleaseMsiLifecycleHostBinding({context, taskRoot: input.taskRoot,
        closureRoot: input.closureRoot, observedPreparation, linuxFixture, installedBaseSeal,
        stage2Result: input.stage2Result, sources,
        prerequisiteEvidence: {rollbackCalibration: input.prerequisiteEvidence.rollbackCalibration,
            oldContainment: preflight.record},
        /*
         * The preflight ran in this job, so the matrix may only claim what it left behind. A
         * remainder that could not hold one row with its margins stops the run here.
         */
        budget: chargeWindowsMsiContainmentPreflight({limits: input.budget,
            elapsedMilliseconds: preflight.reservation.elapsedMilliseconds}),
        wallDeadlineUnixMilliseconds: input.wallDeadlineUnixMilliseconds});
    return runV161PostReleaseMsiLifecycleHost(binding, {
        retainHostRequest: dependencies.retainHostRequest
            ?? (value => writeV161PostReleaseMsiHostRequest(input.hostRequestPath, value)),
        ...(dependencies.runHost ? {runHost: dependencies.runHost} : {})});
}

/*
 * A run that stopped early still has to say what it observed, so the CLI takes a progress path
 * alongside the result path. A completed matrix writes the result; an unsuccessful run writes the
 * typed bounded progress instead, and never both.
 */
export const parseV161PostReleaseMsiControllerArguments = argv => {
    if (!Array.isArray(argv) || argv.length !== 9 || argv[0] !== "run" || argv[1] !== "--request"
        || argv[3] !== "--result" || argv[5] !== "--progress" || argv[7] !== "--host-request")
        fail("arguments differ");
    return {requestPath: argv[2], resultPath: argv[4], progressPath: argv[6], hostRequestPath: argv[8]};
};

const readControllerDocument = target => {
    const observed = inspectV161PostReleaseMsiLinuxFile({path: target,
        maximumBytes: MAX_CONTROLLER_DOCUMENT_BYTES, includeBytes: true});
    let value;
    try { value = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(observed.content)); }
    catch { fail("request JSON differs"); }
    if (!observed.content.equals(Buffer.from(`${JSON.stringify(value)}\n`, "utf8")))
        fail("request serialization differs");
    return value;
};

const writeControllerResult = (target, value) => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    if (bytes.length < 3 || bytes.length > MAX_CONTROLLER_DOCUMENT_BYTES) fail("result size differs");
    const handle = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(handle, bytes); fs.fsyncSync(handle); }
    finally { fs.closeSync(handle); }
};

export const retainV161PostReleaseMsiControllerProgress = (error, write) => {
    if (!(error instanceof WindowsMsiLifecycleRunError
        || error instanceof WindowsMsiContainmentPreflightRunError
        || error instanceof WindowsMsiScenario0CalibrationRunError)) return false;
    write(error.progress);
    return true;
};

const main = async () => {
    const options = parseV161PostReleaseMsiControllerArguments(process.argv.slice(2));
    const input = readControllerDocument(options.requestPath);
    const actual = deriveActualHostedContext(input?.context?.nonce);
    if (!isDeepStrictEqual(actual, input?.context)
        || options.requestPath !== `${input?.taskRoot}/msi-lifecycle-request.json`
        || options.resultPath !== `${input?.taskRoot}/msi-lifecycle-result.json`
        || options.progressPath !== `${input?.taskRoot}/msi-lifecycle-progress.json`
        || options.hostRequestPath
            !== `${input?.taskRoot}/${V161_POST_RELEASE_MSI_HOST_REQUEST_NAME}`)
        fail("actual hosted controller binding differs");
    try {
        writeControllerResult(options.resultPath, await runV161PostReleaseMsiLinuxController(
            {...input, hostRequestPath: options.hostRequestPath}));
    } catch (error) {
        retainV161PostReleaseMsiControllerProgress(error,
            progress => writeControllerResult(options.progressPath, progress));
        throw error;
    }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}

export const POST_RELEASE_MSI_LINUX_CONTROLLER_CONSTANTS = Object.freeze({ARTIFACT_NAME,
    CLOSURE_FILES, MAX_ARTIFACT_BYTES, MAX_CONTROLLER_DOCUMENT_BYTES, MAX_DOCUMENT_BYTES,
    MAX_FAILURE_CHARACTERS, PREFLIGHT_PROGRESS_KIND, PREFLIGHT_PROGRESS_STATUS, PREFLIGHT_STAGES,
    SOURCE_NAMES});
