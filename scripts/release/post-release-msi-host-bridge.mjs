import {createHash} from "node:crypto";
import path from "node:path";
import {isDeepStrictEqual} from "node:util";

import {validateHostedContext} from "../qualification/linux-kvm-capability.mjs";
import {validateSameJobInstalledBaseSeal} from
    "../qualification/windows-msi-installed-base.mjs";
import {buildV161PostReleaseMsiAcquisitionPlan, validateV161PostReleaseMsiAcquisitionRecord} from
    "./post-release-msi-acquisition.mjs";
import {validateV161PostReleaseMsiEnvelope} from
    "./post-release-msi-envelope.mjs";
import {validateV161PostReleaseMsiWindowsPreparation} from
    "./post-release-msi-hosted-prepare.mjs";
import {buildV161PostReleaseMsiFixturePlan, validateV161PostReleaseMsiFixturePreparation} from
    "./post-release-msi-fixture-preparation.mjs";
import {validateV161PostReleaseBaselineInputPreparation} from
    "./post-release-msi-baseline-input-preparation.mjs";
import {bindV161PostReleaseTarget} from "./post-release-target.mjs";

const SCHEMA_VERSION = 2;
const KIND = "myspeed-v1.6.1-published-msi-host-provenance";
const TRANSPORT_KIND = "myspeed-v1.6.1-post-release-msi-preparation-transport";
const TRANSPORT_ARTIFACT_NAME = "post-release-v1.6.1-msi-appassets";
const AUTHORITY = "same-run-preparation-and-pre-execution-byte-binding-only";
const REPOSITORY = "i7Gamer/MySpeed";
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,19}$/u;
const MAX_PATH_CHARACTERS = 1024;
const MAX_FILE_BYTES = 1_073_741_824;
const MAX_DOCUMENT_BYTES = 1_048_576;
const CURRENT_BINDINGS = Object.freeze(["candidate-default", "candidate-baseline"]);
const ROOT_KEYS = ["schemaVersion", "kind", "authority", "qualifying", "targetSha256", "harness",
    "candidate", "envelope", "acquisition", "preparation", "fixturePreparation", "baselinePreparation",
    "transport", "execution", "installedBase", "releaseGatesCleared"];

const fail = message => { throw new Error(`Invalid v1.6.1 post-release MSI host provenance: ${message}`); };
const object = (value, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
};
const exactKeys = (value, keys, label) => {
    object(value, label);
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
const positiveInteger = (value, label) => {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_FILE_BYTES) fail(`${label} differs`);
    return value;
};
const deepFreeze = value => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
};
const hashJson = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (actual, expected, label) => {
    if (!isDeepStrictEqual(actual, expected)) fail(`${label} differs`);
};

const harnessFromHostedContext = context => ({repository: context.repository, sourceSha: context.sourceSha,
    eventSha: context.eventSha, runId: context.runId, runAttempt: context.runAttempt,
    imageVersion: context.environment.ImageVersion, nonce: context.nonce});

const validateCrossJobContext = (preparation, execution) => {
    exactKeys(preparation, ["repository", "sourceSha", "eventSha", "runId", "runAttempt", "imageVersion",
        "nonce"], "preparation harness");
    for (const name of ["repository", "sourceSha", "eventSha", "runId", "runAttempt"])
        if (preparation[name] !== execution[name]) fail(`cross-job ${name} differs`);
    if (preparation.repository !== REPOSITORY || preparation.sourceSha !== preparation.eventSha)
        fail("preparation harness identity differs");
    exactString(preparation.sourceSha, COMMIT_SHA, "preparation source SHA");
    if (preparation.nonce === execution.nonce) fail("preparation and execution nonces must be distinct");
};

const acquisitionRoot = plan => {
    if (!Array.isArray(plan?.files) || plan.files.length === 0) fail("acquisition plan differs");
    const first = plan.files[0]?.destinationPath;
    if (typeof first !== "string") fail("acquisition plan root differs");
    return path.win32.dirname(first);
};

