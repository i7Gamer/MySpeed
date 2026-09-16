import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {deriveActualHostedContext} from "./linux-windows-cpu-floor-stage2-controller.mjs";
import {validateHostedContext} from "./linux-kvm-capability.mjs";
import {createHostedQemuProcessLauncher, runHostedOwnedProcess} from "./linux-windows-cpu-floor-stage2-hosted.mjs";
import {buildWindowsMsiGuestSeedDocuments} from "./windows-msi-guest-seed-documents.mjs";
import {validateWindowsMsiGuestExecutionManifest} from "./windows-msi-guest-matrix-operations.mjs";
import {validateWindowsMsiGuestMatrixRowRequest} from "./windows-msi-guest-matrix-row.mjs";
import {validateWindowsMsiGuestMatrixSemanticResult} from "./windows-msi-guest-matrix-executor.mjs";
import {validateSameJobInstalledBaseSeal} from "./windows-msi-installed-base.mjs";

import {
    composeWindowsMsiHostQemuArguments,
    assertSuccessfulWindowsMsiHostProcess,
    parseWindowsMsiHostJson,
    createWindowsMsiHostFileInspector,
    assertWindowsMsiHostRowOverlay,
    assertWindowsMsiHostRowMedia,
    assertWindowsMsiHostRowLaunch,
    assertWindowsMsiHostRowSeedFiles,
    buildWindowsMsiHostRowActivationHandoff
} from "./linux-windows-msi-lifecycle-host.mjs";
import {renderWindowsMsiGuestBootstrap} from "./windows-msi-guest-bootstrap.mjs";


export const SCHEMA_VERSION = 1;
export const SCENARIO0_CALIBRATION_REQUEST_KIND = "myspeed-windows-msi-scenario0-calibration-request";
export const SCENARIO0_CALIBRATION_RESULT_KIND = "myspeed-windows-msi-scenario0-calibration-result";
export const SCENARIO0_CALIBRATION_PROGRESS_KIND = "myspeed-windows-msi-scenario0-calibration-progress";
export const SCENARIO0_CALIBRATION_BUDGET_KIND = "myspeed-windows-msi-scenario0-calibration-budget-observation";
export const SCENARIO0_CALIBRATION_SCENARIO_INDEX = 0;
export const SCENARIO0_CALIBRATION_SCENARIO_ID = "clean-default";

// Operational safety ceilings accepted for the FIRST diagnostic path
export const SCENARIO0_CALIBRATION_MAX_JOB_MILLISECONDS = 120 * 60_000;
export const SCENARIO0_CALIBRATION_MAX_EXECUTION_MILLISECONDS = 45 * 60_000;
export const SCENARIO0_CALIBRATION_MAX_CLEANUP_MILLISECONDS = 5 * 60_000;
export const SCENARIO0_CALIBRATION_RETENTION_RESERVE_MILLISECONDS = 10 * 60_000;
export const SCENARIO0_CALIBRATION_COMMAND_MILLISECONDS = 120_000;
export const SCENARIO0_CALIBRATION_OUTPUT_DISK_BYTES = 268_435_456;
export const SCENARIO0_CALIBRATION_RESERVATION_LABEL = "scenario0-calibration";
export const SCENARIO0_CALIBRATION_MINIMUM_PHASE_MILLISECONDS = 1_000;

const OPERATION_NAMES = Object.freeze(["inspectBase", "createOverlay", "prepareMedia", "launchRow",
    "readGuestResult", "cleanupRow"]);
const EXECUTION_PHASE = "execution";
const CLEANUP_PHASE = "cleanup";
const MINIMUM_WALL_DEADLINE = 1_000_000_000_000;
const MAXIMUM_WALL_DEADLINE = 100_000_000_000_000;
const MAX_FAILURE_MESSAGE_CHARACTERS = 512;
const MAX_AGGREGATED_FAILURES = 8;
const PUBLISHED_PROVENANCE_KIND = "myspeed-v1.6.1-published-msi-host-provenance";
const SEED_MANIFEST_NAME = "seed.json";
const BOOTSTRAP_NAME = "bootstrap.ps1";
const ACTIVATION_HANDOFF_NAME = "activation-handoff.json";
const EMPTY_WAL_NAME = "myspeed.empty.wal";
const EMPTY_SHA256 = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const NONCE = /^[0-9a-f]{32}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const RUN_ATTEMPT = /^[1-9][0-9]{0,9}$/u;
const MAX_JSON_BYTES = 1_048_576;
const FILE_WRITE_BITS = 0o222;

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

const exactKeys = (value, expected, label) => {
    if (!isObject(value)) throw new Error(`${label} must be an object`);
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
        throw new Error(`${label} keys differ`);
    return value;
};

const exactString = (value, label, pattern) => {
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

const bool = (value, expected, label) => {
    if (typeof value !== "boolean" || value !== expected) throw new Error(`${label} differs`);
    return value;
};

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

const posixPath = (value, label) => {
    const candidate = exactString(value, label, /^\/[^\x00-\x1f\x7f]*$/u);
    if (path.posix.normalize(candidate) !== candidate || candidate.includes("//"))
        throw new Error(`${label} is not canonical POSIX`);
    return candidate;
};

const executableIdentity = (value, label) => {
    exactKeys(value, ["path", "bytes", "sha256", "ownership"], label);
    posixPath(value.path, `${label} path`);
    exactString(value.bytes, `${label} bytes`, /^[1-9][0-9]{0,19}$/u);
    exactString(value.sha256, `${label} SHA-256`, SHA256);
    exactKeys(value.ownership, ["uid", "gid", "mode", "ordinaryUserWritable"], `${label} ownership`);
    for (const name of ["uid", "gid"]) exactString(value.ownership[name], `${label} ownership ${name}`,
        /^(?:0|[1-9][0-9]{0,9})$/u);
    exactString(value.ownership.mode, `${label} ownership mode`, /^[0-7]{3,4}$/u);
    bool(value.ownership.ordinaryUserWritable, false, `${label} ordinary-user writability`);
    return value;
};

const sealedRootIdentity = (value, label) => {
    executableIdentity(value, label);
    const mode = Number.parseInt(value.ownership.mode, 8);
    if (value.ownership.uid !== "0" || value.ownership.gid !== "0"
        || value.ownership.ordinaryUserWritable !== false || (mode & FILE_WRITE_BITS) !== 0)
        throw new Error(`${label} ownership differs`);
    return value;
};

const fileIdentity = (value, label) => {
    if (isObject(value) && value.ownership) return sealedRootIdentity(value, label);
    exactKeys(value, ["path", "bytes", "sha256"], label);
    posixPath(value.path, `${label} path`);
    exactString(value.bytes, `${label} bytes`, /^[1-9][0-9]{0,19}$/u);
    exactString(value.sha256, `${label} SHA-256`, SHA256);
    return value;
};

const descendant = (root, value, label) => {
    const candidate = posixPath(value, label);
    const relative = path.posix.relative(root, candidate);
    if (relative === "" || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative))
        throw new Error(`${label} escapes its root`);
    return candidate;
};

/*
 * Every retained document is carried as its own bytes with the digest that identifies them, never as a
 * parsed projection beside them. A projection can be true while the bytes it claims to describe are
 * not, and the bytes are what the guest actually produced, so validation decodes these and reads
 * nothing else. Base64 rather than a Buffer because the controller writes this document as JSON and a
 * later step reads it back: a Buffer arrives on the far side as {type,data} and is no longer evidence.
 */
