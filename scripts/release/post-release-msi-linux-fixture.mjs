import {createHash} from "node:crypto";
import path from "node:path";

import {validateHostedContext} from "../qualification/linux-kvm-capability.mjs";
import {POST_RELEASE_BASELINE_INPUT_CONSTANTS, validateV161PostReleaseBaselineInputPreparation} from
    "./post-release-msi-baseline-input-preparation.mjs";
import {validateV161PostReleaseMsiHostFixture} from "./post-release-msi-host-request.mjs";

const SCHEMA_VERSION = 1;
const KIND = "myspeed-v1.6.1-post-release-msi-linux-fixture-preparation";
const AUTHORITY = "same-job-local-byte-preparation-only";
const TASK_ROOT_PREFIX = "/home/runner/work/_temp/myspeed-windows-msi-";
const SHA256 = /^[0-9a-f]{64}$/u;
const LEGACY_SENTINEL_BYTES = Buffer.from("myspeed-v1.6.1-msi-legacy-sentinel\n", "utf8");
const DESTINATION_SENTINEL_BYTES = Buffer.from("myspeed-v1.6.1-msi-destination-sentinel\n", "utf8");
const BASELINE_ROOT = "files/baseline";
const FIXTURE_TRANSPORT = "fixture/transport.json";
const DESTINATION_SENTINEL_NAME = "fixture/populated/destination.sentinel";
const LEGACY_SENTINEL_NAME = "fixture/legacy/legacy.sentinel";
const FIXTURE_PING = "123.456";
const FIXTURE_RESULT_ID = "qualification-seed-row";
const MAX_FIXTURE_ROOT_CHARACTERS = 512;

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const object = (value, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} differs`);
};
const exactKeys = (value, keys, label) => {
    object(value, label); const actual = Object.keys(value).sort(); const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
        throw new TypeError(`${label} keys differ`);
};
const exactHash = (value, pattern, label) => {
    if (typeof value !== "string" || pattern.exec(value)?.[0] !== value) throw new TypeError(`${label} differs`);
};
const deepFreeze = value => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
};

const validateObservation = (value, expectedPath, expected, label) => {
    exactKeys(value, ["path", "bytes", "identity"], label);
    if (!Buffer.isBuffer(value.bytes) || value.path !== expectedPath) throw new TypeError(`${label} bytes differ`);
    exactKeys(value.identity, ["path", "bytes", "sha256"], `${label} identity`);
    if (value.identity.path !== expectedPath || value.identity.bytes !== value.bytes.length
        || value.identity.sha256 !== sha256(value.bytes) || value.identity.bytes !== expected.bytes
        || value.identity.sha256 !== expected.sha256) throw new TypeError(`${label} identity differs`);
    return value;
};

const parseTransport = bytes => {
    let value;
    try { value = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)); }
    catch { throw new TypeError("baseline fixture transport JSON differs"); }
    if (!bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`, "utf8")))
        throw new TypeError("baseline fixture transport serialization differs");
    exactKeys(value, ["schemaVersion", "source", "populated", "reset", "expected"],
        "baseline fixture transport");
    exactKeys(value.source, ["commit", "bunLockSha256", "packageSha256"], "baseline fixture source");
    exactKeys(value.populated, ["root", "nonce", "markerSha256", "databaseSha256", "filesSha256"],
        "baseline populated fixture");
    exactKeys(value.reset, ["root", "nonce", "markerSha256", "filesSha256"], "baseline reset fixture");
    exactKeys(value.expected, ["ping", "resultId", "passwordValueSha256"], "baseline fixture expected values");
    if (value.schemaVersion !== SCHEMA_VERSION || value.source.commit
        !== POST_RELEASE_BASELINE_INPUT_CONSTANTS.CANDIDATE_SOURCE_SHA
        || value.expected.ping !== FIXTURE_PING || value.expected.resultId !== FIXTURE_RESULT_ID)
        throw new TypeError("baseline fixture transport identity differs");
    for (const [candidate, label] of [[value.source.bunLockSha256, "bun lock"],
        [value.source.packageSha256, "package"], [value.populated.markerSha256, "populated marker"],
        [value.populated.databaseSha256, "populated database"], [value.reset.markerSha256, "reset marker"],
        [value.expected.passwordValueSha256, "password value"]]) exactHash(candidate, SHA256, label);
    for (const [tree, label] of [[value.populated, "populated"], [value.reset, "reset"]]) {
        if (typeof tree.root !== "string" || tree.root.length < 1
            || tree.root.length > MAX_FIXTURE_ROOT_CHARACTERS)
            throw new TypeError(`baseline ${label} fixture root differs`);
        exactHash(tree.nonce, /^[0-9a-f]{48}$/u, `baseline ${label} fixture nonce`);
        object(tree.filesSha256, `baseline ${label} fixture inventory`);
        for (const [name, digest] of Object.entries(tree.filesSha256)) {
            if (typeof name !== "string" || !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u.test(name)
                || path.posix.normalize(name) !== name) throw new TypeError(`baseline ${label} member differs`);
            exactHash(digest, SHA256, `baseline ${label} member SHA-256`);
        }
    }
    if (value.populated.filesSha256[".myspeed-qualification.json"] !== value.populated.markerSha256
        || value.populated.filesSha256["data/storage.db"] !== value.populated.databaseSha256
        || value.reset.filesSha256[".myspeed-qualification.json"] !== value.reset.markerSha256)
        throw new TypeError("baseline fixture distinguished files differ");
    return value;
};

