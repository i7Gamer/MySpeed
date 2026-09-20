import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA_VERSION = 1;
const BUNDLE_KIND = "myspeed-windows-baseline-fixture-bundle";
const OWNERSHIP_KIND = "myspeed-windows-baseline-owned-root";
const OWNERSHIP_MARKER = ".myspeed-baseline-owned.json";
const CONTROLLER_NAME = "windows-clean-stop-controller.ps1";
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 512 * 1024 * 1024;
const MAX_CONTROLLER_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_OWNED_ENTRIES = 1_024;
const MAX_OWNED_DEPTH = 16;
const MAX_OWNED_BYTES = 1024 * 1024 * 1024;
const EXPECTED_PING = "123.456";
const EXPECTED_RESULT_ID = "qualification-seed-row";
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
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

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

function readExactFile(identity, maximumBytes, label) {
    exactKeys(identity, ["bytes", "path", "sha256"], `${label} identity`);
    const expectedBytes = decimal(identity.bytes, `${label} bytes`);
    if (expectedBytes > maximumBytes) throw new TypeError(`${label} exceeds its byte bound`);
    exactString(identity.sha256, /^[0-9a-f]{64}$/u, `${label} SHA`);
    const handle = fs.openSync(identity.path, "r");
    try {
        const before = fs.fstatSync(handle, {bigint: true});
        const lexical = fs.lstatSync(identity.path, {bigint: true});
        const canonical = fs.realpathSync.native(identity.path);
        if (!before.isFile() || !lexical.isFile() || lexical.isSymbolicLink() || before.nlink !== 1n ||
            before.dev !== lexical.dev || before.ino !== lexical.ino || before.size !== BigInt(expectedBytes) ||
            canonical !== identity.path) throw new Error(`${label} physical identity differs`);
        const bytes = fs.readFileSync(handle);
        const after = fs.fstatSync(handle, {bigint: true});
        if (bytes.length !== expectedBytes || sha256(bytes) !== identity.sha256 || before.dev !== after.dev ||
            before.ino !== after.ino || before.size !== after.size || before.nlink !== after.nlink)
            throw new Error(`${label} content identity differs`);
        return bytes;
    } finally { fs.closeSync(handle); }
}

function decodeRecord(value, expectedPath, label) {
    exactKeys(value, ["bytes", "bytesBase64", "path", "sha256"], label);
    if (value.path !== expectedPath) throw new TypeError(`${label} path differs`);
    const isEmptyWal = expectedPath === OPTIONAL_EMPTY_WAL && value.bytes === "0";
    const size = isEmptyWal ? 0 : decimal(value.bytes, `${label} bytes`);
    if (size > MAX_FILE_BYTES) throw new TypeError(`${label} exceeds its byte bound`);
    exactString(value.sha256, /^[0-9a-f]{64}$/u, `${label} SHA`);
    exactString(value.bytesBase64, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
        `${label} Base64`);
    const bytes = Buffer.from(value.bytesBase64, "base64");
    if (bytes.length !== size || bytes.toString("base64") !== value.bytesBase64 || sha256(bytes) !== value.sha256 ||
        (isEmptyWal && value.sha256 !== EMPTY_SHA256))
        throw new TypeError(`${label} content differs`);
    return {path: value.path, bytes};
}

function validateTree(value, expectedNames, label) {
    exactKeys(value, ["files"], label);
    const actualNames = Array.isArray(value.files) ? value.files.map(file => file?.path) : [];
    const permittedNames = label.includes("populated") && actualNames.includes(OPTIONAL_EMPTY_WAL)
        ? [...expectedNames, OPTIONAL_EMPTY_WAL].sort() : expectedNames;
    if (!Array.isArray(value.files) || value.files.length !== permittedNames.length ||
        JSON.stringify(actualNames) !== JSON.stringify(permittedNames))
        throw new TypeError(`${label} inventory differs`);
    return value.files.map((file, index) => decodeRecord(file, permittedNames[index], `${label} file`));
}