const rawBinding = (value, label) => {
    exactKeys(value, ["path", "bytes", "sha256", "bytesBase64"], label);
    posixPath(value.path, `${label} path`);
    integer(value.bytes, `${label} bytes`, 1, MAX_JSON_BYTES);
    exactString(value.sha256, `${label} SHA-256`, SHA256);
    const expectedBase64Characters = 4 * Math.ceil(value.bytes / 3);
    if (typeof value.bytesBase64 !== "string" || value.bytesBase64.length !== expectedBase64Characters)
        throw new Error(`${label} base64 differs`);
    const bytes = Buffer.from(value.bytesBase64, "base64");
    if (bytes.toString("base64") !== value.bytesBase64 || bytes.length !== value.bytes
        || sha256(bytes) !== value.sha256) throw new Error(`${label} identity differs`);
    try {
        const parsed = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
        if (!bytes.equals(Buffer.from(JSON.stringify(parsed), "utf8"))) throw new Error();
    } catch { throw new Error(`${label} JSON differs`); }
    return value;
};

const decodeRawBinding = (value, label) => {
    rawBinding(value, label);
    return JSON.parse(Buffer.from(value.bytesBase64, "base64").toString("utf8"));
};

const boundedText = value => String(value ?? "").slice(0, MAX_FAILURE_MESSAGE_CHARACTERS);

const failureEntry = error => ({name: boundedText(error instanceof Error ? error.name : "Error"),
    message: boundedText(error instanceof Error ? error.message : error)});

const failureRecord = error => ({...failureEntry(error),
    failures: (error instanceof AggregateError ? error.errors : []).slice(0, MAX_AGGREGATED_FAILURES)
        .map(failureEntry)});


export class WindowsMsiScenario0CalibrationRunError extends Error {
    constructor(progress, cause) {
        super(progress?.failure?.message ?? "Scenario 0 calibration failed", {cause});
        this.name = "WindowsMsiScenario0CalibrationRunError";
        this.progress = progress;
    }
}

export class WindowsMsiScenario0CalibrationBudgetError extends Error {
    constructor(message, observation) {
        super(message);
        this.name = "WindowsMsiScenario0CalibrationBudgetError";
        this.observation = observation;
    }
}

const defaultMonotonicMilliseconds = () => Number(process.hrtime.bigint() / 1_000_000n);

/*
 * One budget, created once, for the whole job. It is deliberately not restartable: the operations
 * factory builds it before the first command and the runner is handed the same object, so no phase
 * can re-zero the clock the way a second construction would. Two bounds apply at once. The monotonic
 * bound is what this process has spent, and the wall deadline is the instant the job as a whole must
 * be done by - it was fixed before the controller started and so already carries the setup this
 * process never saw. Whichever is nearer wins. Every phase then subtracts the reserves that must
 * survive it: execution keeps cleanup and retention back, cleanup keeps retention back, and nothing
 * is allowed to spend the retention reserve, because evidence that is never uploaded proves nothing.
 */
export const createWindowsMsiScenario0CalibrationBudget = ({request: input, dependencies = {}}) => {
    const request = validateWindowsMsiScenario0CalibrationRequest(input);
    const monotonicMilliseconds = dependencies.monotonicMilliseconds ?? defaultMonotonicMilliseconds;
    const unixMilliseconds = dependencies.unixMilliseconds ?? Date.now;
    if (typeof monotonicMilliseconds !== "function" || typeof unixMilliseconds !== "function")
        throw new TypeError("MSI scenario0 calibration budget needs a clock");
    const limits = request.limits;
    const started = monotonicMilliseconds();
    const reserveFor = phase => phase === CLEANUP_PHASE
        ? limits.retentionReserveMilliseconds
        : limits.retentionReserveMilliseconds + limits.maxCleanupMilliseconds;
    const elapsedMilliseconds = () => monotonicMilliseconds() - started;
    const remainingMilliseconds = () => Math.min(limits.jobBudgetMilliseconds - elapsedMilliseconds(),
        request.wallDeadlineUnixMilliseconds - unixMilliseconds());
    const seal = status => {
        const remaining = remainingMilliseconds();
        return {schemaVersion: SCHEMA_VERSION, kind: SCENARIO0_CALIBRATION_BUDGET_KIND, status,
            exhausted: status !== "completed",
            jobBudgetMilliseconds: limits.jobBudgetMilliseconds,
            wallDeadlineUnixMilliseconds: request.wallDeadlineUnixMilliseconds,
            elapsedMilliseconds: limits.jobBudgetMilliseconds - remaining,
            remainingMilliseconds: remaining};
    };
    const refuse = message => {
        throw new WindowsMsiScenario0CalibrationBudgetError(message, seal("exhausted"));
    };
    const allowance = phase => remainingMilliseconds() - reserveFor(phase);
    return Object.freeze({
        startedMonotonicMilliseconds: started,
        monotonicMilliseconds,
        elapsedMilliseconds,
        remainingMilliseconds,
        allowance,
        seal,
        commandMilliseconds(phase = EXECUTION_PHASE) {
            const available = allowance(phase);
            if (available < SCENARIO0_CALIBRATION_MINIMUM_PHASE_MILLISECONDS)
                refuse(`MSI scenario0 calibration budget cannot fund a ${phase} command`);
            return Math.min(limits.commandMilliseconds, available);
        },
        admitExecution() {
            const available = allowance(EXECUTION_PHASE);
            if (available < SCENARIO0_CALIBRATION_MINIMUM_PHASE_MILLISECONDS)
                refuse("MSI scenario0 calibration budget cannot fund the execution reservation");
            return {label: request.reservation.label,
                executionMilliseconds: Math.min(request.reservation.executionMilliseconds, available),
                cleanupMilliseconds: request.reservation.cleanupMilliseconds};
        },
        assertRetention(label) {
            if (remainingMilliseconds() < limits.retentionReserveMilliseconds)
                refuse(`MSI scenario0 calibration budget cannot hold the retention reserve after ${label}`);
        }
    });
};

