/*
 * The guest entrypoint for the containment preflight.
 *
 * `windows-msi-guest-runner.ps1` is generic over the module it runs: it reads the launch request,
 * invokes `node <runner> --request <document> --request-sha256 <digest>`, and captures the semantic
 * output beside its own launcher receipt. So the preflight needs no new PowerShell - it is another
 * runner behind the same launcher, driving the containment helper that rows eleven to fourteen
 * already use, once, before any of them.
 *
 * The order is the point. The guest proves it is the guest this run created, installs the IFEO
 * interception against the authentic 1.6.0 default MSI, and confirms the interception is actually
 * active before anything could start the old payload. Only then does it read the raw launch history
 * and take the containment away again.
 *
 * The helper reports the digest it took over its own listing, once per call. Two such values
 * agreeing with each other bind nothing - any common value would pass, and the history retained
 * beside them would never be compared with either. So the inventory is recomputed here, in the
 * helper's own canonical form, from the records this executor actually read, and both proofs have to
 * equal it. What is retained is the identity of each record, not its bytes.
 *
 * Two counts are kept apart and never renamed into each other. A `containment-launch-*.json` record
 * is the IFEO *stub* having run in place of the old payload: a blocked attempt. The helper's
 * `oldPayloadExecutionCount` is what it says. A record that claims it was not intercepted, or a
 * helper reporting an execution, fails the preflight rather than being counted as containment.
 *
 * Nothing is fabricated when something goes wrong: a helper failure is preserved as it was thrown,
 * an empty launch history is retained as an empty history, and there is no path that writes a
 * calibration for work that did not happen.
 */
import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const SCHEMA_VERSION = 1;
const REQUEST_KIND = "myspeed-windows-msi-guest-containment-preflight-request";
const ENVELOPE_KIND = "myspeed-windows-msi-guest-containment-preflight-envelope";
const CALIBRATION_KIND = "myspeed-windows-msi-guest-containment-calibration";
const LAUNCH_KIND = "myspeed-windows-msi-guest-containment-launch";
const BINDING_ID = "authentic-1.6.0-default-msi";
const MODES = Object.freeze(["Install", "Remove"]);

const MAX_INPUT_BYTES = 1_048_576;
const MAX_RESULT_BYTES = 65_536;
const MAX_LAUNCH_RECORDS = 256;
const MAX_LAUNCH_RECORD_BYTES = 4_096;
const MAX_PATH_CHARACTERS = 1024;
const MAX_MSI_BYTES = 1_073_741_824;
const SUCCESS_EXIT = 0;

const SHA256 = /^[0-9a-f]{64}$/u;
const SHA1 = /^[0-9a-f]{40}$/u;
const NONCE = /^[0-9a-f]{32}$/u;
const DECIMAL = /^[1-9][0-9]{0,19}$/u;
const ATTEMPT = /^[1-9][0-9]{0,9}$/u;
const PRODUCT_CODE = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/u;
const WINDOWS_PATH = /^[A-Za-z]:\\[^\0<>|?*"]{0,1000}$/u;
/*
 * The helper enumerates exactly `containment-launch-<nonce>-*.json`, so this has to enumerate the same
 * set or the recomputed inventory could never equal the helper's. Binding the nonce into the name
 * also keeps a record another run left behind out of this run's history. The nonce is 32 hex
 * characters by the time it reaches here, so it carries nothing a pattern could misread.
 */
const launchRecordNamePattern = nonce =>
    new RegExp(`^containment-launch-${nonce}-[0-9A-Za-z-]{1,64}\\.json$`, "u");

export const WINDOWS_MSI_GUEST_PREFLIGHT_CONSTANTS = Object.freeze({
    requestKind: REQUEST_KIND, envelopeKind: ENVELOPE_KIND, calibrationKind: CALIBRATION_KIND,
    launchKind: LAUNCH_KIND, bindingId: BINDING_ID, modes: MODES,
    maximumLaunchRecords: MAX_LAUNCH_RECORDS, maximumResultBytes: MAX_RESULT_BYTES,
    maximumInputBytes: MAX_INPUT_BYTES
});

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

const exactKeys = (value, keys, label) => {
    if (!isObject(value)) throw new Error(`${label} differs`);
    const actual = Object.keys(value).sort();
    const wanted = [...keys].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
        throw new Error(`${label} differs`);
    return value;
};

const exactString = (value, label, pattern) => {
    if (typeof value !== "string" || value.length < 1 || value.length > MAX_PATH_CHARACTERS)
        throw new Error(`${label} differs`);
    const match = pattern.exec(value);
    if (!match || match.index !== 0 || match[0].length !== value.length)
        throw new Error(`${label} differs`);
    return value;
};

const integerIn = (value, label, minimum, maximum) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new Error(`${label} differs`);
    return value;
};

