import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    CONNACK, CONNECT, DISCONNECT, DISCONNECT_PACKET, MAX_PAYLOAD_LENGTH, PUBACK, PUBLISH,
    connectPacket, encodeLength, encodeString, publishPacket, readPacket
} from "../../server/util/mqtt.js";

/**
 * MQTT 3.1.1 on the wire, which is upstream #1190 and #807 - the second asks for
 * a Home Assistant integration, and this is what that means in practice.
 *
 * Written out rather than taken from a library. Publishing needs four packets -
 * CONNECT, CONNACK, PUBLISH, DISCONNECT - and at QoS 0 there is no
 * acknowledgement state machine at all; the standard client is sixteen
 * transitive dependencies for a path that uses almost none of it. The tradeoff
 * is the opposite of the one email got: SMTP's variability lives in other
 * people's servers, where a library has been round the houses already, while
 * this is a tight binary spec that Mosquitto, EMQX and HiveMQ all read the same
 * way.
 *
 * The assertions are exact byte sequences. A wire format is the one thing where
 * "it looked right" is not a test: a broker answers a malformed packet by
 * closing the connection, with nothing said about which field was wrong.
 */
describe("the remaining-length varint", () => {
    const bytes = (value) => [...encodeLength(value)];

    /**
     * The boundaries are where this goes wrong. Each additional byte starts one
     * past a power of 128, and the continuation bit is what says another byte
     * follows - a length encoded one byte short leaves the broker reading the
     * next packet's header as this packet's payload.
     */
    it("encodes the single-byte range", () => {
        assert.deepEqual(bytes(0), [0x00]);
        assert.deepEqual(bytes(1), [0x01]);
        assert.deepEqual(bytes(127), [0x7f]);
    });

    it("sets the continuation bit at each boundary", () => {
        assert.deepEqual(bytes(128), [0x80, 0x01]);
        assert.deepEqual(bytes(16383), [0xff, 0x7f]);
        assert.deepEqual(bytes(16384), [0x80, 0x80, 0x01]);
        assert.deepEqual(bytes(2097151), [0xff, 0xff, 0x7f]);
        assert.deepEqual(bytes(2097152), [0x80, 0x80, 0x80, 0x01]);
    });

    // Four bytes is the whole of the field, and the largest packet the protocol
    // can describe. Beyond it there is no encoding at all, so it is refused
    // rather than wrapped into a shorter length the broker would misread.
    it("refuses a length the field cannot hold", () => {
        assert.throws(() => encodeLength(MAX_PAYLOAD_LENGTH + 1), /too large|length/i);
    });
});

describe("a length-prefixed string", () => {
    it("carries its byte count ahead of it", () => {
        assert.deepEqual([...encodeString("MQTT")], [0x00, 0x04, 0x4d, 0x51, 0x54, 0x54]);
    });

    it("is empty-safe", () => {
        assert.deepEqual([...encodeString("")], [0x00, 0x00]);
    });

    /**
     * Bytes, not characters. The topic and the payload can both carry anything
     * an operator typed, and a length counted in characters puts every following
     * field at the wrong offset - which a broker reads as a malformed packet and
     * answers by hanging up.
     */
    it("counts bytes rather than characters", () => {
        assert.deepEqual([...encodeString("ä")], [0x00, 0x02, 0xc3, 0xa4]);
        assert.deepEqual([...encodeString("🙂")], [0x00, 0x04, 0xf0, 0x9f, 0x99, 0x82]);
    });
});

describe("CONNECT", () => {
    const anonymous = connectPacket({clientId: "myspeed-1", keepAlive: 30});

    it("announces the protocol it speaks", () => {
        // Type 1 in the high nibble, no flags. Then the remaining length, then
        // the protocol name and level 4, which is 3.1.1.
        assert.equal(anonymous[0], CONNECT << 4);
        assert.deepEqual([...anonymous.subarray(2, 9)], [0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04]);
    });

    /**
     * Clean session, always. Nothing here subscribes or waits for a queued
     * message, so asking a broker to keep state for this client would leave it
     * holding a session per test for a connection that never comes back.
     */
    it("asks for a clean session and no will", () => {
        assert.equal(anonymous[9], 0x02);
    });

    it("carries the keepalive and the client id", () => {
        assert.deepEqual([...anonymous.subarray(10, 12)], [0x00, 0x1e]);
        assert.deepEqual([...anonymous.subarray(12)], [...encodeString("myspeed-1")]);
    });

    /**
     * The two credential bits sit at the top of the flags byte, and their order
     * in the payload is username then password. Getting either wrong is a
     * connection the broker refuses with a bare return code.
     */
    it("sets both credential flags and appends them in order", () => {
        const packet = connectPacket({clientId: "c", username: "user", password: "pass", keepAlive: 30});

        assert.equal(packet[9] & 0xc0, 0xc0, "the username and password flags are not both set");

        const payload = packet.subarray(12);
        assert.deepEqual([...payload],
            [...encodeString("c"), ...encodeString("user"), ...encodeString("pass")]);
    });

    // A relay that wants only a username is ordinary, and setting the password
    // bit without a password is a malformed packet.
    it("sets only the username flag when there is no password", () => {
        const packet = connectPacket({clientId: "c", username: "user", keepAlive: 30});

        assert.equal(packet[9] & 0xc0, 0x80);
        assert.deepEqual([...packet.subarray(12)], [...encodeString("c"), ...encodeString("user")]);
    });

    it("declares its own remaining length", () => {
        const stated = anonymous[1];

        assert.equal(stated, anonymous.length - 2, "the length field does not describe the packet");
    });
});

