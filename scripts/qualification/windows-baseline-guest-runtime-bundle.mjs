import crypto from "node:crypto";
import fs from "node:fs";

const SCHEMA_VERSION = 1;
const BUNDLE_KIND = "myspeed-windows-baseline-guest-runtime-bundle";
const MAX_RUNTIME_FILE_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_BUNDLE_BYTES = 16 * 1024 * 1024;
const RUNTIME_PATHS = Object.freeze([
    "scripts/qualification/windows-baseline-guest-executor.mjs",
    "scripts/qualification/windows-baseline-guest-runner.mjs",
    "scripts/qualification/windows-baseline-guest-composer.mjs",
    "scripts/qualification/windows-baseline-guest-operations.mjs",
    "scripts/qualification/windows-baseline-guest-runtime.mjs",
    "scripts/qualification/windows-baseline-guest-materializer.mjs",
    "scripts/qualification/windows-baseline-guest-candidate-wrapper.ps1",
    "scripts/qualification/windows-native-candidate-controller.ps1",
    "scripts/qualification/windows-clean-stop-controller.ps1",
    "scripts/qualification/check-artifact.mjs",
    "scripts/qualification/safety.mjs",
    "scripts/qualification/fixture.mjs",
    "scripts/qualification/sqlite-check.mjs"
]);

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
const decimal = (value, label) => {
    exactString(value, /^[1-9][0-9]*$/u, label);
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new TypeError(`${label} differs`);
    return number;
};

function readOwnedSource(identity, label) {
    exactKeys(identity, ["bytes", "path", "sha256"], `${label} identity`);
    const expectedBytes = decimal(identity.bytes, `${label} bytes`);
    if (expectedBytes > MAX_RUNTIME_FILE_BYTES) throw new TypeError(`${label} exceeds its byte bound`);
    exactString(identity.sha256, /^[0-9a-f]{64}$/u, `${label} SHA`);
    const handle = fs.openSync(identity.path, "r");
    try {
        const before = fs.fstatSync(handle, {bigint: true});
        const lexicalBefore = fs.lstatSync(identity.path, {bigint: true});
        if (!before.isFile() || !lexicalBefore.isFile() || lexicalBefore.isSymbolicLink() || before.nlink !== 1n ||
            before.dev !== lexicalBefore.dev || before.ino !== lexicalBefore.ino ||
            before.size !== BigInt(expectedBytes) || fs.realpathSync.native(identity.path) !== identity.path)
            throw new Error(`${label} physical identity differs`);
        const bytes = fs.readFileSync(handle);
        const after = fs.fstatSync(handle, {bigint: true});
        const lexicalAfter = fs.lstatSync(identity.path, {bigint: true});
        if (bytes.length !== expectedBytes || sha256(bytes) !== identity.sha256 || before.dev !== after.dev ||
            before.ino !== after.ino || before.size !== after.size || before.nlink !== after.nlink ||
            after.dev !== lexicalAfter.dev || after.ino !== lexicalAfter.ino || lexicalAfter.isSymbolicLink())
            throw new Error(`${label} content identity differs`);
        return bytes;
    } finally { fs.closeSync(handle); }
}

function decodeFile(value, expectedPath, label) {
    exactKeys(value, ["bytes", "bytesBase64", "path", "sha256"], label);
    if (value.path !== expectedPath) throw new TypeError(`${label} path differs`);
    const expectedBytes = decimal(value.bytes, `${label} bytes`);
    if (expectedBytes > MAX_RUNTIME_FILE_BYTES) throw new TypeError(`${label} exceeds its byte bound`);
    exactString(value.sha256, /^[0-9a-f]{64}$/u, `${label} SHA`);
    exactString(value.bytesBase64, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
        `${label} Base64`);
    const bytes = Buffer.from(value.bytesBase64, "base64");
    if (bytes.length !== expectedBytes || bytes.toString("base64") !== value.bytesBase64 ||
        sha256(bytes) !== value.sha256) throw new TypeError(`${label} content differs`);
    return {path: value.path, bytes: value.bytes, sha256: value.sha256, bytesBase64: value.bytesBase64};
}

function validateHeader(value, expected) {
    exactKeys(value, ["schemaVersion", "kind", "sourceSha", "nonce", "totalBytes", "files"],
        "baseline runtime bundle");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== BUNDLE_KIND)
        throw new TypeError("baseline runtime bundle header differs");
    exactString(value.sourceSha, /^[0-9a-f]{40}$/u, "baseline runtime source SHA");
    exactString(value.nonce, /^[0-9a-f]{32}$/u, "baseline runtime nonce");
    if (value.sourceSha !== expected.sourceSha || value.nonce !== expected.nonce)
        throw new TypeError("baseline runtime bundle context differs");
    if (!Array.isArray(value.files) || value.files.length !== RUNTIME_PATHS.length)
        throw new TypeError("baseline runtime inventory differs");
    const files = value.files.map((file, index) => decodeFile(file, RUNTIME_PATHS[index],
        `baseline runtime file ${index}`));
    const totalBytes = files.reduce((sum, file) => sum + Number(file.bytes), 0);
    if (totalBytes > MAX_RUNTIME_BUNDLE_BYTES || value.totalBytes !== String(totalBytes))
        throw new TypeError("baseline runtime byte total differs");
    return {schemaVersion: SCHEMA_VERSION, kind: BUNDLE_KIND, sourceSha: value.sourceSha, nonce: value.nonce,
        totalBytes: value.totalBytes, files};
}

export function validateWindowsBaselineGuestRuntimeBundle(bytes, expected) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_RUNTIME_BUNDLE_BYTES * 2)
        throw new TypeError("baseline runtime bundle bytes differ");
    let value;
    try { value = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)); }
    catch { throw new TypeError("baseline runtime bundle is not valid UTF-8 JSON"); }
    return validateHeader(value, expected);
}

export function buildWindowsBaselineGuestRuntimeBundle({sourceSha, nonce, files}) {
    exactString(sourceSha, /^[0-9a-f]{40}$/u, "baseline runtime source SHA");
    exactString(nonce, /^[0-9a-f]{32}$/u, "baseline runtime nonce");
    if (!Array.isArray(files) || files.length !== RUNTIME_PATHS.length ||
        JSON.stringify(files.map(file => file?.relativePath)) !== JSON.stringify(RUNTIME_PATHS))
        throw new TypeError("baseline runtime source inventory differs");
    const records = files.map((file, index) => {
        exactKeys(file, ["relativePath", "source"], `baseline runtime source ${index}`);
        const bytes = readOwnedSource(file.source, `baseline runtime source ${index}`);
        return {path: file.relativePath, bytes: String(bytes.length), sha256: sha256(bytes),
            bytesBase64: bytes.toString("base64")};
    });
    const totalBytes = records.reduce((sum, file) => sum + Number(file.bytes), 0);
    if (totalBytes > MAX_RUNTIME_BUNDLE_BYTES) throw new TypeError("baseline runtime byte total differs");
    const bytes = Buffer.from(`${JSON.stringify({schemaVersion: SCHEMA_VERSION, kind: BUNDLE_KIND, sourceSha,
        nonce, totalBytes: String(totalBytes), files: records})}\n`, "utf8");
    validateWindowsBaselineGuestRuntimeBundle(bytes, {sourceSha, nonce});
    return bytes;
}

export const WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS = Object.freeze({BUNDLE_KIND, MAX_RUNTIME_BUNDLE_BYTES,
    MAX_RUNTIME_FILE_BYTES, RUNTIME_PATHS});

