// Shared by node:test, bun test and a compiled Bun entry. Every real peer is
// loopback; the observation wrapper refuses unsafe lookup results before they
// can reach a native dialer, including when testing a broken implementation.
import assert from "node:assert/strict";
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import {publishAll, readPacket, CONNECT, PUBLISH, DISCONNECT} from "../../../server/util/mqtt.js";
import setupMqtt from "../../../server/integrations/mqtt.js";
import {checkOutboundHost} from "../../../server/util/safeUrl.js";

const HOST = "outbound-fixture.invalid";
const WRONG_HOST = "wrong-fixture.invalid";
const IPV4 = {address: "127.0.0.1", family: 4};
const IPV6 = {address: "::1", family: 6};
const REFUSED_IPV4 = {address: "127.0.0.2", family: 4};
const BLOCKED = [{address: "169.254.169.254", family: 4}, {address: "fe80::1", family: 6}];
const CONNECT_TIMEOUT_MS = 3000;
const SHORT_TIMEOUT_MS = 500;
const SCENARIO_TIMEOUT_MS = 10000;
const LATE_EVENT_GRACE_MS = 50;
const EPHEMERAL_PORT = 0;
const MQTT_LENGTH_BYTES = 2;
const MQTT_QOS_SHIFT = 1;
const MQTT_QOS_MASK = 3;
const TOPIC = "synthetic/results";
const PAYLOAD = "Grüezi 🌍";
const CONNACK = Buffer.from([0x20, 0x02, 0x00, 0x00]);
const PUBACK_HEADER = Buffer.from([0x40, 0x02]);
const certificateFailure = error => !/did not answer|fixture timed out/i.test(error.message)
    && /cert|hostname|self.signed/i.test(`${error.code} ${error.message}`);
const pause = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => {
    let resolve;
    const promise = new Promise(done => {resolve = done;});
    return {promise, resolve};
};

