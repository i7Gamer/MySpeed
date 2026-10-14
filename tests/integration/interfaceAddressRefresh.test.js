import {after, before, beforeEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import https from "node:https";
import dgram from "node:dgram";
import {EventEmitter} from "node:events";
import {bootServer} from "./helpers/boot.js";

let server;
let loader;
const PINNED = "eth0";
const UNSET_INTERFACE = "none";
const OLD_IP = "192.0.2.10";
const NEW_IP = "192.0.2.20";
const IPV6 = "2001:db8::10";
const entry = (address, internal = false) => ({
    address, internal, family: address.includes(":") ? "IPv6" : "IPv4"
});

before(async () => {
    server = await bootServer();
    console.log(`Isolated interface fixture: PID ${process.pid}, ${server.baseUrl}, data ${server.dataDir}`);
    loader = await import("../../server/util/loadInterfaces.js");
});
after(async () => {
    await new Promise(setImmediate);
    await server?.close();
});
beforeEach(async () => {
    for (const name of Object.keys(loader.interfaces)) delete loader.interfaces[name];
    loader.interfaces[PINNED] = OLD_IP;
    loader.resetMissingRounds();
    await server.config.updateValue("interface", PINNED);
});

// The full refresh uses the real temporary configuration. Only the OS snapshot
// and HTTPS transport are replaced, so no external request can escape the test.
const network = (t, adapters, answered = [], routedAddress = null) => {
    t.mock.method(os, "networkInterfaces", () => adapters);
    t.mock.method(https, "request", (options, onResponse) => {
        const req = new EventEmitter();
        req.destroy = () => {};
        req.end = () => queueMicrotask(() => answered.includes(options.localAddress)
            ? onResponse({}) : req.emit("error", new Error("probe blocked")));
        return req;
    });
    t.mock.method(dgram, "createSocket", (family) => {
        const socket = new EventEmitter();
        const address = typeof routedAddress === "string" ? routedAddress : routedAddress?.[family];
        socket.close = () => {};
        socket.address = () => ({address});
        socket.connect = (port, host, callback) => queueMicrotask(() => address
            ? callback() : socket.emit("error", new Error("no fixture route")));
        return socket;
    });
};

describe("refreshing an adapter's current binding", () => {
    for (const current of [UNSET_INTERFACE, PINNED])
        it(`binds the routed IPv6 address on a dual-stack fallback from ${current}`, async (t) => {
            await server.config.updateValue("interface", current);
            network(t, {wan: [entry(NEW_IP), entry(IPV6)]}, [], {udp6: IPV6});
            const rounds = current === loader.NO_INTERFACE ? 1 : loader.ROUNDS_BEFORE_FALLBACK;
            for (let round = 1; round <= rounds; round++) {
                await loader.requestInterfaces();
                if (round < rounds) assert.equal(await server.config.getValue("interface"), current);
            }
            assert.equal(await server.config.getValue("interface"), "wan");
            assert.equal(loader.interfaces.wan, IPV6, "the measurement would bind the unrouted IPv4 address");
        });

    it("prefers the routed adapter only after the entire fallback grace period", async (t) => {
        const bridge = "192.0.2.30";
        network(t, {docker0: [entry(bridge)], wan: [entry(NEW_IP)]}, [bridge, NEW_IP], NEW_IP);
        for (let round = 1; round <= loader.ROUNDS_BEFORE_FALLBACK; round++) {
            await loader.requestInterfaces();
            assert.equal(await server.config.getValue("interface"),
                round < loader.ROUNDS_BEFORE_FALLBACK ? PINNED : "wan");
        }
    });

    it("uses the route immediately for an unset interface", async (t) => {
        await server.config.updateValue("interface", loader.NO_INTERFACE);
        network(t, {docker0: [entry(OLD_IP)], wg0: [entry(NEW_IP)]}, [OLD_IP, NEW_IP], NEW_IP);
        await loader.requestInterfaces();
        assert.equal(await server.config.getValue("interface"), "wg0");
        assert.equal((await server.config.validateInput("interface", "wg0")).value, "wg0");
    });

    it("preserves a selected VPN even when another adapter carries the route", async (t) => {
        await server.config.updateValue("interface", "wg0");
        network(t, {wg0: [entry(OLD_IP)], wan: [entry(NEW_IP)]}, [NEW_IP], NEW_IP);
        await loader.requestInterfaces();
        assert.equal(await server.config.getValue("interface"), "wg0");
        assert.equal(loader.interfaces.wg0, OLD_IP);
    });

    it("shares concurrent probes and takes a new snapshot after settlement", async (t) => {
        let snapshots = 0;
        let answer;
        t.mock.method(os, "networkInterfaces", () => {
            snapshots++;
            return {[PINNED]: [entry(snapshots === 1 ? OLD_IP : NEW_IP)]};
        });
        t.mock.method(https, "request", (options, onResponse) => {
            const req = new EventEmitter();
            req.destroy = () => {};
            req.end = () => { answer = () => onResponse({}); };
            return req;
        });
        const first = loader.requestInterfaces();
        const second = loader.requestInterfaces();
        answer();
        // On the broken implementation, the second call replaced the only
        // callback. Check before awaiting the first request, which is stranded.
        assert.equal(snapshots, 1);
        await Promise.all([first, second]);
        assert.equal(loader.interfaces[PINNED], OLD_IP);
        const next = loader.requestInterfaces();
        answer();
        await next;
        assert.equal(snapshots, 2);
        assert.equal(loader.interfaces[PINNED], NEW_IP);
    });

    it("allows another refresh after a snapshot fails", async (t) => {
        const failure = new Error("snapshot unavailable");
        const read = t.mock.method(os, "networkInterfaces", () => { throw failure; });
        await assert.rejects(loader.requestInterfaces(), failure);
        read.mock.restore();
        network(t, {[PINNED]: [entry(NEW_IP)]});
        await loader.requestInterfaces();
        assert.equal(loader.interfaces[PINNED], NEW_IP);
    });

    for (const [name, previous, current, answered, expected] of [
        ["keeps an unchanged address when its probe fails", OLD_IP, [OLD_IP], [], OLD_IP],
        ["replaces an expired IPv4 lease when probes fail", OLD_IP, [NEW_IP], [], NEW_IP],
        ["uses IPv6 when the old IPv4 lease disappears", OLD_IP, [IPV6], [], IPV6],
        ["prefers an answered IPv6 to an unprobed IPv4", OLD_IP, [NEW_IP, IPV6], [IPV6], IPV6],
        ["retains a proven IPv6 still assigned alongside IPv4", IPV6, [NEW_IP, IPV6], [], IPV6]
    ]) {
        it(name, async (t) => {
            loader.interfaces[PINNED] = previous;
            network(t, {[PINNED]: current.map((address) => entry(address))}, answered);
            await loader.requestInterfaces();
            assert.deepEqual(loader.interfaces, {[PINNED]: expected});
            assert.equal(await server.config.getValue("interface"), PINNED);
        });
    }

    for (const [name, adapters] of [
        ["a removed adapter", {backup: [entry(NEW_IP)]}],
        ["an adapter with no external address", {[PINNED]: [entry("127.0.0.1", true)], backup: [entry(NEW_IP)]}],
        ["an adapter with an empty address list", {[PINNED]: [], backup: [entry(NEW_IP)]}]
    ]) {
        it(`drops the stale binding for ${name} without shortening fallback grace`, async (t) => {
            network(t, adapters);
            for (let round = 1; round <= loader.ROUNDS_BEFORE_FALLBACK; round++) {
                await loader.requestInterfaces();
                assert.deepEqual(loader.interfaces, {backup: NEW_IP});
                assert.equal(await server.config.getValue("interface"),
                    round < loader.ROUNDS_BEFORE_FALLBACK ? PINNED : "backup");
            }
        });
    }
});
