import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {buildWindowsBaselineGuestFixtureBundle} from
    "../qualification/windows-baseline-guest-fixture-bundle.mjs";
import {WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS} from
    "../qualification/windows-baseline-guest-runtime-bundle.mjs";

const CANDIDATE_SOURCE_SHA = "4fa4dd40a89a062735f98bd85d685e0624ff46a8";
const MANIFEST_BYTES = 21_518;
const MANIFEST_SHA256 = "7339a6446d048bbae93759734bcafc94208e2b847af15677e847ae9a4b2f8bca";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const FIXTURE_COMMON = Object.freeze(["bin/cfspeedtest.exe", "bin/iperf3.exe", "bin/librespeed-cli.exe",
    "bin/speedtest.exe", "data/servers/librespeed.json", "data/servers/ookla.json"]);
const OPTIONAL_WAL = "data/storage.db-wal";
const TRANSIENT_SHARED_MEMORY = "data/storage.db-shm";
const POPULATED_SQLITE_SIDECARS = Object.freeze([TRANSIENT_SHARED_MEMORY, OPTIONAL_WAL]);
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const RESULT_KIND = "myspeed-v1.6.1-post-release-baseline-input-preparation";
const RESULT_AUTHORITY = "windows-hosted-input-preparation-only";

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const recordId = relativePath => `baseline:${relativePath}`;
const exactKeys = (value, keys, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort()))
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
const expectedRelativePaths = populatedSidecars => ["qualification-manifest.json", "fixture/transport.json",
    ...[".myspeed-qualification.json", ...FIXTURE_COMMON, "data/storage.db",
        ...populatedSidecars].map(name => `fixture/populated/${name}`),
    ...[".myspeed-qualification.json", ...FIXTURE_COMMON].map(name => `fixture/reset/${name}`),
    ...[...WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS,
        "scripts/qualification/windows-baseline-guest-runtime-installer.ps1"]
        .map(name => `runtime/${name}`)];

export function validateV161PostReleaseBaselineInputPreparation(value) {
    exactKeys(value, ["schemaVersion", "kind", "status", "authority", "candidateSourceSha", "harnessSourceSha",
        "files"], "baseline input preparation");
    if (value.schemaVersion !== 1 || value.kind !== RESULT_KIND || value.status !== "prepared"
        || value.authority !== RESULT_AUTHORITY || value.candidateSourceSha !== CANDIDATE_SOURCE_SHA)
        throw new TypeError("baseline input preparation header differs");
    exactHash(value.harnessSourceSha, COMMIT_SHA, "baseline harness source");
    if (value.harnessSourceSha === value.candidateSourceSha) throw new TypeError("baseline source roles collapse");
    if (!Array.isArray(value.files)) throw new TypeError("baseline input files differ");
    const populatedSidecars = POPULATED_SQLITE_SIDECARS.filter(name => value.files.some(file =>
        file?.relativePath === `fixture/populated/${name}`));
    const expectedPaths = expectedRelativePaths(populatedSidecars);
    if (value.files.length !== expectedPaths.length) throw new TypeError("baseline input file count differs");
    value.files.forEach((file, index) => {
        exactKeys(file, ["bindingId", "sourceRole", "sourceSha", "relativePath", "bytes", "sha256"],
            "baseline input file");
        const relativePath = expectedPaths[index];
        const sourceRole = relativePath.startsWith("runtime/") ? "harness" : "candidate";
        const sourceSha = sourceRole === "harness" ? value.harnessSourceSha : value.candidateSourceSha;
        if (file.bindingId !== recordId(relativePath) || file.relativePath !== relativePath
            || file.sourceRole !== sourceRole || file.sourceSha !== sourceSha
            || path.posix.normalize(relativePath) !== relativePath || path.posix.isAbsolute(relativePath))
            throw new TypeError("baseline input file binding differs");
        const isWal = relativePath === `fixture/populated/${OPTIONAL_WAL}`;
        if (!Number.isSafeInteger(file.bytes) || file.bytes < (isWal ? 0 : 1) || file.bytes > MAX_FILE_BYTES)
            throw new TypeError("baseline input file bytes differ");
        exactHash(file.sha256, SHA256, "baseline input file SHA-256");
        if (isWal && (file.bytes !== 0 || file.sha256 !== EMPTY_SHA256))
            throw new TypeError("baseline input WAL differs");
    });
    const manifest = value.files[0];
    if (manifest.bytes !== MANIFEST_BYTES || manifest.sha256 !== MANIFEST_SHA256)
        throw new TypeError("baseline qualification manifest differs");
    return deepFreeze(structuredClone(value));
}

function readBounded(target, allowEmpty = false) {
    const canonical = fs.realpathSync.native(target);
    if (canonical !== target) throw new Error("baseline input source path differs");
    const lexical = fs.lstatSync(target, {bigint: true});
    const handle = fs.openSync(target, fs.constants.O_RDONLY);
    try {
        const before = fs.fstatSync(handle, {bigint: true});
        if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.nlink !== 1n || !before.isFile() ||
            before.nlink !== 1n || before.dev !== lexical.dev || before.ino !== lexical.ino ||
            before.size > BigInt(MAX_FILE_BYTES) || (!allowEmpty && before.size < 1n))
            throw new Error("baseline input source identity differs");
        const bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) { const count = fs.readSync(handle, bytes, offset, bytes.length - offset, offset);
            if (count < 1) throw new Error("baseline input source was truncated"); offset += count; }
        const trailing = Buffer.alloc(1);
        const trailingCount = fs.readSync(handle, trailing, 0, 1, bytes.length);
        const after = fs.fstatSync(handle, {bigint: true});
        const lexicalAfter = fs.lstatSync(target, {bigint: true});
        if (trailingCount !== 0 || before.dev !== after.dev || before.ino !== after.ino ||
            before.size !== after.size || after.dev !== lexicalAfter.dev || after.ino !== lexicalAfter.ino ||
            lexicalAfter.isSymbolicLink()) throw new Error("baseline input source changed while reading");
        return bytes;
    } finally { fs.closeSync(handle); }
}

