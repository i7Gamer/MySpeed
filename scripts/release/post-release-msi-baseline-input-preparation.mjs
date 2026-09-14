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

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const recordId = relativePath => `baseline:${relativePath}`;

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
    const fixtureNames = ["transport.json",
        ...[".myspeed-qualification.json", ...FIXTURE_COMMON, "data/storage.db",
            ...(fs.existsSync(path.join(candidateFixture.populatedRoot, ...OPTIONAL_WAL.split("/")))
                ? [OPTIONAL_WAL] : [])].map(name => `populated/${name}`),
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
    return Object.freeze({schemaVersion: 1, kind: "myspeed-v1.6.1-post-release-baseline-input-preparation",
        status: "prepared", authority: "windows-hosted-input-preparation-only",
        candidateSourceSha: CANDIDATE_SOURCE_SHA, harnessSourceSha, files});
}

export const POST_RELEASE_BASELINE_INPUT_CONSTANTS = Object.freeze({CANDIDATE_SOURCE_SHA, EMPTY_SHA256,
    FIXTURE_COMMON, MANIFEST_BYTES, MANIFEST_SHA256, MAX_FILE_BYTES, OPTIONAL_WAL});