export const validateWindowsMsiScenario0CalibrationRequest = value => {
    exactKeys(value, [
        "schemaVersion", "kind", "qualifying", "sourceSha", "eventSha", "runId",
        "runAttempt", "nonce", "toolchainSha256", "context", "limits", "reservation",
        "toolchain", "baseImage", "candidateProvenance", "expected", "row", "installedBaseSeal",
        "wallDeadlineUnixMilliseconds"
    ], "MSI scenario0 calibration request");

    integer(value.schemaVersion, "MSI scenario0 calibration request schema", SCHEMA_VERSION, SCHEMA_VERSION);
    if (value.kind !== SCENARIO0_CALIBRATION_REQUEST_KIND)
        throw new Error("MSI scenario0 calibration request kind differs");
    bool(value.qualifying, false, "MSI scenario0 calibration request qualifying");

    exactString(value.sourceSha, "MSI scenario0 calibration request source SHA", COMMIT_SHA);
    exactString(value.eventSha, "MSI scenario0 calibration request event SHA", COMMIT_SHA);
    exactString(value.runId, "MSI scenario0 calibration request run ID", RUN_ID);
    exactString(value.runAttempt, "MSI scenario0 calibration request run attempt", RUN_ATTEMPT);
    exactString(value.nonce, "MSI scenario0 calibration request nonce", NONCE);
    exactString(value.toolchainSha256, "MSI scenario0 calibration request toolchain SHA", SHA256);

    validateHostedContext(value.context);
    for (const name of ["sourceSha", "eventSha", "runId", "runAttempt", "nonce"]) {
        if (value.context[name] !== value[name])
            throw new Error(`MSI scenario0 calibration context binding differs: ${name}`);
    }

    // Limits
    exactKeys(value.limits, [
        "jobBudgetMilliseconds", "maxExecutionMilliseconds", "maxCleanupMilliseconds",
        "retentionReserveMilliseconds", "commandMilliseconds", "outputDiskBytes"
    ], "MSI scenario0 calibration limits");
    integer(value.limits.jobBudgetMilliseconds, "job budget", 60_000, SCENARIO0_CALIBRATION_MAX_JOB_MILLISECONDS);
    integer(value.limits.maxExecutionMilliseconds, "max execution", 1_000, SCENARIO0_CALIBRATION_MAX_EXECUTION_MILLISECONDS);
    integer(value.limits.maxCleanupMilliseconds, "max cleanup", 1_000, SCENARIO0_CALIBRATION_MAX_CLEANUP_MILLISECONDS);
    integer(value.limits.retentionReserveMilliseconds, "retention reserve", 60_000, SCENARIO0_CALIBRATION_MAX_JOB_MILLISECONDS);
    integer(value.limits.commandMilliseconds, "command limit", 1_000, SCENARIO0_CALIBRATION_COMMAND_MILLISECONDS);
    integer(value.limits.outputDiskBytes, "output disk bytes", SCENARIO0_CALIBRATION_OUTPUT_DISK_BYTES, SCENARIO0_CALIBRATION_OUTPUT_DISK_BYTES);
    integer(value.wallDeadlineUnixMilliseconds, "MSI scenario0 calibration wall deadline",
        MINIMUM_WALL_DEADLINE, MAXIMUM_WALL_DEADLINE);

    // Reservation
    exactKeys(value.reservation, ["label", "executionMilliseconds", "cleanupMilliseconds"], "MSI scenario0 calibration reservation");
    if (value.reservation.label !== SCENARIO0_CALIBRATION_RESERVATION_LABEL)
        throw new Error("MSI scenario0 calibration reservation label differs");
    integer(value.reservation.executionMilliseconds, "execution reservation", 1_000, value.limits.maxExecutionMilliseconds);
    integer(value.reservation.cleanupMilliseconds, "cleanup reservation", 1_000, value.limits.maxCleanupMilliseconds);

    if (value.reservation.executionMilliseconds + value.reservation.cleanupMilliseconds + value.limits.retentionReserveMilliseconds > value.limits.jobBudgetMilliseconds)
        throw new Error("MSI scenario0 calibration reservation exceeds job budget");

    // Base image
    fileIdentity(value.baseImage, "MSI scenario0 calibration base image");

    // Installed base seal
    validateSameJobInstalledBaseSeal(value.installedBaseSeal, value.context);
    if (value.installedBaseSeal.image.sha256 !== value.baseImage.sha256)
        throw new Error("MSI scenario0 calibration installed base image digest differs");

    if (!isObject(value.candidateProvenance))
        throw new Error("MSI scenario0 calibration candidate provenance differs");

    // Expected
    exactKeys(value.expected, [
        "sourceSha", "eventSha", "runId", "runAttempt", "candidateManifestSha256",
        "closureSha256", "fixtureManifestSha256", "baseImageSha256", "probeArtifact"
    ], "MSI scenario0 calibration expected");
    for (const name of ["sourceSha", "eventSha", "runId", "runAttempt"]) {
        if (value.expected[name] !== value[name])
            throw new Error(`MSI scenario0 calibration expected binding differs: ${name}`);
    }
    if (value.expected.baseImageSha256 !== value.baseImage.sha256)
        throw new Error("MSI scenario0 calibration expected base image differs");

    // Row: Scenario 0 only
    const row = value.row;
    exactKeys(row, [
        "scenarioIndex", "scenarioId", "nonce", "rowRoot", "overlayPath", "seedRoot",
        "seedIsoPath", "outputDiskPath", "guestResultPath", "serialLogPath", "pidPath",
        "ovmfVarsPath", "rowRequest", "executionManifest", "guestEnvelope",
        "launcherRequest", "seedFiles"
    ], "MSI scenario0 calibration row");
    integer(row.scenarioIndex, "scenario index", SCENARIO0_CALIBRATION_SCENARIO_INDEX, SCENARIO0_CALIBRATION_SCENARIO_INDEX);
    if (row.scenarioId !== SCENARIO0_CALIBRATION_SCENARIO_ID)
        throw new Error("MSI scenario0 calibration scenario ID differs");
    exactString(row.nonce, "row nonce", NONCE);

    posixPath(row.rowRoot, "row root");
    for (const name of [
        "overlayPath", "seedRoot", "seedIsoPath", "outputDiskPath", "guestResultPath",
        "serialLogPath", "pidPath", "ovmfVarsPath"
    ]) {
        descendant(row.rowRoot, row[name], `MSI scenario0 calibration row ${name}`);
    }

    const generatedNames = [SEED_MANIFEST_NAME, BOOTSTRAP_NAME, ACTIVATION_HANDOFF_NAME];
    for (const name of ["rowRequest", "executionManifest", "guestEnvelope", "launcherRequest"]) {
        rawBinding(row[name], `MSI scenario0 calibration retained ${name}`);
        descendant(row.seedRoot, row[name].path, `MSI scenario0 calibration retained ${name} path`);
        generatedNames.push(path.posix.relative(row.seedRoot, row[name].path));
    }

    /*
     * Every seed file name is interpolated into the seed root and then created there, so the set is
     * bounded and each name is a safe relative path before any of it is used. The names the host
     * generates for itself are reserved: a seed file that landed on one of them would either be
     * refused mid-copy, with the row already half written, or silently stand in for a document the
     * guest is supposed to receive from the host.
     */
    const seedByName = assertWindowsMsiHostRowSeedFiles(row.seedFiles,
        {label: "MSI scenario0 calibration", reservedNames: generatedNames});

    const rowRequest = validateWindowsMsiGuestMatrixRowRequest(
        decodeRawBinding(row.rowRequest, "MSI scenario0 calibration row request"));
    const execution = validateWindowsMsiGuestExecutionManifest(
        decodeRawBinding(row.executionManifest, "MSI scenario0 calibration execution manifest"));
    const launchRequest = decodeRawBinding(row.launcherRequest, "MSI scenario0 calibration launcher request");

    /*
     * The retained row request is the document the guest actually executes, so this run's identity has
     * to be readable from it rather than asserted beside it. Everything the guest later reports is
     * bound back to these same fields by the semantic validator, which closes the loop from the
     * dispatched job through the guest and back into the result.
     */
    for (const [name, expected] of Object.entries({sourceSha: value.sourceSha, eventSha: value.eventSha,
        runId: value.runId, runAttempt: value.runAttempt, nonce: row.nonce}))
        if (rowRequest[name] !== expected)
            throw new Error(`MSI scenario0 calibration row request binding differs: ${name}`);
    if (rowRequest.scenarioIndex !== SCENARIO0_CALIBRATION_SCENARIO_INDEX
        || rowRequest.matrix.scenarios[rowRequest.scenarioIndex].id !== SCENARIO0_CALIBRATION_SCENARIO_ID)
        throw new Error("MSI scenario0 calibration row request scenario differs");
    if (rowRequest.guest.baseImageSha256 !== value.baseImage.sha256
        || rowRequest.prerequisites.candidateManifestSha256 !== value.expected.candidateManifestSha256
        || rowRequest.prerequisites.closureSha256 !== value.expected.closureSha256
        || rowRequest.prerequisites.fixtureManifestSha256 !== value.expected.fixtureManifestSha256
        || execution.fixture.manifestSha256 !== value.expected.fixtureManifestSha256
        || JSON.stringify(execution.probeArtifact) !== JSON.stringify(value.expected.probeArtifact))
        throw new Error("MSI scenario0 calibration row prerequisite differs");

    const runnerSource = seedByName.get("windows-msi-guest-matrix-executor.mjs");
    const launcherSource = seedByName.get("media-job-launcher.ps1");
    if (!runnerSource || !launcherSource)
        throw new Error("MSI scenario0 calibration required seed launcher differs");

    const rebuilt = buildWindowsMsiGuestSeedDocuments({
        rowRequest,
        executionManifest: execution,
        matrixRunner: {
            path: launchRequest.files.runner.path,
            bytes: Number(runnerSource.bytes),
            sha256: runnerSource.sha256
        },
        launcher: {
            path: launchRequest.files.launcher.path,
            bytes: Number(launcherSource.bytes),
            sha256: launcherSource.sha256
        },
        observerSha256: launchRequest.observerSha256,
        wallDeadlineUnixMilliseconds: launchRequest.wallDeadlineUnixMilliseconds
    });

    for (const [name, actual] of Object.entries({
        rowRequest: row.rowRequest,
        executionManifest: row.executionManifest,
        envelope: row.guestEnvelope,
        launcherRequest: row.launcherRequest
    })) {
        const exp = rebuilt[name];
        if (actual.bytes !== exp.bytes || actual.sha256 !== exp.sha256 || actual.bytesBase64 !== exp.bytesBase64)
            throw new Error(`MSI scenario0 calibration rebuilt ${name} differs`);
    }

    return value;
};

