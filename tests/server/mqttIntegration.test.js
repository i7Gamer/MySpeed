import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import setupMqtt from "../../server/integrations/mqtt.js";
import { CONNACK, CONNECT, PUBLISH, readPacket } from "../../server/util/mqtt.js";

/**
 * The MQTT integration, which is upstream #1190 and #807.
 *
 * #807 asks for "integration with Home Assistant" and #1190 for MQTT, and they
 * are the same request: a Home Assistant entity is an MQTT topic somebody
 * publishes to. So the payload is the flat JSON every other consumer already
 * gets - the same vocabulary as the webhook, the CSV export and the API - which
 * a Home Assistant sensor reads straight off with `value_json.download`.
 *
 * Driven against the same loopback stub the client's own tests use: what matters
 * is that a broker can read what was sent.
 */
let broker;
let port;
let seen;
let refuseConnection;

const CONNECTION_ACCEPTED = 0;

before(async () => {
    broker = net.createServer((socket) => {
        let buffered = Buffer.alloc(0);

        socket.on("data", (chunk) => {
            buffered = Buffer.concat([buffered, chunk]);

            for (let next = readPacket(buffered); next !== null; next = readPacket(buffered)) {
                buffered = buffered.subarray(next.consumed);
                seen.push(next);

                if (next.type === CONNECT)
                    socket.write(Buffer.from([CONNACK << 4, 0x02, 0x00,
                        refuseConnection ? 4 : CONNECTION_ACCEPTED]));
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
    seen = [];
    refuseConnection = false;
});

const load = () => {
    const events = {};
    const definition = setupMqtt((name, callback) => { events[name] = callback; });

    return {events, definition};
};

const config = (overrides = {}) => ({
    host: "127.0.0.1", port, topic: "myspeed/result",
    send_finished: true, send_failed: true, ...overrides
});

const RESULT = {id: 12, provider: "ookla", ping: 12.4, download: 100.5, upload: 50.2, packetLoss: 0};
const FAILURE = {id: 13, provider: "ookla", error: "Too many requests. Please try again later"};

let notes = [];

const fire = async (name, settings, payload) => {
    notes = [];
    const {events} = load();

    await events[name]({data: settings}, payload, (failed) => { notes.push(failed); });
};

/** Waits for the stub to have read a PUBLISH, then returns its topic and body. */
const published = async () => {
    for (let attempt = 0; attempt < 500 && !seen.some((p) => p.type === PUBLISH); attempt++)
        await new Promise((resolve) => setImmediate(resolve));

    const message = seen.find((packet) => packet.type === PUBLISH);
    assert.ok(message, "nothing was published");

    const topicLength = message.body.readUInt16BE(0);

    return {
        topic: message.body.subarray(2, 2 + topicLength).toString(),
        payload: JSON.parse(message.body.subarray(2 + topicLength).toString()),
        flags: message.flags
    };
};

describe("a finished test", () => {
    it("is published to the configured topic", async () => {
        await fire("testFinished", config(), RESULT);

        const {topic, payload} = await published();

        assert.equal(topic, "myspeed/result");
        assert.equal(payload.download, 100.5);
        assert.equal(payload.ping, 12.4);
    });

    /**
     * The flat payload every other consumer gets, rather than a shape invented
     * here: a Home Assistant sensor reads `value_json.download`, and a key that
     * exists in the webhook but not here would be a second vocabulary to learn.
     */
    it("carries the whole result rather than a chosen few numbers", async () => {
        await fire("testFinished", config(), RESULT);

        const {payload} = await published();

        for (const key of ["provider", "packetLoss", "id"])
            assert.ok(key in payload, `the payload does not carry ${key}`);
    });

    it("is not published when the operator did not ask for it", async () => {
        await fire("testFinished", config({send_finished: false}), RESULT);

        assert.equal(seen.length, 0);
    });
});

describe("a failed test", () => {
    /**
     * Its own topic, because the two payloads are different shapes - a failure
     * carries `error` and none of the measurements. On one topic a Home
     * Assistant sensor would read a result and then a record with no numbers in
     * it, and go unavailable.
     */
    it("goes to a topic of its own, derived from the base one", async () => {
        await fire("testFailed", config(), FAILURE);

        const {topic, payload} = await published();

        assert.equal(topic, "myspeed/result/error");
        assert.match(payload.error, /Too many requests/);
    });

    it("goes wherever the operator says instead", async () => {
        await fire("testFailed", config({error_topic: "myspeed/broken"}), FAILURE);

        assert.equal((await published()).topic, "myspeed/broken");
    });

    it("is not published when the operator did not ask for it", async () => {
        await fire("testFailed", config({send_failed: false}), FAILURE);

        assert.equal(seen.length, 0);
    });
});

describe("the message settings", () => {
    /**
     * Retained is what makes this useful across a restart: without it a Home
     * Assistant entity reads "unknown" until the next speedtest, which on the
     * default hourly schedule is up to an hour of a sensor that exists and says
     * nothing.
     */
    it("retain when asked", async () => {
        await fire("testFinished", config({retain: true}), RESULT);

        assert.equal((await published()).flags & 0x01, 0x01);
    });

    it("do not retain by default", async () => {
        await fire("testFinished", config(), RESULT);

        assert.equal((await published()).flags & 0x01, 0);
    });

    it("carry the configured QoS", async () => {
        await fire("testFinished", config({qos: 0}), RESULT);

        assert.equal(((await published()).flags & 0x06) >> 1, 0);
    });
});

describe("the outcome", () => {
    it("is noted against the integration when the message goes", async () => {
        await fire("testFinished", config(), RESULT);

        assert.deepEqual(notes, [false]);
    });

    it("is noted as a failure when the broker refuses", async () => {
        refuseConnection = true;

        await fire("testFinished", config(), RESULT);

        assert.deepEqual(notes, [true]);
    });

    /**
     * And does not escape. triggerEvent works through the integrations one at a
     * time, so a throw here takes the ones after it down with this one.
     */
    it("does not throw out of the module when the broker refuses", async () => {
        refuseConnection = true;

        await assert.doesNotReject(() => fire("testFinished", config(), RESULT));
    });
});

/**
 * The guard every HTTP integration inherits from util/http.js, which nothing
 * about a raw MQTT socket goes through.
 */
describe("a broker it may not reach", () => {
    it("is not dialled at a link-local address", async () => {
        await fire("testFinished", config({host: "169.254.169.254"}), RESULT);

        assert.equal(seen.length, 0, "the cloud metadata address was dialled");
        assert.deepEqual(notes, [true]);
    });

    it("is not dialled at the metadata address in the other family", async () => {
        await fire("testFinished", config({host: "fd00:ec2::254"}), RESULT);

        assert.equal(seen.length, 0);
    });
});

describe("the declared fields", () => {
    const fields = () => load().definition.fields;
    const named = (name) => fields().find((field) => field.name === name);

    /**
     * Not a notifier, for the reason influxdb is not one: the threshold settings
     * exist so an operator is told only when the line is bad, and a data sink
     * wants every point. A Home Assistant history with the good results filtered
     * out is not a history.
     */
    it("does not take the shared threshold settings", () => {
        assert.notEqual(load().definition.notifier, true);
    });

    it("requires what a connection cannot be made without", () => {
        for (const name of ["host", "port", "topic"])
            assert.equal(named(name)?.required, true, `${name} is not required`);
    });

    it("does not require credentials, and redacts the password", () => {
        assert.equal(named("username").required, false);
        assert.equal(named("password").required, false);
        assert.equal(named("password").secret, true);
    });

    it("bounds the port to a port", () => {
        assert.equal(named("port").type, "number");
        assert.equal(named("port").min, 1);
        assert.equal(named("port").max, 65535);
    });

    /**
     * Nothing above QoS 1. The client acknowledges a PUBACK and no more, so
     * accepting 2 would store a level that silently behaves as something else.
     */
    it("bounds the QoS to what the client actually speaks", () => {
        assert.equal(named("qos").min, 0);
        assert.equal(named("qos").max, 1);
    });

    /**
     * A wildcard is a subscription, not a destination. A broker refuses a
     * PUBLISH carrying one, so accepting it here would store a topic that can
     * never deliver.
     */
    it("refuses a topic that is a subscription pattern", () => {
        const {regex} = named("topic");

        assert.ok(regex.test("myspeed/result"));
        assert.ok(regex.test("home/myspeed"));

        for (const bad of ["myspeed/+/result", "myspeed/#", "my speed", ""])
            assert.ok(!regex.test(bad), `${JSON.stringify(bad)} was accepted as a topic`);
    });
});
