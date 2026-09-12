import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { once } from "node:events";

export const LOOPBACK_IPV4 = "127.0.0.1";
export const LOOPBACK_IPV6 = "::1";
export const MAX_PORT = 65_535;
export const PNG_WIDTH = 1_200;
export const PNG_HEIGHT = 600;
export const MIN_PNG_BYTES = 32;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_STOP_TIMEOUT_MS = 15_000;

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const TRANSIENT_PROC_EXIT_ERROR_CODES = new Set(["EACCES", "ENOENT"]);
const SAFE_ENVIRONMENT_KEYS = [
    "PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR", "TZ",
    "LANG", "LC_ALL", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"
];

const isLiteralLoopback = (host) => host === LOOPBACK_IPV4 || host === LOOPBACK_IPV6;

export const buildLocalOrigin = (host, port) => {
    if (!isLiteralLoopback(host) || net.isIP(host) === 0)
        throw new Error(`Verification host must be a literal loopback address, received "${host}"`);
    if (!Number.isInteger(port) || port < 1 || port > MAX_PORT)
        throw new Error(`Verification port must be an integer from 1 through ${MAX_PORT}`);

    return `http://${host === LOOPBACK_IPV6 ? `[${host}]` : host}:${port}`;
};

/**
 * The artifact receives an allowlist, not a copy of the runner environment.
 * Platform loader/search paths survive; application, database, proxy,
 * integration and credential settings do not cross the process boundary.
 */
export const sanitizedEnvironment = (source, {host, port, extra = {}}) => {
    buildLocalOrigin(host, port);
    const clean = {};

    for (const key of SAFE_ENVIRONMENT_KEYS)
        if (typeof source[key] === "string" && source[key] !== "") clean[key] = source[key];

    return {
        ...clean,
        ...extra,
        NODE_ENV: "production",
        DB_TYPE: "sqlite",
        SERVER_HOST: host,
        SERVER_PORT: String(port),
        RUN_TEST_ON_STARTUP: "false"
    };
};

const ipv6Key = (address) => {
    const halves = address.toLowerCase().split("::");
    if (halves.length > 2) return null;

    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;

    const groups = [...left, ...Array(missing).fill("0"), ...right];
    if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
    return groups.map((group) => group.padStart(4, "0")).join("");
};

const addressKey = (address) => {
    const unwrapped = String(address).replace(/^\[|]$/g, "").split("%")[0];
    if (net.isIP(unwrapped) === 4) return `v4:${unwrapped}`;
    if (net.isIP(unwrapped) === 6) return `v6:${ipv6Key(unwrapped)}`;
    return null;
};

const isWildcard = (address) => address === "*"
    || addressKey(address) === addressKey("0.0.0.0")
    || addressKey(address) === addressKey("::");

export const assertOwnedListener = ({listeners, host, port, pid}) => {
    buildLocalOrigin(host, port);
    if (!Number.isInteger(pid) || pid < 1) throw new Error("The launched process has no valid PID");

    const onPort = listeners.filter((listener) => Number(listener.port) === port);
    const wildcard = onPort.find((listener) => isWildcard(listener.address));
    if (wildcard) throw new Error(`Refusing wildcard listener ${wildcard.address}:${port}`);

    const expectedAddress = addressKey(host);
    const exact = onPort.filter((listener) => addressKey(listener.address) === expectedAddress);
    if (exact.length === 0) throw new Error(`The launched process is not listening on ${host}:${port}`);

    const owned = exact.find((listener) => Number(listener.pid) === pid);
    if (!owned) {
        const owners = exact.map((listener) => listener.pid ?? "unknown").join(", ");
        throw new Error(`${host}:${port} is not owned by PID ${pid} (reported owner: ${owners})`);
    }

    if (exact.some((listener) => Number(listener.pid) !== pid))
        throw new Error(`${host}:${port} has a foreign listener beside owned PID ${pid}`);

    return owned;
};

const decodeIpv4 = (hex) => Array.from(Buffer.from(hex, "hex")).reverse().join(".");

const decodeIpv6 = (hex) => {
    const bytes = [];
    for (let offset = 0; offset < hex.length; offset += 8)
        bytes.push(...Array.from(Buffer.from(hex.slice(offset, offset + 8), "hex")).reverse());

    const groups = [];
    for (let offset = 0; offset < bytes.length; offset += 2)
        groups.push(((bytes[offset] << 8) | bytes[offset + 1]).toString(16));
    return groups.join(":");
};