const transportDocument = (value, expectedName, root, label) => {
    exactKeys(value, ["path", "bytes", "sha256", "bytesBase64"], label);
    if (typeof value.path !== "string" || path.posix.dirname(value.path) !== root
        || path.posix.basename(value.path) !== expectedName) fail(`${label} path differs`);
    positiveInteger(value.bytes, `${label} bytes`); exactString(value.sha256, SHA256, `${label} SHA-256`);
    const bytes = Buffer.from(value.bytesBase64, "base64");
    if (bytes.toString("base64") !== value.bytesBase64 || bytes.length !== value.bytes
        || createHash("sha256").update(bytes).digest("hex") !== value.sha256) fail(`${label} identity differs`);
    const parsed = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
    if (!bytes.equals(Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8"))) fail(`${label} JSON differs`);
    return parsed;
};

const validateTransport = (value, preparationHarness, executionRoot) => {
    exactKeys(value, ["schemaVersion", "kind", "artifact", "result", "fixtureProof", "baselineProof"],
        "preparation transport");
    if (value.schemaVersion !== 1 || value.kind !== TRANSPORT_KIND)
        fail("preparation transport header differs");
    exactKeys(value.artifact, ["repository", "id", "name", "bytes", "digest", "runId", "runAttempt",
        "headSha"], "preparation transport artifact");
    const artifact = value.artifact;
    if (artifact.repository !== REPOSITORY || artifact.name !== TRANSPORT_ARTIFACT_NAME
        || artifact.runId !== preparationHarness.runId || artifact.runAttempt !== preparationHarness.runAttempt
        || artifact.headSha !== preparationHarness.sourceSha) fail("preparation transport identity differs");
    exactString(artifact.id, POSITIVE_DECIMAL, "preparation transport artifact ID");
    exactString(artifact.bytes, POSITIVE_DECIMAL, "preparation transport artifact bytes");
    if (BigInt(artifact.bytes) > BigInt(MAX_FILE_BYTES)) fail("preparation transport artifact bytes differ");
    exactString(artifact.digest, /^sha256:[0-9a-f]{64}$/u, "preparation transport artifact digest");
    return {result: transportDocument(value.result, "result.json", executionRoot, "preparation result"),
        fixtureProof: transportDocument(value.fixtureProof, "fixture-proof.json", executionRoot,
            "fixture preparation proof"),
        baselineProof: transportDocument(value.baselineProof, "baseline-proof.json", executionRoot,
            "baseline input preparation proof")};
};

const bindRetainedTarget = value => {
    exactKeys(value, ["harnessSourceSha", "manifestBytesBase64", "observedAt", "qualificationArchive",
        "qualificationRun", "release", "tag"], "retained target input");
    if (typeof value.manifestBytesBase64 !== "string") fail("retained target manifest differs");
    const manifestBytes = Buffer.from(value.manifestBytesBase64, "base64");
    if (manifestBytes.toString("base64") !== value.manifestBytesBase64)
        fail("retained target manifest differs");
    const input = structuredClone(value);
    delete input.manifestBytesBase64;
    return bindV161PostReleaseTarget({...input, manifestBytes});
};

const posixFile = (value, expected, expectedPath, root, label) => {
    exactKeys(value, ["bindingId", "role", "path", "bytes", "sha256"], label);
    if (value.bindingId !== expected.bindingId || value.role !== expected.role
        || value.bytes !== expected.source.bytes || value.sha256 !== expected.source.sha256)
        fail(`${label} identity differs`);
    positiveInteger(value.bytes, `${label} bytes`);
    exactString(value.sha256, SHA256, `${label} SHA-256`);
    if (value.path !== expectedPath || value.path.length > MAX_PATH_CHARACTERS
        || path.posix.normalize(value.path) !== value.path) fail(`${label} path differs`);
    const relative = path.posix.relative(root, value.path);
    if (!relative || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative))
        fail(`${label} escapes its execution root`);
};

const validateExecution = (value, plan, fixturePreparation, artifactDigest, taskRoot) => {
    exactKeys(value, ["root", "transportArchiveSha256", "files", "fixtures", "runtime"],
        "execution observation");
    if (typeof value.root !== "string" || !path.posix.isAbsolute(value.root)
        || path.posix.normalize(value.root) !== value.root || value.root.length > MAX_PATH_CHARACTERS)
        fail("execution observation root differs");
    const executionRelative = path.posix.relative(taskRoot, value.root);
    if (!executionRelative || executionRelative === ".." || executionRelative.startsWith("../")
        || path.posix.isAbsolute(executionRelative)) fail("execution observation escapes the task root");
    if (value.transportArchiveSha256 !== artifactDigest.slice("sha256:".length))
        fail("execution transport digest differs");
    if (!Array.isArray(value.files) || value.files.length !== plan.files.length)
        fail("execution file inventory differs");
    value.files.forEach((file, index) => posixFile(file, plan.files[index],
        `${value.root}/files/${path.win32.basename(plan.files[index].destinationPath)}`,
        value.root, "execution file"));
    if (!Array.isArray(value.fixtures) || value.fixtures.length !== fixturePreparation.fixtures.length)
        fail("execution fixture inventory differs");
    value.fixtures.forEach((file, index) => {
        const expected = fixturePreparation.fixtures[index];
        exactKeys(file, ["bindingId", "role", "path", "bytes", "sha256"], "execution fixture");
        const expectedName = expected.bindingId === "lower-stamp-fixture" ? "lower-stamp.msi"
            : "safe-rollback-predecessor.msi";
        if (file.bindingId !== expected.bindingId || file.role !== "msi"
            || file.path !== `${value.root}/files/fixtures/${expectedName}` || file.bytes !== expected.bytes
            || file.sha256 !== expected.sha256) fail("execution fixture identity differs");
        positiveInteger(file.bytes, "execution fixture bytes");
        exactString(file.sha256, SHA256, "execution fixture SHA-256");
        const relative = path.posix.relative(value.root, file.path);
        if (!relative || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)
            || path.posix.normalize(file.path) !== file.path) fail("execution fixture path differs");
    });
    exactKeys(value.runtime, ["path", "bytes", "sha256"], "execution runtime");
    positiveInteger(value.runtime.bytes, "execution runtime bytes");
    exactString(value.runtime.sha256, SHA256, "execution runtime SHA-256");
    if (value.runtime.sha256 !== plan.runtime.sha256
        || value.runtime.path !== `${value.root}/files/node-v22.19.0-win-x64/node.exe`
        || path.posix.normalize(value.runtime.path) !== value.runtime.path)
        fail("execution runtime SHA-256 differs");
    const relative = path.posix.relative(value.root, value.runtime.path);
    if (!relative || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative))
        fail("execution runtime path differs");
};

