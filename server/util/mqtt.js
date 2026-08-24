import net from "node:net";
import tls from "node:tls";
import { randomBytes } from "node:crypto";

/**
 * Enough of MQTT 3.1.1 to publish a message, and nothing else.
 *
 * Upstream #1190 asks for MQTT and #807 asks for Home Assistant, which is the
 * same request: an entity in Home Assistant is an MQTT topic somebody publishes
 * to. What that needs is four packets - CONNECT, CONNACK, PUBLISH, DISCONNECT -
 * and at QoS 0 there is no acknowledgement state machine at all.
 *
 * Written out rather than taken from the standard client, which is sixteen
 * transitive dependencies and 1.9 MB for a path that uses almost none of it.
 * This is deliberately the opposite call from the one the email module makes:
 * SMTP's long tail lives in other people's servers, where a library has already
 * been round the houses, while MQTT is a tight binary spec that Mosquitto, EMQX
 * and HiveMQ all read the same way. Owning the socket also means the outbound
 * guard and the shared deadline apply here exactly as they do everywhere else,
 * rather than having to be worked around a library's own connect path.
 *
 * No subscribe, no QoS 2, no MQTT 5 properties, no keepalive ping - a
 * connect-publish-disconnect cycle never idles long enough to need one.
 */

export const CONNECT = 1;
export const CONNACK = 2;
export const PUBLISH = 3;
export const PUBACK = 4;
export const DISCONNECT = 14;

/** MQTT 3.1.1. The name is fixed by the specification and so is the level. */
const PROTOCOL_NAME = "MQTT";
const PROTOCOL_LEVEL = 4;

/** Clean session: nothing here subscribes, so a broker has no state to keep. */
const CLEAN_SESSION = 0x02;
const PASSWORD_FLAG = 0x40;
const USERNAME_FLAG = 0x80;

/**
 * The largest remaining length the four-byte field can describe. Beyond it there
 * is no encoding, so a longer packet is refused rather than wrapped into a
 * shorter length the broker would read as the end of the message.
 */
export const MAX_PAYLOAD_LENGTH = 268435455;

const CONTINUATION = 0x80;
const SEVEN_BITS = 0x7f;
const VARINT_SHIFT = 128;
const MAX_LENGTH_BYTES = 4;

/**
 * The remaining-length field: seven bits per byte, with the top bit saying
 * another follows.
 *
 * The boundaries are where this goes wrong, which is why the tests walk them: a
 * length encoded one byte short leaves the broker reading the next packet's
 * header as this packet's payload, and it answers that by hanging up with
 * nothing said.
 */
export const encodeLength = (value) => {
    if (!Number.isInteger(value) || value < 0 || value > MAX_PAYLOAD_LENGTH)
        throw new Error(`An MQTT packet of ${value} bytes is too large to describe`);

    const bytes = [];
    let remaining = value;

    do {
        let byte = remaining % VARINT_SHIFT;
        remaining = Math.floor(remaining / VARINT_SHIFT);

        if (remaining > 0) byte |= CONTINUATION;

        bytes.push(byte);
    } while (remaining > 0);

    return Buffer.from(bytes);
};

/**
 * A UTF-8 string with its **byte** count in front.
 *
 * Counted in bytes rather than characters, because the topic and the payload
 * carry whatever an operator typed: a length counted in characters puts every
 * following field at the wrong offset, which is the same malformed packet as
 * above.
 */
export const encodeString = (value) => {
    const body = Buffer.from(String(value ?? ""), "utf8");
    const header = Buffer.alloc(2);

    header.writeUInt16BE(body.length);

    return Buffer.concat([header, body]);
};

const packet = (type, flags, body) =>
    Buffer.concat([Buffer.from([(type << 4) | flags]), encodeLength(body.length), body]);

export const connectPacket = ({clientId, username, password, keepAlive}) => {
    // The password flag without a password is a malformed packet, and a broker
    // that wants only a username is ordinary - so the two are decided
    // separately rather than as one "has credentials".
    const flags = CLEAN_SESSION
        | (username ? USERNAME_FLAG : 0)
        | (username && password ? PASSWORD_FLAG : 0);

    const keepAliveBytes = Buffer.alloc(2);
    keepAliveBytes.writeUInt16BE(keepAlive);

    return packet(CONNECT, 0, Buffer.concat([
        encodeString(PROTOCOL_NAME),
        Buffer.from([PROTOCOL_LEVEL, flags]),
        keepAliveBytes,
        encodeString(clientId),
        ...(username ? [encodeString(username)] : []),
        ...(username && password ? [encodeString(password)] : [])
    ]));
};

