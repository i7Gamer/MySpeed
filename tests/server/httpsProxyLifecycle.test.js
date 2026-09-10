import {it} from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import tls from "node:tls";
import {Socket} from "node:net";
import {PassThrough} from "node:stream";
import {getEventListeners} from "node:events";
import {Pool} from "undici/index.js";
import {sendHttpsProxy} from "../../server/util/outboundHttpsProxy.js";

const TARGET = new URL("https://outbound-fixture.invalid:5309/notify");
const PROXY = new URL("http://proxy-fixture.invalid:5310/");
const ALLOWED = [{address: "127.0.0.1", family: 4}];
const BLOCKED = [{address: "169.254.169.254", family: 4}, {address: "fe80::1", family: 6},
    {address: "fd00:ec2::254", family: 6}];
const CASE_TIMEOUT_MS = 2000;

const refuseDispatch = (t) => {
    const calls = [];
    t.mock.method(Pool.prototype, "dispatch", (options) => {
        calls.push(options.origin);
        throw new Error("fixture stopped before any socket could dial");
    });
    return calls;
};

it("an already-cancelled send does not start DNS or acquire a connection", async (t) => {
    const calls = refuseDispatch(t);
    const controller = new AbortController();
    const reason = new Error("cancelled before lookup");
    controller.abort(reason);
    t.mock.method(dns, "lookup", () => assert.fail("DNS should not start"));
    await assert.rejects(sendHttpsProxy(TARGET, {signal: controller.signal}, PROXY), error => error === reason);
    assert.deepEqual(calls, []);
    assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
});

for (const target of ["https://169.254.169.254/", "https://[fe80::1]/", "https://[fd00:ec2::254]/"]) {
    it(`refuses the literal ${target} before DNS or proxy dispatch`, async (t) => {
        const calls = refuseDispatch(t);
        t.mock.method(dns, "lookup", () => assert.fail("blocked literal reached DNS"));
        await assert.rejects(sendHttpsProxy(new URL(target), {}, PROXY));
        assert.deepEqual(calls, []);
    });
}

for (const candidates of [BLOCKED, [], [{address: "unexpected-host.invalid", family: 4}]]) {
    it("refuses unusable DNS candidates without retaining deadline listeners", async (t) => {
        const calls = refuseDispatch(t);
        const controller = new AbortController();
        t.mock.method(dns, "lookup", (_host, options, callback) => {
            assert.equal(options.all, true);
            callback(null, candidates);
        });
        await assert.rejects(sendHttpsProxy(TARGET, {signal: controller.signal}, PROXY), {code: "EBLOCKEDADDRESS"});
        assert.deepEqual(calls, []);
        assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
    });
}

for (const synchronous of [false, true]) {
    it(`contains a ${synchronous ? "thrown" : "reported"} DNS failure`, async (t) => {
        const calls = refuseDispatch(t);
        const controller = new AbortController();
        const fault = Object.assign(new Error("synthetic resolver failure"), {code: "ENOTFOUND"});
        t.mock.method(dns, "lookup", (_host, _options, callback) => {
            if (synchronous) throw fault;
            callback(fault);
        });
        await assert.rejects(sendHttpsProxy(TARGET, {signal: controller.signal}, PROXY), error => error === fault);
        assert.deepEqual(calls, []);
        assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
    });
}

it("cancels stalled DNS promptly and ignores a later successful resolution", async (t) => {
    const calls = refuseDispatch(t);
    const controller = new AbortController();
    let finishLookup;
    t.mock.method(dns, "lookup", (_host, _options, callback) => {finishLookup = callback;});
    const pending = sendHttpsProxy(TARGET, {signal: controller.signal}, PROXY);
    const rejected = assert.rejects(pending, /deadline reached/);
    controller.abort(new Error("deadline reached"));
    await rejected;
    finishLookup(null, ALLOWED);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, []);
    assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
});

it("checks cancellation again when DNS resolves in the same turn", async (t) => {
    const calls = refuseDispatch(t);
    const controller = new AbortController();
    t.mock.method(dns, "lookup", (_host, _options, callback) => {
        callback(null, ALLOWED);
        controller.abort(new Error("cancelled during lookup completion"));
    });
    await assert.rejects(sendHttpsProxy(TARGET, {signal: controller.signal}, PROXY), /cancelled during lookup/);
    assert.deepEqual(calls, []);
    assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
});

it("releases the deadline listener when proxy construction refuses malformed credentials", async (t) => {
    const calls = refuseDispatch(t);
    const controller = new AbortController();
    t.mock.method(dns, "lookup", (_host, _options, callback) => callback(null, ALLOWED));
    await assert.rejects(sendHttpsProxy(TARGET, {signal: controller.signal},
        new URL("http://synthetic%ZZ:secret@proxy-fixture.invalid/")), URIError);
    assert.deepEqual(calls, []);
    assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
});