const ownedSocketInodes = (pid) => {
    const inodes = new Set();
    const directory = `/proc/${pid}/fd`;

    for (const entry of fs.readdirSync(directory)) {
        try {
            const target = fs.readlinkSync(`${directory}/${entry}`);
            const match = /^socket:\[(\d+)]$/.exec(target);
            if (match) inodes.add(match[1]);
        } catch {
            // A descriptor may close between listing and readlink. The next
            // ownership poll observes the stable set.
        }
    }

    return inodes;
};

const linuxListeners = (pid) => {
    const owned = ownedSocketInodes(pid);
    const listeners = [];
    const files = [
        {path: "/proc/net/tcp", decode: decodeIpv4},
        {path: "/proc/net/tcp6", decode: decodeIpv6}
    ];

    for (const source of files) {
        const lines = fs.readFileSync(source.path, "utf8").trim().split(/\r?\n/).slice(1);
        for (const line of lines) {
            const fields = line.trim().split(/\s+/);
            if (fields[3] !== "0A") continue;
            const [rawAddress, rawPort] = fields[1].split(":");
            const inode = fields[9];
            listeners.push({
                address: source.decode(rawAddress),
                port: Number.parseInt(rawPort, 16),
                pid: owned.has(inode) ? pid : null
            });
        }
    }

    return listeners;
};

const windowsListeners = () => {
    const output = execFileSync("netstat", ["-ano", "-p", "TCP"], {encoding: "utf8"});
    const listeners = [];

    for (const line of output.split(/\r?\n/)) {
        const match = /^\s*TCP\s+(\[[^\]]+]|[^:\s]+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
        if (!match) continue;
        listeners.push({address: match[1].replace(/^\[|]$/g, ""), port: Number(match[2]), pid: Number(match[3])});
    }

    return listeners;
};

const macListeners = (pid) => {
    const output = execFileSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-F", "pn"], {
        encoding: "utf8"
    });
    const listeners = [];

    for (const line of output.split(/\r?\n/)) {
        if (!line.startsWith("n")) continue;
        const endpoint = line.slice(1).split("->")[0];
        const match = /^(\[[^\]]+]|[^:]+):(\d+)$/.exec(endpoint);
        if (match) listeners.push({address: match[1].replace(/^\[|]$/g, ""), port: Number(match[2]), pid});
    }

    return listeners;
};

export const systemListeners = (pid, platform = process.platform) => {
    if (platform === "linux") return linuxListeners(pid);
    if (platform === "win32") return windowsListeners();
    if (platform === "darwin") return macListeners(pid);
    throw new Error(`Listener ownership inspection is unsupported on ${platform}`);
};

export const assertPortFree = async ({host, port, inspect = systemListeners}) => {
    buildLocalOrigin(host, port);
    const alreadyListening = inspect(process.pid).filter((listener) => Number(listener.port) === port);
    if (alreadyListening.length > 0)
        throw new Error(`Port ${port} is already occupied; no HTTP request was made`);

    const probe = net.createServer();
    await new Promise((resolve, reject) => {
        probe.once("error", reject);
        probe.listen({host, port, exclusive: true}, resolve);
    });
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
};

export const waitForOwnedListener = async ({child, host, port, timeoutMs, inspect = systemListeners,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), pollMs = 50}) => {
    const deadline = Date.now() + timeoutMs;
    let lastError = new Error(`The launched process is not listening on ${host}:${port}`);

    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(`The artifact exited before listening (code ${child.exitCode}, signal ${child.signalCode})`);

        try {
            return assertOwnedListener({listeners: inspect(child.pid), host, port, pid: child.pid});
        } catch (error) {
            if (/wildcard|not owned|foreign/i.test(error.message)) throw error;
            lastError = error;
        }

        await delay(pollMs);
    }

    throw new Error(`Timed out waiting for the owned listener: ${lastError.message}`);
};

export const waitForListenerFreeExit = async ({child, port, timeoutMs, inspect = systemListeners,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), pollMs = 10,
    waitForExit = waitForProcessExit}) => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;

        let opened;
        try {
            opened = inspect(child.pid).find((listener) => Number(listener.port) === port);
        } catch (error) {
            if (!TRANSIENT_PROC_EXIT_ERROR_CODES.has(error?.code)) throw error;

            const confirmationTimeoutMs = Math.min(pollMs, Math.max(0, deadline - Date.now()));
            const reaped = confirmationTimeoutMs > 0 && await waitForExit(child, confirmationTimeoutMs);
            if (reaped && (child.exitCode !== null || child.signalCode !== null)) return child.exitCode;
            throw error;
        }
        if (opened) throw new Error(`Listener-free process opened ${opened.address}:${port}`);
        await delay(pollMs);
    }

    throw new Error("Listener-free process did not exit before its deadline");
};

