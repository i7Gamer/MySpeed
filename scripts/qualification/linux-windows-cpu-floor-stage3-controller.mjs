import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {deriveActualHostedContext} from "./linux-windows-cpu-floor-stage2-controller.mjs";
import {createHostedStage3Operations} from "./linux-windows-cpu-floor-stage3-hosted.mjs";
import {runWindowsCpuFloorStage3, validateCompletedStage3Result} from "./linux-windows-cpu-floor-stage3.mjs";

const SCHEMA_VERSION = 1;
const REQUEST_KIND = "myspeed-windows-cpu-floor-stage3-controller-request";
const SUCCESS_EXIT_CODE = 0;
const FAILURE_EXIT_CODE = 1;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_CLOSURE_FILE_BYTES = 4 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const NONCE_PATTERN = /^[0-9a-f]{32}$/u;
const CLOSURE_PATHS = Object.freeze([
    "scripts/qualification/linux-windows-cpu-floor-stage3-controller.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage3-hosted.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage3.mjs",
    "scripts/qualification/windows-baseline-guest-bootstrap.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage2-controller.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage2.mjs",
    "scripts/qualification/linux-windows-cpu-floor-admission.mjs",
    "scripts/qualification/linux-kvm-capability.mjs",
    "scripts/qualification/linux-kvm-privileged-capability.mjs",
    "scripts/qualification/windows-msi-post-setup-activation.mjs",
    "scripts/qualification/safety.mjs"
]);

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, expected, label) => {
    if (!isObject(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
        throw new TypeError(`${label} schema differs`);
};

function readVerified(target, maximumBytes) {
    const handle = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const before = fs.fstatSync(handle, {bigint: true});
        const lexical = fs.lstatSync(target, {bigint: true});
        const canonical = fs.realpathSync(`/proc/self/fd/${handle}`);
        if (!before.isFile() || !lexical.isFile() || lexical.isSymbolicLink() || before.nlink !== 1n ||
            before.dev !== lexical.dev || before.ino !== lexical.ino || before.size < 1n ||
            before.size > BigInt(maximumBytes) || canonical !== target) throw new Error("verified input identity differs");
        const bytes = fs.readFileSync(handle); const after = fs.fstatSync(handle, {bigint: true});
        if (BigInt(bytes.length) !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
            before.size !== after.size || before.nlink !== after.nlink) throw new Error("verified input changed");
        return {path: canonical, bytes, sha256: sha256(bytes)};
    } finally { fs.closeSync(handle); }
}

function validateIdentity(value, expectedPath, label) {
    exactKeys(value, ["bytes", "path", "sha256"], label);
    if (value.path !== expectedPath || typeof value.bytes !== "string" || !/^[1-9][0-9]*$/u.test(value.bytes) ||
        !SHA256_PATTERN.test(value.sha256)) throw new TypeError(`${label} differs`);
    return structuredClone(value);
}

function validateEnvelope(value, actualContext) {
    exactKeys(value, ["closure", "context", "guestFiles", "kind", "schemaVersion", "stage3"],
        "Stage 3 controller request");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== REQUEST_KIND ||
        JSON.stringify(value.context) !== JSON.stringify(actualContext) ||
        JSON.stringify(value.stage3?.context) !== JSON.stringify(actualContext))
        throw new TypeError("Stage 3 controller context differs");
    exactKeys(value.closure, ["files", "root"], "Stage 3 controller closure");
    const expectedRoot = `/home/runner/work/_temp/myspeed-stage3-closure-${actualContext.nonce}`;
    if (value.closure.root !== expectedRoot || !Array.isArray(value.closure.files) ||
        value.closure.files.length !== CLOSURE_PATHS.length) throw new TypeError("Stage 3 controller closure differs");
    const files = value.closure.files.map((record, index) => validateIdentity(record,
        `${expectedRoot}/${CLOSURE_PATHS[index]}`, `Stage 3 closure file ${index}`));
    if (!Array.isArray(value.guestFiles)) throw new TypeError("Stage 3 guest closure differs");
    return {closure: {root: expectedRoot, files}, guestFiles: structuredClone(value.guestFiles),
        stage3: structuredClone(value.stage3)};
}

