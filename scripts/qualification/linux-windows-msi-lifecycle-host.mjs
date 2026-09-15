import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {deriveActualHostedContext} from
    "./linux-windows-cpu-floor-stage2-controller.mjs";
import {bindWindowsMsiPrerequisiteEvidence} from
    "./windows-msi-prerequisite-evidence.mjs";
import {createWindowsMsiLifecycleBudget, validateWindowsMsiLifecycleBudgetLimits,
    WINDOWS_MSI_LIFECYCLE_BUDGET, WindowsMsiLifecycleAdmissionError} from
    "./windows-msi-lifecycle-budget.mjs";
import {validateEarlyBoot} from "./linux-windows-cpu-floor-stage2.mjs";
import {validateHostedContext} from "./linux-kvm-capability.mjs";
import {createHostedQemuProcessLauncher, runHostedOwnedProcess} from
    "./linux-windows-cpu-floor-stage2-hosted.mjs";
import {renderWindowsMsiGuestBootstrap} from "./windows-msi-guest-bootstrap.mjs";
import {buildWindowsMsiGuestSeedDocuments} from "./windows-msi-guest-seed-documents.mjs";
import {inspectCompletedWindowsMsiGuestMatrixEvidence} from
    "./windows-msi-guest-lifecycle-evidence.mjs";
import {validateV161PostReleaseMsiHostProvenance} from
    "../release/post-release-msi-host-bridge.mjs";
import {buildWindowsMsiSetupCompleteActivation, createWindowsMsiSetupCompleteHandoff} from
    "./windows-msi-post-setup-activation.mjs";

const SCHEMA_VERSION = 1;
const REQUEST_KIND = "myspeed-windows-msi-lifecycle-host-request";
const RESULT_KIND = "myspeed-windows-msi-lifecycle-host-result";
const SCENARIO_COUNT = 14;
const MAX_JSON_BYTES = 1_048_576;
const MAX_PATH_CHARACTERS = 1024;
const OUTPUT_DISK_BYTES = 268_435_456;
const ROW_MILLISECONDS = 16_200_000;
const QEMU_MEMORY = "6144M";
const QEMU_SMP = "2,sockets=1,cores=2,threads=1";
const QEMU_MACHINE = "q35";
const COMMAND_MILLISECONDS = 120_000;
const MAX_COMMAND_STREAM_BYTES = 65_536;
const FILE_WRITE_BITS = 0o222;
const SEED_MANIFEST_NAME = "seed-manifest.json";
const MSI_HANDOFF_NAME = "myspeed-msi-handoff.json";
const DELETE_CHARACTER_CODE = 127;
const IO_CHUNK_BYTES = 1024 * 1024;
const OPTIONAL_EMPTY_WAL_NAME = "fixture/populated/data/storage.db-wal";
const PROGRESS_KIND = "myspeed-windows-msi-lifecycle-host-progress";
const MAX_FAILURE_MESSAGE_CHARACTERS = 512;
const MAX_AGGREGATED_FAILURES = 8;
const BUDGET_OBSERVATION_KIND = "myspeed-windows-msi-lifecycle-budget-observation";
const EMPTY_SHA256 = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const NONCE = /^[0-9a-f]{32}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const RUN_ATTEMPT = /^[1-9][0-9]{0,9}$/u;
const DECIMAL = /^[1-9][0-9]{0,19}$/u;
const PRESEAL_ARTIFACT_NAME = "release-candidate-manifest";
const PRESEAL_INNER_NAME = "qualification-manifest.json";
const CANDIDATE_ARTIFACT_NAMES = Object.freeze({"candidate-default": {
    msi: "release-msi-MySpeed-installer.msi", exe: "MySpeed-windows-x64.exe"},
"candidate-baseline": {msi: "release-msi-MySpeed-installer-baseline.msi",
    exe: "MySpeed-windows-x64-baseline.exe"}});

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
    if (typeof value !== "string" || value.length < 1 || value.length > MAX_PATH_CHARACTERS)
        throw new Error(`${label} differs`);
    const match = pattern.exec(value);
    if (!match || match.index !== 0 || match[0].length !== value.length) throw new Error(`${label} differs`);
    return value;
};
const integer = (value, label, minimum, maximum) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new Error(`${label} differs`);
    return value;
};
const bool = (value, label) => {
    if (typeof value !== "boolean") throw new Error(`${label} differs`);
    return value;
};
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const posixPath = (value, label) => {
    if (typeof value !== "string" || value.length < 2 || value.length > MAX_PATH_CHARACTERS
        || !value.startsWith("/") || value.includes(",") || [...value].some(character => {
            const code = character.codePointAt(0);
            return code <= 31 || code === DELETE_CHARACTER_CODE;
        })) throw new Error(`${label} differs`);
    const item = value;
    if (path.posix.normalize(item) !== item) throw new Error(`${label} differs`);
    return item;
};
const seedRelativePath = (value, label) => {
    exactString(value, label, /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u);
    if (path.posix.normalize(value) !== value || value.split("/").some(part => part === "." || part === ".."))
        throw new Error(`${label} differs`);
    return value;
};
const descendant = (root, value, label) => {
    const item = posixPath(value, label);
    const relative = path.posix.relative(root, item);
    if (relative === "" || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative))
        throw new Error(`${label} escapes its root`);
    return item;
};
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
const fileIdentity = (value, label) => {
    exactKeys(value, ["path", "bytes", "sha256"], label);
    posixPath(value.path, `${label} path`);
    exactString(value.bytes, `${label} bytes`, /^[1-9][0-9]{0,19}$/u);
    exactString(value.sha256, `${label} SHA-256`, SHA256);
    return value;
};

const archiveIdentity = (value, label) => {
    exactKeys(value, ["bytes", "sha256"], label);
    exactString(value.bytes, `${label} bytes`, DECIMAL);
    exactString(value.sha256, `${label} SHA-256`, SHA256);
    return value;
};

const candidateArtifact = (value, bindingId, kind, label) => {
    exactKeys(value, ["artifactId", "artifactName", "archive", "inner"], label);
    exactString(value.artifactId, `${label} ID`, DECIMAL);
    if (value.artifactName !== CANDIDATE_ARTIFACT_NAMES[bindingId][kind])
        throw new Error(`${label} name differs`);
    archiveIdentity(value.archive, `${label} archive`);
    exactKeys(value.inner, ["name", "bytes", "sha256"], `${label} inner`);
    if (value.inner.name !== (kind === "msi" ? "MySpeed-installer.msi" : "MySpeed.exe"))
        throw new Error(`${label} inner name differs`);
    exactString(value.inner.bytes, `${label} inner bytes`, DECIMAL);
    exactString(value.inner.sha256, `${label} inner SHA-256`, SHA256);
    return value;
};