/**
 * The payload as bytes.
 *
 * A string is accepted as well as a Buffer, because a payload is very often one
 * - JSON.stringify answers a string, and every caller here is publishing JSON.
 * Encoded as UTF-8, which is what the length in front of the topic is counted in
 * too.
 */
const payloadBytes = (payload) =>
    Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ""), "utf8");

export const publishPacket = ({topic, payload, qos = 0, retain = false, packetId}) => {
    const flags = (retain ? 0x01 : 0) | ((qos & 0x03) << 1);

    // Only above QoS 0, and immediately after the topic: sending one at QoS 0
    // shifts the whole payload two bytes along.
    const identifier = Buffer.alloc(qos > 0 ? 2 : 0);
    if (qos > 0) identifier.writeUInt16BE(packetId);

    return packet(PUBLISH, flags, Buffer.concat([encodeString(topic), identifier, payloadBytes(payload)]));
};

export const DISCONNECT_PACKET = Buffer.from([DISCONNECT << 4, 0x00]);

/**
 * The first whole packet in a buffer, or null while it is still arriving.
 *
 * TCP delivers bytes rather than packets: a CONNACK can arrive split across two
 * reads, or trailing something else in one. The caller keeps the tail and asks
 * again.
 */
export const readPacket = (buffer) => {
    if (buffer.length < 2) return null;

    let length = 0;
    let multiplier = 1;
    let index = 1;

    while (index <= MAX_LENGTH_BYTES) {
        if (index >= buffer.length) return null;

        const byte = buffer[index];
        length += (byte & SEVEN_BITS) * multiplier;
        index++;

        if ((byte & CONTINUATION) === 0) break;

        multiplier *= VARINT_SHIFT;
    }

    if (buffer.length < index + length) return null;

    return {
        type: buffer[0] >> 4,
        flags: buffer[0] & 0x0f,
        body: buffer.subarray(index, index + length),
        consumed: index + length
    };
};

/**
 * What a broker's CONNACK return code means, in words an operator can act on.
 *
 * The code alone is a single byte and the connection is closed straight after
 * it, so without this the only thing to report is that the broker said no.
 */
const CONNACK_REASONS = {
    1: "the broker refused the protocol version",
    2: "the broker rejected the client id",
    3: "the broker is unavailable",
    4: "the username or password was wrong",
    5: "the broker refused this client"
};

const CONNECTION_ACCEPTED = 0;

/** Seconds. Only stated because CONNECT has a field for it; nothing idles. */
const KEEP_ALIVE_SECONDS = 30;

const MAX_PACKET_ID = 0xffff;

/** A client id a broker will accept, and that names what connected. */
export const generateClientId = () => `myspeed-${randomBytes(4).toString("hex")}`;

/**
 * Connects, publishes one message, and disconnects.
 *
 * Resolves when the broker has taken the message - which at QoS 0 means the
 * bytes are away, and at QoS 1 means a PUBACK came back. Rejects with something
 * worth reading on every other outcome.
 *
 * One connection per message rather than one held open. These arrive at most
 * once per speedtest, so a persistent session would spend the whole gap between
 * two runs idle, need a keepalive to stay up, need tearing down on shutdown, and
 * need rebuilding whenever the integration is reconfigured - none of which any
 * other integration in this project has to think about, for a saving of one
 * handshake an hour.
 */