const safeRequestUrl = (origin, target) => {
    const parsedOrigin = new URL(origin);
    const hostname = parsedOrigin.hostname.replace(/^\[|]$/g, "");
    if (!isLiteralLoopback(hostname) || parsedOrigin.protocol !== "http:")
        throw new Error("Request origin must use HTTP on a literal loopback address");
    if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//"))
        throw new Error("Request target must be an origin-relative path beginning with one slash");

    const url = new URL(target, parsedOrigin);
    if (url.origin !== parsedOrigin.origin) throw new Error("Request target escaped the verified loopback origin");
    return url;
};

export const requestLocal = async (origin, target, {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    method = "GET",
    headers = {},
    body
} = {}) => {
    const url = safeRequestUrl(origin, target);
    const response = await fetchImpl(url, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs)
    });

    if (response.status >= 300 && response.status < 400)
        throw new Error(`Unexpected redirect from ${target}; Location was ${response.headers.get("location") ?? "absent"}`);

    const bytes = Buffer.from(await response.arrayBuffer());
    return {status: response.status, headers: response.headers, bytes, url: url.href};
};

export const checkJsonResponse = (response, expected) => {
    if (response.status !== 200) throw new Error(`Expected HTTP 200, received ${response.status}`);
    const body = response.body ?? JSON.parse(response.bytes.toString("utf8"));

    for (const [key, value] of Object.entries(expected))
        if (body[key] !== value) throw new Error(`Expected JSON ${key}=${JSON.stringify(value)}`);

    return body;
};

export const checkPng = (bytes) => {
    if (!Buffer.isBuffer(bytes) || bytes.length < MIN_PNG_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE))
        throw new Error("Response is not a nonempty PNG");
    if (bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("PNG has no leading IHDR chunk");

    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width !== PNG_WIDTH || height !== PNG_HEIGHT)
        throw new Error(`Expected a ${PNG_WIDTH}x${PNG_HEIGHT} PNG, received ${width}x${height}`);

    return {width, height, bytes: bytes.length};
};

export const assertLinuxNetworkIsolation = ({
    platform = process.platform,
    routeTable = platform === "linux" && process.platform === "linux"
        ? fs.readFileSync("/proc/net/route", "utf8") : "",
    ipv6RouteTable = platform === "linux" && process.platform === "linux"
        ? fs.readFileSync("/proc/net/ipv6_route", "utf8") : ""
} = {}) => {
    if (platform !== "linux")
        throw new Error(`This verifier cannot prove process-level outbound network denial on ${platform}`);

    const routes = routeTable.split(/\r?\n/).slice(1).map((line) => line.trim()).filter(Boolean);
    const external = routes.find((line) => line.split(/\s+/)[0] !== "lo");
    if (external) throw new Error(`Runtime network isolation has an outbound route: ${external}`);

    const externalIpv6 = ipv6RouteTable.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        .find((line) => line.split(/\s+/).at(-1) !== "lo");
    if (externalIpv6) throw new Error(`Runtime network isolation has an outbound IPv6 route: ${externalIpv6}`);
    return true;
};

export const assertOriginalBuildUnavailable = (root, access = fs.accessSync) => {
    if (!path.isAbsolute(root)) throw new Error("--original-build-root must be an absolute path");

    try {
        access(root, fs.constants.R_OK);
    } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "EACCES" || error?.code === "EPERM") return true;
        throw error;
    }

    throw new Error(`Original build root is still readable: ${root}`);
};

export const waitForProcessExit = async (child, timeoutMs) => {
    if (child.exitCode !== null || child.signalCode !== null) return true;

    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
    });
    const exited = once(child, "exit").then(() => true);
    const result = await Promise.race([exited, timeout]);
    clearTimeout(timer);
    return result;
};

export const stopOwnedProcess = async (child, {
    waitForExit = waitForProcessExit,
    gracefulTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    forcedTimeoutMs = DEFAULT_STOP_TIMEOUT_MS
} = {}) => {
    if (!child || !Number.isInteger(child.pid) || child.pid < 1)
        throw new Error("Cannot stop a process without its owned PID");
    if (child.exitCode !== null || child.signalCode !== null) return;

    child.kill("SIGTERM");
    if (await waitForExit(child, gracefulTimeoutMs)) return;

    child.kill("SIGKILL");
    if (await waitForExit(child, forcedTimeoutMs)) return;

    throw new Error(`Owned PID ${child.pid} is still running after forced teardown`);
};
