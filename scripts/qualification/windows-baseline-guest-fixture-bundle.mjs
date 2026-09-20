import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA_VERSION = 1;
const BUNDLE_KIND = "myspeed-windows-baseline-fixture-bundle";
const MARKER_NAME = ".myspeed-qualification.json";
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SOURCE_PATTERN = /^[0-9a-f]{40}$/u;
const NONCE_PATTERN = /^[0-9a-f]{48}$/u;
/*
 * Every provider binary the fixture producer emits. This list was four entries for a year after
 * ost-cli shipped, because the only caller ran an older producer and nothing compared the two; the
 * mismatch surfaced the first time the producer and the guest came from the same commit.
 */
const COMMON_FILES = Object.freeze(["bin/cfspeedtest.exe", "bin/iperf3.exe", "bin/librespeed-cli.exe",
    "bin/ost-cli.exe", "bin/speedtest.exe", "data/servers/librespeed.json",
    "data/servers/ookla.json"]);
const POPULATED_FILES = Object.freeze([...COMMON_FILES, "data/storage.db"].sort());
const RESET_FILES = Object.freeze([...COMMON_FILES].sort());
const OPTIONAL_EMPTY_WAL = "data/storage.db-wal";
const TRANSIENT_SHARED_MEMORY = "data/storage.db-shm";
const EMPTY_SHA256 = crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex");

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, expected, label) => {
    if (!isObject(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
        throw new TypeError(`${label} schema differs`);
};
const exactString = (value, pattern, label) => {
    const match = typeof value === "string" ? pattern.exec(value) : null;
    if (match === null || match.index !== 0 || match[0].length !== value.length)
        throw new TypeError(`${label} differs`);
    return value;
};

function readOwned(identity, maximumBytes, label) {
    exactKeys(identity, ["bytes", "path", "sha256"], `${label} identity`);
    exactString(identity.bytes, /^[1-9][0-9]*$/u, `${label} bytes`);
    exactString(identity.sha256, SHA256_PATTERN, `${label} SHA`);
    const expectedBytes = Number(identity.bytes);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes > maximumBytes)
        throw new TypeError(`${label} byte bound differs`);
    const lexical = fs.lstatSync(identity.path, {bigint: true});
    if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.nlink !== 1n)
        throw new Error(`${label} is not an ordinary single-link file`);
    const handle = fs.openSync(identity.path, "r");
    try {
        const before = fs.fstatSync(handle, {bigint: true});
        if (!before.isFile() || before.nlink !== 1n || before.dev !== lexical.dev || before.ino !== lexical.ino ||
            before.size !== BigInt(expectedBytes) || fs.realpathSync.native(identity.path) !== identity.path)
            throw new Error(`${label} physical identity differs`);
        const bytes = fs.readFileSync(handle);
        const after = fs.fstatSync(handle, {bigint: true});
        if (bytes.length !== expectedBytes || sha256(bytes) !== identity.sha256 || before.dev !== after.dev ||
            before.ino !== after.ino || before.size !== after.size || before.nlink !== after.nlink)
            throw new Error(`${label} content identity differs`);
        return bytes;
    } finally { fs.closeSync(handle); }
}

function readEmptyWal(target, label) {
    const lexical = fs.lstatSync(target, {bigint: true});
    if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.nlink !== 1n || lexical.size !== 0n)
        throw new Error(`${label} optional WAL identity differs`);
    const handle = fs.openSync(target, "r");
    try {
        const before = fs.fstatSync(handle, {bigint: true});
        const canonical = fs.realpathSync.native(target);
        const bytes = fs.readFileSync(handle);
        const after = fs.fstatSync(handle, {bigint: true});
        const lexicalAfter = fs.lstatSync(target, {bigint: true});
        if (!before.isFile() || before.nlink !== 1n || before.dev !== lexical.dev || before.ino !== lexical.ino ||
            canonical !== target || bytes.length !== 0 || before.dev !== after.dev || before.ino !== after.ino ||
            before.size !== after.size || after.dev !== lexicalAfter.dev || after.ino !== lexicalAfter.ino ||
            lexicalAfter.isSymbolicLink() || sha256(bytes) !== EMPTY_SHA256)
            throw new Error(`${label} optional WAL identity differs`);
        return bytes;
    } finally { fs.closeSync(handle); }
}