export const publishAll = ({host, port, secure, username, password, clientId, messages,
                               qos = 0, timeout}) => new Promise((resolve, reject) => {
    let settled = false;
    let received = Buffer.alloc(0);
    let socket;

    /**
     * The failure door. destroy() rather than end(), because there is nothing
     * left worth flushing and a broker that has stopped reading would otherwise
     * hold the handle - and the process - open until its own timeout.
     */
    const fail = (error) => {
        if (settled) return;
        settled = true;

        clearTimeout(timer);
        socket?.destroy();
        reject(error);
    };

    /**
     * The success door, and it has to go through end() rather than destroy().
     *
     * destroy() closes the socket immediately and discards whatever has not
     * reached the operating system yet - so at QoS 0, where nothing is waited
     * for, the PUBLISH this whole function exists to send could be thrown away
     * on the way out. Whether it survived depended on how much of it happened to
     * flush synchronously, which is to say on the size of the payload.
     *
     * end() writes the goodbye, flushes what is queued behind it and sends FIN;
     * its callback is what says the bytes are away. `close` fires afterwards and
     * finds the latch already set.
     */
    const succeed = () => {
        if (settled) return;

        socket.end(DISCONNECT_PACKET, () => {
            if (settled) return;
            settled = true;

            clearTimeout(timer);
            resolve();
        });
    };

    const timer = setTimeout(() =>
        fail(new Error(`The broker did not answer within ${Math.round(timeout / 1000)} seconds`)), timeout);

    /*
     * One identifier per message, counted from one.
     *
     * Distinct, because at QoS 1 the exchange is over when the *last* one has
     * been acknowledged: two messages sharing an id would have one PUBACK close
     * a connection with a message still outstanding. Wrapped rather than allowed
     * to run past the field, and never zero, which the protocol reserves.
     *
     * Counted rather than begun somewhere random, which is what this did until
     * CodeQL pointed out that reducing crypto bytes with `%` biases the result.
     * The bias was real - 0xffff values folded onto 0xfffe - but the randomness
     * was the actual mistake: an identifier is not a secret, it exists to match
     * a PUBLISH to its PUBACK within one connection, and CONNECT always sets
     * CLEAN_SESSION, so no broker state survives a reconnect for a random start
     * to have been avoiding.
     */
    const identifierFor = (index) => (index % MAX_PACKET_ID) + 1;

    let acknowledged = 0;

    const sendMessages = () => {
        messages.forEach((message, index) => socket.write(publishPacket({
            topic: message.topic,
            payload: message.payload,
            qos,
            // Per message rather than per call: a discovery config has to be
            // retained and the result beside it does not.
            retain: message.retain === true,
            packetId: identifierFor(index)
        })));

        // At QoS 0 there is nothing to wait for: the broker acknowledges
        // nothing, so the messages are as delivered as they are ever going to be
        // once the bytes have left. succeed() is what makes sure they have.
        if (qos === 0) succeed();
    };

    const handle = (received) => {
        if (received.type === CONNACK) {
            const code = received.body[1];

            if (code !== CONNECTION_ACCEPTED)
                return fail(new Error(CONNACK_REASONS[code] ?? `the broker refused the connection (${code})`));

            return sendMessages();
        }

        // Counted rather than taken as the end: the last acknowledgement is what
        // finishes the exchange, and the broker may answer them in any order.
        if (received.type === PUBACK && ++acknowledged >= messages.length) succeed();
    };

    try {
        const options = {host, port, ...(secure ? {servername: host} : {})};

        socket = secure ? tls.connect(options) : net.connect(options);
    } catch (error) {
        return fail(error);
    }

    socket.on("connect", () => socket.write(connectPacket({
        clientId: clientId || generateClientId(),
        username, password,
        keepAlive: KEEP_ALIVE_SECONDS
    })));

    // tls.connect announces itself differently, and writing before the handshake
    // finishes would send the CONNECT in the clear.
    socket.on("secureConnect", () => socket.write(connectPacket({
        clientId: clientId || generateClientId(),
        username, password,
        keepAlive: KEEP_ALIVE_SECONDS
    })));

    socket.on("data", (chunk) => {
        received = Buffer.concat([received, chunk]);

        for (let next = readPacket(received); next !== null; next = readPacket(received)) {
            received = received.subarray(next.consumed);
            handle(next);

            if (settled) return;
        }
    });

    socket.on("error", (error) => fail(error));

    // A broker that hangs up without answering. Harmless once the exchange is
    // over - the latch is already set by then - and the one thing that would
    // otherwise leave this promise pending until the timeout.
    socket.on("close", () => fail(new Error("The broker closed the connection")));
});

/**
 * One message, which is publishAll with a list of one.
 *
 * Kept as its own name because it is what almost every caller wants, and because
 * reading `publishAll({messages: [one]})` at a call site says less than this
 * does.
 */
export const publish = ({topic, payload, retain = false, ...connection}) =>
    publishAll({...connection, messages: [{topic, payload, retain}]});
