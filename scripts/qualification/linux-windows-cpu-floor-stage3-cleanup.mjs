import fs from "node:fs";
import path from "node:path";

const SCHEMA_VERSION = 1;
const RECEIPT_KIND = "myspeed-windows-cpu-floor-cleanup-authority";
const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_PROCESS_ID = 0x7fff_ffff;
const DEFAULT_CLEANUP_MILLISECONDS = 5_000;
const DEFAULT_POLL_MILLISECONDS = 100;
const MAX_AUTHORITIES = 2;
const GROUP_OR_OTHER_PERMISSION_BITS = 0o077;
const START_TICKS = /^[1-9][0-9]{0,23}$/u;
const EXECUTABLE_PATH = /^\/[\x20-\x7e]{1,511}$/u;

const exactKeys = (value, expected, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
        throw new TypeError(`${label} schema differs`);
};

function validateAuthority(value) {
    exactKeys(value, ["executablePath", "pid", "processGroupId", "startTicks"], "cleanup authority");
    for (const name of ["pid", "processGroupId"]) {
        if (!Number.isInteger(value[name]) || value[name] < 1 || value[name] > MAX_PROCESS_ID)
            throw new TypeError(`cleanup authority ${name} is invalid`);
    }
    if (!START_TICKS.test(value.startTicks) || !EXECUTABLE_PATH.test(value.executablePath))
        throw new TypeError("cleanup authority process identity is invalid");
    return Object.freeze(structuredClone(value));
}

