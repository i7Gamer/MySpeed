import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {deriveActualHostedContext, runHostedStage2Controller} from
    "./linux-windows-cpu-floor-stage2-controller.mjs";
import {runHostedStage3Controller, STAGE3_CONTROLLER_CONSTANTS} from "./linux-windows-cpu-floor-stage3-controller.mjs";

const SCHEMA_VERSION = 1;
const SEQUENCE_KIND = "myspeed-windows-cpu-floor-stage3-sequence";
const CONTROLLER_REQUEST_KIND = "myspeed-windows-cpu-floor-stage3-controller-request";
const STAGE2_RESULT_NAME = "stage2-result.json";
const GUEST_RESULT_NAME = "guest-result.json";
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_CLOSURE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FAILURE_CHARACTERS = 512;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const NONCE_PATTERN = /^[0-9a-f]{32}$/u;

const SEQUENCE_CLOSURE_PATHS = Object.freeze([
    "scripts/qualification/linux-windows-cpu-floor-stage3-sequence.mjs",
    ...STAGE3_CONTROLLER_CONSTANTS.CLOSURE_PATHS
]);

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const exactKeys = (value, expected, label) => {
    if (!isObject(value) || !same(Object.keys(value).sort(), [...expected].sort()))
        throw new TypeError(`${label} schema differs`);
};

function readVerifiedClosureFile(target, maximumBytes) {
    const lexical = fs.lstatSync(target, {bigint: true});
    if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.size < 1n ||
        lexical.size > BigInt(maximumBytes)) throw new Error("closure file identity differs");
    const bytes = fs.readFileSync(target);
    return {bytes, identity: {path: target, bytes: String(bytes.length), sha256: sha256(bytes)}};
}

function readOwned(target, maximumBytes) {
    const lexical = fs.lstatSync(target, {bigint: true});
    if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.nlink !== 1n || lexical.size < 1n ||
        lexical.size > BigInt(maximumBytes)) throw new Error("retained Stage 2 evidence identity differs");
    const handle = fs.openSync(target, fs.constants.O_RDONLY);
    try {
        const before = fs.fstatSync(handle, {bigint: true});
        const canonical = fs.realpathSync.native(target);
        if (!before.isFile() || before.nlink !== 1n || before.dev !== lexical.dev || before.ino !== lexical.ino ||
            before.size !== lexical.size || canonical !== target)
            throw new Error("retained Stage 2 evidence physical identity differs");
        const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
        while (offset < bytes.length) {
            const count = fs.readSync(handle, bytes, offset, bytes.length - offset, offset);
            if (count < 1) throw new Error("retained Stage 2 evidence read was truncated");
            offset += count;
        }
        const trailing = Buffer.alloc(1);
        const trailingCount = fs.readSync(handle, trailing, 0, trailing.length, bytes.length);
        const after = fs.fstatSync(handle, {bigint: true});
        if (trailingCount !== 0 || before.dev !== after.dev || before.ino !== after.ino ||
            before.size !== after.size || before.nlink !== after.nlink)
            throw new Error("retained Stage 2 evidence changed while reading");
        return {bytes, identity: {path: canonical, bytes: String(bytes.length), sha256: sha256(bytes)}};
    } finally { fs.closeSync(handle); }
}

function writeExclusive(target, bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_EVIDENCE_BYTES)
        throw new Error("retained Stage 2 evidence size differs");
    const handle = fs.openSync(target, "wx+", FILE_MODE);
    try {
        let offset = 0;
        while (offset < bytes.length) {
            const count = fs.writeSync(handle, bytes, offset, bytes.length - offset, offset);
            if (count < 1) throw new Error("retained Stage 2 evidence write did not progress");
            offset += count;
        }
        fs.fsyncSync(handle);
        const before = fs.fstatSync(handle, {bigint: true});
        const observed = Buffer.alloc(bytes.length); offset = 0;
        while (offset < observed.length) {
            const count = fs.readSync(handle, observed, offset, observed.length - offset, offset);
            if (count < 1) throw new Error("retained Stage 2 evidence reread was truncated");
            offset += count;
        }
        const after = fs.fstatSync(handle, {bigint: true});
        const lexical = fs.lstatSync(target, {bigint: true});
        if (!before.isFile() || before.nlink !== 1n || !lexical.isFile() || lexical.isSymbolicLink() ||
            before.dev !== lexical.dev || before.ino !== lexical.ino || before.dev !== after.dev ||
            before.ino !== after.ino || before.size !== after.size || before.size !== BigInt(bytes.length) ||
            !observed.equals(bytes) || fs.realpathSync.native(target) !== target)
            throw new Error("retained Stage 2 evidence output identity differs");
    } finally { fs.closeSync(handle); }
    return {path: target, bytes: String(bytes.length), sha256: sha256(bytes)};
}