const decodeDocument = (value, label) => {
    object(value, label);
    if (typeof value.bytesBase64 !== "string" || !Number.isSafeInteger(value.bytes) || value.bytes < 1
        || value.bytes > MAX_DOCUMENT_BYTES)
        fail(`${label} differs`);
    const bytes = Buffer.from(value.bytesBase64, "base64");
    if (bytes.toString("base64") !== value.bytesBase64 || bytes.length !== value.bytes
        || hashJson(JSON.parse(bytes.toString("utf8"))) !== value.sha256)
        fail(`${label} identity differs`);
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!bytes.equals(Buffer.from(JSON.stringify(parsed), "utf8"))) fail(`${label} JSON differs`);
    return parsed;
};

const validateRows = (rows, acquisition, preparation, fixturePreparation, execution, candidateSourceSha,
    systemTools) => {
    if (!Array.isArray(rows) || rows.length === 0) fail("host rows differ");
    const acquiredByBindingRole = new Map(execution.files.map(file => [`${file.bindingId}\0${file.role}`, file]));
    const sourceByBindingRole = new Map(acquisition.plan.files.map(file =>
        [`${file.bindingId}\0${file.role}`, file.source]));
    const properties = new Map(preparation.inspections.map(item => [item.bindingId, item.properties]));
    const preparedFixtures = new Map(fixturePreparation.fixtures.map(item => [item.bindingId, item]));
    const authenticPayloads = new Map(fixturePreparation.authenticPayloads.map(item =>
        [item.bindingId, item.payload]));
    const allMsi = [...execution.files.filter(item => item.role === "msi"), ...execution.fixtures];
    for (const row of rows) {
        const manifest = decodeDocument(row.executionManifest, "row execution manifest");
        if (manifest.fixture?.sourceSha !== candidateSourceSha)
            fail("row fixture candidate source differs");
        for (const expected of systemTools) {
            const actual = manifest.tools?.[expected.role];
            if (!actual || actual.path !== expected.path || actual.bytes !== Number(expected.bytes)
                || actual.sha256 !== expected.sha256) fail("row installed-system tool identity differs");
        }
        if (!Array.isArray(manifest.artifacts)) fail("row artifact inventory differs");
        for (const msi of allMsi) {
            const artifact = manifest.artifacts.find(item => item.bindingId === msi.bindingId);
            const msiSource = sourceByBindingRole.get(`${msi.bindingId}\0msi`);
            const fixture = preparedFixtures.get(msi.bindingId);
            const retainedPayload = msi.bindingId === "candidate-default" ? fixturePreparation.candidatePayload
                : msi.bindingId === "candidate-baseline" ? fixturePreparation.candidateBaselinePayload
                    : authenticPayloads.get(msi.bindingId);
            const expectedProperties = fixture ? {ProductCode: fixture.productCode} : properties.get(msi.bindingId);
            if (!artifact) fail("row MSI artifact is absent");
            if (artifact.bytes !== msi.bytes || artifact.sha256 !== msi.sha256
                || !expectedProperties || artifact.productCode !== expectedProperties.ProductCode)
                fail(`row MSI preparation binding differs: ${msi.bindingId}`);
            const seedName = path.win32.basename(artifact.path);
            const seed = row.seedFiles.find(file => file.name === seedName);
            if (!seed || seed.sourcePath !== msi.path || seed.bytes !== String(msi.bytes)
                || seed.sha256 !== msi.sha256) fail("row MSI local byte binding differs");
            if (CURRENT_BINDINGS.includes(msi.bindingId)) {
                const exe = acquiredByBindingRole.get(`${msi.bindingId}\0exe`);
                const exeSource = sourceByBindingRole.get(`${msi.bindingId}\0exe`);
                if (!exe || artifact.exeBytes !== exe.bytes || artifact.exeSha256 !== exe.sha256
                    || exe.bytes !== exeSource.bytes || exe.sha256 !== exeSource.sha256)
                    fail("row published executable binding differs");
            }
            if (!fixture && (!retainedPayload || artifact.exeBytes !== retainedPayload.exe.bytes
                || artifact.exeSha256 !== retainedPayload.exe.sha256
                || artifact.configurationSha256 !== retainedPayload.configuration.sha256
                || artifact.serviceWrapperSha256 !== retainedPayload.wrapper.sha256))
                fail("row MSI payload binding differs");
            if (fixture && (artifact.exeBytes !== fixture.exeBytes || artifact.exeSha256 !== fixture.exeSha256
                || artifact.configurationSha256 !== fixture.configurationSha256
                || artifact.serviceWrapperSha256 !== fixture.serviceWrapperSha256))
                fail("row prepared fixture payload binding differs");
            if (!fixture && (msi.bytes !== msiSource.bytes || msi.sha256 !== msiSource.sha256))
                fail("row MSI source binding differs");
        }
        const node = row.seedFiles.find(file => file.name === "node.exe");
        if (!node || node.sourcePath !== execution.runtime.path
            || node.bytes !== String(execution.runtime.bytes) || node.sha256 !== execution.runtime.sha256)
            fail("row Node runtime binding differs");
    }
};

