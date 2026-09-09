import http from "node:http";
import https from "node:https";
import {Readable} from "node:stream";
import {checkOutboundTarget, outboundLookup} from "./safeUrl.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTTP_SUCCESS_START = 200;
const HTTP_SUCCESS_END = 300;
// Preserve Node fetch's restricted-port refusal. Bun fetch permits these ports;
// blocking them there would break existing local integration endpoints.
// https://fetch.spec.whatwg.org/#port-blocking (Node 22's bundled Undici list).
const FETCH_BLOCKED_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43,
    53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
    139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554,
    556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
    5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
const httpAgent = new http.Agent({keepAlive: true});
const httpsAgent = new https.Agent({keepAlive: true});

/**
 * POST transport for configured integrations. The lookup runs inside the
 * connection path: only its approved answers can be dialed, while the original
 * hostname still supplies Host, SNI and certificate verification.
 *
 * The caller drains the returned stream without awaiting it. Keep the same
 * absolute signal attached until that drain ends, including after resolving
 * the headers; a continuously trickling response must not outlive the deadline.
 */
const send = (url, {headers, body, signal} = {}) => new Promise((resolve, reject) => {
    const target = new URL(url);
    const verdict = checkOutboundTarget(target);
    if (!verdict.safe) throw new Error(verdict.reason);
    // Node fetch refused embedded credentials; Bun fetch supports them. Keep
    // each runtime's existing delivery behavior instead of widening Node's
    // requests or breaking a Bun-hosted local integration.
    if (!process.versions.bun) {
        if (target.username || target.password) throw new TypeError("URLs containing credentials are not supported");
        if (FETCH_BLOCKED_PORTS.has(Number(target.port))) throw new TypeError("Bad port");
    } else {
        // Bun fetch accepts userinfo but does not synthesize Authorization.
        // Explicit integration authorization headers still pass through.
        target.username = "";
        target.password = "";
    }

    // Preserve fetch's case-insensitive merging and header-value validation.
    const normalized = new Headers(headers);
    const secure = target.protocol === "https:";
    const bun = process.versions.bun;
    const defaults = {accept: "*/*", "user-agent": bun ? `Bun/${bun}` : "node",
        "accept-encoding": bun ? "gzip, deflate, br, zstd" : secure ? "br, gzip, deflate" : "gzip, deflate",
        ...(bun ? {} : {"accept-language": "*", "sec-fetch-mode": "cors"})};
    for (const [name, value] of Object.entries(defaults)) {
        if (!normalized.has(name)) normalized.set(name, value);
    }
    if (body !== undefined && body !== null)
        normalized.set("content-length", String(Buffer.byteLength(body)));

    const transport = secure ? https : http;
    let response;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
        const error = signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
        response?.destroy(error);
        request.destroy(error);
        // Some runtimes do not emit request.error until a pending lookup
        // completes. The deadline must settle this send immediately too.
        reject(error);
        cleanup();
    };
    const request = transport.request(target, {
        method: "POST", headers: Object.fromEntries(normalized), lookup: outboundLookup,
        agent: secure ? httpsAgent : httpAgent
    }, (incoming) => {
        response = incoming;
        incoming.once("end", cleanup);
        incoming.once("close", cleanup);
        // A body may fail between headers arriving and the caller attaching its
        // drain. The web stream still receives that failure; it never becomes
        // an unhandled node stream error or a new HTTP outcome.
        incoming.on("error", () => undefined);
        if (REDIRECT_STATUSES.has(incoming.statusCode) && incoming.headers.location !== undefined) {
            incoming.destroy();
            reject(new Error("Redirect refused"));
            return;
        }
        resolve({
            ok: incoming.statusCode >= HTTP_SUCCESS_START && incoming.statusCode < HTTP_SUCCESS_END,
            status: incoming.statusCode,
            body: Readable.toWeb(incoming)
        });
    });
    request.on("error", (error) => {
        cleanup();
        response?.destroy(error);
        reject(error);
    });
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, {once: true});
    request.end(body);
});

// One leaf transport seam for both POST helpers; project-defined GETs keep
// their separate fetch transport. No integration can override the lookup.
export const outboundHttp = {send};