function validateBundle(bytes, request) {
    let value;
    try { value = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)); }
    catch { throw new TypeError("baseline fixture bundle is not valid UTF-8 JSON"); }
    exactKeys(value, ["schemaVersion", "kind", "sourceSha", "expected", "populated", "reset"],
        "baseline fixture bundle");
    // The bundle is stamped with the candidate source SHA. Validate against the SHA the request
    // carries, never the harness context SHA - for a published release those are different commits
    // and using the harness one rejected every real bundle (run 35285135433); for a branch build
    // they are the same commit, so the rule is stated as "use the candidate's" either way.
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== BUNDLE_KIND ||
        value.sourceSha !== request.candidate.sourceSha) throw new TypeError("baseline fixture bundle identity differs");
    exactKeys(value.expected, ["passwordValueSha256", "ping", "resultId"], "baseline fixture expectation");
    if (value.expected.ping !== EXPECTED_PING || value.expected.resultId !== EXPECTED_RESULT_ID)
        throw new TypeError("baseline fixture sentinels differ");
    exactString(value.expected.passwordValueSha256, /^[0-9a-f]{64}$/u,
        "baseline fixture password fingerprint");
    return {expected: structuredClone(value.expected),
        populated: validateTree(value.populated, POPULATED_FILES, "baseline populated fixture"),
        reset: validateTree(value.reset, RESET_FILES, "baseline reset fixture")};
}

function assertDirectChild(root, candidate, name) {
    if (path.dirname(candidate).toLowerCase() !== root.toLowerCase() || path.basename(candidate) !== name)
        throw new TypeError(`baseline ${name} path differs`);
}

function writeExclusive(target, bytes) {
    const handle = fs.openSync(target, "wx+");
    try {
        fs.writeFileSync(handle, bytes); fs.fsyncSync(handle);
        const stat = fs.fstatSync(handle, {bigint: true});
        const observed = Buffer.alloc(bytes.length);
        let offset = 0;
        while (offset < observed.length) {
            const count = fs.readSync(handle, observed, offset, observed.length - offset, offset);
            if (count < 1) throw new Error("baseline materialized file read was truncated");
            offset += count;
        }
        if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(bytes.length) ||
            !observed.equals(bytes)) throw new Error("baseline materialized file differs");
    } finally { fs.closeSync(handle); }
}

function createTree(root, records) {
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(root, "bin"));
    fs.mkdirSync(path.join(root, "data"));
    fs.mkdirSync(path.join(root, "data", "servers"));
    for (const record of records) writeExclusive(path.join(root, ...record.path.split("/")), record.bytes);
}

function expectedMarker(request) {
    return {schemaVersion: SCHEMA_VERSION, kind: OWNERSHIP_KIND, nonce: request.context.nonce,
        sourceSha: request.context.sourceSha, root: request.paths.taskRoot};
}

const expectedMarkerBytes = request => Buffer.from(`${JSON.stringify(expectedMarker(request))}\n`);

function assertOwnedTree(root) {
    let entries = 0;
    let bytes = 0n;
    const visit = (target, depth) => {
        entries += 1;
        if (entries > MAX_OWNED_ENTRIES || depth > MAX_OWNED_DEPTH)
            throw new Error("baseline owned tree exceeds its structural bound");
        const stat = fs.lstatSync(target, {bigint: true});
        if (stat.isSymbolicLink()) throw new Error("baseline owned tree contains a link");
        if (stat.isDirectory()) {
            for (const name of fs.readdirSync(target)) visit(path.join(target, name), depth + 1);
        } else if (!stat.isFile() || stat.nlink !== 1n) {
            throw new Error("baseline owned tree contains a special or linked file");
        } else bytes += stat.size;
        if (bytes > BigInt(MAX_OWNED_BYTES)) throw new Error("baseline owned tree exceeds its byte bound");
    };
    visit(root, 0);
}