const bool = (value, wanted, label) => {
    if (typeof value !== "boolean" || value !== wanted) throw new Error(`${label} differs`);
    return value;
};

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

/*
 * The helper's own canonical form: the ordered {name,bytes,sha256} tuples, compressed JSON, UTF-8
 * without a BOM. An empty history canonicalizes to the empty list rather than to nothing at all.
 */
export const canonicalizeWindowsMsiGuestLaunchInventory = records =>
    Buffer.from(JSON.stringify(records.map(record =>
        ({name: record.name, bytes: Number(record.bytes), sha256: record.sha256}))), "utf8");

const descendant = (root, candidate, label) => {
    exactString(candidate, label, WINDOWS_PATH);
    if (!candidate.toLowerCase().startsWith(`${root.toLowerCase()}\\`) || candidate.includes(".."))
        throw new Error(`${label} differs`);
    return candidate;
};

export const validateWindowsMsiGuestPreflightRequest = value => {
    const label = "MSI guest preflight request";
    exactKeys(value, ["schemaVersion", "kind", "qualifying", "sourceSha", "eventSha", "runId",
        "runAttempt", "nonce", "bindingId", "guest", "msi", "helper", "tools", "limits",
        "releaseGatesCleared"], label);
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== REQUEST_KIND)
        throw new Error(`${label} identity differs`);
    bool(value.qualifying, false, `${label} qualifying flag`);
    if (!Array.isArray(value.releaseGatesCleared) || value.releaseGatesCleared.length !== 0)
        throw new Error(`${label} cleared gates differ`);
    if (value.bindingId !== BINDING_ID) throw new Error(`${label} binding differs`);
    exactString(value.sourceSha, `${label} source SHA`, SHA1);
    exactString(value.eventSha, `${label} event SHA`, SHA1);
    exactString(value.runId, `${label} run`, DECIMAL);
    exactString(value.runAttempt, `${label} attempt`, ATTEMPT);
    exactString(value.nonce, `${label} nonce`, NONCE);
    exactKeys(value.guest, ["serial", "cpuEvidenceSha256", "qemuLaunchSha256", "seedRoot",
        "outputRoot"], `${label} guest`);
    exactString(value.guest.serial, `${label} guest serial`, NONCE);
    exactString(value.guest.cpuEvidenceSha256, `${label} guest CPU evidence`, SHA256);
    exactString(value.guest.qemuLaunchSha256, `${label} guest QEMU launch`, SHA256);
    const seedRoot = exactString(value.guest.seedRoot, `${label} seed root`, WINDOWS_PATH);
    const outputRoot = exactString(value.guest.outputRoot, `${label} output root`, WINDOWS_PATH);
    if (seedRoot.toLowerCase() === outputRoot.toLowerCase())
        throw new Error(`${label} roots collide`);
    /* Both executables are read from the seed tree; neither may be the writable evidence tree. */
    exactKeys(value.msi, ["path", "bytes", "sha256", "productCode"], `${label} MSI`);
    descendant(seedRoot, value.msi.path, `${label} MSI path`);
    integerIn(value.msi.bytes, `${label} MSI size`, 1, MAX_MSI_BYTES);
    exactString(value.msi.sha256, `${label} MSI digest`, SHA256);
    exactString(value.msi.productCode, `${label} MSI product code`, PRODUCT_CODE);
    exactKeys(value.helper, ["path", "bytes", "sha256"], `${label} helper`);
    descendant(seedRoot, value.helper.path, `${label} helper path`);
    integerIn(value.helper.bytes, `${label} helper size`, 1, MAX_INPUT_BYTES);
    exactString(value.helper.sha256, `${label} helper digest`, SHA256);
    exactKeys(value.tools, ["powershell"], `${label} tools`);
    exactKeys(value.tools.powershell, ["path", "sha256"], `${label} PowerShell`);
    exactString(value.tools.powershell.path, `${label} PowerShell path`, WINDOWS_PATH);
    exactString(value.tools.powershell.sha256, `${label} PowerShell digest`, SHA256);
    exactKeys(value.limits, ["launchRecords", "resultBytes"], `${label} limits`);
    integerIn(value.limits.launchRecords, `${label} launch record bound`, 0, MAX_LAUNCH_RECORDS);
    integerIn(value.limits.resultBytes, `${label} result bound`, 1, MAX_RESULT_BYTES);
    return value;
};