function createRecord(relativePath, bytes, sourceRole, sourceSha) {
    return {relativePath, bytesValue: bytes, value: Object.freeze({bindingId: recordId(relativePath),
        sourceRole, sourceSha, relativePath, bytes: bytes.length, sha256: sha256(bytes)})};
}

function writeRecord(outputRoot, record) {
    const {relativePath, bytesValue: bytes} = record;
    const target = path.join(outputRoot, ...relativePath.split("/"));
    if (!target.startsWith(`${outputRoot}${path.sep}`)) throw new Error("baseline output path escapes its root");
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, bytes, {flag: "wx"});
    const observed = fs.readFileSync(target);
    if (!observed.equals(bytes)) throw new Error("baseline output verification differs");
}

export function prepareV161PostReleaseBaselineInputs({candidateFixture, harnessRoot, harnessSourceSha,
    manifestPath, outputRoot}) {
    if (!/^[0-9a-f]{40}$/u.test(harnessSourceSha) || harnessSourceSha === CANDIDATE_SOURCE_SHA)
        throw new TypeError("baseline preparation harness source differs");
    if (!path.isAbsolute(outputRoot) || fs.existsSync(outputRoot))
        throw new Error("baseline preparation output root is not fresh");
    const manifestBytes = readBounded(manifestPath);
    if (manifestBytes.length !== MANIFEST_BYTES || sha256(manifestBytes) !== MANIFEST_SHA256)
        throw new Error("baseline preparation qualification manifest differs");
    const fixtureManifestBytes = readBounded(candidateFixture.manifestPath);
    const fixtureManifest = {path: candidateFixture.manifestPath, bytes: String(fixtureManifestBytes.length),
        sha256: sha256(fixtureManifestBytes)};
    buildWindowsBaselineGuestFixtureBundle({sourceSha: CANDIDATE_SOURCE_SHA, manifest: fixtureManifest,
        populatedRoot: candidateFixture.populatedRoot, resetRoot: candidateFixture.resetRoot});
    const fixtureTransport = JSON.parse(fixtureManifestBytes.toString("utf8"));

    const records = [createRecord("qualification-manifest.json", manifestBytes,
        "candidate", CANDIDATE_SOURCE_SHA)];
    const populatedSidecars = POPULATED_SQLITE_SIDECARS.filter(name =>
        Object.hasOwn(fixtureTransport.populated.filesSha256, name));
    const fixtureNames = ["transport.json",
        ...[".myspeed-qualification.json", ...FIXTURE_COMMON, "data/storage.db",
            ...populatedSidecars].map(name => `populated/${name}`),
        ...[".myspeed-qualification.json", ...FIXTURE_COMMON].map(name => `reset/${name}`)];
    for (const name of fixtureNames) {
        const source = name === "transport.json" ? candidateFixture.manifestPath :
            path.join(name.startsWith("populated/") ? candidateFixture.populatedRoot : candidateFixture.resetRoot,
                ...name.slice(name.indexOf("/") + 1).split("/"));
        const relative = `fixture/${name}`;
        const allowEmpty = name === `populated/${OPTIONAL_WAL}`;
        const bytes = readBounded(source, allowEmpty);
        const treeName = name.slice(0, name.indexOf("/"));
        const memberName = name.slice(name.indexOf("/") + 1);
        const expectedSha256 = name === "transport.json" ? fixtureManifest.sha256
            : fixtureTransport[treeName].filesSha256[memberName];
        if (sha256(bytes) !== expectedSha256) throw new Error("baseline fixture source identity differs");
        if (allowEmpty && (bytes.length !== 0 || sha256(bytes) !== EMPTY_SHA256))
            throw new Error("baseline preparation optional WAL differs");
        records.push(createRecord(relative, bytes, "candidate", CANDIDATE_SOURCE_SHA));
    }
    const runtimePaths = [...WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS,
        "scripts/qualification/windows-baseline-guest-runtime-installer.ps1"];
    for (const relativePath of runtimePaths) {
        const bytes = readBounded(path.join(harnessRoot, ...relativePath.split("/")));
        records.push(createRecord(`runtime/${relativePath}`, bytes, "harness", harnessSourceSha));
    }
    fs.mkdirSync(path.dirname(outputRoot), {recursive: true});
    fs.mkdirSync(outputRoot, {recursive: false});
    for (const record of records) writeRecord(outputRoot, record);
    const files = Object.freeze(records.map(record => record.value));
    return validateV161PostReleaseBaselineInputPreparation({schemaVersion: 1, kind: RESULT_KIND,
        status: "prepared", authority: RESULT_AUTHORITY, candidateSourceSha: CANDIDATE_SOURCE_SHA,
        harnessSourceSha, files});
}

export const POST_RELEASE_BASELINE_INPUT_CONSTANTS = Object.freeze({CANDIDATE_SOURCE_SHA, EMPTY_SHA256,
    FIXTURE_COMMON, MANIFEST_BYTES, MANIFEST_SHA256, MAX_FILE_BYTES, OPTIONAL_WAL, TRANSIENT_SHARED_MEMORY});
