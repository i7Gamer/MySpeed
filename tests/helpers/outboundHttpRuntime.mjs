// Child process contract probe; the parent owns all local HTTP/TLS listeners.
import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import {getEventListeners} from "node:events";
import {EventEmitter} from "node:events";
import {outboundHttp} from "../../server/util/outboundHttp.js";

const [httpPort, httpsPort] = process.argv.slice(2);
const HOSTNAME = "outbound-fixture.invalid";
const LOOPBACK = "127.0.0.1";
const DEADLINE_MS = 200;
const REQUEST_DEADLINE_MS = 3000;
const BODY = "Grüezi 🌍";
const suppliedHeaders = {"content-type": "text/plain", "Content-Type": "application/x-fixture",
    Authorization: "Bearer synthetic-fixture"};
const blocked = [{address: "169.254.169.254", family: 4}, {address: "fe80::1", family: 6}];
const allowed = [{address: "::1", family: 6}, {address: LOOPBACK, family: 4}];
let answers = blocked;
let releaseLookup;
dns.lookup = (hostname, options, callback) => {
    assert.equal(options.all, true);
    if (hostname === "stalled-fixture.invalid") {releaseLookup = callback; return;}
    callback(null, answers);
};
const dialed = [];
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    this.on("connectionAttempt", (address) => dialed.push(address));
    return originalConnect.apply(this, args);
};
const approved = [];
const observeLookup = (lookup) => (hostname, options, callback) => lookup(hostname, options, (error, result, family) => {
    if (!error) {
        const entries = options.all ? result : [{address: result, family}];
        for (const entry of entries) {
            assert.ok(allowed.some(({address}) => address === entry.address), "a forbidden address reached the native dialer");
            approved.push(entry.address);
        }
    }
    callback(error, result, family);
});
const originalHttpRequest = http.request.bind(http);
http.request = (target, options, callback) => originalHttpRequest(target, {...options, lookup: observeLookup(options.lookup)}, callback);
const cert = fs.readFileSync(new URL("../fixtures/outbound-tls/cert.pem", import.meta.url));
const originalRequest = https.request.bind(https);
https.request = (target, options, callback) => originalRequest(target, {...options, ca: cert,
    lookup: observeLookup(options.lookup)}, callback);

const send = (path, options = {}) => outboundHttp.send(`http://${HOSTNAME}:${httpPort}${path}`, {
    body: BODY, headers: suppliedHeaders, signal: AbortSignal.timeout(REQUEST_DEADLINE_MS), ...options
});
const baseline = await fetch(`http://${LOOPBACK}:${httpPort}/baseline`, {method: "POST", body: BODY, headers: suppliedHeaders});
await baseline.text();
await assert.rejects(send("/blocked"), {code: "EBLOCKEDADDRESS"});
assert.equal(approved.length, 0);
answers = [blocked[0], allowed[0], blocked[1], allowed[1]];
for (const path of ["/ok", "/ok"]) {
    const signal = AbortSignal.timeout(REQUEST_DEADLINE_MS);
    const response = await send(path, {signal});
    assert.equal(response.status, 202);
    assert.equal(response.ok, true);
    assert.ok(getEventListeners(signal, "abort").length > 0, "deadline detached at headers");
    await response.body.pipeTo(new WritableStream());
    assert.equal(getEventListeners(signal, "abort").length, 0, "deadline listener leaked after drain");
}
const signal = AbortSignal.timeout(DEADLINE_MS);
const response = await send("/trickle", {signal});
assert.equal(signal.aborted, false, "caller waited for the stalled body");
await assert.rejects(response.body.pipeTo(new WritableStream()));
assert.equal(signal.aborted, true);
assert.equal(getEventListeners(signal, "abort").length, 0);
await assert.rejects(send("/redirect"), /Redirect refused/);
const refused = await send("/error");
assert.equal(refused.status, 429);
assert.equal(refused.ok, false);
await refused.body.pipeTo(new WritableStream());
const tls = await outboundHttp.send(`https://${HOSTNAME}:${httpsPort}/tls`, {
    signal: AbortSignal.timeout(REQUEST_DEADLINE_MS), body: BODY
});
assert.equal(tls.status, 200);
await tls.body.pipeTo(new WritableStream());
await assert.rejects(outboundHttp.send(`https://wrong-fixture.invalid:${httpsPort}/tls`, {
    signal: AbortSignal.timeout(REQUEST_DEADLINE_MS), body: BODY
}));
const stalledSignal = AbortSignal.timeout(DEADLINE_MS);
// The fake resolver has no native DNS handle to keep the process alive.
const holdProcess = setTimeout(() => undefined, REQUEST_DEADLINE_MS);
try {
    await assert.rejects(outboundHttp.send(`http://stalled-fixture.invalid:${httpPort}/pending-dns`, {signal: stalledSignal}));
    releaseLookup(null, allowed);
    await new Promise(resolve => setTimeout(resolve, DEADLINE_MS));
} finally {clearTimeout(holdProcess);}
assert.equal(stalledSignal.aborted, true);
assert.equal(getEventListeners(stalledSignal, "abort").length, 0);
assert.ok(approved.includes(LOOPBACK));
if (!process.versions.bun) {
    assert.ok(dialed.includes(LOOPBACK));
    assert.ok(dialed.includes("::1"));
    for (const address of dialed) assert.ok(allowed.some(entry => entry.address === address));
} // Bun exposes no native connectionAttempt events: assert its real lookup handoff above instead.
for (const headers of [{}, {Authorization: "Bearer explicit-fixture"}]) {
    const url = `http://fixture:synthetic@${HOSTNAME}:${httpPort}/credentials`;
    if (process.versions.bun) {
        const reply = await outboundHttp.send(url, {body: BODY, headers});
        await reply.body.pipeTo(new WritableStream());
    } else await assert.rejects(outboundHttp.send(url, {body: BODY, headers}));
}
for (const port of [25, 10080]) {
    let constructed = false;
    http.request = () => {
        constructed = true;
        const request = new EventEmitter();
        request.end = () => request.emit("error", new Error("test stopped before socket"));
        return request;
    };
    await assert.rejects(outboundHttp.send(`http://${HOSTNAME}:${port}/port-policy`),
        process.versions.bun ? /test stopped before socket/ : /Bad port/);
    assert.equal(constructed, Boolean(process.versions.bun));
}
console.log(JSON.stringify({runtime: process.versions.bun ?? process.version, passed: true,
    nativeDialEventsAvailable: !process.versions.bun, dialed}));
