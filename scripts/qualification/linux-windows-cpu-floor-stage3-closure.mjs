// Trusted bootstrap: built-in imports only. Authenticate this file against the seal
// job's output before invoking it, then authenticate the entire tree before import.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {isDeepStrictEqual} from "node:util";

const SCHEMA_VERSION = 1;
const KIND = "myspeed-stage3-execution-closure";
const MANIFEST_NAME = "execution-closure.json";
const LAUNCHER = "scripts/qualification/linux-windows-cpu-floor-stage3-launcher.mjs";
const MAX_MEMBER_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SHA256 = /^[a-f0-9]{64}$/u;

export const STAGE3_EXECUTION_PATHS = Object.freeze([
    "scripts/qualification/linux-windows-cpu-floor-stage3-closure.mjs",
    LAUNCHER,
    "scripts/qualification/linux-windows-cpu-floor-stage3-cleanup.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage3-sequence.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage3-controller.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage3-hosted.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage3.mjs",
    "scripts/qualification/windows-baseline-guest-bootstrap.mjs",
    "scripts/qualification/windows-baseline-guest-fixture-bundle.mjs",
    "scripts/qualification/windows-baseline-guest-runtime-bundle.mjs",
    "scripts/qualification/windows-baseline-guest-seed-documents.mjs",
    "scripts/qualification/windows-cpu-floor-candidate-provenance.mjs",
    "scripts/release/prerelease-cpu-floor-target.mjs",
    "scripts/release/prerelease-cpu-floor.mjs",
    "scripts/release/prerelease-cpu-floor-hosted-inputs.mjs",
    "scripts/qualification/linux-windows-msi-lifecycle-host.mjs",
    "scripts/qualification/windows-msi-containment-preflight-host.mjs",
    "scripts/qualification/windows-msi-containment-preflight.mjs",
    "scripts/qualification/windows-msi-guest-bootstrap.mjs",
    "scripts/qualification/windows-msi-guest-containment-preflight-executor.mjs",
    "scripts/qualification/windows-msi-guest-lifecycle-evidence.mjs",
    "scripts/qualification/windows-msi-guest-matrix-executor.mjs",
    "scripts/qualification/windows-msi-guest-matrix-operations.mjs",
    "scripts/qualification/windows-msi-guest-matrix-row.mjs",
    "scripts/qualification/windows-msi-guest-seed-documents.mjs",
    "scripts/qualification/windows-msi-installed-base-hosted.mjs",
    "scripts/qualification/windows-msi-installed-base.mjs",
    "scripts/qualification/windows-msi-lifecycle-budget.mjs",
    "scripts/qualification/windows-msi-matrix-contract.mjs",
    "scripts/qualification/windows-msi-prerequisite-evidence.mjs",
    "scripts/qualification/windows-msi-scenario0-calibration.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage2-controller.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage2.mjs",
    "scripts/qualification/linux-windows-cpu-floor-admission.mjs",
    "scripts/qualification/linux-kvm-capability.mjs",
    "scripts/qualification/linux-kvm-privileged-capability.mjs",
    "scripts/qualification/windows-msi-post-setup-activation.mjs",
    "scripts/qualification/windows-msi-stage2-request.mjs",
    "scripts/qualification/safety.mjs",
    "scripts/release/post-release-cpu-floor.mjs",
    "scripts/release/post-release-cpu-floor-guest-preparation.mjs",
    "scripts/release/post-release-cpu-floor-hosted-inputs.mjs",
    "scripts/release/post-release-msi-acquisition.mjs",
    "scripts/release/post-release-msi-baseline-input-preparation.mjs",
    "scripts/release/post-release-msi-envelope.mjs",
    "scripts/release/post-release-msi-fixture-preparation.mjs",
    "scripts/release/post-release-msi-host-bridge.mjs",
    "scripts/release/post-release-msi-host-request.mjs",
    "scripts/release/post-release-msi-hosted-prepare.mjs",
    "scripts/release/post-release-msi-linux-controller.mjs",
    "scripts/release/post-release-msi-linux-fixture.mjs",
    "scripts/release/post-release-target.mjs",
    "tests/fixtures/post-release-native-v1.6.1/qualification-manifest.json",
    "tests/fixtures/post-release-native-v1.6.1/baseline-qualification-summary.json"
].sort());

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function exactKeys(value, keys, label) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) throw new Error(`${label} keys differ`);
}
function validateContext(context) {
    exactKeys(context, ["repository", "sourceSha", "runId", "runAttempt", "nonce"], "closure context");
    if (context.repository !== "i7Gamer/MySpeed" || !/^[a-f0-9]{40}$/u.test(context.sourceSha) ||
        !/^[a-f0-9]{32}$/u.test(context.nonce) ||
        [context.runId, context.runAttempt].some(value => typeof value !== "string" || !/^[1-9][0-9]{0,19}$/u.test(value)))
        throw new Error("closure context differs");
}
function readBounded(target, maximum) {
    const lexical = fs.lstatSync(target, {bigint: true});
    if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.nlink !== 1n ||
        lexical.size < 1n || lexical.size > BigInt(maximum) || fs.realpathSync.native(target) !== target)
        throw new Error("closure member physical identity differs");
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
        const before = fs.fstatSync(fd, {bigint: true});
        if (before.dev !== lexical.dev || before.ino !== lexical.ino || before.size !== lexical.size)
            throw new Error("closure member changed before reading");
        const bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
            const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (!count) throw new Error("closure member truncated");
            offset += count;
        }
        const trailing = fs.readSync(fd, Buffer.alloc(1), 0, 1, bytes.length);
        const after = fs.fstatSync(fd, {bigint: true});
        const current = fs.lstatSync(target, {bigint: true});
        if (trailing || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
            after.mtimeNs !== before.mtimeNs || current.dev !== before.dev || current.ino !== before.ino ||
            current.isSymbolicLink() || current.nlink !== 1n)
            throw new Error("closure member changed while reading");
        return bytes;
    } finally { fs.closeSync(fd); }
}
function inventory(root, relative = "") {
    const current = path.join(root, relative);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(current) !== current)
        throw new Error("closure inventory directory differs");
    return fs.readdirSync(current, {withFileTypes: true}).flatMap(entry => {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) return inventory(root, name);
        if (!entry.isFile()) throw new Error("closure inventory contains a non-file");
        return [name];
    }).sort();
}

