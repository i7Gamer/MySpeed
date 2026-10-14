import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {getDefaultRouteInterface, ROUTE_LOOKUP_TIMEOUT} from "../../server/util/routeInterface.js";

const IPV4 = "192.0.2.10";
const IPV6 = "2001:db8::10";
const adapters = {
    docker0: [{address: "192.0.2.20", internal: false}],
    eth0: [{address: IPV4, internal: false}],
    wg0: [{address: IPV6, internal: false}],
    lo: [{address: "127.0.0.1", internal: true}]
};

const transport = (outcomes) => {
    const sockets = [];
    const createSocket = (family) => {
        const socket = new EventEmitter();
        const outcome = outcomes[family];
        socket.closed = false;
        socket.close = () => { socket.closed = true; };
        socket.address = () => ({address: outcome});
        socket.connect = (port, host, callback) => {
            socket.destination = {port, host};
            if (outcome === "throw") throw new Error("connect failed");
            if (outcome === "stall") return;
            queueMicrotask(() => outcome === "error"
                ? socket.emit("error", new Error("no route")) : callback());
        };
        // Sending would fail: route discovery must only connect and inspect.
        socket.send = () => { throw new Error("unexpected packet"); };
        sockets.push(socket);
        return socket;
    };
    return {createSocket, sockets};
};

describe("route-aware interface discovery", () => {
    it("chooses the routed adapter rather than enumeration order and closes its socket", async () => {
        const fake = transport({udp4: IPV4});
        assert.equal(await getDefaultRouteInterface(adapters, fake), "eth0");
        assert.equal(fake.sockets.length, 1);
        assert.ok(fake.sockets.every((socket) => socket.closed));
    });

    for (const outcome of ["error", "throw", "192.0.2.99", "127.0.0.1"])
        it(`tries IPv6 when IPv4 returns ${outcome}, retaining VPN eligibility`, async () => {
            const fake = transport({udp4: outcome, udp6: IPV6});
            assert.equal(await getDefaultRouteInterface(adapters, fake), "wg0");
            assert.ok(fake.sockets.every((socket) => socket.closed));
        });

    it("returns no preference when neither family has an eligible route", async () => {
        const fake = transport({udp4: "error", udp6: "error"});
        assert.equal(await getDefaultRouteInterface(adapters, fake), null);
        assert.ok(fake.sockets.every((socket) => socket.closed));
    });

    it("handles socket creation failure", async () => {
        const createSocket = () => { throw new Error("unavailable"); };
        assert.equal(await getDefaultRouteInterface(adapters, {createSocket}), null);
    });

    it("bounds a stalled lookup and ignores a late callback", async (t) => {
        t.mock.timers.enable({apis: ["setTimeout"]});
        const fake = transport({udp4: "stall", udp6: IPV6});
        let late;
        const createSocket = (family) => {
            const socket = fake.createSocket(family);
            if (family === "udp4") socket.connect = (port, host, callback) => { late = callback; };
            return socket;
        };
        const pending = getDefaultRouteInterface(adapters, {createSocket});
        t.mock.timers.tick(ROUTE_LOOKUP_TIMEOUT);
        assert.equal(await pending, "wg0");
        late();
        assert.ok(fake.sockets.every((socket) => socket.closed));
    });
});
