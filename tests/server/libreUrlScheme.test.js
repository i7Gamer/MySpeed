import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { targetProblem } from "../../server/controller/targets.js";
import { ALLOWED_PROTOCOLS } from "../../server/util/safeUrl.js";

/**
 * The one stored URL the scheme check had never reached.
 *
 * The librespeed backend address was validated by whether `new URL()` could
 * parse it - which is true of `javascript:`, `data:`, `file:` and every other
 * scheme the parser knows. So the setting accepted, stored and displayed
 * values that are not addresses of anything the server can fetch, and the only
 * sign of it was a speedtest failing later for a reason that named none of
 * this.
 *
 * A node URL has been held to http-or-https since safeUrl was written, and a
 * webhook target since checkOutboundTarget joined it. This is the third value
 * of the same kind, judged by the same set rather than by a list of its own:
 * two lists drift, and the whole argument for one home is that the next scheme
 * question gets one answer. It lives on the target rows now, so the question
 * is put to targetProblem.
 */
const libre = (endpoint) => ({name: "Own backend", provider: "libre", endpoint});

const refuses = (endpoint) => {
    const answer = targetProblem(libre(endpoint));

    assert.notEqual(answer, null, `endpoint=${JSON.stringify(endpoint)} was accepted`);
    return answer;
};

const accepts = (endpoint) => {
    const answer = targetProblem(libre(endpoint));

    assert.equal(answer, null, `endpoint=${JSON.stringify(endpoint)} was refused with "${answer}"`);
};

describe("the librespeed backend URL", () => {
    it("accepts the two schemes the server can actually fetch", () => {
        accepts("http://speed.lan:8080");
        accepts("https://speed.example.net/backend");
    });

    // No custom backend at all - the shape "choose a server automatically"
    // stores. It is not a URL and must not be judged as one.
    it("still accepts an unset endpoint", () => {
        accepts(null);
    });

    for (const value of ["javascript:alert(1)", "file:///etc/passwd", "ftp://speed.lan",
        "data:text/plain,hello", "gopher://speed.lan"])
        it(`refuses ${value}`, () => {
            assert.match(refuses(value), /protocol/);
        });

    it("still refuses something that is not a URL at all", () => {
        assert.match(refuses("not a url"), /URL/);
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
