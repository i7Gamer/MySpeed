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
     * The scheme check ran alone: `new URL()` parses an address as readily as
     * a hostname, and nothing after it asked whether that address was one this
     * server should ever fetch. So a libre target's endpoint was the one
     * stored outbound URL in the codebase that reached librespeed-cli without
     * passing through checkOutboundHost - every run handed the metadata
     * service's address to the CLI on schedule.
     */
    it("refuses the cloud metadata service", () => {
        assert.match(refuses("http://169.254.169.254/latest/meta-data/"), /link-local/);
    });

    // The same service in the other family, which is Unique-Local rather than
    // link-local - bareHost strips the brackets a v6 literal carries in a URL,
    // so it is judged the same as the bare address above.
    it("refuses the cloud metadata service over IPv6", () => {
        assert.match(refuses("http://[fd00:ec2::254]/latest/meta-data/"), /metadata/);
    });

    // Loopback and the private ranges stay allowed, the same as for a node: an
    // endpoint on the operator's own LAN is the ordinary case this provider
    // exists for, not something to refuse.
    it("still accepts an ordinary LAN endpoint", () => {
        accepts("http://speed.lan:8080");
        accepts("http://192.168.1.10/");
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