function validateRoot(root, label) {
    const canonical = fs.realpathSync.native(root);
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== root)
        throw new Error(`${label} root identity differs`);
    return canonical;
}

function validateInventory(value, expectedFiles, label, allowEmptyWal = false) {
    if (!isObject(value)) throw new TypeError(`${label} inventory differs`);
    const hasWal = Object.hasOwn(value, OPTIONAL_EMPTY_WAL);
    const hasSharedMemory = Object.hasOwn(value, TRANSIENT_SHARED_MEMORY);
    const transientFiles = [
        ...(hasWal && allowEmptyWal ? [OPTIONAL_EMPTY_WAL] : []),
        ...(hasSharedMemory && allowEmptyWal ? [TRANSIENT_SHARED_MEMORY] : [])
    ];
    const expected = [MARKER_NAME, ...expectedFiles, ...transientFiles].sort();
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected))
        throw new TypeError(`${label} inventory differs`);
    for (const name of expected) exactString(value[name], SHA256_PATTERN, `${label} ${name} SHA`);
    if (hasWal && value[OPTIONAL_EMPTY_WAL] !== EMPTY_SHA256)
        throw new TypeError(`${label} optional WAL identity differs`);
    return {inventory: value, files: [...expectedFiles, ...transientFiles].sort()};
}