describe("PUBLISH", () => {
    it("carries the topic and then the payload, with no packet id at QoS 0", () => {
        const packet = publishPacket({topic: "myspeed/result", payload: Buffer.from("{}"), qos: 0, retain: false});

        assert.equal(packet[0], PUBLISH << 4);
        assert.deepEqual([...packet.subarray(2)], [...encodeString("myspeed/result"), 0x7b, 0x7d]);
    });

    /**
     * Retain is the low bit, and it is what makes this useful to Home Assistant:
     * without it an entity is blank until the next speedtest, which on an hourly
     * schedule means an hour of "unknown" after every restart.
     */
    it("sets the retain bit in the fixed header", () => {
        const packet = publishPacket({topic: "t", payload: Buffer.alloc(0), qos: 0, retain: true});

        assert.equal(packet[0] & 0x01, 0x01);
    });

    it("puts the QoS in bits two and one", () => {
        assert.equal(publishPacket({topic: "t", payload: Buffer.alloc(0), qos: 1, packetId: 1})[0] & 0x06, 0x02);
    });

    // Only at QoS 1 and above, and immediately after the topic. Sending one at
    // QoS 0 shifts the whole payload by two bytes.
    it("carries a packet id only above QoS 0", () => {
        const withId = publishPacket({topic: "t", payload: Buffer.from("x"), qos: 1, packetId: 0x1234});

        assert.deepEqual([...withId.subarray(2)], [...encodeString("t"), 0x12, 0x34, 0x78]);
    });

    /**
     * A string as readily as a Buffer. Every caller here publishes JSON, and
     * JSON.stringify answers a string - so requiring the caller to wrap it was a
     * step each of them had to remember, and forgetting it threw from inside
     * Buffer.concat with a message about "list[2]".
     */
    it("takes a string payload as UTF-8 bytes", () => {
        const fromString = publishPacket({topic: "t", payload: '{"a":1}', qos: 0});
        const fromBuffer = publishPacket({topic: "t", payload: Buffer.from('{"a":1}'), qos: 0});

        assert.deepEqual([...fromString], [...fromBuffer]);
    });

    it("counts a multibyte payload in bytes", () => {
        const packet = publishPacket({topic: "t", payload: "ä", qos: 0});

        assert.deepEqual([...packet.subarray(2)], [...encodeString("t"), 0xc3, 0xa4]);
    });
});

describe("DISCONNECT", () => {
    it("is the two bytes it is allowed to be", () => {
        assert.deepEqual([...DISCONNECT_PACKET], [DISCONNECT << 4, 0x00]);
    });
});

/**
 * The reader, which has to cope with TCP rather than with packets: a broker's
 * CONNACK and PUBACK can arrive in one read, split across two, or trailing the
 * end of something else.
 */
describe("reading a packet off the stream", () => {
    const connack = Buffer.from([CONNACK << 4, 0x02, 0x00, 0x00]);

    it("reads a whole packet and says how much it used", () => {
        const packet = readPacket(connack);

        assert.equal(packet.type, CONNACK);
        assert.equal(packet.consumed, 4);
        assert.deepEqual([...packet.body], [0x00, 0x00]);
    });

    it("answers nothing while the packet is still arriving", () => {
        assert.equal(readPacket(connack.subarray(0, 1)), null);
        assert.equal(readPacket(connack.subarray(0, 3)), null);
        assert.equal(readPacket(Buffer.alloc(0)), null);
    });

    it("leaves whatever followed for the next read", () => {
        const two = Buffer.concat([connack, Buffer.from([PUBACK << 4, 0x02, 0x00, 0x07])]);
        const first = readPacket(two);

        assert.equal(first.consumed, 4);

        const second = readPacket(two.subarray(first.consumed));
        assert.equal(second.type, PUBACK);
        assert.deepEqual([...second.body], [0x00, 0x07]);
    });

    // A length that needs more than one byte, which is where a naive reader that
    // assumes a single-byte header goes wrong.
    it("reads a multi-byte length", () => {
        const body = Buffer.alloc(200, 0x61);
        const packet = readPacket(Buffer.concat([Buffer.from([PUBLISH << 4]), encodeLength(200), body]));

        assert.equal(packet.consumed, 203);
        assert.equal(packet.body.length, 200);
    });
});
