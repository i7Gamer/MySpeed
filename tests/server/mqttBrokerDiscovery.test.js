import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import setupMqtt, { forgetAnnouncements } from "../../server/integrations/mqtt.js";
import { CONNECT, PUBLISH, readPacket } from "../../server/util/mqtt.js";

const LOOPBACK_A = "127.0.0.1";
const LOOPBACK_B = "127.0.0.2";
const EPHEMERAL_PORT = 0;
const DISCOVERY_SENSOR_COUNT = 7;
const TOPIC_LENGTH_BYTES = 2;
const CONNECTION_ACCEPTED_PACKET = Buffer.from([0x20, 0x02, 0x00, 0x00]);
const TEST_TIMEOUT_MS = 5000;
const RESULT = {id: 12, provider: "ookla", ping: 12.4, download: 100.5, upload: 50.2};
const SECONDARY = {...RESULT, primary: false, targetId: 7, targetName: "LAN Box"};

beforeEach(() => forgetAnnouncements());

// Each real TCP endpoint records a complete exchange, including the peer's
// disconnect. No timer guesses when its QoS-0 publications have arrived.
const startBroker = async (t, host = LOOPBACK_A, port = EPHEMERAL_PORT) => {
    const sockets = new Set();
    const waiting = [];
    const server = net.createServer((socket) => {
        sockets.add(socket);
        let buffered = Buffer.alloc(0);
        const messages = [];
        socket.on("data", (chunk) => {
            buffered = Buffer.concat([buffered, chunk]);
            for (let packet = readPacket(buffered); packet !== null; packet = readPacket(buffered)) {
                buffered = buffered.subarray(packet.consumed);
                if (packet.type === CONNECT) socket.write(CONNECTION_ACCEPTED_PACKET);
                if (packet.type === PUBLISH) {
                    const length = packet.body.readUInt16BE(0);
                    messages.push({
                        topic: packet.body.subarray(TOPIC_LENGTH_BYTES, TOPIC_LENGTH_BYTES + length).toString(),
                        payload: JSON.parse(packet.body.subarray(TOPIC_LENGTH_BYTES + length).toString())
                    });
                }
            }
        });
        socket.on("error", () => undefined);
        socket.on("close", () => {
            sockets.delete(socket);
            waiting.shift()?.(messages);
        });
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
    });
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
    });

    return {
        host,
        port: server.address().port,
        async receive(overrides = {}, payload = RESULT) {
            const completed = new Promise((resolve) => waiting.push(resolve));
            const events = {};
            setupMqtt((name, callback) => { events[name] = callback; });
            const outcomes = [];
            await events.testFinished({data: {
                host, port: server.address().port, topic: "myspeed/shared",
                discovery: true, send_finished: true, ...overrides
            }}, payload, (failed) => outcomes.push(failed));
            assert.deepEqual(outcomes, [false], "the broker must actually accept the send");
            return completed;
        }
    };
};

const configs = (messages) => messages.filter(({topic}) => topic.endsWith("/config"));

describe("MQTT discovery belongs to its destination broker", {timeout: TEST_TIMEOUT_MS}, () => {
    for (const changed of ["host", "port"]) {
        for (const payload of [RESULT, SECONDARY]) {
            it(`announces ${payload === RESULT ? "primary" : "secondary"} sensors after a broker ${changed} change`, async (t) => {
                const first = await startBroker(t);
                const second = await startBroker(t, changed === "host" ? LOOPBACK_B : LOOPBACK_A,
                    changed === "host" ? first.port : EPHEMERAL_PORT);
                const original = await first.receive({}, payload);
                assert.equal(configs(original).length, DISCOVERY_SENSOR_COUNT);

                // Same process and same topic/target: clearing announcements
                // between these sends would conceal the original defect.
                const moved = await second.receive({}, payload);
                assert.equal(configs(moved).length, DISCOVERY_SENSOR_COUNT,
                    "results reached the second broker without their discovery configuration");
                assert.equal(moved.filter(({topic}) => !topic.endsWith("/config")).length, 1);
                assert.deepEqual(configs(moved).map(({payload: value}) => value.state_topic),
                    configs(original).map(({payload: value}) => value.state_topic));

                assert.equal(configs(await second.receive({}, payload)).length, 0);
                assert.equal(configs(await first.receive({}, payload)).length, 0,
                    "returning to a broker that already holds discovery needlessly announced again");
            });
        }
    }

    it("treats equivalent numeric port spellings as the same destination", async (t) => {
        const broker = await startBroker(t);
        assert.equal(configs(await broker.receive()).length, DISCOVERY_SENSOR_COUNT);
        assert.equal(configs(await broker.receive({port: `0${broker.port}`})).length, 0);
        assert.equal(configs(await broker.receive({port: String(broker.port)})).length, 0);
    });

    it("does not confuse delimiter-bearing prefixes and topics", async (t) => {
        const broker = await startBroker(t);
        const first = {discovery_prefix: "homeassistant|branch", topic: "myspeed"};
        const second = {discovery_prefix: "homeassistant", topic: "branch|myspeed"};
        assert.equal(configs(await broker.receive(first)).length, DISCOVERY_SENSOR_COUNT);
        const changed = configs(await broker.receive(second));
        assert.equal(changed.length, DISCOVERY_SENSOR_COUNT);
        for (const {topic, payload} of changed) {
            assert.ok(topic.startsWith("homeassistant/sensor/"));
            assert.equal(payload.state_topic, second.topic);
        }
    });
});
