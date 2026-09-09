import {afterEach, it} from "node:test";
import assert from "node:assert/strict";
import previewReadOnly from "../../server/middlewares/previewReadOnly.js";
const original = process.env.PREVIEW_MODE;
afterEach(() => {if (original === undefined) delete process.env.PREVIEW_MODE; else process.env.PREVIEW_MODE = original;});
for (const [name, middleware, message] of [["default", previewReadOnly, "You can't change anything on this instance in preview mode"], ["saying", previewReadOnly.saying("existing wording"), "existing wording"], ["blocking", previewReadOnly.blocking("existing wording"), "existing wording"]]) {
    it(`${name} retains its refusal and adds a stable machine-readable type`, () => {
        process.env.PREVIEW_MODE = "true";
        const res = {status(value) {this.statusCode = value; return this;}, json(value) {this.body = value; return this;}};
        middleware({method: "PUT"}, res, () => assert.fail("request allowed"));
        assert.equal(res.statusCode, 403); assert.deepEqual(res.body, {message, type: "PREVIEW_READ_ONLY"});
    });
}
