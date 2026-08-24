import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
    CONNACK, CONNECT, DISCONNECT, PUBACK, PUBLISH, encodeLength, publish, readPacket
} from "../../server/util/mqtt.js";

/**
 * The exchange itself, against a broker that is real enough to answer.
 *
 * A stub speaking the four packets on loopback, rather than a mock of the
 * client: what is being tested is whether a broker can read what we send, and a
 * mock would only confirm that the code calls the functions it calls. The same
 * approach ntfy.test.js and outboundRedirects.test.js already take for HTTP.
 *
 * Nothing here reaches the network - an ephemeral port on 127.0.0.1, torn down
 * in `after`.
 */
let broker;
let port;

/** What the stub is told to do with the next connection. */
let behaviour;

/** Every packet the stub received, in order. */
let seen;

const CONNECTION_ACCEPTED = 0;

const connack = (code) => Buffer.from([CONNACK << 4, 0x02, 0x00, code]);
const puback = (packetId) => {
    const body = Buffer.alloc(2);
    body.writeUInt16BE(packetId);

    return Buffer.concat([Buffer.from([PUBACK << 4, 0x02]), body]);
};

before(async () => {
    broker = net.createServer((socket) => {
        let buffered = Buffer.alloc(0);

        if (behaviour.silent) return;

        socket.on("data", (chunk) => {
            buffered = Buffer.concat([buffered, chunk]);

            for (let next = readPacket(buffered); next !== null; next = readPacket(buffered)) {
                buffered = buffered.subarray(next.consumed);
                seen.push(next);

                if (next.type === CONNECT) {
                    if (behaviour.hangUp) return socket.destroy();
                    socket.write(connack(behaviour.returnCode ?? CONNECTION_ACCEPTED));
                }

                if (next.type === PUBLISH && behaviour.ackPublish) {
                    // The packet id sits straight after the topic, which is
                    // itself length-prefixed.
                    const topicLength = next.body.readUInt16BE(0);
                    socket.write(puback(next.body.readUInt16BE(2 + topicLength)));
                }
            }
        });

        socket.on("error", () => undefined);
    });

    await new Promise((resolve) => broker.listen(0, "127.0.0.1", resolve));
    port = broker.address().port;
});

after(async () => {
    await new Promise((resolve) => broker.close(resolve));
});

beforeEach(() => {
    behaviour = {};
    seen = [];
});

const TIMEOUT = 2000;

const send = (overrides = {}) => publish({
    host: "127.0.0.1", port, topic: "myspeed/result",
    payload: Buffer.from('{"download":100}'), timeout: TIMEOUT, ...overrides
});

/**
 * Waits for the stub to have seen a packet of this type.
 *
 * publish() resolving says the bytes have left this process, not that the broker
 * has parsed them - so every assertion about what the stub received has to wait
 * for the stub rather than for the promise. Asserting straight after the await
 * is a race that passes on a small payload and fails on a large one.
 */
const sawType = async (type) => {
    for (let attempt = 0; attempt < 500; attempt++) {
        if (seen.some((packet) => packet.type === type)) return true;
        await new Promise((resolve) => setImmediate(resolve));
    }

    return false;
};

/** The published message, once the stub has actually read it. */
const publishedMessage = async () => {
    assert.ok(await sawType(PUBLISH), "the broker never received a PUBLISH");

    return seen.find((packet) => packet.type === PUBLISH);
};

/** The topic and payload out of a PUBLISH body, which is length-prefixed. */
const contentOf = (message) => {
    const topicLength = message.body.readUInt16BE(0);

    return {topic: message.body.subarray(2, 2 + topicLength).toString(), body: message.body.subarray(2 + topicLength)};
};

describe("publishing at QoS 0", () => {
    it("connects, publishes and disconnects", async () => {
        await send();
        await sawType(DISCONNECT);

        assert.deepEqual(seen.map((packet) => packet.type), [CONNECT, PUBLISH, DISCONNECT],
            "the exchange was not the four packets it is meant to be");
    });

    it("carries the topic and the payload the caller gave it", async () => {
        await send();

        const {topic, body} = contentOf(await publishedMessage());

        assert.equal(topic, "myspeed/result");
        assert.equal(body.toString(), '{"download":100}');
    });

    /**
     * Retained, or a Home Assistant entity reads "unknown" from every restart
     * until the next speedtest - which on the default hourly schedule is up to
     * an hour of a sensor that exists and says nothing.
     */
    it("sets retain when asked", async () => {
        await send({retain: true});

        assert.equal((await publishedMessage()).flags & 0x01, 0x01);
    });

    // Ahead of the close, so the broker records a client that went away rather
    // than one that dropped - which most brokers log as an error.
    it("says goodbye rather than dropping the connection", async () => {
        await send();

        assert.ok(await sawType(DISCONNECT), "the broker saw the connection drop without a DISCONNECT");
    });
});