export async function runHostedStage3Controller(value, dependencies = {}) {
    const nonce = value?.context?.nonce;
    if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) throw new TypeError("Stage 3 nonce differs");
    const actualContext = (dependencies.deriveActualContext ?? deriveActualHostedContext)(nonce);
    const checked = validateEnvelope(value, actualContext);
    const read = dependencies.readVerified ?? readVerified;
    for (const member of checked.closure.files) {
        const observed = read(member.path, MAX_CLOSURE_FILE_BYTES);
        if (String(observed.bytes.length) !== member.bytes || observed.sha256 !== member.sha256)
            throw new Error("Stage 3 closure file content differs");
    }
    const operations = dependencies.operations ?? (dependencies.createOperations ?? createHostedStage3Operations)({
        context: actualContext, paths: checked.stage3.paths, guestFiles: checked.guestFiles,
        dependencies: dependencies.native});
    const result = await (dependencies.runStage3 ?? runWindowsCpuFloorStage3)(checked.stage3, operations);
    if (result?.status === "observed") {
        const retained = read(checked.stage3.stage2.result.path, MAX_EVIDENCE_BYTES);
        if (String(retained.bytes.length) !== checked.stage3.stage2.result.bytes ||
            retained.sha256 !== checked.stage3.stage2.result.sha256)
            throw new Error("Stage 3 retained Stage 2 result differs");
        (dependencies.validateCompleted ?? validateCompletedStage3Result)(result, checked.stage3, retained.bytes);
    }
    return result;
}

function writeExclusive(target, value) {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    if (bytes.length < 2 || bytes.length > MAX_EVIDENCE_BYTES) throw new Error("Stage 3 result size differs");
    fs.writeFileSync(target, bytes, {flag: "wx", mode: 0o600});
}

function parseArguments(argv) {
    const names = ["--nonce", "--request", "--request-sha256", "--result"];
    if (argv.length !== names.length * 2) throw new TypeError("Stage 3 controller arguments differ");
    const values = {};
    for (const [index, name] of names.entries()) {
        if (argv[index * 2] !== name) throw new TypeError("Stage 3 controller arguments differ");
        values[name] = argv[index * 2 + 1];
    }
    if (!NONCE_PATTERN.test(values["--nonce"]) || !SHA256_PATTERN.test(values["--request-sha256"]))
        throw new TypeError("Stage 3 controller argument identity differs");
    const root = `/home/runner/work/_temp/myspeed-stage3-envelope-${values["--nonce"]}`;
    if (values["--request"] !== `${root}/request.json` || values["--result"] !== `${root}/result.json`)
        throw new TypeError("Stage 3 controller argument path differs");
    return {nonce: values["--nonce"], request: values["--request"],
        requestSha256: values["--request-sha256"], result: values["--result"]};
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const actualContext = deriveActualHostedContext(options.nonce);
    const loaded = readVerified(options.request, MAX_REQUEST_BYTES);
    if (loaded.sha256 !== options.requestSha256) throw new Error("Stage 3 request content differs");
    const request = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(loaded.bytes));
    if (JSON.stringify(request?.context) !== JSON.stringify(actualContext))
        throw new Error("Stage 3 request actual context differs");
    const result = await runHostedStage3Controller(request, {deriveActualContext: () => actualContext});
    writeExclusive(options.result, result);
    if (result.status !== "observed") process.exitCode = FAILURE_EXIT_CODE;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = FAILURE_EXIT_CODE; });
}

export const STAGE3_CONTROLLER_CONSTANTS = Object.freeze({CLOSURE_PATHS, FAILURE_EXIT_CODE, MAX_EVIDENCE_BYTES,
    MAX_REQUEST_BYTES, REQUEST_KIND, SUCCESS_EXIT_CODE});