export function validateSequence(value, actualContext) {
    exactKeys(value, ["closure", "context", "guestFiles", "kind", "schemaVersion", "stage2Request", "stage3",
        "transportRoot"], "Stage 3 sequence");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== SEQUENCE_KIND || !same(value.context, actualContext) ||
        !same(value.stage2Request?.context, actualContext) || !same(value.stage3?.context, actualContext) ||
        value.stage3?.profile !== "baseline-cpu" || !isObject(value.closure) || !Array.isArray(value.guestFiles))
        throw new TypeError("Stage 3 sequence context differs");
    exactKeys(value.closure, ["files", "root"], "Stage 3 sequence closure");
    if (typeof value.closure.root !== "string" ||
        path.basename(value.closure.root) !== `myspeed-stage3-closure-${actualContext.nonce}` ||
        !Array.isArray(value.closure.files) ||
        value.closure.files.length !== SEQUENCE_CLOSURE_PATHS.length)
        throw new TypeError("Stage 3 sequence closure differs");
    const files = value.closure.files.map((record, index) => {
        exactKeys(record, ["bytes", "path", "sha256"], `Stage 3 sequence closure file ${index}`);
        const expectedRel = SEQUENCE_CLOSURE_PATHS[index];
        const normalizedMemberPath = path.resolve(record.path);
        const expectedPath = path.resolve(value.closure.root, expectedRel);
        if (normalizedMemberPath !== expectedPath || typeof record.bytes !== "string" ||
            !/^[1-9][0-9]*$/u.test(record.bytes) || !SHA256_PATTERN.test(record.sha256))
            throw new TypeError(`Stage 3 sequence closure file ${index} differs`);
        return structuredClone(record);
    });
    if (typeof value.transportRoot !== "string" || path.resolve(value.transportRoot) !== value.transportRoot ||
        path.basename(value.transportRoot) !== `myspeed-stage2-transport-${actualContext.nonce}`)
        throw new TypeError("Stage 3 sequence transport differs");
    const transport = fs.lstatSync(value.transportRoot);
    if (!transport.isDirectory() || transport.isSymbolicLink() ||
        fs.realpathSync.native(value.transportRoot) !== value.transportRoot || fs.readdirSync(value.transportRoot).length !== 0)
        throw new Error("Stage 3 sequence transport is not fresh");
    const stage2Root = value.stage2Request?.paths?.root;
    if (typeof stage2Root !== "string" || path.basename(stage2Root) !==
        `myspeed-windows-cpu-floor-${actualContext.nonce}`)
        throw new TypeError("Stage 3 sequence Stage 2 root differs");
    return {...structuredClone(value), closure: {root: value.closure.root, files}};
}