const hostFile = binding => ({name: binding.name, sourceRole: binding.sourceRole,
    sourceSha: binding.sourceSha, sourcePath: binding.sourcePath, bytes: binding.bytes, sha256: binding.sha256});

const validateBinding = (value, expected, label) => {
    exactKeys(value, ["name", "sourceRole", "sourceSha", "sourcePath", "bytes", "sha256"], label);
    if (JSON.stringify(value) !== JSON.stringify(expected)) throw new TypeError(`${label} differs`);
    return value;
};

export const validateV161PostReleaseMsiLinuxFixturePreparation = (value, input) => {
    exactKeys(input, ["context", "taskRoot", "artifactRoot", "baselinePreparation"],
        "MSI Linux fixture validation input");
    const context = validateHostedContext(input.context);
    const baseline = validateV161PostReleaseBaselineInputPreparation(input.baselinePreparation);
    const expectedTaskRoot = `${TASK_ROOT_PREFIX}${context.nonce}`;
    if (input.taskRoot !== expectedTaskRoot || input.artifactRoot !== `${expectedTaskRoot}/appassets`
        || baseline.harnessSourceSha !== context.sourceSha)
        throw new TypeError("MSI Linux fixture validation roots differ");
    exactKeys(value, ["schemaVersion", "kind", "status", "authority", "qualifying", "binding", "hostFixture"],
        "MSI Linux fixture preparation");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== KIND || value.status !== "prepared"
        || value.authority !== AUTHORITY || value.qualifying !== false)
        throw new TypeError("MSI Linux fixture preparation header differs");
    exactKeys(value.binding, ["candidateSourceSha", "harnessSourceSha", "candidateFiles", "generatedSentinels"],
        "MSI Linux fixture binding");
    if (value.binding.candidateSourceSha !== baseline.candidateSourceSha
        || value.binding.harnessSourceSha !== baseline.harnessSourceSha)
        throw new TypeError("MSI Linux fixture source binding differs");
    const manifest = validateV161PostReleaseMsiHostFixture(value.hostFixture, context);
    const manifestValue = parseTransport(Buffer.from(manifest.manifest.bytesBase64, "base64"));
    const records = new Map(baseline.files.map(file => [file.relativePath, file]));
    const expectedCandidate = Object.keys(manifestValue.populated.filesSha256).map(name => {
        const relativePath = `fixture/populated/${name}`;
        const record = records.get(relativePath);
        if (!record || record.sha256 !== manifestValue.populated.filesSha256[name])
            throw new TypeError("MSI Linux fixture candidate inventory differs");
        return {name: relativePath, sourceRole: "candidate", sourceSha: baseline.candidateSourceSha,
            sourcePath: `${input.artifactRoot}/${BASELINE_ROOT}/${relativePath}`,
            bytes: record.bytes, sha256: record.sha256};
    });
    if (!Array.isArray(value.binding.candidateFiles)
        || value.binding.candidateFiles.length !== expectedCandidate.length)
        throw new TypeError("MSI Linux fixture candidate binding differs");
    value.binding.candidateFiles.forEach((record, index) =>
        validateBinding(record, expectedCandidate[index], "MSI Linux fixture candidate binding"));
    const expectedSentinels = [[DESTINATION_SENTINEL_NAME, DESTINATION_SENTINEL_BYTES],
        [LEGACY_SENTINEL_NAME, LEGACY_SENTINEL_BYTES]].map(([name, bytes]) => ({name, sourceRole: "harness",
        sourceSha: baseline.harnessSourceSha,
        sourcePath: `${input.taskRoot}/generated-fixture/${name.slice("fixture/".length)}`,
        bytes: bytes.length, sha256: sha256(bytes)}));
    if (!Array.isArray(value.binding.generatedSentinels) || value.binding.generatedSentinels.length !== 2)
        throw new TypeError("MSI Linux fixture sentinel binding differs");
    value.binding.generatedSentinels.forEach((record, index) =>
        validateBinding(record, expectedSentinels[index], "MSI Linux fixture sentinel binding"));
    const expectedFiles = [...expectedCandidate, ...expectedSentinels].map(hostFile);
    if (JSON.stringify(value.hostFixture.files) !== JSON.stringify(expectedFiles)
        || value.hostFixture.execution.sourceSha !== baseline.candidateSourceSha
        || value.hostFixture.execution.destinationSentinelSha256 !== expectedSentinels[0].sha256
        || value.hostFixture.execution.legacySentinelSha256 !== expectedSentinels[1].sha256)
        throw new TypeError("MSI Linux fixture host binding differs");
    return deepFreeze(structuredClone(value));
};