async function fixture({secure = false, listenHost = IPV4.address, trust = true, silent = false,
    holdAcknowledgement = false, closeOnConnect = false, stalledTls = false} = {}, run) {
    const certificateDir = process.env.OUTBOUND_TLS_FIXTURE_DIR || path.resolve("tests/fixtures/outbound-tls");
    // Existing public synthetic fixture key, explicitly trusted only here.
    const cert = fs.readFileSync(path.join(certificateDir, "cert.pem"));
    const key = fs.readFileSync(path.join(certificateDir, "key.pem"));
    const sockets = new Set();
    const clients = [];
    const applicationWrites = [];
    const packets = [];
    const approved = [];
    const attempts = [];
    const lookupCalls = [];
    const handoffs = [];
    const sni = [];
    const failures = [];
    const disconnected = deferred();
    const published = deferred();
    const dnsStarted = deferred();
    let acceptedConnections = 0;
    let pendingAcknowledgement;
    let answers = [IPV4];
    let dnsError;
    let holdDns = false;
    let delayedDns;
    const receive = (socket) => {
        if (secure && !stalledTls) sni.push(socket.servername);
        if (silent || stalledTls) return;
        let buffer = Buffer.alloc(0);
        socket.on("data", chunk => {
            try {
                buffer = Buffer.concat([buffer, chunk]);
                for (let packet = readPacket(buffer); packet; packet = readPacket(buffer)) {
                    buffer = buffer.subarray(packet.consumed);
                    packets.push(packet);
                    if (packet.type === CONNECT) {
                        if (closeOnConnect) {socket.destroy(); return;}
                        socket.write(CONNACK);
                    }
                    if (packet.type === PUBLISH) {
                        published.resolve();
                        const qos = (packet.flags >> MQTT_QOS_SHIFT) & MQTT_QOS_MASK;
                        if (qos) {
                            const offset = MQTT_LENGTH_BYTES + packet.body.readUInt16BE(0);
                            const ack = () => socket.write(Buffer.concat([PUBACK_HEADER,
                                packet.body.subarray(offset, offset + MQTT_LENGTH_BYTES)]));
                            if (holdAcknowledgement) pendingAcknowledgement = ack;
                            else ack();
                        }
                    }
                    if (packet.type === DISCONNECT) disconnected.resolve();
                }
            } catch (error) {failures.push(error); socket.destroy();}
        });
    };
    const server = secure && !stalledTls ? tls.createServer({key, cert}, receive) : net.createServer(receive);
    server.on("connection", socket => {
        acceptedConnections++;
        sockets.add(socket);
        socket.on("error", () => undefined);
        socket.once("close", () => sockets.delete(socket));
    });
    server.on("tlsClientError", () => undefined);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(EPHEMERAL_PORT, listenHost, resolve);
    });
    const originalLookup = dns.lookup;
    const originalNetConnect = net.connect;
    const originalTlsConnect = tls.connect;
    const guardOptions = (options) => {
        assert.equal(typeof options.lookup, "function", "default MQTT socket lacks guarded lookup");
        if (secure) assert.equal(options.servername, options.host, "TLS must retain the original hostname");
        const lookup = options.lookup;
        return {...options, lookup: (host, opts, callback) => {
            lookupCalls.push({host, ...opts});
            lookup(host, opts, (error, result, family) => {
                if (!error) {
                    const entries = opts.all ? result : [{address: result, family}];
                    // Never let a mutant dial forbidden or non-fixture addresses.
                    const unsafe = entries.find(entry => ![IPV4.address, IPV6.address, REFUSED_IPV4.address].includes(entry.address));
                    if (unsafe) {
                        failures.push(new Error(`unguarded candidate ${unsafe.address}`));
                        callback(new Error("fixture stopped unsafe dial"));
                        return;
                    }
                    approved.push(...entries.map(entry => entry.address));
                }
                handoffs.push({error: error?.code, result});
                callback(error, result, family);
            });
        }};
    };
    const observe = socket => {
        clients.push(socket);
        socket.on("connectionAttempt", address => attempts.push(address));
        // TLS handshake bytes use the native TLS implementation; socket.write
        // observes the application's plaintext MQTT writes before encryption.
        const write = socket.write;
        socket.write = function (...args) {
            applicationWrites.push(Buffer.from(args[0]));
            return write.apply(this, args);
        };
        return socket;
    };
    dns.lookup = (host, options, callback) => {
        assert.ok(host === HOST || host === WRONG_HOST, "unexpected real DNS hostname");
        assert.equal(options.all, true, "filter must inspect all DNS answers");
        if (holdDns) {delayedDns = callback; dnsStarted.resolve();}
        else queueMicrotask(() => callback(dnsError, answers));
    };
    net.connect = options => observe(originalNetConnect.call(net, guardOptions(options)));
    tls.connect = options => observe(originalTlsConnect.call(tls, {
        ...guardOptions(options), ...(trust ? {ca: cert} : {})
    }));
    let timeout;
    try {
        await Promise.race([
            run({
                packets, approved, attempts, lookupCalls, handoffs, clients, sni, applicationWrites,
                connections: () => acceptedConnections,
                answers: value => {answers = value;},
                dnsError: value => {dnsError = value;},
                holdDns: () => {holdDns = true;},
                releaseDns: () => {assert.ok(delayedDns); delayedDns(null, answers);},
                acknowledge: () => {assert.ok(pendingAcknowledgement); pendingAcknowledgement();},
                published: published.promise,
                dnsStarted: dnsStarted.promise,
                disconnected: disconnected.promise,
                send: overrides => publishAll({host: HOST, port: server.address().port, secure,
                    username: "fixture", password: "synthetic", timeout: CONNECT_TIMEOUT_MS,
                    qos: 1, messages: [{topic: TOPIC, payload: PAYLOAD, retain: true}], ...overrides}),
                integration: async host => {
                    const events = {};
                    setupMqtt((name, callback) => {events[name] = callback;});
                    const activity = [];
                    await events.testFinished({data: {host, port: server.address().port, secure,
                        topic: TOPIC, send_finished: true, qos: 1}}, {download: 10}, failed => activity.push(failed));
                    return activity;
                }
            }),
            new Promise((_, reject) => {timeout = setTimeout(() => reject(new Error("transport fixture timed out")), SCENARIO_TIMEOUT_MS);})
        ]);
        assert.deepEqual(failures, [], "fixture observed unsafe candidates or invalid broker traffic");
        if (!process.versions.bun && approved.length && !holdDns) {
            assert.ok(attempts.length, "Node must expose actual socket attempts");
            assert.ok(attempts.every(address => approved.includes(address)), "unapproved native socket attempt");
        }
    } finally {
        clearTimeout(timeout);
        dns.lookup = originalLookup;
        net.connect = originalNetConnect;
        tls.connect = originalTlsConnect;
        for (const socket of [...clients, ...sockets]) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    }
}