function validateTreeShape(root, expectedFiles, label) {
    const expectedDirectories = new Set();
    for (const name of expectedFiles) {
        let parent = path.posix.dirname(name);
        while (parent !== ".") { expectedDirectories.add(parent); parent = path.posix.dirname(parent); }
    }
    const expected = [...expectedDirectories].map(name => `directory:${name}`)
        .concat(expectedFiles.map(name => `file:${name}`)).sort();
    const actual = [];
    const visit = (directory, relative) => {
        for (const name of fs.readdirSync(directory).sort()) {
            const target = path.join(directory, name);
            const child = relative === "" ? name : `${relative}/${name}`;
            const stat = fs.lstatSync(target, {bigint: true});
            if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic link`);
            if (stat.isDirectory()) { actual.push(`directory:${child}`); visit(target, child); }
            else if (stat.isFile() && stat.nlink === 1n) actual.push(`file:${child}`);
            else throw new Error(`${label} contains a special or linked file`);
        }
    };
    visit(root, "");
    if (JSON.stringify(actual.sort()) !== JSON.stringify(expected))
        throw new Error(`${label} physical inventory differs`);
}

function readTree(root, expectedFiles, inventory, label) {
    const records = [];
    for (const name of [MARKER_NAME, ...expectedFiles].sort()) {
        const target = path.join(root, ...name.split("/"));
        const observedSize = fs.lstatSync(target).size;
        const bytes = name === OPTIONAL_EMPTY_WAL && observedSize === 0
            ? readEmptyWal(target, label)
            : readOwned({path: target, bytes: String(observedSize), sha256: inventory[name]},
                MAX_FILE_BYTES, `${label} ${name}`);
        if (name === OPTIONAL_EMPTY_WAL && (bytes.length !== 0 || sha256(bytes) !== EMPTY_SHA256))
            throw new TypeError(`${label} optional WAL identity differs`);
        if (name !== MARKER_NAME && name !== TRANSIENT_SHARED_MEMORY) records.push({path: name, bytes: String(bytes.length), sha256: sha256(bytes),
            bytesBase64: bytes.toString("base64")});
    }
    return records;
}

export function buildWindowsBaselineGuestFixtureBundle(input) {
    exactKeys(input, ["manifest", "populatedRoot", "resetRoot", "sourceSha"], "baseline fixture input");
    exactString(input.sourceSha, SOURCE_PATTERN, "baseline fixture source SHA");
    const manifestBytes = readOwned(input.manifest, MAX_MANIFEST_BYTES, "baseline fixture manifest");
    let manifest;
    try { manifest = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(manifestBytes)); }
    catch { throw new TypeError("baseline fixture manifest is invalid UTF-8 JSON"); }
    exactKeys(manifest, ["expected", "populated", "reset", "schemaVersion", "source"],
        "baseline fixture manifest");
    if (manifest.schemaVersion !== SCHEMA_VERSION) throw new TypeError("baseline fixture manifest version differs");
    exactKeys(manifest.source, ["bunLockSha256", "commit", "packageSha256"], "baseline fixture source");
    if (manifest.source.commit !== input.sourceSha) throw new TypeError("baseline fixture source differs");
    exactString(manifest.source.bunLockSha256, SHA256_PATTERN, "baseline fixture Bun lock SHA");
    exactString(manifest.source.packageSha256, SHA256_PATTERN, "baseline fixture package SHA");
    exactKeys(manifest.expected, ["passwordValueSha256", "ping", "resultId"], "baseline fixture expected");
    if (manifest.expected.ping !== "123.456" || manifest.expected.resultId !== "qualification-seed-row")
        throw new TypeError("baseline fixture sentinel differs");
    exactString(manifest.expected.passwordValueSha256, SHA256_PATTERN, "baseline fixture password SHA");
    exactKeys(manifest.populated, ["databaseSha256", "filesSha256", "markerSha256", "nonce", "root"],
        "baseline populated transport");
    exactKeys(manifest.reset, ["filesSha256", "markerSha256", "nonce", "root"], "baseline reset transport");
    for (const [value, label] of [[manifest.populated, "baseline populated transport"],
        [manifest.reset, "baseline reset transport"]]) {
        exactString(value.nonce, NONCE_PATTERN, `${label} nonce`);
        exactString(value.root, /^[^\u0000-\u001f\u007f]{1,1024}$/u, `${label} producer root`);
        exactString(value.markerSha256, SHA256_PATTERN, `${label} marker SHA`);
    }
    exactString(manifest.populated.databaseSha256, SHA256_PATTERN, "baseline populated database SHA");
    const populated = validateInventory(manifest.populated.filesSha256, POPULATED_FILES,
        "baseline populated transport", true);
    const reset = validateInventory(manifest.reset.filesSha256, RESET_FILES, "baseline reset transport");
    if (populated.inventory[MARKER_NAME] !== manifest.populated.markerSha256 ||
        reset.inventory[MARKER_NAME] !== manifest.reset.markerSha256 ||
        populated.inventory["data/storage.db"] !== manifest.populated.databaseSha256)
        throw new TypeError("baseline fixture distinguished file identity differs");
    const populatedRoot = validateRoot(input.populatedRoot, "baseline populated transport");
    const resetRoot = validateRoot(input.resetRoot, "baseline reset transport");
    validateTreeShape(populatedRoot, [MARKER_NAME, ...populated.files], "baseline populated transport");
    validateTreeShape(resetRoot, [MARKER_NAME, ...reset.files], "baseline reset transport");
    const populatedFiles = readTree(populatedRoot, populated.files, populated.inventory,
        "baseline populated transport");
    const resetFiles = readTree(resetRoot, reset.files, reset.inventory, "baseline reset transport");
    const value = {schemaVersion: SCHEMA_VERSION, kind: BUNDLE_KIND, sourceSha: input.sourceSha,
        expected: structuredClone(manifest.expected), populated: {files: populatedFiles}, reset: {files: resetFiles}};
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    if (bytes.length < 2 || bytes.length > MAX_BUNDLE_BYTES)
        throw new TypeError("baseline fixture bundle size differs");
    return bytes;
}

export const WINDOWS_BASELINE_GUEST_FIXTURE_BUNDLE_CONSTANTS = Object.freeze({BUNDLE_KIND, COMMON_FILES,
    EMPTY_SHA256, MARKER_NAME, MAX_BUNDLE_BYTES, MAX_FILE_BYTES, MAX_MANIFEST_BYTES, OPTIONAL_EMPTY_WAL,
    POPULATED_FILES, RESET_FILES});