export const validateWindowsMsiGuestPreflightEnvelope = value => {
    const label = "MSI guest preflight envelope";
    exactKeys(value, ["schemaVersion", "kind", "qualifying", "sourceSha", "eventSha", "runId",
        "runAttempt", "nonce", "seedRoot", "outputRoot", "preflightRequest", "resultPath", "limits"],
    label);
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== ENVELOPE_KIND)
        throw new Error(`${label} identity differs`);
    bool(value.qualifying, false, `${label} qualifying flag`);
    exactString(value.sourceSha, `${label} source SHA`, SHA1);
    exactString(value.eventSha, `${label} event SHA`, SHA1);
    exactString(value.runId, `${label} run`, DECIMAL);
    exactString(value.runAttempt, `${label} attempt`, ATTEMPT);
    exactString(value.nonce, `${label} nonce`, NONCE);
    const seedRoot = exactString(value.seedRoot, `${label} seed root`, WINDOWS_PATH);
    const outputRoot = exactString(value.outputRoot, `${label} output root`, WINDOWS_PATH);
    if (seedRoot.toLowerCase() === outputRoot.toLowerCase()) throw new Error(`${label} roots collide`);
    exactKeys(value.preflightRequest, ["path", "bytes", "sha256"], `${label} request binding`);
    descendant(seedRoot, value.preflightRequest.path, `${label} request path`);
    exactKeys(value.limits, ["inputBytes", "resultBytes"], `${label} limits`);
    integerIn(value.limits.inputBytes, `${label} input bound`, 1, MAX_INPUT_BYTES);
    integerIn(value.preflightRequest.bytes, `${label} request size`, 1, value.limits.inputBytes);
    exactString(value.preflightRequest.sha256, `${label} request digest`, SHA256);
    integerIn(value.limits.resultBytes, `${label} result bound`, 1, MAX_RESULT_BYTES);
    /* The result is written into the evidence tree, never back into the read-only seed tree. */
    descendant(outputRoot, value.resultPath, `${label} result path`);
    return value;
};

/*
 * The helper's own declared parameters. The identities come from the request the host bound, so the
 * guest cannot name a different MSI, a different product or a different helper than the one whose
 * digest the host took from independently observed evidence.
 */
export const createWindowsMsiGuestPreflightArguments = (request, mode) => {
    if (!MODES.includes(mode)) throw new Error("MSI guest preflight mode differs");
    return ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", request.helper.path, "-Mode", mode,
        "-ProductCode", request.msi.productCode, "-MsiPath", request.msi.path,
        "-MsiSha256", request.msi.sha256, "-EvidenceRoot", request.guest.outputRoot,
        "-Nonce", request.nonce, "-ExpectedSerial", request.guest.serial,
        "-HelperSha256", request.helper.sha256];
};

const assertProof = (value, mode, request) => {
    const label = `MSI guest preflight ${mode.toLowerCase()} containment proof`;
    exactKeys(value, ["status", "mode", "productCode", "ifeoActive", "oldPayloadExecutionCount",
        "registryRestored", "launchInventorySha256"], label);
    if (value.status !== "completed" || value.mode !== mode
        || value.productCode !== request.msi.productCode)
        throw new Error(`${label} differs`);
    bool(value.ifeoActive, mode === "Install", `${label} interception`);
    bool(value.registryRestored, mode === "Remove", `${label} registry state`);
    exactString(value.launchInventorySha256, `${label} launch inventory`, SHA256);
    /*
     * The helper's own execution count. It is never replaced by, or compared with, the number of
     * blocked launch attempts - those are a different thing entirely.
     */
    if (value.oldPayloadExecutionCount !== 0)
        throw new Error(`${label} reports an old-payload execution`);
    return value;
};