const validateBase = (seal, request) => {
    const expected = {path: seal.image.path, bytes: seal.image.bytes, sha256: seal.image.sha256,
        ownership: seal.image.ownership};
    same(request.baseImage, expected, "host installed base");
    if (request.expected?.baseImageSha256 !== seal.image.sha256)
        fail("host expected base SHA-256 differs");
};

export const validateV161PostReleaseMsiHostProvenance = (value, request) => {
    exactKeys(value, ROOT_KEYS, "host provenance");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== KIND || value.authority !== AUTHORITY
        || value.qualifying !== false || !Array.isArray(value.releaseGatesCleared)
        || value.releaseGatesCleared.length !== 0) fail("host provenance header differs");
    exactString(value.targetSha256, SHA256, "target SHA-256");
    exactKeys(value.envelope, ["sha256", "value"], "retained MSI envelope");
    if (value.envelope.sha256 !== hashJson(value.envelope.value)) fail("retained MSI envelope hash differs");
    exactKeys(value.acquisition, ["planSha256", "recordSha256", "plan", "record"],
        "retained acquisition");
    if (value.acquisition.planSha256 !== hashJson(value.acquisition.plan)
        || value.acquisition.recordSha256 !== hashJson(value.acquisition.record))
        fail("retained acquisition hash differs");
    const executionContext = validateHostedContext(request.context);
    const executionHarness = harnessFromHostedContext(executionContext);
    validateCrossJobContext(value.harness, executionHarness);
    const rebuiltPlan = buildV161PostReleaseMsiAcquisitionPlan(value.envelope.value, value.harness,
        acquisitionRoot(value.acquisition.plan));
    same(value.acquisition.plan, JSON.parse(JSON.stringify(rebuiltPlan)), "retained acquisition plan");
    validateV161PostReleaseMsiAcquisitionRecord(value.acquisition.record, rebuiltPlan);
    validateV161PostReleaseMsiWindowsPreparation(value.preparation, rebuiltPlan);
    same(value.preparation.files, value.acquisition.record.files.map(file => ({bindingId: file.bindingId,
        role: file.role, ...file.local})), "preparation and acquisition files");
    same(value.preparation.runtime, value.acquisition.record.runtime, "preparation and acquisition runtime");
    const fixturePlan = buildV161PostReleaseMsiFixturePlan({acquisitionPlan: rebuiltPlan,
        windowsPreparation: value.preparation,
        outputRoot: path.win32.dirname(value.fixturePreparation.fixtures?.[0]?.path ?? "")});
    validateV161PostReleaseMsiFixturePreparation(value.fixturePreparation, fixturePlan);
    const baseline = validateV161PostReleaseBaselineInputPreparation(value.baselinePreparation);
    if (baseline.harnessSourceSha !== value.harness.sourceSha
        || baseline.candidateSourceSha !== value.candidate.sourceSha)
        fail("baseline input source binding differs");
    const retained = validateTransport(value.transport, value.harness, value.execution.root);
    exactKeys(retained.result, ["schemaVersion", "kind", "status", "qualifying", "installerExecution",
        "releaseGatesCleared", "target", "envelope", "acquisition", "windowsPreparation", "inspections",
        "targetInput", "fixturePreparation", "baselinePreparation", "pending"],
    "retained preparation result");
    if (retained.result.schemaVersion !== 1
        || retained.result.kind !== "myspeed-v1.6.1-post-release-msi-prepare-result"
        || retained.result.status !== "prepared" || retained.result.qualifying !== false
        || retained.result.installerExecution !== false || retained.result.pending?.length !== 1
        || retained.result.pending[0] !== "linux-transport-reobservation"
        || retained.result.releaseGatesCleared?.length !== 0) fail("retained preparation result header differs");
    const retainedTarget = bindRetainedTarget(retained.result.targetInput);
    same(retainedTarget, retained.result.target, "retained rebound target");
    validateV161PostReleaseMsiEnvelope(value.envelope.value, retainedTarget, value.harness);
    same(retained.result.envelope, value.envelope.value, "retained result envelope");
    same(retained.result.acquisition, value.acquisition.record, "retained result acquisition");
    same(retained.result.windowsPreparation, value.preparation, "retained result Windows preparation");
    same(retained.result.inspections, value.preparation.inspections, "retained result inspections");
    same(retained.result.fixturePreparation, value.fixturePreparation, "retained result fixture preparation");
    same(retained.fixtureProof, value.fixturePreparation, "retained fixture proof");
    same(retained.result.baselinePreparation, baseline, "retained result baseline input preparation");
    same(retained.baselineProof, baseline, "retained baseline input proof");
    if (hashJson(retained.result.target) !== value.targetSha256) fail("retained result target differs");
    validateExecution(value.execution, rebuiltPlan, value.fixturePreparation, value.transport.artifact.digest,
        request.taskRoot);
    exactKeys(value.installedBase, ["sha256", "seal"], "installed base binding");
    if (value.installedBase.sha256 !== hashJson(value.installedBase.seal))
        fail("installed base seal hash differs");
    const seal = validateSameJobInstalledBaseSeal(value.installedBase.seal, executionContext);
    validateBase(seal, request);
    same(value.candidate, value.envelope.value.candidate, "candidate identity");
    if (request.repository !== REPOSITORY || request.sourceSha !== executionHarness.sourceSha
        || request.eventSha !== executionHarness.eventSha || request.runId !== executionHarness.runId
        || request.runAttempt !== executionHarness.runAttempt || request.nonce !== executionHarness.nonce)
        fail("host execution identity differs");
    if (request.expected?.candidateManifestSha256 !== value.envelope.value.originalQualification.manifest.sha256)
        fail("host candidate manifest binding differs");
    validateRows(request.rows, value.acquisition, value.preparation, value.fixturePreparation, value.execution,
        value.candidate.sourceSha, seal.source.systemTools);
    return true;
};