const validateLegacyCandidateProvenance = (value, expectedManifestSha256, rows) => {
    exactKeys(value, ["preseal", "artifacts"], "MSI lifecycle candidate provenance");
    exactKeys(value.preseal, ["artifactId", "artifactName", "archive", "innerManifest"],
        "MSI lifecycle candidate preseal");
    exactString(value.preseal.artifactId, "MSI lifecycle preseal artifact ID", DECIMAL);
    if (value.preseal.artifactName !== PRESEAL_ARTIFACT_NAME)
        throw new Error("MSI lifecycle preseal artifact name differs");
    archiveIdentity(value.preseal.archive, "MSI lifecycle preseal archive");
    exactKeys(value.preseal.innerManifest, ["name", "bytes", "sha256"],
        "MSI lifecycle preseal inner manifest");
    if (value.preseal.innerManifest.name !== PRESEAL_INNER_NAME
        || value.preseal.innerManifest.sha256 !== expectedManifestSha256)
        throw new Error("MSI lifecycle preseal inner manifest differs");
    exactString(value.preseal.innerManifest.bytes, "MSI lifecycle preseal inner bytes", DECIMAL);
    exactString(value.preseal.innerManifest.sha256, "MSI lifecycle preseal inner SHA-256", SHA256);
    if (!Array.isArray(value.artifacts) || value.artifacts.length !== 2)
        throw new Error("MSI lifecycle candidate provenance artifacts differ");
    const artifactIds = new Set([value.preseal.artifactId]);
    value.artifacts.forEach((item, index) => {
        const bindingId = index === 0 ? "candidate-default" : "candidate-baseline";
        exactKeys(item, ["bindingId", "msi", "exe"], "MSI lifecycle candidate provenance artifact");
        if (item.bindingId !== bindingId) throw new Error("MSI lifecycle candidate binding order differs");
        candidateArtifact(item.msi, bindingId, "msi", `MSI lifecycle ${bindingId} MSI`);
        candidateArtifact(item.exe, bindingId, "exe", `MSI lifecycle ${bindingId} EXE`);
        for (const record of [item.msi, item.exe]) {
            if (artifactIds.has(record.artifactId)) throw new Error("MSI lifecycle candidate artifact ID is reused");
            artifactIds.add(record.artifactId);
        }
    });
    for (const row of rows) {
        const execution = decodeRawBinding(row.executionManifest, "MSI lifecycle candidate execution manifest");
        value.artifacts.forEach(item => {
            const actual = execution.artifacts.find(record => record.bindingId === item.bindingId);
            if (!actual || String(actual.bytes) !== item.msi.inner.bytes || actual.sha256 !== item.msi.inner.sha256
                || String(actual.exeBytes) !== item.exe.inner.bytes || actual.exeSha256 !== item.exe.inner.sha256)
                throw new Error("MSI lifecycle candidate payload provenance differs");
        });
    }
    return value;
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
    bool(value.ownership.ordinaryUserWritable, `${label} ordinary-user writability`);
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

const validateToolchain = value => {
    exactKeys(value, ["portableRoot", "runtimeLoader", "libraryPath", "firmware", "qemu", "qemuImg", "genisoimage", "mformat", "mcopy",
        "ovmfCode", "ovmfVarsTemplate"], "MSI lifecycle toolchain");
    const portableRoot = posixPath(value.portableRoot, "MSI lifecycle portable root");
    for (const name of ["runtimeLoader", "qemu", "qemuImg", "genisoimage", "mformat", "mcopy",
        "ovmfCode", "ovmfVarsTemplate"]) {
        sealedRootIdentity(value[name], `MSI lifecycle tool ${name}`);
        if (name !== "ovmfCode" && name !== "ovmfVarsTemplate")
            descendant(portableRoot, value[name].path, `MSI lifecycle tool ${name} path`);
    }
    if (!Array.isArray(value.libraryPath) || value.libraryPath.length < 1 || value.libraryPath.length > 64)
        throw new Error("MSI lifecycle library path differs");
    for (const directory of value.libraryPath) posixPath(directory, "MSI lifecycle library directory");
    exactKeys(value.firmware, ["searchPath", "kvmvapic", "vga"], "MSI lifecycle firmware");
    if (value.firmware.searchPath !== `${portableRoot}/usr/share/qemu`)
        throw new Error("MSI lifecycle firmware search path differs");
    for (const [name, expectedPath] of [["kvmvapic", `${portableRoot}/usr/share/qemu/kvmvapic.bin`],
        ["vga", `${portableRoot}/usr/share/seabios/vgabios-stdvga.bin`]]) {
        sealedRootIdentity(value.firmware[name], `MSI lifecycle ${name} firmware`);
        if (value.firmware[name].path !== expectedPath)
            throw new Error(`MSI lifecycle ${name} firmware path differs`);
    }
    return value;
};

const validateExpected = value => {
    exactKeys(value, ["sourceSha", "eventSha", "runId", "runAttempt", "candidateManifestSha256",
        "closureSha256", "fixtureManifestSha256", "rollbackCalibrationSha256", "oldContainmentSha256",
        "baseImageSha256", "probeArtifact"], "MSI lifecycle expected evidence");
    exactString(value.sourceSha, "MSI lifecycle source SHA", COMMIT_SHA);
    exactString(value.eventSha, "MSI lifecycle event SHA", COMMIT_SHA);
    exactString(value.runId, "MSI lifecycle run ID", RUN_ID);
    exactString(value.runAttempt, "MSI lifecycle run attempt", RUN_ATTEMPT);
    for (const name of ["candidateManifestSha256", "closureSha256", "fixtureManifestSha256",
        "rollbackCalibrationSha256", "oldContainmentSha256", "baseImageSha256"])
        exactString(value[name], `MSI lifecycle expected ${name}`, SHA256);
    if (!isObject(value.probeArtifact)) throw new Error("MSI lifecycle probe artifact differs");
    return value;
};

const validateHostRequest = (value, allowUnboundPostRelease) => {
    exactKeys(value, ["schemaVersion", "kind", "qualifying", "context", "repository", "sourceSha", "eventSha",
        "runId", "runAttempt", "nonce", "taskRoot", "expected", "candidateProvenance", "prerequisiteEvidence",
        "privilegeMode", "toolchain", "toolchainSha256", "baseImage", "rows", "limits"],
    "MSI lifecycle host request");
    integer(value.schemaVersion, "MSI lifecycle host schema", SCHEMA_VERSION, SCHEMA_VERSION);
    if (value.kind !== REQUEST_KIND || bool(value.qualifying, "MSI lifecycle host qualifying"))
        throw new Error("MSI lifecycle host request must be nonqualifying");
    exactString(value.repository, "MSI lifecycle repository", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
    const context = validateHostedContext(value.context);
    const expected = validateExpected(value.expected);
    for (const name of ["sourceSha", "eventSha", "runId", "runAttempt"])
        if (value[name] !== expected[name] || value[name] !== context[name])
            throw new Error(`MSI lifecycle host binding differs: ${name}`);
    if (value.repository !== context.repository || value.nonce !== context.nonce)
        throw new Error("MSI lifecycle hosted context differs");
    /*
     * The two prerequisite digests the rows carry used to be free input: any 64-character
     * hexadecimal string satisfied them, so nothing downstream could tell an executed rollback
     * calibration or containment run from a typo. The request now carries the producers' retained
     * documents, and every validation re-derives the digests from those bytes and replays the
     * acceptance semantics. A digest that does not come out of inspected evidence fails here.
     */
    const prerequisites = bindWindowsMsiPrerequisiteEvidence({
        rollbackCalibration: value.prerequisiteEvidence?.rollbackCalibration,
        oldContainment: value.prerequisiteEvidence?.oldContainment,
        context: {repository: value.repository, sourceSha: value.sourceSha, eventSha: value.eventSha,
            runId: value.runId, runAttempt: value.runAttempt, nonce: value.nonce}});
    exactKeys(value.prerequisiteEvidence, ["rollbackCalibration", "oldContainment"],
        "MSI lifecycle prerequisite evidence");
    for (const name of ["rollbackCalibrationSha256", "oldContainmentSha256"])
        if (expected[name] !== prerequisites[name])
            throw new Error(`MSI lifecycle expected ${name} is not the digest of its retained evidence`);
    if (value.privilegeMode !== "ordinary-kvm" && value.privilegeMode !== "reviewed-sudo-kvm")
        throw new Error("MSI lifecycle privilege mode differs");
    exactString(value.nonce, "MSI lifecycle host nonce", NONCE);
    validateToolchain(value.toolchain);
    exactString(value.toolchainSha256, "MSI lifecycle toolchain SHA-256", SHA256);
    if (value.toolchainSha256 !== sha256(Buffer.from(JSON.stringify(value.toolchain), "utf8")))
        throw new Error("MSI lifecycle toolchain identity differs");
    const taskRoot = posixPath(value.taskRoot, "MSI lifecycle task root");
    if (!taskRoot.endsWith(`/myspeed-windows-msi-${value.nonce}`))
        throw new Error("MSI lifecycle task root differs");
    exactKeys(value.limits, ["outputDiskBytes", "rowMilliseconds", "budget"], "MSI lifecycle host limits");
    integer(value.limits.outputDiskBytes, "MSI lifecycle output disk bytes", OUTPUT_DISK_BYTES, OUTPUT_DISK_BYTES);
    integer(value.limits.rowMilliseconds, "MSI lifecycle row deadline", ROW_MILLISECONDS, ROW_MILLISECONDS);
    validateWindowsMsiLifecycleBudgetLimits(value.limits.budget);
    sealedRootIdentity(value.baseImage, "MSI lifecycle base image");
    if (value.baseImage.sha256 !== expected.baseImageSha256 || value.baseImage.path.startsWith(`${taskRoot}/`)
        || value.baseImage.bytes === "0") throw new Error("MSI lifecycle base image binding differs");
    if (!Array.isArray(value.rows) || value.rows.length !== SCENARIO_COUNT)
        throw new Error("MSI lifecycle host row count differs");
    const nonces = new Set();
    value.rows.forEach((row, scenarioIndex) => {
        exactKeys(row, ["scenarioIndex", "scenarioId", "nonce", "rowRoot", "overlayPath", "seedRoot",
            "seedIsoPath", "outputDiskPath", "guestResultPath", "serialLogPath", "pidPath", "ovmfVarsPath",
            "rowRequest", "executionManifest", "guestEnvelope", "launcherRequest", "seedFiles"],
        "MSI lifecycle host row");
        integer(row.scenarioIndex, "MSI lifecycle host row index", scenarioIndex, scenarioIndex);
        exactString(row.scenarioId, "MSI lifecycle host scenario ID", /^[a-z0-9-]{1,96}$/u);
        exactString(row.nonce, "MSI lifecycle host row nonce", NONCE);
        if (nonces.has(row.nonce)) throw new Error("MSI lifecycle host row nonce is reused");
        nonces.add(row.nonce);
        const rowRoot = descendant(taskRoot, row.rowRoot, "MSI lifecycle row root");
        for (const name of ["overlayPath", "seedRoot", "seedIsoPath", "outputDiskPath", "guestResultPath",
            "serialLogPath", "pidPath", "ovmfVarsPath"])
            descendant(rowRoot, row[name], `MSI lifecycle row ${name}`);
        for (const [name, document] of Object.entries({rowRequest: row.rowRequest,
            executionManifest: row.executionManifest, guestEnvelope: row.guestEnvelope,
            launcherRequest: row.launcherRequest})) {
            rawBinding(document, `MSI lifecycle retained ${name}`);
            if (!document.path.startsWith(`${row.seedRoot}/`))
                throw new Error("MSI lifecycle retained guest input path differs");
        }
        if (!Array.isArray(row.seedFiles) || row.seedFiles.length < 1 || row.seedFiles.length > 128)
            throw new Error("MSI lifecycle seed file set differs");
        const names = new Set();
        for (const file of row.seedFiles) {
            exactKeys(file, ["name", "sourcePath", "bytes", "sha256"], "MSI lifecycle seed file");
            seedRelativePath(file.name, "MSI lifecycle seed file name");
            posixPath(file.sourcePath, "MSI lifecycle seed source");
            const exactEmptyWal = file.name === OPTIONAL_EMPTY_WAL_NAME && file.bytes === "0"
                && file.sha256 === EMPTY_SHA256;
            if (!exactEmptyWal) exactString(file.bytes, "MSI lifecycle seed bytes", /^[1-9][0-9]{0,19}$/u);
            exactString(file.sha256, "MSI lifecycle seed SHA-256", SHA256);
            if (file.bytes === "0" && !exactEmptyWal)
                throw new Error("MSI lifecycle empty seed file differs");
            if (names.has(file.name) || [...names].some(name => name.startsWith(`${file.name}/`)
                || file.name.startsWith(`${name}/`))) throw new Error("MSI lifecycle seed file is duplicated");
            names.add(file.name);
        }
        const rowRequest = decodeRawBinding(row.rowRequest, "MSI lifecycle retained row request");
        const execution = decodeRawBinding(row.executionManifest,
            "MSI lifecycle retained execution manifest");
        const launchRequest = decodeRawBinding(row.launcherRequest,
            "MSI lifecycle retained launcher request");
        const byName = new Map(row.seedFiles.map(file => [file.name, file]));
        const runnerSource = byName.get("windows-msi-guest-matrix-executor.mjs");
        const launcherSource = byName.get("media-job-launcher.ps1");
        if (!runnerSource || !launcherSource) throw new Error("MSI lifecycle required seed launcher differs");
        const rebuilt = buildWindowsMsiGuestSeedDocuments({rowRequest, executionManifest: execution,
            matrixRunner: {path: launchRequest.files.runner.path, bytes: Number(runnerSource.bytes),
                sha256: runnerSource.sha256}, launcher: {path: launchRequest.files.launcher.path,
                bytes: Number(launcherSource.bytes), sha256: launcherSource.sha256},
            observerSha256: launchRequest.observerSha256,
            wallDeadlineUnixMilliseconds: launchRequest.wallDeadlineUnixMilliseconds});
        for (const [name, actual] of Object.entries({rowRequest: row.rowRequest,
            executionManifest: row.executionManifest, envelope: row.guestEnvelope,
            launcherRequest: row.launcherRequest})) {
            const expected = rebuilt[name];
            if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256
                || actual.bytesBase64 !== expected.bytesBase64)
                throw new Error(`MSI lifecycle rebuilt ${name} differs`);
        }
        if (rowRequest.nonce !== row.nonce || rowRequest.scenarioIndex !== scenarioIndex
            || rowRequest.matrix.scenarios[scenarioIndex].id !== row.scenarioId)
            throw new Error("MSI lifecycle row semantic identity differs");
        for (const name of ["sourceSha", "eventSha", "runId", "runAttempt"])
            if (rowRequest[name] !== value[name]) throw new Error(`MSI lifecycle row ${name} differs`);
        if (rowRequest.prerequisites.candidateManifestSha256 !== value.expected.candidateManifestSha256
            || rowRequest.prerequisites.closureSha256 !== value.expected.closureSha256
            || rowRequest.prerequisites.fixtureManifestSha256 !== value.expected.fixtureManifestSha256
            || rowRequest.prerequisites.rollbackCalibrationSha256 !== value.expected.rollbackCalibrationSha256
            || rowRequest.prerequisites.oldContainmentSha256 !== value.expected.oldContainmentSha256
            || rowRequest.guest.baseImageSha256 !== value.baseImage.sha256
            || JSON.stringify(execution.probeArtifact) !== JSON.stringify(value.expected.probeArtifact))
            throw new Error("MSI lifecycle row prerequisite binding differs");
    });
    if (value.candidateProvenance === null && allowUnboundPostRelease === true) return value;
    if (value.candidateProvenance?.kind === "myspeed-v1.6.1-published-msi-host-provenance")
        validateV161PostReleaseMsiHostProvenance(value.candidateProvenance, value);
    else validateLegacyCandidateProvenance(value.candidateProvenance,
        value.expected.candidateManifestSha256, value.rows);
    return value;
};

export const validateWindowsMsiLifecycleHostRequest = value => validateHostRequest(value, false);

export const buildWindowsMsiLifecycleRowActivationHandoff = ({request: input, row: inputRow,
    bootstrapBytes}) => {
    const request = validateWindowsMsiLifecycleHostRequest(input);
    if (request.candidateProvenance?.kind !== "myspeed-v1.6.1-published-msi-host-provenance")
        throw new Error("MSI lifecycle activation handoff requires published provenance");
    const row = request.rows[inputRow?.scenarioIndex];
    if (!row || JSON.stringify(row) !== JSON.stringify(inputRow))
        throw new Error("MSI lifecycle activation handoff row differs");
    if (!Buffer.isBuffer(bootstrapBytes) || bootstrapBytes.length < 1 || bootstrapBytes.length > MAX_JSON_BYTES)
        throw new Error("MSI lifecycle activation bootstrap differs");
    const activation = buildWindowsMsiSetupCompleteActivation({repository: request.repository,
        sourceSha: request.sourceSha, eventSha: request.eventSha, runId: request.runId,
        runAttempt: request.runAttempt, nonce: request.nonce});
    const value = createWindowsMsiSetupCompleteHandoff(activation, {rowNonce: row.nonce,
        scenarioIndex: row.scenarioIndex, scenarioId: row.scenarioId,
        bootstrap: {name: "bootstrap.ps1", bytes: bootstrapBytes.length, sha256: sha256(bootstrapBytes)}});
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    return Object.freeze({value, bytes: bytes.length, sha256: sha256(bytes),
        bytesBase64: bytes.toString("base64")});
};

const drive = (id, format, file, readOnly = false) =>
    `if=none,id=${id},format=${format}${readOnly ? ",readonly=on" : ""},file=${file}`;

/*
 * The one QEMU vector, with one forbidden-backend guard, shared by the fourteen matrix rows and by
 * the containment preflight that runs once before them.
 *
 * `-smbios type=1,serial=<guest serial>` is what lets the guest read the serial it is held to. Both
 * the matrix boundary check and the containment helper refuse to proceed unless `Win32_BIOS`
 * reports exactly the nonce the request named, and nothing else in the chain supplies it: without
 * this the value a guest reads is whatever QEMU defaults to, which is never that nonce.
 */
export const composeWindowsMsiHostQemuArguments = ({toolchain, paths, overlay, media, guestSerial}) => {
    if (typeof guestSerial !== "string" || !NONCE.test(guestSerial))
        throw new Error("MSI host QEMU guest serial differs");
    const argv = ["-nodefaults", "-no-user-config", "-display", "none", "-monitor", "none", "-qmp", "stdio",
        "-L", toolchain.firmware.searchPath, "-accel", "kvm",
        "-machine", QEMU_MACHINE, "-cpu", "host", "-smp", QEMU_SMP, "-m", QEMU_MEMORY, "-nic", "none",
        "-smbios", `type=1,serial=${guestSerial}`,
        "-device", `VGA,id=video0,romfile=${toolchain.firmware.vga.path}`,
        "-device", "qemu-xhci,id=usb0", "-device", "usb-kbd,bus=usb0.0",
        "-drive", `if=pflash,format=raw,readonly=on,file=${toolchain.ovmfCode.path}`,
        "-drive", `if=pflash,format=raw,file=${paths.ovmfVarsPath}`, "-device", "ich9-ahci,id=sata",
        "-drive", drive("osdisk", "qcow2", overlay.path), "-device", "ide-hd,drive=osdisk,bus=sata.1",
        "-drive", drive("seed", "raw", media.seed.path, true), "-device", "ide-cd,drive=seed,bus=sata.2",
        "-drive", drive("output", "raw", media.outputBefore.path), "-device", "ide-hd,drive=output,bus=sata.3",
        "-chardev", `file,id=serial0,path=${paths.serialLogPath}`, "-device", "isa-serial,chardev=serial0",
        "-pidfile", paths.pidPath, "-boot", "order=c,strict=on"];
    const forbiddenSwitches = new Set(["-net", "-netdev", "-virtfs", "-fsdev"]);
    if (argv.some(item => forbiddenSwitches.has(item)
        || /(?:^|[,=])(?:tap|user|socket|vsock)(?:[,=]|$)|(?:^|[,=])(?:fat:|nbd:|ssh:|https?:)/iu.test(item)))
        throw new Error("MSI lifecycle QEMU vector contains a forbidden backend");
    return Object.freeze(argv);
};

const composeWindowsMsiLifecycleQemuArguments = ({request, row, overlay, media}) =>
    composeWindowsMsiHostQemuArguments({toolchain: request.toolchain, overlay, media,
        guestSerial: row.nonce,
        paths: {ovmfVarsPath: row.ovmfVarsPath, serialLogPath: row.serialLogPath, pidPath: row.pidPath}});

export const buildWindowsMsiLifecycleQemuArguments = ({request, row, overlay, media}) => {
    validateWindowsMsiLifecycleHostRequest(request);
    assertOverlay(overlay, row, request);
    assertMedia(media, row, request, Object.hasOwn(media, "outputAfter"));
    return composeWindowsMsiLifecycleQemuArguments({request, row, overlay, media});
};

export const buildUnboundWindowsMsiLifecycleQemuArguments = ({request, row, overlay, media}) => {
    validateHostRequest(request, true);
    if (request.candidateProvenance !== null)
        throw new Error("MSI lifecycle unbound QEMU request must await published provenance");
    assertOverlay(overlay, row, request);
    assertMedia(media, row, request, Object.hasOwn(media, "outputAfter"));
    return composeWindowsMsiLifecycleQemuArguments({request, row, overlay, media});
};

const assertOperations = operations => {
    const names = ["inspectBase", "createOverlay", "prepareMedia", "launchRow", "readGuestResult",
        "cleanupRow"];
    exactKeys(operations, names, "MSI lifecycle host operations");
    for (const name of names) if (typeof operations[name] !== "function")
        throw new Error(`MSI lifecycle host operation is absent: ${name}`);
};

const assertBase = (value, request) => {
    exactKeys(value, ["path", "bytes", "sha256", "ownership", "format", "virtualBytes", "sealedReadOnly"],
        "MSI lifecycle observed base image");
    if (value.path !== request.baseImage.path || value.bytes !== request.baseImage.bytes
        || value.sha256 !== request.baseImage.sha256
        || JSON.stringify(value.ownership) !== JSON.stringify(request.baseImage.ownership) || value.format !== "qcow2"
        || typeof value.virtualBytes !== "string" || !/^[1-9][0-9]{0,19}$/u.test(value.virtualBytes)
        || value.sealedReadOnly !== true) throw new Error("MSI lifecycle base image differs");
    return value;
};

const assertOverlay = (value, row, request) => {
    exactKeys(value, ["path", "format", "backingBaseSha256", "createNew", "receiptSha256"],
        "MSI lifecycle overlay");
    if (value.path !== row.overlayPath || value.format !== "qcow2"
        || value.backingBaseSha256 !== request.baseImage.sha256 || value.createNew !== true)
        throw new Error("MSI lifecycle overlay differs");
    exactString(value.receiptSha256, "MSI lifecycle overlay receipt SHA-256", SHA256);
    return value;
};

const assertMedia = (value, row, request, retained = false) => {
    exactKeys(value, ["seed", "outputBefore", "ovmfVarsSha256", ...(retained ? ["outputAfter"] : [])],
        "MSI lifecycle row media");
    const postRelease = request.candidateProvenance?.kind === "myspeed-v1.6.1-published-msi-host-provenance";
    exactKeys(value.seed, ["path", "bytes", "sha256", "manifestSha256", "readOnly", "volumeLabel",
        ...(postRelease ? ["activationHandoffSha256"] : [])],
        "MSI lifecycle seed ISO");
    if (value.seed.path !== row.seedIsoPath || value.seed.readOnly !== true
        || value.seed.volumeLabel !== "MYSPEEDSEED") throw new Error("MSI lifecycle seed ISO differs");
    exactString(value.seed.bytes, "MSI lifecycle seed ISO bytes", /^[1-9][0-9]{0,19}$/u);
    exactString(value.seed.sha256, "MSI lifecycle seed ISO SHA-256", SHA256);
    exactString(value.seed.manifestSha256, "MSI lifecycle seed manifest SHA-256", SHA256);
    if (postRelease)
        exactString(value.seed.activationHandoffSha256, "MSI lifecycle activation handoff SHA-256", SHA256);
    exactKeys(value.outputBefore, ["path", "bytes", "sha256", "createNew", "volumeLabel"],
        "MSI lifecycle empty output disk");
    if (value.outputBefore.path !== row.outputDiskPath
        || value.outputBefore.bytes !== String(request.limits.outputDiskBytes)
        || value.outputBefore.createNew !== true || value.outputBefore.volumeLabel !== "MYSPEEDOUT")
        throw new Error("MSI lifecycle empty output disk differs");
    exactString(value.outputBefore.sha256, "MSI lifecycle empty output SHA-256", SHA256);
    exactString(value.ovmfVarsSha256, "MSI lifecycle OVMF variables SHA-256", SHA256);
    return value;
};

const assertLaunch = (value, request, row, overlay, media) => {
    exactKeys(value, ["argv", "argvSha256", "loaderPath", "loaderSha256", "qemuPath", "qemuSha256",
        "pid", "startTicks", "processGroupId", "exitCode", "signal", "timedOut", "terminationReason",
        "cleanupProven", "earlyBoot", "treeGone"], "MSI lifecycle QEMU result");
    if (!Array.isArray(value.argv) || value.argv.length < 1 || value.argv.length > 128
        || value.argv.some(item => typeof item !== "string" || item.length < 1 || item.length > MAX_PATH_CHARACTERS))
        throw new Error("MSI lifecycle QEMU argv differs");
    const expectedArgv = buildWindowsMsiLifecycleQemuArguments({request, row, overlay, media});
    if (JSON.stringify(value.argv) !== JSON.stringify(expectedArgv)
        || value.argvSha256 !== sha256(Buffer.from(JSON.stringify(expectedArgv), "utf8"))
        || value.loaderPath !== request.toolchain.runtimeLoader.path
        || value.loaderSha256 !== request.toolchain.runtimeLoader.sha256
        || value.qemuPath !== request.toolchain.qemu.path
        || value.qemuSha256 !== request.toolchain.qemu.sha256)
        throw new Error("MSI lifecycle QEMU invocation differs");
    exactString(value.argvSha256, "MSI lifecycle QEMU argv SHA-256", SHA256);
    for (const name of ["loaderPath", "qemuPath"]) posixPath(value[name], `MSI lifecycle ${name}`);
    for (const name of ["loaderSha256", "qemuSha256"])
        exactString(value[name], `MSI lifecycle ${name}`, SHA256);
    integer(value.pid, "MSI lifecycle QEMU PID", 1, 0x7fff_ffff);
    exactString(value.startTicks, "MSI lifecycle QEMU start ticks", /^[1-9][0-9]{0,23}$/u);
    integer(value.processGroupId, "MSI lifecycle QEMU process group", 1, 0x7fff_ffff);
    integer(value.exitCode, "MSI lifecycle QEMU exit", 0, 255);
    if (value.signal !== null || bool(value.timedOut, "MSI lifecycle QEMU timeout")
        || value.terminationReason !== null || !bool(value.cleanupProven, "MSI lifecycle QEMU cleanup")
        || !bool(value.treeGone, "MSI lifecycle QEMU tree exit"))
        throw new Error("MSI lifecycle QEMU row did not stop cleanly");
    validateEarlyBoot(value.earlyBoot, {root: row.rowRoot});
    return value;
};

/*
 * A run that stops early still has to say what it observed. An opaque rejection loses the two facts
 * a later feasibility judgement needs - how many rows actually fit, and what stopped the run - so
 * every unsuccessful run carries a bounded typed progress document instead.
 */
export class WindowsMsiLifecycleRunError extends Error {
    constructor(progress, cause) {
        super(progress.status === "budget-exhausted"
            ? `MSI lifecycle run stopped after ${progress.budget.rowsCompleted} of ${SCENARIO_COUNT} rows`
            : `MSI lifecycle run failed: ${progress.failure?.message ?? "unknown failure"}`);
        this.name = "WindowsMsiLifecycleRunError";
        this.progress = progress;
        this.cause = cause;
    }
}

const boundedText = value => String(value ?? "").slice(0, MAX_FAILURE_MESSAGE_CHARACTERS);

const failureEntry = error => ({name: boundedText(error instanceof Error ? error.name : "Error"),
    message: boundedText(error instanceof Error ? error.message : error)});

const failureRecord = error => ({...failureEntry(error),
    aggregated: (error instanceof AggregateError && Array.isArray(error.errors) ? error.errors : [])
        .slice(0, MAX_AGGREGATED_FAILURES).map(failureEntry)});

const buildProgress = ({request, status, completedRows, failedRow, refusedScenarioIndex, failure,
    budget}) => Object.freeze({schemaVersion: SCHEMA_VERSION, kind: PROGRESS_KIND, status,
    qualifying: false, sourceSha: request.sourceSha, eventSha: request.eventSha, runId: request.runId,
    runAttempt: request.runAttempt, nonce: request.nonce, scenarioCount: SCENARIO_COUNT,
    completedRows: Object.freeze(completedRows.map(row => Object.freeze({...row}))),
    refusedScenarioIndex, failedScenarioIndex: failedRow?.scenarioIndex ?? null,
    failedScenarioId: failedRow?.scenarioId ?? null, failure, budget, releaseGatesCleared: Object.freeze([])});

const defaultMonotonicMilliseconds = () => Number(process.hrtime.bigint() / 1_000_000n);

export const runWindowsMsiLifecycleHost = async (input, operations, dependencies = {}) => {
    const request = validateWindowsMsiLifecycleHostRequest(input);
    assertOperations(operations);
    /*
     * The whole-job budget is charged against observed elapsed time, not against the per-row
     * deadline: a row is admitted only while the remainder still covers that row, its cleanup and
     * the final margin the run needs after the last row.
     */
    const budget = createWindowsMsiLifecycleBudget({limits: request.limits.budget,
        monotonicMilliseconds: dependencies.monotonicMilliseconds ?? defaultMonotonicMilliseconds});
    const completedRows = [];
    let currentRow = null;
    try {
        const baseBefore = assertBase(await operations.inspectBase({request, phase: "before"}), request);
        const guestRows = [];
        const hostRows = [];
        for (const row of request.rows) {
            currentRow = row;
            budget.admitRow(row.scenarioIndex);
            let launchAttempted = false;
            let groupZero = false;
            let guestResult = null;
            let overlay = null;
            let media = null;
            let launch = null;
            let primaryFailure = null;
            try {
                overlay = assertOverlay(await operations.createOverlay({request, row, base: baseBefore}),
                    row, request);
                media = assertMedia(await operations.prepareMedia({request, row, overlay}), row, request);
                launchAttempted = true;
                launch = assertLaunch(await operations.launchRow({request, row, overlay, media}),
                    request, row, overlay, media);
                groupZero = true;
                const retained = await operations.readGuestResult({request, row, media, launch});
                exactKeys(retained, ["bytes", "outputAfter"], "MSI lifecycle retained guest result");
                guestResult = retained.bytes;
                if (!Buffer.isBuffer(guestResult) || guestResult.length < 1
                    || guestResult.length > MAX_JSON_BYTES)
                    throw new Error("MSI lifecycle guest result differs");
                fileIdentity(retained.outputAfter, "MSI lifecycle output disk after QEMU");
                if (retained.outputAfter.path !== row.outputDiskPath
                    || retained.outputAfter.bytes !== String(request.limits.outputDiskBytes))
                    throw new Error("MSI lifecycle output disk binding differs");
                media = {...media, outputAfter: retained.outputAfter};
            } catch (error) { primaryFailure = error; }
            let cleanup = null;
            let cleanupFailure = null;
            /*
             * The cleanup contract is checked inside the same guarded region as the cleanup call so a
             * row that failed before launch reports the overlay or media error that stopped it. The
             * group-zero comparison proves a successful launch was torn down; it is never allowed to
             * stand in for the cause, and a genuine cleanup failure is aggregated rather than dropped.
             * Catching a row error grants cleanup no authority over an unproven QEMU process.
             */
            try {
                cleanup = await operations.cleanupRow({request, row, overlay, media, launch,
                    launchAttempted, groupZero});
                if (!isObject(cleanup) || cleanup.removed !== true
                    || cleanup.groupZeroBeforeRemoval !== groupZero)
                    throw new Error("MSI lifecycle row cleanup differs");
            } catch (error) { cleanupFailure = error; }
            if (cleanupFailure !== null) {
                if (primaryFailure !== null) throw new AggregateError([primaryFailure, cleanupFailure],
                    "MSI lifecycle row and cleanup failed");
                throw cleanupFailure;
            }
            if (primaryFailure !== null) throw primaryFailure;
            if (!groupZero) throw new Error("MSI lifecycle row did not prove QEMU group zero");
            const semanticRetained = {bytes: guestResult.length, sha256: sha256(guestResult),
                bytesBase64: guestResult.toString("base64")};
            guestRows.push({scenarioIndex: row.scenarioIndex, scenarioId: row.scenarioId,
                rowRequest: {bytes: row.rowRequest.bytes, sha256: row.rowRequest.sha256,
                    bytesBase64: row.rowRequest.bytesBase64},
                executionManifest: {bytes: row.executionManifest.bytes,
                    sha256: row.executionManifest.sha256,
                    bytesBase64: row.executionManifest.bytesBase64}, semanticResult: semanticRetained});
            hostRows.push({scenarioIndex: row.scenarioIndex, scenarioId: row.scenarioId,
                overlay, media, qemu: launch, guestSemanticSha256: semanticRetained.sha256,
                rowRequestSha256: row.rowRequest.sha256,
                executionManifestSha256: row.executionManifest.sha256,
                overlayReceiptSha256: overlay.receiptSha256, qemuLaunchSha256: launch.argvSha256,
                outputAfterSha256: media.outputAfter.sha256, overlayCleanup: cleanup});
            budget.completeRow(row.scenarioIndex);
            completedRows.push({scenarioIndex: row.scenarioIndex, scenarioId: row.scenarioId});
        }
        currentRow = null;
        const baseAfter = assertBase(await operations.inspectBase({request, phase: "after"}), request);
        if (JSON.stringify(baseAfter) !== JSON.stringify(baseBefore))
            throw new Error("MSI lifecycle base image changed");
        const guestEvidence = {schemaVersion: 1, kind: "myspeed-windows-msi-guest-lifecycle-evidence",
            status: "completed", qualifying: false, ...request.expected, rows: guestRows,
            releaseGatesCleared: []};
        const inspection = inspectCompletedWindowsMsiGuestMatrixEvidence(guestEvidence, request.expected);
        const result = {schemaVersion: 1, kind: RESULT_KIND, status: "completed", qualifying: false,
            sourceSha: request.sourceSha, eventSha: request.eventSha, runId: request.runId,
            runAttempt: request.runAttempt, nonce: request.nonce, toolchainSha256: request.toolchainSha256,
            candidateProvenance: structuredClone(request.candidateProvenance), baseBefore, baseAfter,
            hostRows, guestEvidence, guestInspection: inspection, budget: budget.seal(),
            releaseGatesCleared: []};
        return validateCompletedWindowsMsiLifecycleHostResult(result, request);
    } catch (error) {
        if (error instanceof WindowsMsiLifecycleRunError) throw error;
        const exhausted = error instanceof WindowsMsiLifecycleAdmissionError;
        throw new WindowsMsiLifecycleRunError(buildProgress({request,
            status: exhausted ? "budget-exhausted" : "failed", completedRows,
            failedRow: exhausted ? null : currentRow,
            refusedScenarioIndex: exhausted ? error.scenarioIndex : null,
            failure: exhausted ? null : failureRecord(error),
            budget: exhausted ? error.progress : budget.seal()}), error);
    }
};

/*
 * A completed result may only carry a budget observation that actually completed the matrix: every
 * row admitted, every row completed in order, nothing refused and no gate cleared. A partial run
 * reports its progress through WindowsMsiLifecycleRunError instead, so a truncated matrix can never
 * be mistaken for a finished one.
 */
const assertBudgetObservation = (value, request) => {
    exactKeys(value, ["schemaVersion", "kind", "qualifying", "status", "refusedScenarioIndex",
        "scenarioCount", "rowsAdmitted", "rowsCompleted", "rowsOverranAllowance", "rows", "limits",
        "elapsedMilliseconds", "remainingMilliseconds", "requiredMilliseconds", "exhausted",
        "allowanceEnforced", "enforcedRowDeadlineMilliseconds", "releaseGatesCleared"],
    "MSI lifecycle budget observation");
    if (value.kind !== BUDGET_OBSERVATION_KIND || value.status !== "completed"
        || bool(value.qualifying, "MSI lifecycle budget qualifying")
        || value.refusedScenarioIndex !== null || value.exhausted !== false)
        throw new Error("MSI lifecycle budget observation differs");
    integer(value.schemaVersion, "MSI lifecycle budget schema", SCHEMA_VERSION, SCHEMA_VERSION);
    integer(value.scenarioCount, "MSI lifecycle budget scenario count", SCENARIO_COUNT, SCENARIO_COUNT);
    integer(value.rowsAdmitted, "MSI lifecycle budget admitted rows", SCENARIO_COUNT, SCENARIO_COUNT);
    integer(value.rowsCompleted, "MSI lifecycle budget completed rows", SCENARIO_COUNT, SCENARIO_COUNT);
    if (!Array.isArray(value.rows) || value.rows.length !== SCENARIO_COUNT)
        throw new Error("MSI lifecycle budget rows differ");
    value.rows.forEach((row, index) => {
        exactKeys(row, ["scenarioIndex", "observedMilliseconds", "overranAllowance"],
            "MSI lifecycle budget row");
        if (row.scenarioIndex !== index) throw new Error("MSI lifecycle budget row order differs");
        integer(row.observedMilliseconds, "MSI lifecycle budget row duration", 0, Number.MAX_SAFE_INTEGER);
        if (typeof row.overranAllowance !== "boolean"
            || row.overranAllowance !== row.observedMilliseconds > request.limits.budget.rowAllowanceMilliseconds)
            throw new Error("MSI lifecycle budget row overrun differs");
    });
    /*
     * The allowance is a planning figure the launcher does not enforce, and a completed result has to
     * keep saying so rather than let a reader treat the cleanup margin as a reserve that was held.
     */
    if (value.allowanceEnforced !== false
        || value.enforcedRowDeadlineMilliseconds !== WINDOWS_MSI_LIFECYCLE_BUDGET.rowDeadlineMilliseconds)
        throw new Error("MSI lifecycle budget allowance enforcement differs");
    integer(value.rowsOverranAllowance, "MSI lifecycle budget overran rows", 0, SCENARIO_COUNT);
    if (value.rowsOverranAllowance !== value.rows.filter(row => row.overranAllowance).length)
        throw new Error("MSI lifecycle budget overran rows differ");
    if (JSON.stringify(value.limits) !== JSON.stringify(request.limits.budget))
        throw new Error("MSI lifecycle budget limits differ");
    for (const name of ["elapsedMilliseconds", "remainingMilliseconds", "requiredMilliseconds"])
        integer(value[name], `MSI lifecycle budget ${name}`, 0, Number.MAX_SAFE_INTEGER);
    if (!Array.isArray(value.releaseGatesCleared) || value.releaseGatesCleared.length !== 0)
        throw new Error("MSI lifecycle budget cleared gates differ");
    return value;
};

export const WINDOWS_MSI_LIFECYCLE_OUTPUT_DISK_BYTES = OUTPUT_DISK_BYTES;

export const validateCompletedWindowsMsiLifecycleHostResult = (value, input) => {
    const request = validateWindowsMsiLifecycleHostRequest(input);
    exactKeys(value, ["schemaVersion", "kind", "status", "qualifying", "sourceSha", "eventSha", "runId",
        "runAttempt", "nonce", "toolchainSha256", "candidateProvenance", "baseBefore", "baseAfter", "hostRows", "guestEvidence",
        "guestInspection", "budget", "releaseGatesCleared"], "MSI lifecycle host result");
    assertBudgetObservation(value.budget, request);
    integer(value.schemaVersion, "MSI lifecycle host result schema", SCHEMA_VERSION, SCHEMA_VERSION);
    if (value.kind !== RESULT_KIND || value.status !== "completed" || value.qualifying !== false)
        throw new Error("MSI lifecycle host result did not complete");
    for (const name of ["sourceSha", "eventSha", "runId", "runAttempt", "nonce", "toolchainSha256"])
        if (value[name] !== request[name]) throw new Error(`MSI lifecycle host result binding differs: ${name}`);
    if (JSON.stringify(value.candidateProvenance) !== JSON.stringify(request.candidateProvenance))
        throw new Error("MSI lifecycle result candidate provenance differs");
    const baseBefore = assertBase(value.baseBefore, request);
    const baseAfter = assertBase(value.baseAfter, request);
    if (JSON.stringify(baseBefore) !== JSON.stringify(baseAfter))
        throw new Error("MSI lifecycle host base image changed");
    if (!Array.isArray(value.hostRows) || value.hostRows.length !== SCENARIO_COUNT)
        throw new Error("MSI lifecycle host proof row count differs");
    if (!Array.isArray(value.releaseGatesCleared) || value.releaseGatesCleared.length !== 0)
        throw new Error("MSI lifecycle host result cleared a gate");
    const guestInspection = inspectCompletedWindowsMsiGuestMatrixEvidence(value.guestEvidence, request.expected);
    if (JSON.stringify(value.guestInspection) !== JSON.stringify(guestInspection))
        throw new Error("MSI lifecycle guest inspection differs");
    const launches = new Set();
    value.hostRows.forEach((rowProof, scenarioIndex) => {
        exactKeys(rowProof, ["scenarioIndex", "scenarioId", "overlay", "media", "qemu",
            "rowRequestSha256", "executionManifestSha256", "overlayReceiptSha256", "qemuLaunchSha256",
            "guestSemanticSha256", "outputAfterSha256", "overlayCleanup"], "MSI lifecycle host row proof");
        const row = request.rows[scenarioIndex];
        integer(rowProof.scenarioIndex, "MSI lifecycle host proof index", scenarioIndex, scenarioIndex);
        if (rowProof.scenarioId !== row.scenarioId) throw new Error("MSI lifecycle host proof scenario differs");
        assertOverlay(rowProof.overlay, row, request);
        assertMedia(rowProof.media, row, request, true);
        exactKeys(rowProof.media.outputAfter, ["path", "bytes", "sha256"],
            "MSI lifecycle output disk after QEMU");
        fileIdentity(rowProof.media.outputAfter, "MSI lifecycle output disk after QEMU");
        if (rowProof.media.outputAfter.path !== row.outputDiskPath
            || rowProof.media.outputAfter.bytes !== String(request.limits.outputDiskBytes)
            || rowProof.outputAfterSha256 !== rowProof.media.outputAfter.sha256)
            throw new Error("MSI lifecycle output disk proof differs");
        assertLaunch(rowProof.qemu, request, row, rowProof.overlay, rowProof.media);
        const launchIdentity = `${rowProof.qemu.pid}:${rowProof.qemu.startTicks}:${rowProof.qemu.processGroupId}`;
        if (launches.has(launchIdentity)) throw new Error("MSI lifecycle QEMU identity is reused");
        launches.add(launchIdentity);
        exactString(rowProof.guestSemanticSha256, "MSI lifecycle guest semantic SHA-256", SHA256);
        if (rowProof.guestSemanticSha256 !== value.guestEvidence.rows[scenarioIndex].semanticResult.sha256)
            throw new Error("MSI lifecycle guest semantic binding differs");
        const guestRow = value.guestEvidence.rows[scenarioIndex];
        const requestRaw = {bytes: row.rowRequest.bytes, sha256: row.rowRequest.sha256,
            bytesBase64: row.rowRequest.bytesBase64};
        const executionRaw = {bytes: row.executionManifest.bytes, sha256: row.executionManifest.sha256,
            bytesBase64: row.executionManifest.bytesBase64};
        if (JSON.stringify(guestRow.rowRequest) !== JSON.stringify(requestRaw)
            || JSON.stringify(guestRow.executionManifest) !== JSON.stringify(executionRaw)
            || rowProof.rowRequestSha256 !== row.rowRequest.sha256
            || rowProof.executionManifestSha256 !== row.executionManifest.sha256)
            throw new Error("MSI lifecycle host and guest retained inputs differ");
        const guestRequest = JSON.parse(Buffer.from(guestRow.rowRequest.bytesBase64, "base64").toString("utf8"));
        if (rowProof.overlayReceiptSha256 !== rowProof.overlay.receiptSha256
            || guestRequest.guest.overlayReceiptSha256 !== rowProof.overlayReceiptSha256
            || rowProof.qemuLaunchSha256 !== rowProof.qemu.argvSha256
            || guestRequest.guest.qemuLaunchSha256 !== rowProof.qemuLaunchSha256)
            throw new Error("MSI lifecycle host and guest launch binding differs");
        exactKeys(rowProof.overlayCleanup, ["groupZeroBeforeRemoval", "removed"],
            "MSI lifecycle overlay cleanup");
        if (rowProof.overlayCleanup.groupZeroBeforeRemoval !== true || rowProof.overlayCleanup.removed !== true)
            throw new Error("MSI lifecycle overlay cleanup differs");
    });
    return value;
};

const successful = (value, label) => {
    if (!isObject(value) || !isObject(value.process) || value.process.exitCode !== 0
        || value.process.signal !== null || value.process.timedOut !== false
        || value.process.cleanupProven !== true || value.process.errorObserved !== false
        || value.process.stdoutOverflow !== false || value.process.stderrOverflow !== false)
        throw new Error(`${label} failed`);
    return value;
};

const parseJson = (bytes, label) => {
    let parsed;
    try { parsed = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)); }
    catch { throw new Error(`${label} differs`); }
    return parsed;
};

