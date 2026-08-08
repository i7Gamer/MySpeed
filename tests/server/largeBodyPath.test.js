import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLargeBodyPath, LARGE_BODY_PATHS } from "../../server/routes/storage.js";

/**
 * app.js keeps its 100kb parser off these paths so the routes can parse a large
 * body themselves, after authenticating. Getting the match wrong in one
 * direction leaves an anonymous caller able to post 50mb; in the other it
 * breaks the imports the large limit exists for.
 */
describe("isLargeBodyPath", () => {
    it("matches the import endpoints", () => {
        for (const path of LARGE_BODY_PATHS)
            assert.equal(isLargeBodyPath(path), true, `${path} was not matched`);
    });

    it("tolerates a trailing slash", () => {
        assert.equal(isLargeBodyPath("/api/storage/config/"), true);
    });

    /**
     * Regression: the match was an exact-string list, but while a node is
     * selected the client sends these same imports through the proxy prefix.
     * The 100kb parser then ran and every import of a real history failed.
     */
    it("matches the node-proxied form the client actually sends", () => {
        assert.equal(isLargeBodyPath("/api/nodes/1/storage/tests/history"), true);
        assert.equal(isLargeBodyPath("/api/nodes/42/storage/config"), true);
        assert.equal(isLargeBodyPath("/api/nodes/abc-def/storage/config"), true);
    });

    it("does not open up anything else", () => {
        const others = [
            "/api/storage", "/api/storage/tests", "/api/config", "/api/speedtests",
            "/api/nodes/1/config", "/api/nodes/1/speedtests", "/api/nodes",
            "/", "/api/storage/tests/history/csv"
        ];

        for (const path of others)
            assert.equal(isLargeBodyPath(path), false, `${path} was allowed a large body`);
    });

    // Only one path segment is a node id: a deeper prefix must not be stripped
    // into a match.
    it("does not strip more than the node prefix", () => {
        assert.equal(isLargeBodyPath("/api/nodes/1/2/storage/config"), false);
    });
});