export async function materializeWindowsBaselineGuestFixture({request, execution, dependencies = {}}) {
    if (!isObject(request) || !isObject(request.context) || !isObject(request.paths) ||
        !isObject(request.candidate) || !Array.isArray(request.scenarios))
        throw new TypeError("baseline materializer request differs");
    // Guarded here so validateBundle's identity comparison can never pass on two absent values.
    exactString(request.candidate.sourceSha, /^[0-9a-f]{40}$/u, "baseline candidate source SHA");
    const root = path.resolve(request.paths.taskRoot);
    if (root !== request.paths.taskRoot || fs.existsSync(root)) throw new Error("baseline task root is not fresh");
    assertDirectChild(root, request.candidate.path, "MySpeed.exe");
    assertDirectChild(root, request.paths.populatedWork, "populated");
    assertDirectChild(root, request.paths.resetWork, "reset");
    if (!isObject(execution) || !isObject(execution.candidateSource) || !isObject(execution.cleanStopController) ||
        !isObject(execution.fixtureBundle)) throw new TypeError("baseline materializer execution differs");
    const candidateBytes = readExactFile(execution.candidateSource, MAX_CANDIDATE_BYTES, "baseline candidate source");
    if (execution.candidateSource.bytes !== request.candidate.bytes ||
        execution.candidateSource.sha256 !== request.candidate.sha256)
        throw new TypeError("baseline candidate source binding differs");
    const controllerBytes = readExactFile(execution.cleanStopController, MAX_CONTROLLER_BYTES,
        "baseline clean-stop controller");
    const bundleBytes = readExactFile(execution.fixtureBundle, MAX_BUNDLE_BYTES, "baseline fixture bundle");
    const bundle = validateBundle(bundleBytes, request);
    if (typeof dependencies.checkPopulatedDatabase !== "function")
        throw new TypeError("baseline database observer is absent");

    fs.mkdirSync(root);
    writeExclusive(path.join(root, OWNERSHIP_MARKER), expectedMarkerBytes(request));
    writeExclusive(request.candidate.path, candidateBytes);
    writeExclusive(path.join(root, CONTROLLER_NAME), controllerBytes);
    createTree(request.paths.populatedWork, bundle.populated);
    createTree(request.paths.resetWork, bundle.reset);
    for (const entry of request.scenarios) {
        exactKeys(entry, ["port", "scenario"], "baseline scenario");
        fs.mkdirSync(path.join(root, `session-${entry.scenario}`));
    }
    const initialDatabase = await dependencies.checkPopulatedDatabase(
        path.join(request.paths.populatedWork, "data", "storage.db"), bundle.expected);
    return {expected: bundle.expected, initialDatabase};
}

export function cleanupWindowsBaselineGuestFixture({request, sessions}) {
    if (!Array.isArray(sessions)) throw new TypeError("baseline cleanup sessions differ");
    // A session is removed only after the shared controller result and listener absence have both been validated.
    // Any retained session is therefore an unresolved candidate-tree obligation, even if the controller exited.
    if (sessions.length !== 0) return {cleanupProven: false};
    const root = request.paths.taskRoot;
    const markerPath = path.join(root, OWNERSHIP_MARKER);
    let marker;
    try {
        const handle = fs.openSync(markerPath, "r");
        try {
            const stat = fs.fstatSync(handle);
            if (!stat.isFile() || stat.size !== expectedMarkerBytes(request).length)
                return {cleanupProven: false};
            marker = fs.readFileSync(handle);
        } finally { fs.closeSync(handle); }
    }
    catch { return {cleanupProven: false}; }
    if (!marker.equals(expectedMarkerBytes(request))) return {cleanupProven: false};
    try {
        assertOwnedTree(root);
        fs.rmSync(root, {recursive: true, force: false});
        return {cleanupProven: !fs.existsSync(root)};
    } catch { return {cleanupProven: false}; }
}

export const WINDOWS_BASELINE_GUEST_MATERIALIZER_CONSTANTS = Object.freeze({BUNDLE_KIND, MAX_BUNDLE_BYTES,
    EMPTY_SHA256, OPTIONAL_EMPTY_WAL, OWNERSHIP_KIND, OWNERSHIP_MARKER, POPULATED_FILES, RESET_FILES});