export const buildWindowsMsiScenario0CalibrationQemuArguments = ({request, row, overlay, media}) => {
    validateWindowsMsiScenario0CalibrationRequest(request);
    return composeWindowsMsiHostQemuArguments({
        toolchain: request.toolchain,
        overlay,
        media,
        guestSerial: row.nonce,
        paths: {
            ovmfVarsPath: row.ovmfVarsPath,
            serialLogPath: row.serialLogPath,
            pidPath: row.pidPath
        }
    });
};

const assertBase = (value, request) => {
    exactKeys(value, ["path", "bytes", "sha256", "format", "ownership", "virtualBytes", "sealedReadOnly"],
        "MSI scenario0 calibration base image");
    if (value.path !== request.baseImage.path || value.bytes !== request.baseImage.bytes
        || value.sha256 !== request.baseImage.sha256 || value.format !== "qcow2"
        || value.sealedReadOnly !== true)
        throw new Error("MSI scenario0 calibration base image changed");
    return value;
};

const assertLaunchRecord = (value, {request, row, overlay, media}) => {
    assertWindowsMsiHostRowLaunch(value, {request, row, overlay, media,
        expectedArgv: buildWindowsMsiScenario0CalibrationQemuArguments({request, row, overlay, media}),
        additionalKeys: ["qemuPidAbsentAfter"]});
    /*
     * One addition to the shared row contract: PID absence is kept as its own observation, because
     * the point of a calibration is to learn what the launcher actually reported and a flag that
     * folds it into treeGone cannot say which half was missing. The exit status is now required to be
     * success by the shared contract itself.
     */
    bool(value.qemuPidAbsentAfter, true, "MSI scenario0 calibration QEMU execution proof");
    return value;
};

const assertOperations = operations => {
    if (!isObject(operations)) throw new Error("MSI scenario0 calibration operations differ");
    for (const name of OPERATION_NAMES) if (typeof operations[name] !== "function")
        throw new Error(`MSI scenario0 calibration operation is absent: ${name}`);
    const budget = operations.budget;
    if (!isObject(budget) || typeof budget.admitExecution !== "function"
        || typeof budget.seal !== "function" || typeof budget.assertRetention !== "function")
        throw new Error("MSI scenario0 calibration operations budget differs");
    return budget;
};

const progressDocument = ({status, failure, budget}) => ({
    schemaVersion: SCHEMA_VERSION,
    kind: SCENARIO0_CALIBRATION_PROGRESS_KIND,
    status,
    qualifying: false,
    scenarioIndex: SCENARIO0_CALIBRATION_SCENARIO_INDEX,
    scenarioId: SCENARIO0_CALIBRATION_SCENARIO_ID,
    failure,
    budget,
    releaseGatesCleared: []
});

export const runWindowsMsiScenario0Calibration = async (input, operations) => {
    const request = validateWindowsMsiScenario0CalibrationRequest(input);
    const budget = assertOperations(operations);
    const row = request.row;
    const startedMonotonicMilliseconds = budget.monotonicMilliseconds();

    let launchAttempted = false;
    let groupZero = false;
    let overlay = null;
    let media = null;
    let launch = null;
    let launchReservation = null;
    try {
        const baseBefore = assertBase(await operations.inspectBase({request, phase: "before"}), request);
        overlay = assertWindowsMsiHostRowOverlay(
            await operations.createOverlay({request, row, base: baseBefore}), row, request);
        media = assertWindowsMsiHostRowMedia(
            await operations.prepareMedia({request, row, overlay}), row, request);

        let guestResult = null;
        let primaryFailure = null;
        try {
            launchReservation = budget.admitExecution();
            launchAttempted = true;
            launch = assertLaunchRecord(await operations.launchRow({request, row, overlay, media,
                reservation: launchReservation}), {request, row, overlay, media});
            groupZero = true;
            const retained = await operations.readGuestResult({request, row, media, launch});
            exactKeys(retained, ["guestResult", "outputAfter"], "MSI scenario0 calibration retained row output");
            guestResult = rawBinding(retained.guestResult, "MSI scenario0 calibration retained guest result");
            fileIdentity(retained.outputAfter, "MSI scenario0 calibration output disk after QEMU");
            media = {...media, outputAfter: retained.outputAfter};
        } catch (error) { primaryFailure = error; }

        /*
         * Cleanup is asked for unconditionally and is never told what to believe: the operations hold
         * the only record of what this run's QEMU actually did, and that record - not the fact that a
         * call returned, and not a flag passed down from here - is what may authorise a deletion.
         */
        let cleanup = null;
        let cleanupFailure = null;
        try {
            cleanup = await operations.cleanupRow({request, row, overlay, media, launch, launchAttempted});
            exactKeys(cleanup ?? {}, ["groupZeroBeforeRemoval", "removed"],
                "MSI scenario0 calibration overlay cleanup");
            if (cleanup.removed !== true || cleanup.groupZeroBeforeRemoval !== groupZero)
                throw new Error("MSI scenario0 calibration overlay cleanup differs");
        } catch (error) { cleanupFailure = error; }

        if (cleanupFailure !== null) {
            if (primaryFailure !== null)
                throw new AggregateError([primaryFailure, cleanupFailure],
                    "MSI scenario0 calibration row and cleanup failed");
            throw cleanupFailure;
        }
        if (primaryFailure !== null) throw primaryFailure;
        if (!groupZero) throw new Error("MSI scenario0 calibration row did not prove QEMU group zero");

        const completedMonotonicMilliseconds = budget.monotonicMilliseconds();
        budget.assertRetention("the calibration row");

        const baseAfter = assertBase(await operations.inspectBase({request, phase: "after"}), request);
        if (JSON.stringify(baseBefore) !== JSON.stringify(baseAfter))
            throw new Error("MSI scenario0 calibration base image changed");

        const result = {
            schemaVersion: SCHEMA_VERSION,
            kind: SCENARIO0_CALIBRATION_RESULT_KIND,
            status: "completed",
            qualifying: false,
            sourceSha: request.sourceSha,
            eventSha: request.eventSha,
            runId: request.runId,
            runAttempt: request.runAttempt,
            nonce: request.nonce,
            toolchainSha256: request.toolchainSha256,
            candidateProvenance: structuredClone(request.candidateProvenance),
            baseBefore,
            baseAfter,
            installedBaseSeal: structuredClone(request.installedBaseSeal),
            rowProof: {
                scenarioIndex: SCENARIO0_CALIBRATION_SCENARIO_INDEX,
                scenarioId: SCENARIO0_CALIBRATION_SCENARIO_ID,
                overlay,
                media,
                qemu: launch,
                guestResult,
                guestResultSha256: guestResult.sha256,
                rowRequestSha256: row.rowRequest.sha256,
                executionManifestSha256: row.executionManifest.sha256,
                overlayReceiptSha256: overlay.receiptSha256,
                qemuLaunchSha256: launch.argvSha256,
                outputAfterSha256: media.outputAfter.sha256,
                overlayCleanup: cleanup
            },
            timing: {
                observedDurationMilliseconds: completedMonotonicMilliseconds - startedMonotonicMilliseconds,
                startedMonotonicMilliseconds,
                completedMonotonicMilliseconds,
                reservation: launchReservation,
                budget: budget.seal("completed")
            },
            releaseGatesCleared: []
        };

        return validateCompletedWindowsMsiScenario0CalibrationResult(result, request);
    } catch (error) {
        if (error instanceof WindowsMsiScenario0CalibrationRunError) throw error;
        const exhausted = error instanceof WindowsMsiScenario0CalibrationBudgetError;
        throw new WindowsMsiScenario0CalibrationRunError(progressDocument({
            status: exhausted ? "budget-exhausted" : "failed",
            failure: exhausted ? null : failureRecord(error),
            budget: exhausted ? error.observation : budget.seal("failed")
        }), error);
    }
};