export const prepareV161PostReleaseMsiLinuxFixture = async (input, operations) => {
    exactKeys(input, ["context", "taskRoot", "artifactRoot", "baselinePreparation"],
        "MSI Linux fixture input");
    exactKeys(operations, ["readExact", "createExact"], "MSI Linux fixture operations");
    if (typeof operations.readExact !== "function" || typeof operations.createExact !== "function")
        throw new TypeError("MSI Linux fixture operations differ");
    const context = validateHostedContext(input.context);
    const baseline = validateV161PostReleaseBaselineInputPreparation(input.baselinePreparation);
    if (baseline.harnessSourceSha !== context.sourceSha)
        throw new TypeError("MSI Linux fixture harness source differs");
    const expectedTaskRoot = `${TASK_ROOT_PREFIX}${context.nonce}`;
    if (input.taskRoot !== expectedTaskRoot || input.artifactRoot !== `${expectedTaskRoot}/appassets`)
        throw new TypeError("MSI Linux fixture roots differ");
    const records = new Map(baseline.files.map(file => [file.relativePath, file]));
    const observe = async record => {
        const sourcePath = `${input.artifactRoot}/${BASELINE_ROOT}/${record.relativePath}`;
        const observed = validateObservation(await operations.readExact({path: sourcePath, expected: record,
            allowEmpty: record.relativePath.endsWith(POST_RELEASE_BASELINE_INPUT_CONSTANTS.OPTIONAL_WAL)}),
        sourcePath, record, "MSI Linux fixture source");
        return {record, sourcePath, bytesValue: observed.bytes};
    };
    const manifestObserved = await observe(records.get(FIXTURE_TRANSPORT));
    const manifestValue = parseTransport(manifestObserved.bytesValue);
    if (manifestValue.source.commit !== baseline.candidateSourceSha)
        throw new TypeError("MSI Linux fixture candidate source differs");
    const populatedNames = Object.keys(manifestValue.populated.filesSha256);
    if (populatedNames.includes("destination.sentinel"))
        throw new TypeError("MSI Linux destination sentinel collides with candidate fixture");
    const candidateBindings = [];
    for (const name of populatedNames) {
        const relativePath = `fixture/populated/${name}`;
        const record = records.get(relativePath);
        if (!record || record.sha256 !== manifestValue.populated.filesSha256[name])
            throw new TypeError("MSI Linux populated fixture inventory differs");
        const observed = await observe(record);
        candidateBindings.push({name: relativePath, sourceRole: "candidate", sourceSha: baseline.candidateSourceSha,
            sourcePath: observed.sourcePath, bytes: record.bytes, sha256: record.sha256});
    }
    for (const [name, digest] of Object.entries(manifestValue.reset.filesSha256)) {
        const record = records.get(`fixture/reset/${name}`);
        if (!record || record.sha256 !== digest) throw new TypeError("MSI Linux reset fixture inventory differs");
    }
    const createSentinel = async (name, bytes) => {
        const sourcePath = `${input.taskRoot}/generated-fixture/${name.slice("fixture/".length)}`;
        const expected = {bytes: bytes.length, sha256: sha256(bytes)};
        const observed = validateObservation(await operations.createExact({path: sourcePath, bytes}), sourcePath,
            expected, "MSI Linux sentinel");
        if (!observed.bytes.equals(bytes)) throw new TypeError("MSI Linux sentinel bytes differ");
        return {name, sourceRole: "harness", sourceSha: baseline.harnessSourceSha, sourcePath,
            bytes: expected.bytes, sha256: expected.sha256};
    };
    const destination = await createSentinel(DESTINATION_SENTINEL_NAME, DESTINATION_SENTINEL_BYTES);
    const legacy = await createSentinel(LEGACY_SENTINEL_NAME, LEGACY_SENTINEL_BYTES);
    const manifest = {path: manifestObserved.sourcePath, bytes: manifestObserved.record.bytes,
        sha256: manifestObserved.record.sha256, bytesBase64: manifestObserved.bytesValue.toString("base64")};
    const execution = {sourceSha: baseline.candidateSourceSha, populatedRoot: "C:\\placeholder\\populated",
        manifestPath: "C:\\placeholder\\fixture.json", manifestSha256: manifest.sha256,
        legacyRoot: "C:\\placeholder\\legacy", populatedMarkerSha256: manifestValue.populated.markerSha256,
        populatedDatabaseSha256: manifestValue.populated.databaseSha256,
        populatedFilesSha256: structuredClone(manifestValue.populated.filesSha256),
        destinationSentinelSha256: destination.sha256, legacySentinelSha256: legacy.sha256,
        expected: structuredClone(manifestValue.expected)};
    const result = {schemaVersion: SCHEMA_VERSION, kind: KIND, status: "prepared", authority: AUTHORITY,
        qualifying: false, binding: {candidateSourceSha: baseline.candidateSourceSha,
            harnessSourceSha: baseline.harnessSourceSha, candidateFiles: candidateBindings,
            generatedSentinels: [destination, legacy]},
        hostFixture: {manifest, execution, files: [...candidateBindings, destination, legacy].map(hostFile)}};
    return deepFreeze(result);
};

export const POST_RELEASE_MSI_LINUX_FIXTURE_CONSTANTS = Object.freeze({AUTHORITY, DESTINATION_SENTINEL_NAME,
    KIND, LEGACY_SENTINEL_NAME});
