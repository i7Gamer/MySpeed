import { describe, it } from "node:test";
import assert from "node:assert/strict";
import rejectBrotliBody from "../../server/middlewares/rejectBrotliBody.js";

const UNSUPPORTED_MEDIA_TYPE = 415;

const response = () => {
    const res = {statusCode: null, body: null, headers: {}};
    res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
    res.status = (status) => { res.statusCode = status; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
};

const run = (contentEncoding) => {
    const headers = contentEncoding === undefined ? {} : {"content-encoding": contentEncoding};
    const res = response();
    let passedThrough = false;

    rejectBrotliBody()({headers}, res, () => { passedThrough = true; });
    return {res, passedThrough};
};

describe("rejectBrotliBody", () => {
    it("passes a request without a content-encoding", () => {
        assert.equal(run().passedThrough, true);
    });

    for (const encoding of ["identity", "gzip", "deflate", "gzip, deflate", ""]) {
        it(`passes a body encoded as "${encoding}"`, () => {
            const {res, passedThrough} = run(encoding);

            assert.equal(passedThrough, true);
            assert.equal(res.statusCode, null);
        });
    }

    /**
     * CVE-2026-111497: the runtime's Brotli decoder writes out of bounds on a
     * crafted stream, and the JSON parser decodes `br` bodies before any
     * password check runs.
     */
    for (const encoding of ["br", "BR", " br ", "gzip, br", "br,gzip", "deflate,  Br"]) {
        it(`refuses a body encoded as "${encoding}"`, () => {
            const {res, passedThrough} = run(encoding);

            assert.equal(passedThrough, false, "a brotli body reached the decoder");
            assert.equal(res.statusCode, UNSUPPORTED_MEDIA_TYPE);
            assert.equal(res.headers["accept-encoding"], "gzip, deflate");
            assert.ok(res.body?.message);
        });
    }

    // A token match, not a substring one: these are not brotli.
    for (const encoding of ["x-br", "brotli", "gzip, abr"]) {
        it(`does not mistake "${encoding}" for brotli`, () => {
            assert.equal(run(encoding).passedThrough, true);
        });
    }
});