const assertBudgetObservation = (value, request, timing) => {
    exactKeys(value, ["schemaVersion", "kind", "status", "exhausted", "jobBudgetMilliseconds",
        "wallDeadlineUnixMilliseconds", "elapsedMilliseconds", "remainingMilliseconds"],
    "MSI scenario0 calibration budget observation");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== SCENARIO0_CALIBRATION_BUDGET_KIND
        || value.status !== "completed" || value.exhausted !== false
        || value.jobBudgetMilliseconds !== request.limits.jobBudgetMilliseconds
        || value.wallDeadlineUnixMilliseconds !== request.wallDeadlineUnixMilliseconds
        || !Number.isSafeInteger(value.elapsedMilliseconds) || !Number.isSafeInteger(value.remainingMilliseconds)
        || value.elapsedMilliseconds < timing.observedDurationMilliseconds
        || value.elapsedMilliseconds + value.remainingMilliseconds !== value.jobBudgetMilliseconds
        || value.remainingMilliseconds < request.limits.retentionReserveMilliseconds)
        throw new Error("MSI scenario0 calibration budget observation differs");
    return value;
};

export const validateCompletedWindowsMsiScenario0CalibrationResult = (value, requestInput) => {
    const request = validateWindowsMsiScenario0CalibrationRequest(requestInput);
    const row = request.row;

    exactKeys(value, [
        "schemaVersion", "kind", "status", "qualifying", "sourceSha", "eventSha",
        "runId", "runAttempt", "nonce", "toolchainSha256", "candidateProvenance",
        "baseBefore", "baseAfter", "installedBaseSeal", "rowProof", "timing",
        "releaseGatesCleared"
    ], "MSI scenario0 calibration result");

    integer(value.schemaVersion, "MSI scenario0 calibration result schema", SCHEMA_VERSION, SCHEMA_VERSION);
    if (value.kind !== SCENARIO0_CALIBRATION_RESULT_KIND || value.status !== "completed")
        throw new Error("MSI scenario0 calibration result did not complete");
    bool(value.qualifying, false, "MSI scenario0 calibration result qualifying");

    if (!Array.isArray(value.releaseGatesCleared) || value.releaseGatesCleared.length !== 0)
        throw new Error("MSI scenario0 calibration cleared release gates");

    for (const name of ["sourceSha", "eventSha", "runId", "runAttempt", "nonce", "toolchainSha256"]) {
        if (value[name] !== request[name])
            throw new Error(`MSI scenario0 calibration result binding differs: ${name}`);
    }

    if (JSON.stringify(value.candidateProvenance) !== JSON.stringify(request.candidateProvenance))
        throw new Error("MSI scenario0 calibration result candidate provenance differs");

    const baseBefore = assertBase(value.baseBefore, request);
    const baseAfter = assertBase(value.baseAfter, request);
    if (JSON.stringify(baseBefore) !== JSON.stringify(baseAfter))
        throw new Error("MSI scenario0 calibration base image changed");

    if (JSON.stringify(value.installedBaseSeal) !== JSON.stringify(request.installedBaseSeal))
        throw new Error("MSI scenario0 calibration installed-base seal differs");

    // Timing
    exactKeys(value.timing, [
        "observedDurationMilliseconds", "startedMonotonicMilliseconds",
        "completedMonotonicMilliseconds", "reservation", "budget"
    ], "MSI scenario0 calibration timing");
    integer(value.timing.observedDurationMilliseconds, "observed duration", 1, SCENARIO0_CALIBRATION_MAX_JOB_MILLISECONDS);
    if (!Number.isFinite(value.timing.startedMonotonicMilliseconds) || !Number.isFinite(value.timing.completedMonotonicMilliseconds))
        throw new Error("MSI scenario0 calibration timing endpoints must be finite");
    if (value.timing.completedMonotonicMilliseconds - value.timing.startedMonotonicMilliseconds !== value.timing.observedDurationMilliseconds)
        throw new Error("MSI scenario0 calibration timing interval recomputation differs");

    exactKeys(value.timing.reservation, ["label", "executionMilliseconds", "cleanupMilliseconds"],
        "MSI scenario0 calibration timing reservation");
    if (value.timing.reservation.label !== request.reservation.label
        || !Number.isSafeInteger(value.timing.reservation.executionMilliseconds)
        || value.timing.reservation.executionMilliseconds < 1
        || value.timing.reservation.executionMilliseconds > request.reservation.executionMilliseconds
        || value.timing.reservation.cleanupMilliseconds !== request.reservation.cleanupMilliseconds)
        throw new Error("MSI scenario0 calibration timing reservation differs");
    if (value.timing.reservation.executionMilliseconds > SCENARIO0_CALIBRATION_MAX_EXECUTION_MILLISECONDS)
        throw new Error("MSI scenario0 calibration execution reservation exceeds ceiling");
    if (value.timing.reservation.cleanupMilliseconds > SCENARIO0_CALIBRATION_MAX_CLEANUP_MILLISECONDS)
        throw new Error("MSI scenario0 calibration cleanup reservation exceeds ceiling");
    assertBudgetObservation(value.timing.budget, request, value.timing);

    // Row proof
    const rowProof = value.rowProof;
    exactKeys(rowProof, [
        "scenarioIndex", "scenarioId", "overlay", "media", "qemu", "guestResult",
        "guestResultSha256", "rowRequestSha256", "executionManifestSha256",
        "overlayReceiptSha256", "qemuLaunchSha256", "outputAfterSha256", "overlayCleanup"
    ], "MSI scenario0 calibration row proof");

    if (rowProof.scenarioIndex !== SCENARIO0_CALIBRATION_SCENARIO_INDEX)
        throw new Error("MSI scenario0 calibration scenario index differs");
    if (rowProof.scenarioId !== SCENARIO0_CALIBRATION_SCENARIO_ID)
        throw new Error("MSI scenario0 calibration scenario ID differs");

    const overlay = assertWindowsMsiHostRowOverlay(rowProof.overlay, row, request);
    const media = assertWindowsMsiHostRowMedia(rowProof.media, row, request, true);
    fileIdentity(media.outputAfter, "MSI scenario0 calibration output disk after QEMU");
    if (media.outputAfter.path !== row.outputDiskPath
        || media.outputAfter.bytes !== String(request.limits.outputDiskBytes)
        || rowProof.outputAfterSha256 !== media.outputAfter.sha256)
        throw new Error("MSI scenario0 calibration output disk proof differs");

    assertLaunchRecord(rowProof.qemu, {request, row, overlay, media});

    /*
     * The host proof and the guest's own retained request have to name the same overlay receipt and
     * the same QEMU invocation. That is what ties the document the guest executed to the process this
     * host actually started, and it is the binding a recomputed digest alone cannot supply.
     */
    const rowRequest = decodeRawBinding(row.rowRequest, "MSI scenario0 calibration row request");
    const execution = decodeRawBinding(row.executionManifest, "MSI scenario0 calibration execution manifest");
    if (rowProof.rowRequestSha256 !== row.rowRequest.sha256
        || rowProof.executionManifestSha256 !== row.executionManifest.sha256)
        throw new Error("MSI scenario0 calibration host and guest retained inputs differ");
    if (rowProof.overlayReceiptSha256 !== overlay.receiptSha256
        || rowRequest.guest.overlayReceiptSha256 !== rowProof.overlayReceiptSha256
        || rowProof.qemuLaunchSha256 !== rowProof.qemu.argvSha256
        || rowRequest.guest.qemuLaunchSha256 !== rowProof.qemuLaunchSha256)
        throw new Error("MSI scenario0 calibration host and guest launch binding differs");

    // Guest result: the retained bytes are the evidence, and nothing beside them is trusted.
    const guest = rawBinding(rowProof.guestResult, "MSI scenario0 calibration retained guest result");
    if (guest.path !== row.guestResultPath)
        throw new Error("MSI scenario0 calibration guest result binding differs");
    if (rowProof.guestResultSha256 !== guest.sha256)
        throw new Error("MSI scenario0 calibration guest result hash differs");
    const parsed = JSON.parse(Buffer.from(guest.bytesBase64, "base64").toString("utf8"));
    try {
        validateWindowsMsiGuestMatrixSemanticResult(parsed, rowRequest, execution);
    } catch (error) {
        throw new Error(`MSI scenario0 calibration guest semantic result differs: ${error.message}`);
    }
    if (parsed.scenarioIndex !== SCENARIO0_CALIBRATION_SCENARIO_INDEX
        || parsed.scenarioId !== SCENARIO0_CALIBRATION_SCENARIO_ID
        || parsed.status !== "completed" || parsed.matrixPassed !== true
        || parsed.rowResult?.rowPassed !== true)
        throw new Error("MSI scenario0 calibration guest semantic result did not pass");

    // Overlay cleanup
    exactKeys(rowProof.overlayCleanup, ["groupZeroBeforeRemoval", "removed"],
        "MSI scenario0 calibration overlay cleanup");
    if (rowProof.overlayCleanup.groupZeroBeforeRemoval !== true || rowProof.overlayCleanup.removed !== true)
        throw new Error("MSI scenario0 calibration overlay cleanup differs");

    return value;
};

