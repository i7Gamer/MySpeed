import {createHash} from "node:crypto";
import {isIP} from "node:net";
import tls from "node:tls";
import {Readable} from "node:stream";
// Bun intercepts the bare "undici" specifier with an incomplete built-in shim.
// Its public package entry selects the pinned implementation on every runtime.
import {Agent, Pool, ProxyAgent, buildConnector, request} from "undici/index.js";
import {BlockedAddressError, checkOutboundTarget, outboundLookup} from "./safeUrl.js";

const HTTPS_DEFAULT_PORT = "443";
const CONNECT_SUCCESS = 200;
const IPV6_FAMILY = 6;
const MAX_IDLE_HTTPS_DISPATCHERS = 16;
const HTTPS_DISPATCHER_IDLE_MS = 5000;
const idle = new Map();

/** Bun 1.3.14 routing, evaluated before replacing the target with a numeric IP. */
export const httpsProxyRoute = (target, env = process.env) => {
    const configured = env.https_proxy || env.HTTPS_PROXY;
    if (!configured) return undefined;
    const hostname = target.hostname.toLowerCase();
    const authorities = [hostname, `${hostname}:${target.port || HTTPS_DEFAULT_PORT}`];
    const bypass = (env.no_proxy || env.NO_PROXY || "").split(",").some((entry) => {
        let pattern = entry.trim().toLowerCase();
        if (pattern === "*") return true;
        if (pattern.startsWith(".")) pattern = pattern.slice(1);
        return pattern !== "" && authorities.some(value => value === pattern || value.endsWith(`.${pattern}`));
    });
    if (bypass) return null;
    try {
        const proxy = new URL(configured.includes("://") ? configured : `http://${configured}`);
        if (proxy.protocol === "http:" || proxy.protocol === "https:") return proxy;
    } catch { /* Keep proxy credentials out of configuration errors. */ }
    throw new Error("Invalid HTTPS proxy configuration");
};

const abortReason = signal => signal?.reason instanceof Error ? signal.reason : new Error("Request aborted");

const ownSocket = (lease, socket) => {
    socket.on("error", () => undefined);
    if (lease.destroyed) {
        socket.destroy(abortReason(lease.owner?.signal));
        return;
    }
    if (lease.sockets.has(socket)) return;
    lease.sockets.add(socket);
    socket.once("close", () => lease.sockets.delete(socket));
};

const destroy = (lease) => {
    if (!lease || lease.destroyed) return;
    lease.destroyed = true;
    clearTimeout(lease.timer);
    if (idle.get(lease.key) === lease) idle.delete(lease.key);
    // Undici cannot destroy a TLS socket it has not received from its connector
    // yet. Own the raw CONNECT (or direct connecting) socket from its creation.
    for (const socket of lease.sockets) socket.destroy(new Error("HTTPS connection closed"));
    // Destruction is asynchronous; failure must not escape a late stream event.
    lease.agent.destroy().catch(() => undefined);
};

const release = (lease) => {
    if (lease.destroyed) return;
    destroy(idle.get(lease.key));
    idle.set(lease.key, lease);
    lease.timer = setTimeout(() => destroy(lease), HTTPS_DISPATCHER_IDLE_MS);
    lease.timer.unref();
    while (idle.size > MAX_IDLE_HTTPS_DISPATCHERS) destroy(idle.values().next().value);
};