describe("publishing at QoS 1", () => {
    it("waits for the broker to acknowledge", async () => {
        behaviour.ackPublish = true;

        await send({qos: 1});
        await sawType(DISCONNECT);

        assert.deepEqual(seen.map((packet) => packet.type), [CONNECT, PUBLISH, DISCONNECT]);
    });

    /**
     * The point of QoS 1: a broker that takes the message and never answers has
     * not taken it as far as the caller is concerned, and saying otherwise would
     * make the level meaningless.
     */
    it("does not report success when no acknowledgement comes", async () => {
        behaviour.ackPublish = false;

        await assert.rejects(() => send({qos: 1, timeout: 300}), /did not answer/);
    });

    it("sends a packet id the broker can acknowledge", async () => {
        behaviour.ackPublish = true;
        await send({qos: 1});

        const message = await publishedMessage();
        const topicLength = message.body.readUInt16BE(0);

        assert.notEqual(message.body.readUInt16BE(2 + topicLength), 0,
            "zero is not a valid packet identifier");
    });
});

describe("credentials", () => {
    it("reach the broker when they are set", async () => {
        await send({username: "user", password: "pass"});
        await sawType(CONNECT);

        const connect = seen.find((packet) => packet.type === CONNECT);

        assert.equal(connect.body[7] & 0xc0, 0xc0);
        assert.match(connect.body.toString("utf8"), /user.*pass/s);
    });

    it("are absent when they are not", async () => {
        await send();
        await sawType(CONNECT);

        assert.equal(seen.find((packet) => packet.type === CONNECT).body[7] & 0xc0, 0);
    });
});

/**
 * What the operator is told. A broker refuses with a single byte and closes, so
 * anything not translated here reaches the integration card as silence.
 */
describe("a broker that says no", () => {
    it("names a rejected password", async () => {
        behaviour.returnCode = 4;

        await assert.rejects(() => send(), /username or password/);
    });

    it("names a refused client", async () => {
        behaviour.returnCode = 5;

        await assert.rejects(() => send(), /refused this client/);
    });

    it("reports a code it does not recognise rather than swallowing it", async () => {
        behaviour.returnCode = 9;

        await assert.rejects(() => send(), /9/);
    });

    it("reports a broker that hangs up mid-exchange", async () => {
        behaviour.hangUp = true;

        await assert.rejects(() => send(), /closed the connection/);
    });

    /**
     * The case the deadline exists for: a broker that accepts the connection and
     * then says nothing would otherwise hold the speedtest run that triggered
     * the notification, since triggerEvent works through the integrations one at
     * a time.
     */
    it("gives up on a broker that accepts and then goes quiet", async () => {
        behaviour.silent = true;

        await assert.rejects(() => send({timeout: 300}), /did not answer within/);
    });

    it("reports a port with nothing behind it", async () => {
        await assert.rejects(() => publish({
            host: "127.0.0.1", port: 1, topic: "t", payload: Buffer.alloc(0), timeout: TIMEOUT
        }), /ECONNREFUSED|EACCES|closed the connection/);
    });
});

describe("the packet length", () => {
    /**
     * A payload past the single-byte length boundary, which is where a varint
     * written by hand goes wrong - and 128 bytes of JSON is an ordinary
     * speedtest result rather than an edge case.
     */
    it("is right for a payload that needs a multi-byte length", async () => {
        const payload = Buffer.from("x".repeat(500));

        await send({payload});

        assert.equal(contentOf(await publishedMessage()).body.length, 500,
            "the broker read a different number of bytes than were sent");
    });

    it("agrees with what the reader expects", () => {
        // The stub above parses with the same reader the client writes for, so
        // this pins the two against each other directly rather than through a
        // socket.
        assert.deepEqual([...encodeLength(500)], [0xf4, 0x03]);
    });
});