const verifyDelivery = async (context, qos = 1) => {
    await context.send({qos});
    await context.disconnected;
    assert.ok(context.applicationWrites.length > 0, "application-write observer must see successful MQTT traffic");
    assert.deepEqual(context.packets.map(packet => packet.type), [CONNECT, PUBLISH, DISCONNECT]);
    const publication = context.packets.find(packet => packet.type === PUBLISH);
    const topicLength = publication.body.readUInt16BE(0);
    assert.equal(publication.body.subarray(MQTT_LENGTH_BYTES, MQTT_LENGTH_BYTES + topicLength).toString(), TOPIC);
    const payloadOffset = MQTT_LENGTH_BYTES + topicLength + (qos ? MQTT_LENGTH_BYTES : 0);
    assert.equal(publication.body.subarray(payloadOffset).toString(), PAYLOAD);
    assert.equal(publication.flags, (qos << MQTT_QOS_SHIFT) | 1);
    assert.ok(context.lookupCalls.every(call => call.all === true));
};

export const scenarios = [];
for (const secure of [false, true]) {
    const protocol = secure ? "TLS" : "TCP";
    scenarios.push({name: `MQTT ${protocol} refuses blocked answers before dialing`, run: () => fixture({secure}, async context => {
        context.answers(BLOCKED);
        await assert.rejects(context.send(), {code: "EBLOCKEDADDRESS"});
        assert.equal(context.connections(), 0);
        assert.deepEqual(context.approved, []);
        assert.deepEqual(context.attempts, []);
        assert.deepEqual(await context.integration(HOST), [true]);
    })});
    for (const qos of [0, 1]) scenarios.push({name: `MQTT ${protocol} filters mixed answers and delivers UTF-8 at QoS ${qos}`, run: () => fixture({secure}, async context => {
        context.answers([BLOCKED[0], IPV4, BLOCKED[1]]);
        await verifyDelivery(context, qos);
        assert.deepEqual(context.approved, [IPV4.address]);
        if (secure) assert.deepEqual(context.sni, [HOST]);
    })});
    for (const first of [REFUSED_IPV4, IPV6]) scenarios.push({name: `MQTT ${protocol} falls back from ${first.address} to allowed IPv4`, run: () => fixture({secure}, async context => {
        context.answers([BLOCKED[0], first, BLOCKED[1], IPV4]);
        await verifyDelivery(context);
        assert.deepEqual(context.approved, [first.address, IPV4.address]);
        if (!process.versions.bun) assert.deepEqual(context.attempts, [first.address, IPV4.address]);
    })});
    scenarios.push({name: `MQTT ${protocol} timeout closes pending DNS and ignores late resolution`, run: () => fixture({secure}, async context => {
        context.holdDns();
        await assert.rejects(context.send({timeout: SHORT_TIMEOUT_MS}), /did not answer/);
        assert.ok(context.clients.every(socket => socket.destroyed));
        context.releaseDns();
        await pause(LATE_EVENT_GRACE_MS);
        assert.equal(context.connections(), 0);
        assert.deepEqual(context.packets, []);
        assert.deepEqual(context.attempts, []);
    })});
    scenarios.push({name: `MQTT ${protocol} accepts delayed DNS before its existing deadline`, run: () => fixture({secure}, async context => {
        context.holdDns();
        const send = context.send();
        await Promise.race([context.dnsStarted, send]);
        assert.equal(context.connections(), 0);
        context.releaseDns();
        await send;
        await context.disconnected;
        assert.equal(context.connections(), 1);
    })});
    scenarios.push({name: `MQTT ${protocol} exhausts refused allowed addresses without an unfiltered retry`, run: () => fixture({secure}, async context => {
        context.answers([BLOCKED[0], REFUSED_IPV4, BLOCKED[1], IPV6]);
        await assert.rejects(context.send());
        assert.equal(context.connections(), 0);
        assert.deepEqual(context.approved, [REFUSED_IPV4.address, IPV6.address]);
        if (!process.versions.bun) assert.deepEqual(context.attempts, [REFUSED_IPV4.address, IPV6.address]);
    })});
}
scenarios.push(
    {name: "MQTT preserves literal-host policy before native lookup bypass", run: () => fixture({}, async context => {
        for (const host of ["169.254.169.254", "2852039166", "::ffff:a9fe:a9fe", "[fd00:ec2::254]", "fe80::1"])
            assert.deepEqual(await context.integration(host), [true]);
        for (const host of ["127.0.0.1", "::1", "192.168.1.2", "fd12::1"])
            assert.equal(checkOutboundHost(host).safe, true);
        assert.equal(context.clients.length, 0);
        assert.equal(context.connections(), 0);
    })},
    {name: "MQTT DNS error and empty answers fail once without delivery", run: () => fixture({}, async context => {
        context.dnsError(Object.assign(new Error("synthetic resolver failure"), {code: "EAI_AGAIN"}));
        await assert.rejects(context.send(), {code: "EAI_AGAIN"});
        context.dnsError(undefined);
        context.answers([]);
        await assert.rejects(context.send(), {code: "EBLOCKEDADDRESS"});
        assert.equal(context.connections(), 0);
    })},
    {name: "MQTT repeats resolution and blocks a changed destination", run: () => fixture({}, async context => {
        await verifyDelivery(context);
        context.answers(BLOCKED);
        await assert.rejects(context.send(), {code: "EBLOCKEDADDRESS"});
        assert.equal(context.lookupCalls.length, 2);
        assert.equal(context.connections(), 1);
    })},
    {name: "MQTT TLS verifies original hostname before sending credentials", run: () => fixture({secure: true}, async context => {
        await assert.rejects(context.send({host: WRONG_HOST}), certificateFailure);
        assert.deepEqual(context.packets, []);
        assert.deepEqual(context.applicationWrites, []);
    })},
    {name: "MQTT TLS refuses an untrusted certificate before sending credentials", run: () => fixture({secure: true, trust: false}, async context => {
        await assert.rejects(context.send(), certificateFailure);
        assert.deepEqual(context.packets, []);
        assert.deepEqual(context.applicationWrites, []);
    })},
    {name: "MQTT QoS1 waits for broker acknowledgement", run: () => fixture({holdAcknowledgement: true}, async context => {
        let settled = false;
        const send = context.send().finally(() => {settled = true;});
        await Promise.race([context.published, send]);
        assert.equal(settled, false);
        context.acknowledge();
        await send;
        await context.disconnected;
    })},
    {name: "MQTT stalled greeting is bounded and closes the socket", run: () => fixture({silent: true}, async context => {
        await assert.rejects(context.send({timeout: SHORT_TIMEOUT_MS}), /did not answer/);
        assert.ok(context.clients.every(socket => socket.destroyed));
    })},
    {name: "MQTT missing PUBACK expires the existing deadline", run: () => fixture({holdAcknowledgement: true}, async context => {
        await assert.rejects(context.send({timeout: SHORT_TIMEOUT_MS}), /did not answer/);
        assert.deepEqual(context.packets.map(packet => packet.type), [CONNECT, PUBLISH]);
        assert.ok(context.clients.every(socket => socket.destroyed));
    })},
    {name: "MQTT peer closure reports failure without another connection", run: () => fixture({closeOnConnect: true}, async context => {
        await assert.rejects(context.send(), /closed/);
        assert.equal(context.connections(), 1);
        assert.deepEqual(context.packets.map(packet => packet.type), [CONNECT]);
    })},
    {name: "MQTT stalled TLS handshake is bounded before MQTT credentials", run: () => fixture({secure: true, stalledTls: true}, async context => {
        await assert.rejects(context.send({timeout: SHORT_TIMEOUT_MS}), /did not answer/);
        assert.ok(context.clients.every(socket => socket.destroyed));
        assert.deepEqual(context.applicationWrites, [], "MQTT must wait for secureConnect before writing credentials");
    })},
    {name: "MQTT delivers to allowed IPv6 when available", run: async () => {
        try {await fixture({listenHost: IPV6.address}, async context => {
            context.answers([IPV6]);
            await verifyDelivery(context);
        });} catch (error) {
            if (["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(error.code)) return {skip: `IPv6 unavailable: ${error.code}`};
            throw error;
        }
    }}
);
