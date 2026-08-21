import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateInput } from "../../server/controller/config.js";
import { ALLOWED_PROTOCOLS } from "../../server/util/safeUrl.js";

/**
 * The one stored URL the scheme check had never reached.
 *
 * libreUrl is the librespeed backend address, and it was validated by whether
 * `new URL()` could parse it - which is true of `javascript:`, `data:`, `file:`
 * and every other scheme the parser knows. So the setting accepted, stored and
 * displayed values that are not addresses of anything the server can fetch, and
 * the only sign of it was a speedtest failing later for a reason that named none
 * of this.
 *
 * A node URL has been held to http-or-https since safeUrl was written, and a
 * webhook target since checkOutboundTarget joined it. This is the third value of
 * the same kind, judged by the same set rather than by a list of its own: two
 * lists drift, and the whole argument for one home is that the next scheme
 * question gets one answer.
 */
const refuses = async (value) => {
    const answer = await validateInput("libreUrl", value);

    assert.equal(typeof answer, "string", `libreUrl=${JSON.stringify(value)} was accepted`);
    return answer;
};

const accepts = async (value) => {
    const answer = await validateInput("libreUrl", value);

    assert.notEqual(typeof answer, "string",
        `libreUrl=${JSON.stringify(value)} was refused with "${answer}"`);
};

describe("the librespeed backend URL", () => {
    it("accepts the two schemes the server can actually fetch", async () => {
        await accepts("http://speed.lan:8080");
        await accepts("https://speed.example.net/backend");
    });

    // The sentinel for "no custom backend". It is not a URL and must not be
    // judged as one, or choosing automatic selection stops being possible.
    it("still accepts the unset sentinel", async () => {
        await accepts("none");
    });

    for (const value of ["javascript:alert(1)", "file:///etc/passwd", "ftp://speed.lan",
        "data:text/plain,hello", "gopher://speed.lan"])
        it(`refuses ${value}`, async () => {
            assert.match(await refuses(value), /valid URL/);
        });

    it("still refuses something that is not a URL at all", async () => {
        assert.match(await refuses("not a url"), /valid URL/);
    });

    /**
     * And it is the same set the node and webhook guards read. A copy here would
     * be a second answer to a question the codebase has already settled once.
     */
    it("judges by the set the other stored URLs are judged by", () => {
        assert.deepEqual([...ALLOWED_PROTOCOLS].sort(), ["http:", "https:"],
            "the shared set no longer says what a fetchable URL is");
    });
});