export function parseCpuFloorCleanupAuthorityReceipt(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_RECEIPT_BYTES)
        throw new TypeError("cleanup authority receipt size is invalid");
    let value;
    try {
        const text = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
        value = JSON.parse(text);
        if (!bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`, "utf8")))
            throw new Error("non-canonical");
    } catch { throw new TypeError("cleanup authority receipt encoding is invalid"); }
    exactKeys(value, ["authorities", "kind", "schemaVersion"], "cleanup authority receipt");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== RECEIPT_KIND ||
        !Array.isArray(value.authorities) || value.authorities.length > MAX_AUTHORITIES)
        throw new TypeError("cleanup authority receipt header is invalid");
    return Object.freeze({schemaVersion: SCHEMA_VERSION, kind: RECEIPT_KIND,
        authorities: Object.freeze(value.authorities.map(validateAuthority))});
}

export function readCpuFloorCleanupAuthorityReceipt(target, operations = {}) {
    if (typeof target !== "string" || !path.posix.isAbsolute(target) || path.posix.normalize(target) !== target)
        throw new TypeError("cleanup authority receipt path is invalid");
    const realpathParent = operations.realpathParent ?? (name => fs.realpathSync(name));
    if (realpathParent(path.posix.dirname(target)) !== path.posix.dirname(target))
        throw new TypeError("cleanup authority receipt parent is unsafe");
    const open = operations.open ?? (name => fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW));
    const fstat = operations.fstat ?? (descriptor => fs.fstatSync(descriptor, {bigint: true}));
    const read = operations.read ?? ((descriptor, size) => {
        const bytes = Buffer.alloc(size); const count = fs.readSync(descriptor, bytes, 0, size, 0);
        return bytes.subarray(0, count);
    });
    const close = operations.close ?? fs.closeSync;
    let descriptor;
    try {
        descriptor = open(target);
        const before = fstat(descriptor);
        if (!before.isFile() || before.isSymbolicLink?.() || before.nlink !== 1n ||
            before.uid !== BigInt(process.getuid?.() ?? -1) || (before.mode & BigInt(GROUP_OR_OTHER_PERMISSION_BITS)) !== 0n ||
            before.size < 2n ||
            before.size > BigInt(MAX_RECEIPT_BYTES)) throw new TypeError("cleanup authority receipt file is unsafe");
        const bytes = read(descriptor, Number(before.size) + 1);
        const after = fstat(descriptor);
        if (bytes.length !== Number(before.size) || after.dev !== before.dev || after.ino !== before.ino ||
            after.size !== before.size || after.mtimeNs !== before.mtimeNs)
            throw new TypeError("cleanup authority receipt changed while reading");
        return parseCpuFloorCleanupAuthorityReceipt(bytes);
    } finally { if (descriptor !== undefined) close(descriptor); }
}

const sameIdentity = (observed, authority) => observed?.state === "present" && observed.pid === authority.pid &&
    observed.processGroupId === authority.processGroupId && observed.startTicks === authority.startTicks &&
    observed.executablePath === authority.executablePath;

function defaultReadProcessIdentity(pid) {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        if (close < 1) throw new Error("process stat is invalid");
        const fields = stat.slice(close + 2).trim().split(/\s+/u);
        return {state: "present", pid, processGroupId: Number(fields[2]), startTicks: fields[19],
            executablePath: fs.realpathSync(`/proc/${pid}/exe`)};
    } catch (error) { if (error?.code === "ENOENT") return {state: "absent"}; throw error; }
}

export async function cleanupTaskOwnedCpuProcesses(input, operations = {}) {
    exactKeys(input, ["authorities", "deadlineMilliseconds"], "cleanup request");
    const io = {readProcessIdentity: operations.readProcessIdentity ?? defaultReadProcessIdentity,
        signalProcessGroup: operations.signalProcessGroup ?? ((group, signal) => process.kill(-group, signal)),
        isProcessGroupAlive: operations.isProcessGroupAlive ?? (group => {
            try { process.kill(-group, 0); return true; } catch (error) {
                if (error?.code === "ESRCH") return false; throw error;
            }
        }),
        monotonicMilliseconds: operations.monotonicMilliseconds ?? (() => performance.now()),
        wait: operations.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))};
    if (!Array.isArray(input.authorities) || input.authorities.length > MAX_AUTHORITIES)
        throw new TypeError("cleanup authorities are invalid");
    const authorities = input.authorities.map(validateAuthority);
    const duration = input.deadlineMilliseconds ?? DEFAULT_CLEANUP_MILLISECONDS;
    if (!Number.isInteger(duration) || duration < 0 || duration > DEFAULT_CLEANUP_MILLISECONDS)
        throw new TypeError("cleanup deadline is invalid");
    const started = io.monotonicMilliseconds();
    const deadline = started + duration;
    const escalationDeadline = started + Math.floor(duration / 2);
    const results = [];
    for (const authority of authorities) {
        if (authority.pid !== authority.processGroupId) {
            results.push({pid: authority.pid, status: "authority-mismatch", cleanupProven: false}); continue;
        }
        if (io.monotonicMilliseconds() >= deadline) {
            results.push({pid: authority.pid, status: "deadline-expired", cleanupProven: false}); continue;
        }
        let observed = await io.readProcessIdentity(authority.pid);
        if (observed?.state === "absent") { results.push({pid: authority.pid, status: "already-absent",
            cleanupProven: !await io.isProcessGroupAlive(authority.processGroupId)}); continue; }
        if (!sameIdentity(observed, authority)) { results.push({pid: authority.pid, status: "authority-mismatch",
            cleanupProven: false}); continue; }
        await io.signalProcessGroup(authority.processGroupId, "SIGTERM");
        let status = "term-sent";
        while (io.monotonicMilliseconds() < escalationDeadline) {
            observed = await io.readProcessIdentity(authority.pid);
            if (observed?.state === "absent") { status = "terminated"; break; }
            if (!sameIdentity(observed, authority)) { status = "identity-changed"; break; }
            await io.wait(Math.min(DEFAULT_POLL_MILLISECONDS,
                Math.max(0, escalationDeadline - io.monotonicMilliseconds())));
        }
        if (status === "term-sent") {
            observed = await io.readProcessIdentity(authority.pid);
            if (sameIdentity(observed, authority)) {
                await io.signalProcessGroup(authority.processGroupId, "SIGKILL");
                status = "kill-sent";
            } else status = observed?.state === "absent" ? "terminated" : "identity-changed";
        }
        let cleanupProven = false;
        while (io.monotonicMilliseconds() < deadline) {
            if (!await io.isProcessGroupAlive(authority.processGroupId)) { cleanupProven = true; break; }
            await io.wait(Math.min(DEFAULT_POLL_MILLISECONDS,
                Math.max(0, deadline - io.monotonicMilliseconds())));
        }
        results.push({pid: authority.pid, status, cleanupProven});
    }
    return Object.freeze({schemaVersion: SCHEMA_VERSION, status: "observed",
        cleanupProven: results.length > 0 && results.every(result => result.cleanupProven === true),
        results: Object.freeze(results)});
}

export const CPU_FLOOR_CLEANUP_CONSTANTS = Object.freeze({DEFAULT_CLEANUP_MILLISECONDS,
    DEFAULT_POLL_MILLISECONDS, MAX_AUTHORITIES, MAX_RECEIPT_BYTES, RECEIPT_KIND, SCHEMA_VERSION});