const acquire = (target, numeric, proxy, signal) => {
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    // Authentication changes must select a different dispatcher, but keys must
    // never contain a proxy password that could appear in a diagnostic dump.
    const key = createHash("sha256").update(JSON.stringify([proxy?.href ?? null, hostname, numeric.origin])).digest("hex");
    let lease = idle.get(key);
    if (lease) {
        idle.delete(key);
        clearTimeout(lease.timer);
    } else {
        lease = {key, destroyed: false, socket: null, sockets: new Set()};
        const requestTls = isIP(hostname) ? {
            // Undici's null servername makes Bun fall back to an IP SNI (or
            // localhost inside a tunnel). A default public context omits SNI;
            // still use the native verifier against the original bare IP.
            secureContext: tls.createSecureContext({}),
            checkServerIdentity: (_name, certificate) => {
                try {return tls.checkServerIdentity(hostname, certificate);}
                catch (error) {
                    return error instanceof Error ? error : new Error("Certificate identity verification failed");
                }
            }
        } : {servername: hostname};
        const factory = (origin, options) => {
            const connect = options.connect;
            return new Pool(origin, {...options, connections: 1, connect: (options, callback) => {
                const owner = lease.owner;
                const connecting = connect(options, (error, socket) => {
                    if (lease.destroyed || owner !== lease.owner || owner.signal?.aborted) {
                        socket?.on("error", () => undefined);
                        socket?.destroy();
                        callback(abortReason(owner.signal));
                        return;
                    }
                    if (!error) {
                        ownSocket(lease, socket);
                        lease.socket = socket;
                        owner.ready = true;
                        socket.once("close", () => {
                            if (lease.socket === socket) lease.socket = null;
                        });
                    }
                    callback(error, socket);
                });
                if (!proxy) ownSocket(lease, connecting);
            }});
        };
        if (proxy) {
            const uri = new URL(proxy);
            const token = uri.username || uri.password
                ? `Basic ${Buffer.from(`${decodeURIComponent(uri.username)}:${decodeURIComponent(uri.password)}`).toString("base64")}`
                : undefined;
            uri.username = "";
            uri.password = "";
            lease.agent = new ProxyAgent({uri: uri.href, token, factory, requestTls,
                clientFactory: (origin, options) => {
                    const connectProxy = options.connect;
                    const pool = new Pool(origin, {...options, connect: (options, callback) => {
                        const owner = lease.owner;
                        const connecting = connectProxy(options, (error, socket) => {
                            if (lease.destroyed || owner !== lease.owner || owner.signal?.aborted) {
                                socket?.on("error", () => undefined);
                                socket?.destroy();
                                callback(abortReason(owner.signal));
                                return;
                            }
                            callback(error, socket);
                        });
                        // This socket exists before proxy TLS and CONNECT have
                        // completed, so the Pool cannot yet close it on abort.
                        ownSocket(lease, connecting);
                        return connecting;
                    }});
                    const connect = pool.connect.bind(pool);
                    pool.connect = async (options) => {
                        const owner = lease.owner;
                        const response = await connect(options);
                        if (lease.destroyed || owner !== lease.owner || owner.signal?.aborted) {
                            response.socket.on("error", () => undefined);
                            response.socket.destroy();
                            throw abortReason(owner.signal);
                        }
                        ownSocket(lease, response.socket);
                        if (response.statusCode !== CONNECT_SUCCESS) lease.proxyResponse = response;
                        return response;
                    };
                    return pool;
                }});
        } else {
            // Native Bun would reconsider NO_PROXY against the numeric URL.
            // This explicitly direct dispatcher never reads proxy variables.
            lease.agent = new Agent({factory, connect: buildConnector(requestTls)});
        }
    }
    // A reused socket will not run the connect callback again. Its next POST
    // may already have reached the origin when an error is reported.
    lease.owner = {signal, ready: Boolean(lease.socket && !lease.socket.destroyed)};
    lease.proxyResponse = null;
    return lease;
};

/** Only the Bun HTTPS proxy/bypass lane; HTTP framing belongs to Undici. */
export const sendHttpsProxy = async (target, {headers, body, signal}, proxy) => {
    const verdict = checkOutboundTarget(target);
    if (!verdict.safe) throw new Error(verdict.reason);
    let lease;
    let rejectAbort;
    const aborted = new Promise((_, reject) => {rejectAbort = reject;});
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
        destroy(lease);
        rejectAbort(abortReason(signal));
        cleanup();
    };
    if (signal?.aborted) throw abortReason(signal);
    signal?.addEventListener("abort", abort, {once: true});
    try {
        const hostname = target.hostname.replace(/^\[|\]$/g, "");
        const resolved = new Promise((resolve, reject) => {
            outboundLookup(hostname, {all: true}, (error, candidates) => error ? reject(error) : resolve(candidates));
        });
        const candidates = await Promise.race([resolved, aborted]);
        if (!candidates.length) throw new BlockedAddressError(hostname);
        for (const [index, {address}] of candidates.entries()) {
            if (signal?.aborted) throw abortReason(signal);
            const numeric = new URL(target);
            const family = isIP(address);
            if (!family) throw new BlockedAddressError(hostname);
            numeric.hostname = family === IPV6_FAMILY ? `[${address}]` : address;
            lease = acquire(target, numeric, proxy, signal);
            try {
                const response = await Promise.race([request(numeric, {
                    dispatcher: lease.agent, method: "POST", body, headers: {...headers, host: target.host},
                    signal, idempotent: false, maxRedirections: 0
                }), aborted]);
                const owner = lease;
                let finished = false;
                const finish = (success) => {
                    if (finished) return;
                    finished = true;
                    cleanup();
                    if (success && !signal?.aborted) release(owner);
                    else destroy(owner);
                };
                response.body.once("end", () => finish(true));
                response.body.on("error", () => finish(false));
                response.body.once("close", () => finish(response.body.readableEnded));
                return response;
            } catch (error) {
                const proxyResponse = lease.proxyResponse;
                const ready = lease.owner.ready;
                destroy(lease);
                if (signal?.aborted) throw abortReason(signal);
                if (proxyResponse) {
                    cleanup();
                    // CONNECT rejection is already an HTTP outcome (e.g. 502).
                    // Close its tunnel without replaying or treating its headers
                    // as evidence about the destination's resolved address.
                    return {ok: false, statusCode: proxyResponse.statusCode,
                        headers: proxyResponse.headers, body: Readable.from([])};
                }
                if (ready || index === candidates.length - 1) throw error;
            }
        }
    } catch (error) {
        destroy(lease);
        cleanup();
        throw error;
    }
};
