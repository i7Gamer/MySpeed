import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { headerSafe } from "../../server/util/helpers.js";

/**
 * What may travel in a header value this server writes.
 *
 * DEL (0x7F) is inside the Latin-1 range the class admitted, and node
 * refuses to write it - res.setHeader throws ERR_INVALID_CHAR and the
 * outbound client refuses the value - so a DEL typed into an ntfy title or
 * an InfluxDB token failed the whole request rather than losing one byte.
 */
describe("headerSafe", () => {
    it("keeps printable Latin-1", () => {
        assert.equal(headerSafe('attachment; filename="résumé.csv"'), 'attachment; filename="résumé.csv"');
    });

    it("folds line breaks and drops what a header cannot carry", () => {
        assert.equal(headerSafe("a\r\nb"), "a b");
        assert.equal(headerSafe("a b\u{1F600}"), "ab");
    });

    it("drops DEL, which node refuses to write", () => {
        assert.equal(headerSafe('attachment; filename="a\x7fb.csv"'), 'attachment; filename="ab.csv"');
    });
});
