import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import {Readable} from "node:stream";
import {X509Certificate} from "node:crypto";
import fs from "node:fs";
import assert from "node:assert/strict";
import {outboundHttp} from "../../../../server/util/outboundHttp.js";
import {httpsProxyRoute, sendHttpsProxy} from "../../../../server/util/outboundHttpsProxy.js";

const HOST = "outbound-fixture.invalid";
const LOCAL = "127.0.0.1";
const REQUEST_MS = 2000;
const CLEANUP_MS = 75;
const KEEP_PROCESS_ALIVE_MS = 1000;
const REUSE_REQUESTS = 3;
const EVICTION_REQUESTS = 17;
const EXPIRY_WAIT_MS = 5250;
const BODY = "Grüezi 🌍 synthetic notification";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runHttpChild() {
    // A deliberately held DNS callback has no native socket to keep Node alive;
    // the harness, not production, owns this handle until its parent snapshots.
    setInterval(() => undefined, KEEP_PROCESS_ALIVE_MS);
    const options = JSON.parse(process.env.OUTBOUND_HTTP_CASE);
    const originalLookup = dns.lookup;
    const lookupCalls = [];
    const answers = options.answers || [{address: LOCAL, family: 4}];
    dns.lookup = (hostname, lookupOptions, callback) => {
        if (net.isIP(hostname)) return originalLookup(hostname, lookupOptions, callback);
        assert.ok([HOST, "wrong-fixture.invalid", "proxy-fixture.invalid"].includes(hostname), "fixture refuses unexpected DNS hostname");
        lookupCalls.push(hostname);
        if (options.holdDns || options.holdProxyDns && hostname === "proxy-fixture.invalid") return;
        if (options.dnsError) return callback(Object.assign(new Error("synthetic DNS failure"), {code: "ENOTFOUND"}));
        const records = hostname === HOST && options.proxyHostOnly ? [{address: LOCAL, family: 4}] : answers;
        if (lookupOptions.all) callback(null, records);
        else callback(null, records[0].address, records[0].family);
    };
    // Intentionally broken policy mutants must still never reach outside this
    // fixture. Production filtering must reject first with its own error code.
    for (const [module, name] of [[net, "connect"], [tls, "connect"]]) {
        const native = module[name];
        module[name] = (connectOptions, ...args) => {
            if (connectOptions?.host && !connectOptions.socket && !connectOptions.httpSocket) {
                assert.ok([LOCAL, "127.0.0.2", "::1", HOST, "wrong-fixture.invalid", "proxy-fixture.invalid"].includes(connectOptions.host),
                    "fixture refuses unsafe native dial");
            }
            return native(connectOptions, ...args);
        };
    }
    const hostname = options.hostname || HOST;
    // Node 22.23.2 rejects ::1 even with a matching IP SAN: its native checker
    // applies domainToASCII before recognizing IPv6. Record the native result
    // explicitly; do not bypass identity verification to make this fixture pass.
    const nativeIpIdentityError = options.ipCertificate ? tls.checkServerIdentity(
        hostname.replace(/^\[|\]$/g, ""),
        new X509Certificate(fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS)).toLegacyObject())?.code : undefined;
    const target = `https://${hostname}${options.defaultPort ? "" : ":" + options.originPort}`;
    const results = [];
    const send = async (pathname = "/notify", overrides = {}) => {
        const result = {};
        const signal = overrides.controller?.signal || AbortSignal.timeout(options.timeout || REQUEST_MS);
        try {
            const init = {
                headers: {"content-type": "text/plain; charset=utf-8", "x-fixture": "synthetic"}, body: BODY, signal
            };
            let response;
            const route = httpsProxyRoute(new URL(target));
            if (process.versions.bun || route === undefined) response = await outboundHttp.send(target + pathname, init);
            else {
                // Node does not implicitly use proxy variables. Exercise the
                // portable leaf directly while Bun exercises real integration wiring.
                const raw = await sendHttpsProxy(new URL(target + pathname), init, route);
                response = {status: raw.statusCode, ok: raw.ok ?? (raw.statusCode >= 200 && raw.statusCode < 300),
                    body: Readable.toWeb(raw.body)};
            }
            result.status = response.status;
            result.ok = response.ok;
            overrides.controller?.abort(new Error("synthetic concurrent cancellation"));
            try {
                if (options.cancelBody) await response.body.cancel(new Error("synthetic body cancellation"));
                else await response.body.pipeTo(new WritableStream());
            }
            catch (error) {result.drainError = error.code || error.name;}
        } catch (error) {result.error = error.code || error.name; result.message = error.message;}
        results.push(result);
        return result;
    };
    if (options.reuse) {
        for (let index = 0; index < REUSE_REQUESTS; index++) await send();
    } else if (options.concurrent) {
        await Promise.all([send("/concurrent-abort", {controller: new AbortController()}), send("/concurrent-ok")]);
    } else if (options.warmClose) {
        await send();
        await send("/close");
    } else if (options.eviction) {
        for (let index = 0; index < EVICTION_REQUESTS; index++) {
            const proxy = new URL(process.env.HTTPS_PROXY);
            proxy.username = `synthetic-${index}`;
            process.env.HTTPS_PROXY = proxy.href;
            await send();
        }
    } else await send(options.pathname);
    if (options.expiry) await pause(EXPIRY_WAIT_MS);
    await pause(CLEANUP_MS);
    // Parent snapshots live peers before terminating this owned child. Keeping
    // it alive prevents process exit from masking missing cancellation cleanup.
    console.log(JSON.stringify({results, lookupCalls, nativeIpIdentityError, runtime: process.versions.bun ? "bun" : "node"}));
}