export const createWindowsMsiHostFileInspector = filesystem => createFileInspector(filesystem);

export const assertSuccessfulWindowsMsiHostProcess = (value, label) => successful(value, label);

export const parseWindowsMsiHostJson = (bytes, label) => parseJson(bytes, label);

const createFileInspector = filesystem => async (target, maximumBytes = Number.MAX_SAFE_INTEGER,
    minimumBytes = 1) => {
    const item = posixPath(target, "MSI lifecycle inspected path");
    const descriptor = filesystem.openSync(item, filesystem.constants.O_RDONLY | filesystem.constants.O_NOFOLLOW);
    let primaryFailure = null;
    try {
        const before = filesystem.fstatSync(descriptor, {bigint: true});
        if (!before.isFile() || before.nlink !== 1n || before.size < BigInt(minimumBytes)
            || before.size > BigInt(maximumBytes))
            throw new Error("MSI lifecycle file identity differs");
        const digest = createHash("sha256");
        const chunk = Buffer.alloc(IO_CHUNK_BYTES);
        let total = 0n;
        for (;;) {
            const count = filesystem.readSync(descriptor, chunk, 0, chunk.length, null);
            if (count === 0) break;
            total += BigInt(count);
            if (total > BigInt(maximumBytes)) throw new Error("MSI lifecycle file exceeded its bound");
            digest.update(chunk.subarray(0, count));
        }
        const after = filesystem.fstatSync(descriptor, {bigint: true});
        const canonical = filesystem.realpathSync(`/proc/self/fd/${descriptor}`);
        if (canonical !== item || before.dev !== after.dev || before.ino !== after.ino
            || before.size !== after.size || before.nlink !== after.nlink || before.mtimeNs !== after.mtimeNs
            || before.ctimeNs !== after.ctimeNs || total !== after.size)
            throw new Error("MSI lifecycle file identity changed while hashing");
        const mode = Number(before.mode & 0o777n).toString(8).padStart(3, "0");
        return {path: canonical, bytes: total.toString(), sha256: digest.digest("hex"), mode: Number(before.mode),
            ownership: {uid: String(before.uid), gid: String(before.gid), mode,
                ordinaryUserWritable: (before.mode & 0o022n) !== 0n}};
    } catch (error) { primaryFailure = error; throw error; }
    finally {
        try { filesystem.closeSync(descriptor); }
        catch (error) { if (primaryFailure === null) throw error; }
    }
};