export async function runHostedStage3Sequence(value, dependencies = {}) {
    const nonce = value?.context?.nonce;
    if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) throw new TypeError("Stage 3 sequence nonce differs");
    const actualContext = (dependencies.deriveActualContext ?? deriveActualHostedContext)(nonce);
    const checked = validateSequence(value, actualContext);

    // Verify all 14 closure files before invoking Stage 2
    const readClosure = dependencies.readVerifiedClosure ?? readVerifiedClosureFile;
    for (const member of checked.closure.files) {
        let observed;
        try {
            observed = readClosure(member.path, MAX_CLOSURE_FILE_BYTES);
        } catch (err) {
            throw new Error(`Stage 3 sequence closure file read failed: ${err.message}`);
        }
        if (String(observed.bytes.length) !== member.bytes || observed.identity.sha256 !== member.sha256)
            throw new Error("Stage 3 sequence closure file content differs");
    }

    const runStage2 = dependencies.runStage2 ?? runHostedStage2Controller;
    const runStage3 = dependencies.runStage3 ?? runHostedStage3Controller;
    const stage2 = await runStage2(checked.stage2Request);
    if (stage2?.status !== "observed" || stage2.cleanupProven !== true || stage2.cpuCalibrationAccepted !== true)
        throw new Error("Stage 2 did not produce accepted calibration evidence");
    const stage2Bytes = Buffer.from(`${JSON.stringify(stage2)}\n`, "utf8");
    const stage2Identity = writeExclusive(path.join(checked.transportRoot, STAGE2_RESULT_NAME), stage2Bytes);
    const rawSource = path.join(checked.stage2Request.paths.root, GUEST_RESULT_NAME);
    const raw = (dependencies.readOwned ?? readOwned)(rawSource, MAX_EVIDENCE_BYTES);
    const guestIdentity = writeExclusive(path.join(checked.transportRoot, GUEST_RESULT_NAME), raw.bytes);
    if (guestIdentity.sha256 !== raw.identity.sha256 || guestIdentity.bytes !== raw.identity.bytes)
        throw new Error("retained Stage 2 raw guest copy differs");
    const stage3 = {...checked.stage3, stage2: {result: stage2Identity, guestResult: guestIdentity}};

    // Filter to the 13 members required by the Stage 3 controller closure
    const controllerClosureFiles = checked.closure.files.filter(f =>
        !f.path.replace(/\\/g, "/").endsWith("linux-windows-cpu-floor-stage3-sequence.mjs"));

    const envelope = {schemaVersion: SCHEMA_VERSION, kind: CONTROLLER_REQUEST_KIND, context: actualContext,
        closure: {root: checked.closure.root, files: controllerClosureFiles},
        guestFiles: checked.guestFiles, stage3};
    return await runStage3(envelope);
}

export function parseStage3SequenceArguments(argv) {
    const names = ["--nonce", "--request", "--request-sha256", "--result"];
    if (!Array.isArray(argv) || argv.length !== names.length * 2)
        throw new TypeError("Stage 3 sequence arguments differ");
    const values = {};
    for (const [index, name] of names.entries()) {
        if (argv[index * 2] !== name) throw new TypeError("Stage 3 sequence arguments differ");
        values[name] = argv[index * 2 + 1];
    }
    if (!NONCE_PATTERN.test(values["--nonce"]) || !SHA256_PATTERN.test(values["--request-sha256"]))
        throw new TypeError("Stage 3 sequence argument identity differs");
    const root = `/home/runner/work/_temp/myspeed-stage3-sequence-envelope-${values["--nonce"]}`;
    if (values["--request"] !== `${root}/request.json` || values["--result"] !== `${root}/result.json`)
        throw new TypeError("Stage 3 sequence argument path differs");
    return {nonce: values["--nonce"], request: values["--request"], requestSha256: values["--request-sha256"],
        result: values["--result"]};
}

async function main() {
    const options = parseStage3SequenceArguments(process.argv.slice(2));
    const actualContext = deriveActualHostedContext(options.nonce);
    const loaded = readOwned(options.request, MAX_EVIDENCE_BYTES);
    if (loaded.identity.sha256 !== options.requestSha256)
        throw new Error("Stage 3 sequence request identity differs");
    let request;
    try { request = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(loaded.bytes)); }
    catch { throw new TypeError("Stage 3 sequence request is invalid UTF-8 JSON"); }
    if (!same(request?.context, actualContext)) throw new Error("Stage 3 sequence actual context differs");
    const result = await runHostedStage3Sequence(request, {deriveActualContext: () => actualContext});
    writeExclusive(options.result, Buffer.from(`${JSON.stringify(result)}\n`, "utf8"));
    if (result?.status !== "observed") process.exitCode = 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { const message = (error instanceof Error ? error.message : String(error))
        .replace(/[\x00-\x1f\x7f]+/gu, " ").slice(0, MAX_FAILURE_CHARACTERS) || "unspecified failure";
    process.stderr.write(`${message}\n`); process.exitCode = 1; });
}

export const STAGE3_SEQUENCE_CONSTANTS = Object.freeze({CONTROLLER_REQUEST_KIND, DIRECTORY_MODE, FILE_MODE,
    GUEST_RESULT_NAME, MAX_EVIDENCE_BYTES, MAX_FAILURE_CHARACTERS, SEQUENCE_CLOSURE_PATHS, SEQUENCE_KIND,
    SHA256_PATTERN, STAGE2_RESULT_NAME});