it("attempts only filtered numeric candidates on failures before a socket is ready", async (t) => {
    const calls = refuseDispatch(t);
    const controller = new AbortController();
    const second = {address: "::1", family: 6};
    t.mock.method(dns, "lookup", (_host, _options, callback) => callback(null, [BLOCKED[0], ...ALLOWED, second]));
    await assert.rejects(sendHttpsProxy(TARGET, {signal: controller.signal}, PROXY), /fixture stopped/);
    assert.deepEqual(calls, ["https://127.0.0.1:5309", "https://[::1]:5309"]);
    assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
});

it("destroys a CONNECT socket delivered after cancellation without starting origin TLS",
    {timeout: CASE_TIMEOUT_MS}, async (t) => {
        const controller = new AbortController();
        let completeTunnel;
        let enteredTunnel;
        const entered = new Promise(resolve => {enteredTunnel = resolve;});
        t.mock.method(dns, "lookup", (_host, _options, callback) => callback(null, ALLOWED));
        t.mock.method(Pool.prototype, "connect", () => new Promise((resolve) => {
            completeTunnel = resolve;
            enteredTunnel();
        }));
        const tlsConnect = t.mock.method(tls, "connect", () => {
            throw new Error("late socket must not reach TLS");
        });
        const pending = sendHttpsProxy(TARGET, {signal: controller.signal}, PROXY);
        const rejected = assert.rejects(pending, /cancelled CONNECT/);
        await entered;
        controller.abort(new Error("cancelled CONNECT"));
        await rejected;

        const socket = new PassThrough();
        completeTunnel({statusCode: 200, headers: {}, socket});
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(socket.destroyed, true);
        assert.equal(tlsConnect.mock.callCount(), 0);
        assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
    });

it("refuses a TLS socket that becomes ready after its owner was cancelled",
    {timeout: CASE_TIMEOUT_MS}, async (t) => {
        const controller = new AbortController();
        const tunnel = new PassThrough();
        const socket = new Socket();
        t.after(() => {socket.destroy(); tunnel.destroy();});
        let enteredTls;
        const entered = new Promise(resolve => {enteredTls = resolve;});
        t.mock.method(dns, "lookup", (_host, _options, callback) => callback(null, ALLOWED));
        t.mock.method(Pool.prototype, "connect", async () => ({statusCode: 200, headers: {}, socket: tunnel}));
        t.mock.method(tls, "connect", () => {enteredTls(); return socket;});
        const write = t.mock.method(socket, "write", () => {
            throw new Error("cancelled TLS socket must not send a POST");
        });
        const pending = sendHttpsProxy(TARGET, {signal: controller.signal, body: "synthetic"}, PROXY);
        const rejected = assert.rejects(pending, /cancelled TLS/);
        await entered;
        controller.abort(new Error("cancelled TLS"));
        await rejected;
        assert.equal(tunnel.destroyed, true, "CONNECT must close even if TLS never finishes");
        socket.emit("secureConnect");
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(socket.destroyed, true);
        assert.equal(write.mock.callCount(), 0);
        assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
    });

it("owns HTTPS proxy TLS before a CONNECT request can be sent", {timeout: CASE_TIMEOUT_MS}, async (t) => {
    const controller = new AbortController();
    const socket = new Socket();
    t.after(() => socket.destroy(new Error("fixture teardown")));
    let enteredTls;
    const entered = new Promise(resolve => {enteredTls = resolve;});
    t.mock.method(dns, "lookup", (_host, _options, callback) => callback(null, ALLOWED));
    t.mock.method(tls, "connect", (options) => {
        assert.equal(options.host, PROXY.hostname);
        enteredTls();
        return socket;
    });
    const pending = sendHttpsProxy(TARGET, {signal: controller.signal},
        new URL("https://proxy-fixture.invalid:5310/"));
    const rejected = assert.rejects(pending, /proxy handshake deadline/);
    await entered;
    controller.abort(new Error("proxy handshake deadline"));
    await rejected;
    assert.equal(socket.destroyed, true, "proxy connector socket survived cancellation before CONNECT");
    assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
});

for (const mode of ["accept", "refuse", "throw-error", "throw-unknown"]) {
    it(`literal-IP TLS delegates native certificate verification and contains ${mode}`, async (t) => {
        const controller = new AbortController();
        const fault = new Error("synthetic certificate refusal");
        const certificate = {};
        let checked = false;
        t.mock.method(dns, "lookup", (_host, _options, callback) => callback(null, ALLOWED));
        t.mock.method(tls, "checkServerIdentity", (hostname, actualCertificate) => {
            assert.equal(hostname, ALLOWED[0].address);
            assert.equal(actualCertificate, certificate);
            if (mode === "throw-error") throw fault;
            if (mode === "throw-unknown") throw undefined;
            return mode === "accept" ? undefined : fault;
        });
        t.mock.method(tls, "connect", (options) => {
            assert.ok(options.secureContext);
            const result = options.checkServerIdentity("localhost", certificate);
            if (mode === "throw-unknown") assert.match(result.message, /Certificate identity verification failed/);
            else assert.equal(result, mode === "accept" ? undefined : fault);
            checked = true;
            throw new Error("fixture stopped before any TLS dial");
        });
        await assert.rejects(sendHttpsProxy(new URL("https://127.0.0.1:5309/"),
            {signal: controller.signal}, null), /fixture stopped/);
        assert.equal(checked, true);
        assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
    });
}