export const createWindowsMsiLifecycleHostOperations = ({request: input, dependencies = {}}) => {
    const request = validateWindowsMsiLifecycleHostRequest(input);
    const actualContext = (dependencies.deriveActualContext ?? deriveActualHostedContext)(request.nonce);
    if (JSON.stringify(actualContext) !== JSON.stringify(request.context))
        throw new Error("MSI lifecycle actual hosted context differs");
    const filesystem = dependencies.filesystem ?? fs;
    const runOwned = dependencies.runOwned ?? runHostedOwnedProcess;
    /*
     * A hosted QEMU launcher stamps its execution budget when it is constructed, so one launcher
     * shared by every row would hand row two onwards whatever remained of a single row budget.
     * Each row is its own QEMU stage: build a fresh default launcher per launch, and keep an
     * injected launcher exactly as supplied. The whole-job bound is a separate admission duty.
     */
    const createRowQemuLauncher = () => dependencies.runQemu
        ?? createHostedQemuProcessLauncher({context: request.context,
            dependencies: dependencies.qemuDependencies});
    const inspectFile = dependencies.inspectFile ?? createFileInspector(filesystem);
    const ownedRows = new Set();
    const qemuResults = new Map();
    const qemuAttempts = new Set();
    const invoke = (tool, argv, timeoutMs = COMMAND_MILLISECONDS) => runOwned(request.toolchain.runtimeLoader.path,
        ["--library-path", request.toolchain.libraryPath.join(":"), tool.path, ...argv],
        {timeoutMs, maxStreamBytes: MAX_COMMAND_STREAM_BYTES});
    const checkTool = async (tool, label) => {
        const observed = await inspectFile(tool.path);
        if (observed.bytes !== tool.bytes || observed.sha256 !== tool.sha256
            || JSON.stringify(observed.ownership) !== JSON.stringify(tool.ownership))
            throw new Error(`MSI lifecycle ${label} identity changed`);
    };
    const writeExclusive = (target, bytes) => {
        const handle = filesystem.openSync(target, "wx", 0o600);
        try { filesystem.writeFileSync(handle, bytes); filesystem.fsyncSync(handle); }
        finally { filesystem.closeSync(handle); }
    };
    const inspectExact = async (expected, allowEmpty = false) => {
        const observed = await inspectFile(expected.path, Number.MAX_SAFE_INTEGER, allowEmpty ? 0 : 1);
        if (observed.bytes !== String(expected.bytes) || observed.sha256 !== expected.sha256
            || (expected.ownership && JSON.stringify(observed.ownership) !== JSON.stringify(expected.ownership)))
            throw new Error("MSI lifecycle copied file identity differs");
        return observed;
    };
    return {
        async inspectBase() {
            const observed = await inspectExact(request.baseImage);
            if ((observed.mode & FILE_WRITE_BITS) !== 0) throw new Error("MSI lifecycle base image is writable");
            await checkTool(request.toolchain.qemuImg, "qemu-img");
            const infoResult = successful(await invoke(request.toolchain.qemuImg,
                ["info", "--output=json", request.baseImage.path]), "MSI lifecycle base inspection");
            const info = parseJson(infoResult.stdout, "MSI lifecycle base metadata");
            if (info.format !== "qcow2" || !Number.isSafeInteger(info["virtual-size"]) || info["virtual-size"] < 1)
                throw new Error("MSI lifecycle base metadata differs");
            return {path: observed.path, bytes: observed.bytes, sha256: observed.sha256, format: "qcow2",
                ownership: observed.ownership, virtualBytes: String(info["virtual-size"]), sealedReadOnly: true};
        },
        async createOverlay({row}) {
            if (filesystem.existsSync(row.rowRoot)) throw new Error("MSI lifecycle row root already exists");
            filesystem.mkdirSync(row.rowRoot, {recursive: false, mode: 0o700});
            ownedRows.add(row.rowRoot);
            await checkTool(request.toolchain.qemuImg, "qemu-img");
            successful(await invoke(request.toolchain.qemuImg, ["create", "-f", "qcow2", "-F", "qcow2", "-b",
                request.baseImage.path, row.overlayPath]), "MSI lifecycle overlay creation");
            const infoResult = successful(await invoke(request.toolchain.qemuImg,
                ["info", "--output=json", row.overlayPath]), "MSI lifecycle overlay inspection");
            const info = parseJson(infoResult.stdout, "MSI lifecycle overlay metadata");
            if (info.format !== "qcow2" || info["backing-filename"] !== request.baseImage.path)
                throw new Error("MSI lifecycle overlay metadata differs");
            const receipt = Buffer.from(JSON.stringify({path: row.overlayPath, format: info.format,
                backingFilename: info["backing-filename"], backingBaseSha256: request.baseImage.sha256}), "utf8");
            return {path: row.overlayPath, format: "qcow2", backingBaseSha256: request.baseImage.sha256,
                createNew: true, receiptSha256: sha256(receipt)};
        },
        async prepareMedia({row}) {
            if (!ownedRows.has(row.rowRoot) || filesystem.existsSync(row.seedRoot))
                throw new Error("MSI lifecycle seed root ownership differs");
            filesystem.mkdirSync(row.seedRoot, {recursive: false, mode: 0o700});
            const copied = [];
            for (const document of [row.rowRequest, row.executionManifest, row.guestEnvelope,
                row.launcherRequest]) {
                writeExclusive(document.path, Buffer.from(document.bytesBase64, "base64"));
                const observed = await inspectExact(document);
                copied.push({name: path.posix.basename(document.path), bytes: Number(observed.bytes),
                    sha256: observed.sha256});
            }
            for (const source of row.seedFiles) {
                const allowEmpty = source.name === OPTIONAL_EMPTY_WAL_NAME && source.bytes === "0"
                    && source.sha256 === EMPTY_SHA256;
                await inspectExact({path: source.sourcePath, bytes: source.bytes, sha256: source.sha256}, allowEmpty);
                const target = `${row.seedRoot}/${source.name}`;
                const parent = path.posix.dirname(target);
                if (parent !== row.seedRoot) filesystem.mkdirSync(parent, {recursive: true, mode: 0o700});
                filesystem.copyFileSync(source.sourcePath, target, filesystem.constants.COPYFILE_EXCL);
                const observed = await inspectExact({path: target, bytes: source.bytes, sha256: source.sha256},
                    allowEmpty);
                copied.push({name: source.name, bytes: Number(observed.bytes), sha256: observed.sha256});
            }
            const seedManifestBytes = Buffer.from(JSON.stringify({schemaVersion: SCHEMA_VERSION,
                kind: "myspeed-windows-msi-lifecycle-row-seed", sourceSha: request.sourceSha,
                eventSha: request.eventSha, runId: request.runId, runAttempt: request.runAttempt,
                hostNonce: request.nonce, rowNonce: row.nonce, scenarioIndex: row.scenarioIndex,
                scenarioId: row.scenarioId, rowRequestSha256: row.rowRequest.sha256,
                executionManifestSha256: row.executionManifest.sha256, files: copied}), "utf8");
            writeExclusive(`${row.seedRoot}/${SEED_MANIFEST_NAME}`, seedManifestBytes);
            const bootstrapBytes = renderWindowsMsiGuestBootstrap({nonce: row.nonce,
                hostNonce: request.nonce, sourceSha: request.sourceSha, eventSha: request.eventSha,
                runId: request.runId, runAttempt: request.runAttempt, scenarioIndex: row.scenarioIndex,
                scenarioId: row.scenarioId, seedManifestSha256: sha256(seedManifestBytes),
                launcherRequestSha256: row.launcherRequest.sha256,
                rowRequestSha256: row.rowRequest.sha256,
                executionManifestSha256: row.executionManifest.sha256});
            writeExclusive(`${row.seedRoot}/bootstrap.ps1`, bootstrapBytes);
            let activationHandoffSha256;
            if (request.candidateProvenance?.kind === "myspeed-v1.6.1-published-msi-host-provenance") {
                const handoff = buildWindowsMsiLifecycleRowActivationHandoff({request, row, bootstrapBytes});
                const handoffBytes = Buffer.from(handoff.bytesBase64, "base64");
                const handoffPath = `${row.seedRoot}/${MSI_HANDOFF_NAME}`;
                writeExclusive(handoffPath, handoffBytes);
                await inspectExact({path: handoffPath, bytes: String(handoff.bytes), sha256: handoff.sha256});
                activationHandoffSha256 = handoff.sha256;
            }
            for (const tool of [request.toolchain.genisoimage, request.toolchain.mformat])
                await checkTool(tool, path.posix.basename(tool.path));
            successful(await invoke(request.toolchain.genisoimage,
                ["-quiet", "-J", "-r", "-V", "MYSPEEDSEED", "-o", row.seedIsoPath, row.seedRoot]),
            "MSI lifecycle seed ISO creation");
            const outputHandle = filesystem.openSync(row.outputDiskPath, "wx", 0o600);
            try { filesystem.ftruncateSync(outputHandle, request.limits.outputDiskBytes);
                filesystem.fsyncSync(outputHandle); } finally { filesystem.closeSync(outputHandle); }
            successful(await invoke(request.toolchain.mformat,
                ["-i", row.outputDiskPath, "-v", "MYSPEEDOUT", "::"]), "MSI lifecycle output disk creation");
            filesystem.copyFileSync(request.toolchain.ovmfVarsTemplate.path, row.ovmfVarsPath,
                filesystem.constants.COPYFILE_EXCL);
            const seed = await inspectFile(row.seedIsoPath);
            const output = await inspectFile(row.outputDiskPath);
            const variables = await inspectExact({path: row.ovmfVarsPath,
                bytes: request.toolchain.ovmfVarsTemplate.bytes, sha256: request.toolchain.ovmfVarsTemplate.sha256});
            return {seed: {path: seed.path, bytes: seed.bytes, sha256: seed.sha256,
                manifestSha256: sha256(seedManifestBytes), readOnly: true, volumeLabel: "MYSPEEDSEED",
                ...(activationHandoffSha256 ? {activationHandoffSha256} : {})},
            outputBefore: {path: output.path, bytes: output.bytes, sha256: output.sha256,
                createNew: true, volumeLabel: "MYSPEEDOUT"}, ovmfVarsSha256: variables.sha256};
        },
        async launchRow({row, overlay, media}) {
            for (const tool of [request.toolchain.runtimeLoader, request.toolchain.qemu])
                await checkTool(tool, path.posix.basename(tool.path));
            const argv = buildWindowsMsiLifecycleQemuArguments({request, row, overlay, media});
            const runQemu = createRowQemuLauncher();
            qemuAttempts.add(row.rowRoot);
            const monitored = await runQemu({paths: {root: row.rowRoot,
                portableRoot: request.toolchain.portableRoot, qemuPid: row.pidPath,
                outputDisk: row.outputDiskPath},
            toolchain: {runtime: {loader: request.toolchain.runtimeLoader,
                libraryPath: request.toolchain.libraryPath},
            qemu: {...request.toolchain.qemu, invocationPath: request.toolchain.qemu.path},
            firmware: request.toolchain.firmware},
            privilegeMode: request.privilegeMode, argv});
            qemuResults.set(row.rowRoot, monitored);
            const processResult = monitored.process ?? {};
            return {argv, argvSha256: sha256(Buffer.from(JSON.stringify(argv), "utf8")),
                loaderPath: request.toolchain.runtimeLoader.path,
                loaderSha256: request.toolchain.runtimeLoader.sha256,
                qemuPath: request.toolchain.qemu.path, qemuSha256: request.toolchain.qemu.sha256,
                pid: processResult.qemuPid ?? 0, startTicks: processResult.qemuStartTicks ?? "0",
                processGroupId: processResult.processGroupId ?? 0,
                exitCode: processResult.exitCode, signal: processResult.signal,
                timedOut: processResult.timedOut, terminationReason: processResult.terminationReason ?? null,
                cleanupProven: monitored.executionSucceeded === true && processResult.cleanupProven === true,
                earlyBoot: monitored.earlyBoot ?? null,
                treeGone: monitored.executionSucceeded === true && processResult.treeGone === true
                    && processResult.qemuPidAbsentAfter === true};
        },
        async readGuestResult({row}) {
            const monitored = qemuResults.get(row.rowRoot);
            if (!monitored || monitored.executionSucceeded !== true || monitored.process?.treeGone !== true
                || monitored.process.qemuPidAbsentAfter !== true)
                throw new Error("MSI lifecycle output read preceded QEMU group zero");
            await checkTool(request.toolchain.mcopy, "mcopy");
            successful(await invoke(request.toolchain.mcopy,
                ["-i", row.outputDiskPath, "::result.json", row.guestResultPath]),
            "MSI lifecycle guest result extraction");
            const result = await inspectFile(row.guestResultPath, MAX_JSON_BYTES);
            const bytes = filesystem.readFileSync(result.path);
            if (bytes.length !== Number(result.bytes) || sha256(bytes) !== result.sha256)
                throw new Error("MSI lifecycle guest result read differs");
            const outputAfter = await inspectFile(row.outputDiskPath);
            return {bytes, outputAfter: {path: outputAfter.path, bytes: outputAfter.bytes,
                sha256: outputAfter.sha256}};
        },
        async cleanupRow({row, groupZero}) {
            if (!ownedRows.has(row.rowRoot)) return {groupZeroBeforeRemoval: false, removed: false};
            const monitored = qemuResults.get(row.rowRoot);
            const observedGroupZero = groupZero === true || (monitored?.executionSucceeded === true
                && monitored.process?.treeGone === true && monitored.process.qemuPidAbsentAfter === true)
                || !qemuAttempts.has(row.rowRoot);
            if (!observedGroupZero) return {groupZeroBeforeRemoval: false, removed: false};
            filesystem.rmSync(row.rowRoot, {recursive: true, force: false});
            if (filesystem.existsSync(row.rowRoot)) throw new Error("MSI lifecycle row cleanup failed");
            ownedRows.delete(row.rowRoot);
            return {groupZeroBeforeRemoval: true, removed: true};
        }
    };
};
