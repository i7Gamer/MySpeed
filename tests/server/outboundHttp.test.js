import {it} from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import dns from "node:dns";
import {EventEmitter} from "node:events";
import {getEventListeners} from "node:events";
import {outboundHttp} from "../../server/util/outboundHttp.js";

const TEST_URL = "http://outbound-fixture.invalid/hook";
const BLOCKED = [{address: "169.254.169.254", family: 4}, {address: "fe80::1", family: 6},
    {address: "fd00:ec2::254", family: 6}];
const ALLOWED = [{address: "::1", family: 6}, {address: "127.0.0.1", family: 4},
    {address: "192.168.1.1", family: 4}, {address: "fd12::1", family: 6}];

for (const url of ["http://169.254.169.254/hook", "http://[fe80::1]/hook", "http://[fd00:ec2::254]/hook",
    "ftp://outbound-fixture.invalid/hook", "not a URL", "http://user:synthetic@outbound-fixture.invalid/hook",
    "http://outbound-fixture.invalid:25/hook", "http://outbound-fixture.invalid:10080/hook"]) {
    it(`rejects ${url} before constructing a request on Node`, async (t) => {
        let constructed = false;
        t.mock.method(http, "request", () => {constructed = true; throw new Error("unexpected request");});
        await assert.rejects(outboundHttp.send(url));
        assert.equal(constructed, false);
    });
}

it("propagates DNS errors without sending or retaining the abort listener", async (t) => {
    const fault = Object.assign(new Error("resolver unavailable"), {code: "EAI_AGAIN"});
    const controller = new AbortController();
    t.mock.method(dns, "lookup", (_host, _options, callback) => callback(fault));
    t.mock.method(http, "request", (_target, options) => {
        const request = new EventEmitter();
        request.end = () => options.lookup("outbound-fixture.invalid", {}, error => request.emit("error", error));
        return request;
    });
    await assert.rejects(outboundHttp.send(TEST_URL, {signal: controller.signal}), error => error === fault);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

it("a request-construction throw leaves no deadline listener", async (t) => {
    const controller = new AbortController();
    const fault = new Error("request construction failed");
    t.mock.method(http, "request", () => {throw fault;});
    await assert.rejects(outboundHttp.send(TEST_URL, {signal: controller.signal}), error => error === fault);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

it("an already-aborted signal never writes the body", async (t) => {
    const controller = new AbortController();
    controller.abort();
    let writes = 0;
    t.mock.method(http, "request", () => {
        const request = new EventEmitter();
        request.destroy = error => request.emit("error", error);
        request.end = () => writes++;
        return request;
    });
    await assert.rejects(outboundHttp.send(TEST_URL, {signal: controller.signal, body: "synthetic"}));
    assert.equal(writes, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

it("refuses every blocked DNS answer before a connection can send credentials", async (t) => {
    let writes = 0;
    t.mock.method(globalThis, "fetch", async () => {writes++; return {ok: true, status: 200};});
    t.mock.method(dns, "lookup", (_host, _options, callback) => callback(null, BLOCKED));
    t.mock.method(http, "request", (_target, options) => {
        const request = new EventEmitter();
        request.destroy = error => request.emit("error", error);
        request.end = () => options.lookup("outbound-fixture.invalid", {all: true}, error => {
            if (error) request.emit("error", error);
            else writes++;
        });
        return request;
    });
    await assert.rejects(outboundHttp.send(TEST_URL, {body: "synthetic secret"}), {code: "EBLOCKEDADDRESS"});
    assert.equal(writes, 0);
});

for (const all of [false, true]) {
    it(`filters mixed DNS answers in resolver order with all=${all}`, async (t) => {
        t.mock.method(globalThis, "fetch", async () => {throw new Error("unguarded fetch path");});
        t.mock.method(dns, "lookup", (_host, options, callback) => {
            assert.equal(options.all, true);
            callback(null, [BLOCKED[0], ALLOWED[0], BLOCKED[1], ...ALLOWED.slice(1)]);
        });
        let resolved;
        t.mock.method(http, "request", (_target, options) => {
            const request = new EventEmitter();
            request.destroy = error => request.emit("error", error);
            request.end = () => options.lookup("outbound-fixture.invalid", {all}, (error, ...answers) => {
                assert.equal(error, null);
                resolved = answers;
                request.emit("error", new Error("stop before socket dial"));
            });
            return request;
        });
        await assert.rejects(outboundHttp.send(TEST_URL), /stop before socket dial/);
        assert.deepEqual(resolved, all ? [ALLOWED] : [ALLOWED[0].address, ALLOWED[0].family]);
    });
}