/*
 * Cleanup deletes named files, never a tree. Every path the operations create is recorded as it is
 * created, and the paths the launcher reports back - its serial log, its screenshots - are recorded
 * from the launcher's own record, so removal can name each one. What is left is a directory that must
 * already be empty: if anything unexpected is inside it the rmdir fails and the row is preserved,
 * which is the outcome to prefer when the alternative is a recursive delete that cannot be reviewed.
 */
const collectDescendantPaths = (value, root, into) => {
    if (typeof value === "string") {
        if (value.startsWith(`${root}/`)) into.add(value);
        return;
    }
    if (Array.isArray(value)) { for (const item of value) collectDescendantPaths(item, root, into); return; }
    if (isObject(value)) for (const item of Object.values(value)) collectDescendantPaths(item, root, into);
};

export const createWindowsMsiScenario0CalibrationOperations = ({request: input, dependencies = {}}) => {
    const request = validateWindowsMsiScenario0CalibrationRequest(input);
    const actualContext = (dependencies.deriveActualContext ?? deriveActualHostedContext)(request.nonce);
    if (JSON.stringify(actualContext) !== JSON.stringify(request.context))
        throw new Error("MSI scenario0 calibration actual hosted context differs");
    const filesystem = dependencies.filesystem ?? fs;
    const runOwned = dependencies.runOwned ?? runHostedOwnedProcess;
    const inspectFile = dependencies.inspectFile ?? createWindowsMsiHostFileInspector(filesystem);
    const budget = dependencies.budget ?? createWindowsMsiScenario0CalibrationBudget({request, dependencies});

    const ownedRows = new Set();
    const ownedFiles = new Set();
    const ownedDirectories = new Map();
    const qemuResults = new Map();
    const qemuAttempts = new Set();

    const ownFile = target => { ownedFiles.add(target); return target; };
    /*
     * A directory is owned only if this task created it, and it is created one level at a time: a
     * recursive mkdir would bring ancestors into existence that nothing recorded, and cleanup would
     * then be unable to empty the root it does own. The non-recursive call is also what keeps a
     * directory that already existed from being claimed — it fails instead of adopting it.
     */
    const directoryIdentity = target => {
        const observed = filesystem.lstatSync(target);
        if (!observed.isDirectory() || observed.isSymbolicLink())
            throw new Error("MSI scenario0 calibration owned directory identity differs");
        return {dev: observed.dev, ino: observed.ino};
    };
    const createOwnedDirectory = target => {
        filesystem.mkdirSync(target, {recursive: false, mode: 0o700});
        ownedDirectories.set(target, directoryIdentity(target));
        return target;
    };
    const createOwnedAncestors = (root, relativeName) => {
        const parts = relativeName.split("/");
        let current = root;
        for (const part of parts.slice(0, -1)) {
            current = `${current}/${part}`;
            if (!ownedDirectories.has(current)) createOwnedDirectory(current);
        }
        return `${root}/${relativeName}`;
    };

    /*
     * The whole inventory is read before anything is removed. Unlinking first and discovering the
     * unexpected entry only while removing directories destroys the overlay, the serial log and the
     * guest result on the way to finding out, which is the opposite of preserving the row for
     * inspection. This is a check, not a lock: an entry can still appear between this walk and the
     * unlink that follows, so it bounds what this task will delete rather than describing what the
     * directory contains at the moment of deletion.
     */
    const assertOwnedInventory = row => {
        if (!ownedDirectories.has(row.rowRoot))
            throw new Error("MSI scenario0 calibration row cleanup scope differs");
        for (const target of [...ownedFiles, ...ownedDirectories.keys()])
            if (target !== row.rowRoot && !target.startsWith(`${row.rowRoot}/`))
                throw new Error("MSI scenario0 calibration row cleanup scope differs");
        const directories = [...ownedDirectories.keys()].sort((left, right) => left.length - right.length);
        for (const directory of directories) {
            const identity = directoryIdentity(directory);
            const expected = ownedDirectories.get(directory);
            if (identity.dev !== expected.dev || identity.ino !== expected.ino)
                throw new Error("MSI scenario0 calibration owned directory identity differs");
            for (const entry of filesystem.readdirSync(directory, {withFileTypes: true})) {
                const target = `${directory}/${entry.name}`;
                const owned = entry.isDirectory() ? ownedDirectories.has(target) : ownedFiles.has(target);
                if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()) || !owned)
                    throw new Error(
                        `MSI scenario0 calibration row cleanup found an unexpected entry: ${target}`);
            }
        }
    };

    const invoke = (tool, argv, phase = EXECUTION_PHASE) =>
        runOwned(request.toolchain.runtimeLoader.path,
            ["--library-path", request.toolchain.libraryPath.join(":"), tool.path, ...argv],
            {timeoutMs: budget.commandMilliseconds(phase), maxStreamBytes: 1_048_576});

    const checkTool = async (tool, label) => {
        const observed = await inspectFile(tool.path);
        if (observed.bytes !== tool.bytes || observed.sha256 !== tool.sha256
            || JSON.stringify(observed.ownership) !== JSON.stringify(tool.ownership))
            throw new Error(`MSI scenario0 calibration ${label} identity changed`);
    };

    const writeExclusive = (target, bytes) => {
        const handle = filesystem.openSync(target, "wx", 0o600);
        try { filesystem.writeFileSync(handle, bytes); filesystem.fsyncSync(handle); }
        finally { filesystem.closeSync(handle); }
        ownFile(target);
    };

    const inspectExact = async (expected, allowEmpty = false) => {
        const observed = await inspectFile(expected.path, Number.MAX_SAFE_INTEGER, allowEmpty ? 0 : 1);
        if (observed.bytes !== String(expected.bytes) || observed.sha256 !== expected.sha256
            || (expected.ownership && JSON.stringify(observed.ownership) !== JSON.stringify(expected.ownership)))
            throw new Error("MSI scenario0 calibration copied file identity differs");
        return observed;
    };

    const createRowQemuLauncher = () => dependencies.runQemu
        ?? createHostedQemuProcessLauncher({
            context: request.context,
            dependencies: dependencies.qemuDependencies
        });

    return {
        budget,
        /*
         * The closing inspection runs after the row has been torn down, so it is funded from what the
         * cleanup phase may still spend rather than from an execution allowance that is by then
         * meaningless. The retention reserve is held back from both.
         */
        async inspectBase({phase} = {}) {
            const observed = await inspectExact(request.baseImage);
            if ((observed.mode & FILE_WRITE_BITS) !== 0)
                throw new Error("MSI scenario0 calibration base image is writable");
            await checkTool(request.toolchain.qemuImg, "qemu-img");
            const infoResult = assertSuccessfulWindowsMsiHostProcess(await invoke(request.toolchain.qemuImg,
                ["info", "--output=json", request.baseImage.path],
                phase === "after" ? CLEANUP_PHASE : EXECUTION_PHASE),
            "MSI scenario0 calibration base inspection");
            const info = parseWindowsMsiHostJson(infoResult.stdout, "MSI scenario0 calibration base metadata");
            if (info.format !== "qcow2" || !Number.isSafeInteger(info["virtual-size"]) || info["virtual-size"] < 1)
                throw new Error("MSI scenario0 calibration base metadata differs");
            return {
                path: observed.path, bytes: observed.bytes, sha256: observed.sha256, format: "qcow2",
                ownership: observed.ownership, virtualBytes: String(info["virtual-size"]), sealedReadOnly: true
            };
        },
        async createOverlay({row}) {
            if (filesystem.existsSync(row.rowRoot))
                throw new Error("MSI scenario0 calibration row root already exists");
            createOwnedDirectory(row.rowRoot);
            ownedRows.add(row.rowRoot);
            await checkTool(request.toolchain.qemuImg, "qemu-img");
            assertSuccessfulWindowsMsiHostProcess(await invoke(request.toolchain.qemuImg, ["create", "-f", "qcow2", "-F", "qcow2", "-b",
                request.baseImage.path, row.overlayPath]), "MSI scenario0 calibration overlay creation");
            ownFile(row.overlayPath);
            const infoResult = assertSuccessfulWindowsMsiHostProcess(await invoke(request.toolchain.qemuImg,
                ["info", "--output=json", row.overlayPath]), "MSI scenario0 calibration overlay inspection");
            const info = parseWindowsMsiHostJson(infoResult.stdout, "MSI scenario0 calibration overlay metadata");
            if (info.format !== "qcow2" || info["backing-filename"] !== request.baseImage.path)
                throw new Error("MSI scenario0 calibration overlay metadata differs");
            const receipt = Buffer.from(JSON.stringify({
                path: row.overlayPath, format: info.format,
                backingFilename: info["backing-filename"], backingBaseSha256: request.baseImage.sha256
            }), "utf8");
            return {
                path: row.overlayPath, format: "qcow2", backingBaseSha256: request.baseImage.sha256,
                createNew: true, receiptSha256: sha256(receipt)
            };
        },
        async prepareMedia({row}) {
            if (!ownedRows.has(row.rowRoot) || filesystem.existsSync(row.seedRoot))
                throw new Error("MSI scenario0 calibration seed root ownership differs");
            createOwnedDirectory(row.seedRoot);
            const copied = [];
            for (const document of [row.rowRequest, row.executionManifest, row.guestEnvelope,
                row.launcherRequest]) {
                writeExclusive(document.path, Buffer.from(document.bytesBase64, "base64"));
                const observed = await inspectExact(document);
                copied.push({name: path.posix.basename(document.path), bytes: Number(observed.bytes),
                    sha256: observed.sha256});
            }
            for (const source of row.seedFiles) {
                const allowEmpty = source.name === EMPTY_WAL_NAME && source.bytes === "0"
                    && source.sha256 === EMPTY_SHA256;
                await inspectExact({path: source.sourcePath, bytes: source.bytes, sha256: source.sha256}, allowEmpty);
                const target = createOwnedAncestors(row.seedRoot, source.name);
                filesystem.copyFileSync(source.sourcePath, target, filesystem.constants.COPYFILE_EXCL);
                ownFile(target);
                const observed = await inspectExact({path: target, bytes: source.bytes, sha256: source.sha256}, allowEmpty);
                copied.push({name: source.name, bytes: Number(observed.bytes), sha256: observed.sha256});
            }
            const seedManifestBytes = Buffer.from(JSON.stringify({
                schemaVersion: SCHEMA_VERSION,
                kind: "myspeed-windows-msi-lifecycle-row-seed",
                sourceSha: request.sourceSha,
                eventSha: request.eventSha,
                runId: request.runId,
                runAttempt: request.runAttempt,
                hostNonce: request.nonce,
                rowNonce: row.nonce,
                scenarioIndex: row.scenarioIndex,
                scenarioId: row.scenarioId,
                rowRequestSha256: row.rowRequest.sha256,
                executionManifestSha256: row.executionManifest.sha256,
                files: copied
            }), "utf8");
            writeExclusive(`${row.seedRoot}/${SEED_MANIFEST_NAME}`, seedManifestBytes);
            const bootstrapBytes = renderWindowsMsiGuestBootstrap({
                nonce: row.nonce,
                hostNonce: request.nonce,
                sourceSha: request.sourceSha,
                eventSha: request.eventSha,
                runId: request.runId,
                runAttempt: request.runAttempt,
                scenarioIndex: row.scenarioIndex,
                scenarioId: row.scenarioId,
                seedManifestSha256: sha256(seedManifestBytes),
                launcherRequestSha256: row.launcherRequest.sha256,
                rowRequestSha256: row.rowRequest.sha256,
                executionManifestSha256: row.executionManifest.sha256
            });
            writeExclusive(`${row.seedRoot}/${BOOTSTRAP_NAME}`, bootstrapBytes);
            let activationHandoffSha256;
            if (request.candidateProvenance?.kind === PUBLISHED_PROVENANCE_KIND) {
                const handoff = buildWindowsMsiHostRowActivationHandoff({
                    identity: {repository: request.context.repository, sourceSha: request.sourceSha,
                        eventSha: request.eventSha, runId: request.runId, runAttempt: request.runAttempt,
                        nonce: request.nonce},
                    row, bootstrapBytes});
                const handoffBytes = Buffer.from(handoff.bytesBase64, "base64");
                const handoffPath = `${row.seedRoot}/${ACTIVATION_HANDOFF_NAME}`;
                writeExclusive(handoffPath, handoffBytes);
                await inspectExact({path: handoffPath, bytes: String(handoff.bytes), sha256: handoff.sha256});
                activationHandoffSha256 = handoff.sha256;
            }
            for (const tool of [request.toolchain.genisoimage, request.toolchain.mformat])
                await checkTool(tool, path.posix.basename(tool.path));
            assertSuccessfulWindowsMsiHostProcess(await invoke(request.toolchain.genisoimage,
                ["-quiet", "-J", "-r", "-V", "MYSPEEDSEED", "-o", row.seedIsoPath, row.seedRoot]),
            "MSI scenario0 calibration seed ISO creation");
            ownFile(row.seedIsoPath);
            const outputHandle = filesystem.openSync(row.outputDiskPath, "wx", 0o600);
            try {
                filesystem.ftruncateSync(outputHandle, request.limits.outputDiskBytes);
                filesystem.fsyncSync(outputHandle);
            } finally { filesystem.closeSync(outputHandle); }
            ownFile(row.outputDiskPath);
            assertSuccessfulWindowsMsiHostProcess(await invoke(request.toolchain.mformat,
                ["-i", row.outputDiskPath, "-v", "MYSPEEDOUT", "::"]),
            "MSI scenario0 calibration output disk creation");
            filesystem.copyFileSync(request.toolchain.ovmfVarsTemplate.path, row.ovmfVarsPath,
                filesystem.constants.COPYFILE_EXCL);
            ownFile(row.ovmfVarsPath);
            const seed = await inspectFile(row.seedIsoPath);
            const output = await inspectFile(row.outputDiskPath);
            const variables = await inspectExact({
                path: row.ovmfVarsPath,
                bytes: request.toolchain.ovmfVarsTemplate.bytes,
                sha256: request.toolchain.ovmfVarsTemplate.sha256
            });
            return {
                seed: {
                    path: seed.path, bytes: seed.bytes, sha256: seed.sha256,
                    manifestSha256: sha256(seedManifestBytes), readOnly: true, volumeLabel: "MYSPEEDSEED",
                    ...(activationHandoffSha256 ? {activationHandoffSha256} : {})
                },
                outputBefore: {
                    path: output.path, bytes: output.bytes, sha256: output.sha256,
                    createNew: true, volumeLabel: "MYSPEEDOUT"
                },
                ovmfVarsSha256: variables.sha256
            };
        },
        async launchRow({row, overlay, media, reservation}) {
            for (const tool of [request.toolchain.runtimeLoader, request.toolchain.qemu])
                await checkTool(tool, path.posix.basename(tool.path));
            const argv = buildWindowsMsiScenario0CalibrationQemuArguments({request, row, overlay, media});
            const runQemu = createRowQemuLauncher();
            qemuAttempts.add(row.rowRoot);
            ownFile(row.pidPath);
            ownFile(row.serialLogPath);
            const monitored = await runQemu({
                paths: {
                    root: row.rowRoot,
                    portableRoot: request.toolchain.portableRoot,
                    qemuPid: row.pidPath,
                    outputDisk: row.outputDiskPath
                },
                toolchain: {
                    runtime: {
                        loader: request.toolchain.runtimeLoader,
                        libraryPath: request.toolchain.libraryPath
                    },
                    qemu: {...request.toolchain.qemu, invocationPath: request.toolchain.qemu.path},
                    firmware: request.toolchain.firmware
                },
                privilegeMode: request.privilegeMode,
                argv,
                reservation
            });
            qemuResults.set(row.rowRoot, monitored);
            const paths = new Set();
            collectDescendantPaths(monitored, row.rowRoot, paths);
            for (const target of paths) ownFile(target);
            const processResult = monitored?.process ?? {};
            /*
             * The record below is what the consumer replays, so every field in it is the launcher's
             * own observation. A launch that cannot show the process gone stops here rather than
             * reporting a default: an unproven process is exactly the case where the row's state has
             * to survive for an authenticated cleanup to deal with.
             */
            if (monitored?.executionSucceeded !== true || processResult.cleanupProven !== true
                || processResult.treeGone !== true || processResult.qemuPidAbsentAfter !== true)
                throw new Error("MSI scenario0 calibration QEMU did not prove group zero");
            return {
                argv,
                argvSha256: sha256(Buffer.from(JSON.stringify(argv), "utf8")),
                loaderPath: request.toolchain.runtimeLoader.path,
                loaderSha256: request.toolchain.runtimeLoader.sha256,
                qemuPath: request.toolchain.qemu.path,
                qemuSha256: request.toolchain.qemu.sha256,
                pid: processResult.qemuPid,
                startTicks: processResult.qemuStartTicks,
                processGroupId: processResult.processGroupId,
                exitCode: processResult.exitCode,
                signal: processResult.signal,
                timedOut: processResult.timedOut,
                terminationReason: processResult.terminationReason ?? null,
                cleanupProven: processResult.cleanupProven,
                earlyBoot: monitored.earlyBoot ?? null,
                treeGone: processResult.treeGone,
                qemuPidAbsentAfter: processResult.qemuPidAbsentAfter
            };
        },
        async readGuestResult({row}) {
            const monitored = qemuResults.get(row.rowRoot);
            if (!monitored || monitored.executionSucceeded !== true || monitored.process?.treeGone !== true
                || monitored.process.qemuPidAbsentAfter !== true)
                throw new Error("MSI scenario0 calibration output read preceded QEMU group zero");
            await checkTool(request.toolchain.mcopy, "mcopy");
            assertSuccessfulWindowsMsiHostProcess(await invoke(request.toolchain.mcopy,
                ["-i", row.outputDiskPath, "::result.json", row.guestResultPath]),
            "MSI scenario0 calibration guest result extraction");
            ownFile(row.guestResultPath);
            const result = await inspectFile(row.guestResultPath, MAX_JSON_BYTES);
            const bytes = filesystem.readFileSync(result.path);
            if (bytes.length !== Number(result.bytes) || sha256(bytes) !== result.sha256)
                throw new Error("MSI scenario0 calibration guest result read differs");
            const outputAfter = await inspectFile(row.outputDiskPath);
            return {
                guestResult: {
                    path: result.path, bytes: bytes.length, sha256: result.sha256,
                    bytesBase64: bytes.toString("base64")
                },
                outputAfter: {
                    path: outputAfter.path,
                    bytes: outputAfter.bytes,
                    sha256: outputAfter.sha256
                }
            };
        },
        async cleanupRow({row}) {
            if (!ownedRows.has(row.rowRoot)) return {groupZeroBeforeRemoval: false, removed: false};
            const monitored = qemuResults.get(row.rowRoot);
            const groupZeroBeforeRemoval = monitored?.executionSucceeded === true
                && monitored.process?.cleanupProven === true && monitored.process.treeGone === true
                && monitored.process.qemuPidAbsentAfter === true;
            if (qemuAttempts.has(row.rowRoot) && !groupZeroBeforeRemoval)
                return {groupZeroBeforeRemoval: false, removed: false};
            assertOwnedInventory(row);
            for (const target of ownedFiles) filesystem.rmSync(target, {recursive: false, force: true});
            for (const directory of [...ownedDirectories.keys()].sort((left, right) => right.length - left.length))
                filesystem.rmdirSync(directory);
            if (filesystem.existsSync(row.rowRoot))
                throw new Error("MSI scenario0 calibration row cleanup failed");
            ownedRows.delete(row.rowRoot);
            return {groupZeroBeforeRemoval, removed: true};
        }
    };
};