export function sealStage3ExecutionClosure({sourceRoot, outputRoot, context}) {
    validateContext(context);
    if (!path.isAbsolute(outputRoot) || path.basename(outputRoot) !== `myspeed-stage3-closure-${context.nonce}` ||
        fs.existsSync(outputRoot)) throw new Error("closure output is not fresh");
    const files = STAGE3_EXECUTION_PATHS.map(name => {
        const bytes = readBounded(path.join(sourceRoot, name), MAX_MEMBER_BYTES);
        return {name, bytes: bytes.length, sha256: sha256(bytes), content: bytes};
    });
    fs.mkdirSync(outputRoot, {mode: DIRECTORY_MODE});
    for (const record of files) {
        const target = path.join(outputRoot, record.name);
        fs.mkdirSync(path.dirname(target), {recursive: true, mode: DIRECTORY_MODE});
        fs.writeFileSync(target, record.content, {flag: "wx", mode: FILE_MODE});
    }
    const manifest = {schemaVersion: SCHEMA_VERSION, kind: KIND, context: structuredClone(context),
        files: files.map(({name, bytes, sha256: digest}) => ({name, bytes, sha256: digest}))};
    const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    fs.writeFileSync(path.join(outputRoot, MANIFEST_NAME), bytes, {flag: "wx", mode: FILE_MODE});
    const manifestSha256 = sha256(bytes);
    verifyStage3ExecutionClosure({root: outputRoot, context, manifestSha256});
    return {manifestSha256, bootstrapSha256: manifest.files.find(record =>
        record.name.endsWith("/linux-windows-cpu-floor-stage3-closure.mjs")).sha256};
}

export function verifyStage3ExecutionClosure({root, context, manifestSha256}) {
    validateContext(context);
    if (typeof root !== "string" || !path.isAbsolute(root) ||
        path.basename(root) !== `myspeed-stage3-closure-${context.nonce}` || !SHA256.test(manifestSha256))
        throw new Error("closure root or manifest digest differs");
    const observedNames = inventory(root);
    if (!isDeepStrictEqual(observedNames, [...STAGE3_EXECUTION_PATHS, MANIFEST_NAME].sort()))
        throw new Error("closure inventory differs");
    const bytes = readBounded(path.join(root, MANIFEST_NAME), MAX_MANIFEST_BYTES);
    if (sha256(bytes) !== manifestSha256) throw new Error("closure manifest digest differs");
    const manifest = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
    exactKeys(manifest, ["schemaVersion", "kind", "context", "files"], "closure manifest");
    if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.kind !== KIND ||
        !isDeepStrictEqual(manifest.context, context)) throw new Error("closure context differs");
    if (!Array.isArray(manifest.files) || manifest.files.length !== STAGE3_EXECUTION_PATHS.length)
        throw new Error("closure member count differs");
    manifest.files.forEach((record, index) => {
        exactKeys(record, ["name", "bytes", "sha256"], "closure member");
        if (record.name !== STAGE3_EXECUTION_PATHS[index] || !Number.isSafeInteger(record.bytes) ||
            record.bytes < 1 || record.bytes > MAX_MEMBER_BYTES || !SHA256.test(record.sha256))
            throw new Error("closure member declaration differs");
        const content = readBounded(path.join(root, record.name), MAX_MEMBER_BYTES);
        if (content.length !== record.bytes || sha256(content) !== record.sha256)
            throw new Error(`closure member content differs: ${record.name}`);
    });
    return manifest;
}

export async function loadVerifiedStage3Launcher(options) {
    verifyStage3ExecutionClosure(options);
    return import(pathToFileURL(path.join(options.root, LAUNCHER)).href);
}