const readLaunchHistory = (records, request) => {
    if (!Array.isArray(records) || records.length > request.limits.launchRecords)
        throw new Error("MSI guest preflight launch history exceeds its bound");
    const namePattern = launchRecordNamePattern(request.nonce);
    const seen = new Set();
    return records.map(entry => {
        exactKeys(entry, ["name", "bytes"], "MSI guest preflight launch record");
        exactString(entry.name, "MSI guest preflight launch record name", namePattern);
        if (!Buffer.isBuffer(entry.bytes) || entry.bytes.length < 1
            || entry.bytes.length > MAX_LAUNCH_RECORD_BYTES)
            throw new Error("MSI guest preflight launch record differs");
        let parsed;
        try { parsed = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(entry.bytes)); }
        catch { throw new Error("MSI guest preflight launch record differs"); }
        exactKeys(parsed, ["schemaVersion", "kind", "nonce", "processId", "intercepted"],
            "MSI guest preflight launch record");
        if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.kind !== LAUNCH_KIND
            || parsed.nonce !== request.nonce)
            throw new Error("MSI guest preflight launch record identity differs");
        integerIn(parsed.processId, "MSI guest preflight launch record process", 1, Number.MAX_SAFE_INTEGER);
        /*
         * `intercepted: false` is the stub reporting that it did not stand in for the old payload,
         * which is the old payload having executed. It is a failure, never a count to rename.
         */
        bool(parsed.intercepted, true, "MSI guest preflight launch record interception");
        if (seen.has(entry.name)) throw new Error("MSI guest preflight launch record is duplicated");
        seen.add(entry.name);
        return {schemaVersion: SCHEMA_VERSION, kind: LAUNCH_KIND, name: entry.name,
            bytes: String(entry.bytes.length), sha256: sha256(entry.bytes),
            processId: parsed.processId, intercepted: true};
    });
};

const defaultOperationsFactory = ({request}) => {
    const run = async (command, argv) => {
        const {spawn} = await import("node:child_process");
        return await new Promise((resolve, reject) => {
            const child = spawn(command, argv, {stdio: ["ignore", "pipe", "pipe"], windowsHide: true});
            const out = []; const err = [];
            child.stdout.on("data", part => out.push(part));
            child.stderr.on("data", part => err.push(part));
            child.on("error", reject);
            child.on("close", code => resolve({code, stdout: Buffer.concat(out),
                stderr: Buffer.concat(err)}));
        });
    };
    return {
        boundary: async () => {
            const completed = await run(request.tools.powershell.path, ["-NoLogo", "-NoProfile",
                "-NonInteractive", "-Command",
                "$bios=Get-CimInstance Win32_BIOS -ErrorAction Stop;"
                + "@{serial=[string]$bios.SerialNumber}|ConvertTo-Json -Compress"]);
            if (completed.code !== SUCCESS_EXIT) throw new Error("MSI guest preflight boundary failed");
            return JSON.parse(completed.stdout.toString("utf8"));
        },
        containment: async mode => {
            const completed = await run(request.tools.powershell.path,
                createWindowsMsiGuestPreflightArguments(request, mode));
            if (completed.code !== SUCCESS_EXIT)
                throw new Error("MSI guest containment helper failed");
            return JSON.parse(completed.stdout.toString("utf8"));
        },
        listLaunchRecords: async () => fs.readdirSync(request.guest.outputRoot, {withFileTypes: true})
            .filter(entry => entry.isFile()
                && launchRecordNamePattern(request.nonce).test(entry.name))
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(entry => ({name: entry.name,
                bytes: fs.readFileSync(path.win32.join(request.guest.outputRoot, entry.name))}))
    };
};

