import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readPasswords, writePasswordHeaders } from "../../server/util/passwordHeader.js";

/**
 * What a raw HTTP header value can actually carry.
 *
 * writePasswordHeaders guarded the plain `password` header with
 * `/^[\x00-\xFF]*$/` - "every code point fits in a byte" - which is not the
 * same question as "Node's http client will accept this in a header value".
 * Node's own checkInvalidHeaderChar refuses \x00-\x08, \x0A-\x1F (control
 * characters, CR and LF included) and \x7F, and a node password holding one of
 * those - restored from a backup, say, since nothing on the import path checks
 * a row this way - reached http.request and threw synchronously. Every
 * proxied request under that node then 500'd, because the throw happened
 * inside the same call that builds the request the caller was waiting on.
 *
 * The encoded `x-password` header is unaffected either way: encodeURIComponent
 * never produces a byte outside 0x21-0x7E, so it always passes both the old
 * regex and the new one, and readPasswords already prefers it when it decodes
 * to something usable. So the fix is only ever narrowing which passwords also
 * get the plain header - it can only remove a 500, never add one.
 */

// The four bytes Node's own header-value check refuses, one from each of the
// ranges the fixed regex has to exclude: a low control character, the CR of a
// CRLF pair, DEL, and the last printable-ASCII byte the regex must still admit
// for comparison.
const CRLF_INJECTION = "abc\r\nX-Injected: 1";
const WITH_DEL = "abc" + String.fromCharCode(0x7f);
const PLAIN = "correct horse battery staple";
const WITH_LATIN1 = "cafe" + "é"; // "café" - one code point, one byte (0xE9).

describe("writePasswordHeaders", () => {
    it("sends both headers for a plain password", () => {
        const headers = writePasswordHeaders(PLAIN);

        assert.equal(headers["x-password"], encodeURIComponent(PLAIN));
        assert.equal(headers.password, PLAIN);
    });

    it("sends only the encoded header for a password carrying CR or LF", () => {
        const headers = writePasswordHeaders(CRLF_INJECTION);

        assert.equal(headers["x-password"], encodeURIComponent(CRLF_INJECTION));
        assert.equal(headers.password, undefined,
            "a header value Node refuses to send was handed to it anyway");
    });

    it("sends only the encoded header for a password carrying DEL (0x7F)", () => {
        const headers = writePasswordHeaders(WITH_DEL);

        assert.equal(headers["x-password"], encodeURIComponent(WITH_DEL));
        assert.equal(headers.password, undefined);
    });

    // A code point that fits in one byte and sits in the upper range Node does
    // accept - the case the old regex was written for - still gets both headers.
    it("still sends both headers for a password with a byte-sized non-ASCII character", () => {
        const headers = writePasswordHeaders(WITH_LATIN1);

        assert.equal(headers["x-password"], encodeURIComponent(WITH_LATIN1));
        assert.equal(headers.password, WITH_LATIN1);
    });

    it("sends nothing for no password and for the clearing sentinel", () => {
        assert.deepEqual(writePasswordHeaders(null), {});
        assert.deepEqual(writePasswordHeaders("none"), {});
    });
});

describe("readPasswords recovering from the encoded header alone", () => {
    it("decodes a password that could only travel encoded", () => {
        const headers = writePasswordHeaders(CRLF_INJECTION);
        const recovered = readPasswords({headers});

        assert.deepEqual(recovered, [CRLF_INJECTION]);
    });

    it("decodes an ordinary password the same way whichever header carried it", () => {
        const headers = writePasswordHeaders(PLAIN);
        const recovered = readPasswords({headers});

        assert.ok(recovered.includes(PLAIN), "the plain password was not recovered");
    });
});

/**
 * The same question put to Node's own http client rather than to a regex that
 * merely claims to model it - a local server on an ephemeral port, so this
 * runs everywhere the suite does.
 */
describe("what http.request actually accepts", () => {
    let server;
    let received;

    const listen = () => new Promise((resolve) => {
        server = http.createServer((req, res) => {
            received = req.headers;
            res.writeHead(200);
            res.end();
        });
        server.listen(0, "127.0.0.1", () => resolve());
    });

    const send = (headers) => new Promise((resolve, reject) => {
        const {port} = server.address();
        const request = http.request({host: "127.0.0.1", port, path: "/", headers}, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
        });
        request.on("error", reject);
        request.end();
    });

    after(() => new Promise((resolve) => server ? server.close(resolve) : resolve()));

    it("throws on a raw password header carrying CR/LF, which is what used to 500", async () => {
        await listen();

        assert.throws(() => http.request({host: "127.0.0.1", port: server.address().port,
            path: "/", headers: {password: CRLF_INJECTION}}),
            /invalid character/i);
    });

    it("accepts the encoded-only headers writePasswordHeaders now produces for it", async () => {
        const status = await send(writePasswordHeaders(CRLF_INJECTION));

        assert.equal(status, 200);
        assert.equal(received.password, undefined);
        assert.equal(received["x-password"], encodeURIComponent(CRLF_INJECTION));
    });

    it("accepts both headers for a plain password", async () => {
        const status = await send(writePasswordHeaders(PLAIN));

        assert.equal(status, 200);
        assert.equal(received.password, PLAIN);
        assert.equal(received["x-password"], encodeURIComponent(PLAIN));
    });
});