export const createV161PostReleaseMsiHostBinding = ({target, harnessContext, envelope, acquisitionPlan,
    acquisitionRecord, preparation, fixturePreparation, baselinePreparation, transport, execution,
    installedBaseSeal, hostRequest}) => {
    validateV161PostReleaseMsiEnvelope(envelope, target, harnessContext);
    const rebuiltPlan = buildV161PostReleaseMsiAcquisitionPlan(envelope, harnessContext,
        acquisitionRoot(acquisitionPlan));
    same(JSON.parse(JSON.stringify(acquisitionPlan)), JSON.parse(JSON.stringify(rebuiltPlan)),
        "acquisition plan");
    validateV161PostReleaseMsiAcquisitionRecord(acquisitionRecord, rebuiltPlan);
    validateV161PostReleaseMsiWindowsPreparation(preparation, rebuiltPlan);
    const fixturePlan = buildV161PostReleaseMsiFixturePlan({acquisitionPlan: rebuiltPlan,
        windowsPreparation: preparation,
        outputRoot: path.win32.dirname(fixturePreparation?.fixtures?.[0]?.path ?? "")});
    validateV161PostReleaseMsiFixturePreparation(fixturePreparation, fixturePlan);
    const baseline = validateV161PostReleaseBaselineInputPreparation(baselinePreparation);
    if (baseline.harnessSourceSha !== harnessContext.sourceSha
        || baseline.candidateSourceSha !== target.candidate.sourceSha)
        fail("baseline input source binding differs");
    const executionContext = validateHostedContext(hostRequest.context);
    validateSameJobInstalledBaseSeal(installedBaseSeal, executionContext);
    if (hostRequest.candidateProvenance !== null) fail("host request must not contain legacy provenance");
    const provenance = deepFreeze({schemaVersion: SCHEMA_VERSION, kind: KIND, authority: AUTHORITY,
        qualifying: false, targetSha256: hashJson(target), harness: structuredClone(harnessContext),
        candidate: structuredClone(target.candidate),
        envelope: {sha256: hashJson(envelope), value: structuredClone(envelope)},
        acquisition: {planSha256: hashJson(acquisitionPlan), recordSha256: hashJson(acquisitionRecord),
            plan: structuredClone(acquisitionPlan), record: structuredClone(acquisitionRecord)},
        preparation: structuredClone(preparation), fixturePreparation: structuredClone(fixturePreparation),
        baselinePreparation: structuredClone(baseline),
        transport: structuredClone(transport),
        execution: structuredClone(execution),
        installedBase: {sha256: hashJson(installedBaseSeal), seal: structuredClone(installedBaseSeal)},
        releaseGatesCleared: []});
    const request = deepFreeze({...structuredClone(hostRequest), candidateProvenance: provenance});
    validateV161PostReleaseMsiHostProvenance(provenance, request);
    return deepFreeze({provenance, hostRequest: request, nativeExecutionStarted: false, releaseGatesCleared: []});
};