export const executeWindowsMsiGuestPreflightEnvelope = async (input, {
    readBoundFile,
    writeCreateNew,
    operationsFactory = defaultOperationsFactory
} = {}) => {
    const envelope = validateWindowsMsiGuestPreflightEnvelope(input);
    const bytes = await readBoundFile(envelope.preflightRequest);
    if (!Buffer.isBuffer(bytes) || bytes.length !== envelope.preflightRequest.bytes
        || sha256(bytes) !== envelope.preflightRequest.sha256)
        throw new Error("MSI guest preflight request identity differs");
    let parsed;
    try { parsed = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)); }
    catch { throw new Error("MSI guest preflight request identity differs"); }
    const request = validateWindowsMsiGuestPreflightRequest(parsed);
    for (const [name, expected] of Object.entries({sourceSha: envelope.sourceSha,
        eventSha: envelope.eventSha, runId: envelope.runId, runAttempt: envelope.runAttempt,
        nonce: envelope.nonce}))
        if (request[name] !== expected)
            throw new Error(`MSI guest preflight request ${name} differs from its envelope`);
    if (request.guest.seedRoot.toLowerCase() !== envelope.seedRoot.toLowerCase()
        || request.guest.outputRoot.toLowerCase() !== envelope.outputRoot.toLowerCase())
        throw new Error("MSI guest preflight envelope roots differ");
    const operations = operationsFactory({request, envelope});
    /* First: this has to be the guest this run created, or nothing else here means anything. */
    const boundary = await operations.boundary();
    if (!isObject(boundary) || boundary.serial !== request.guest.serial)
        throw new Error("MSI guest preflight guest identity differs");
    const install = assertProof(await operations.containment("Install"), "Install", request);
    /*
     * Containment authority, proven before the history is even read: the interception has to be
     * active. `assertProof` already requires it for Install, and this says out loud that nothing
     * below may run if it is not.
     */
    if (install.ifeoActive !== true)
        throw new Error("MSI guest preflight has no containment authority");
    const launchRecords = readLaunchHistory(await operations.listLaunchRecords(), request);
    /*
     * The helper takes its inventory digest at each call, over its own listing. Recomputing that
     * digest from the records read here is what binds the retained history to the one the helper
     * hashed: a value the two calls merely share is a claim about nothing.
     */
    const inventorySha256 = sha256(canonicalizeWindowsMsiGuestLaunchInventory(launchRecords));
    if (install.launchInventorySha256 !== inventorySha256)
        throw new Error("MSI guest preflight launch inventory differs from the records it read");
    const remove = assertProof(await operations.containment("Remove"), "Remove", request);
    /*
     * A different digest at Remove means something was launched under the containment after the
     * history above was read, so the history retained here would not be the complete one.
     */
    if (remove.launchInventorySha256 !== inventorySha256)
        throw new Error("MSI guest preflight launch inventory changed while contained");
    const calibration = {schemaVersion: SCHEMA_VERSION, kind: CALIBRATION_KIND, qualifying: false,
        releaseGatesCleared: [], bindingId: BINDING_ID, productCode: request.msi.productCode,
        msiSha256: request.msi.sha256, helperSha256: request.helper.sha256,
        guestSerial: request.guest.serial, nonce: request.nonce, launchRecords,
        install, remove};
    const resultBytes = Buffer.from(JSON.stringify(calibration), "utf8");
    if (resultBytes.length < 1 || resultBytes.length > envelope.limits.resultBytes)
        throw new Error("MSI guest preflight result exceeds its bound");
    await writeCreateNew(envelope.resultPath, resultBytes);
    return {calibration, identity: {path: envelope.resultPath, bytes: resultBytes.length,
        sha256: sha256(resultBytes)}};
};

const readBoundFile = async binding => {
    const handle = fs.openSync(binding.path, fs.constants.O_RDONLY);
    try {
        const facts = fs.fstatSync(handle);
        if (!facts.isFile() || facts.size !== binding.bytes)
            throw new Error("MSI guest preflight bound file differs");
        const bytes = Buffer.allocUnsafe(facts.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = fs.readSync(handle, bytes, offset, bytes.length - offset, offset);
            if (count <= 0) throw new Error("MSI guest preflight bound read was truncated");
            offset += count;
        }
        return bytes;
    } finally { fs.closeSync(handle); }
};

const writeCreateNew = async (target, bytes) => {
    const handle = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT
        | fs.constants.O_EXCL, 0o600);
    try { fs.writeFileSync(handle, bytes); fs.fsyncSync(handle); }
    finally { fs.closeSync(handle); }
};

const cli = async () => {
    const argv = process.argv.slice(2);
    if (argv.length !== 4 || argv[0] !== "--request" || argv[2] !== "--request-sha256")
        throw new Error("MSI guest preflight arguments differ");
    const bytes = fs.readFileSync(argv[1]);
    if (bytes.length > MAX_INPUT_BYTES || sha256(bytes) !== argv[3])
        throw new Error("MSI guest preflight envelope identity differs");
    await executeWindowsMsiGuestPreflightEnvelope(
        JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)),
        {readBoundFile, writeCreateNew});
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    cli().catch(error => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
