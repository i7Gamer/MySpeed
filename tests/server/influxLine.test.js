import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildLine } from "../../server/integrations/influxdb.js";

const TIMESTAMP = 1786100000;

const fields = {download: 100, upload: 50, ping: 10, jitter: 2};

describe("influx line protocol", () => {
    it("builds a line from a measurement, tags and fields", () => {
        const line = buildLine("speedtests", {host: "server1"}, fields, TIMESTAMP);
        assert.equal(line, `speedtests,host=server1 download=100,upload=50,ping=10,jitter=2 ${TIMESTAMP}`);
    });

    it("omits the tag section when there are no tags", () => {
        assert.match(buildLine("speedtests", {}, fields, TIMESTAMP), /^speedtests download=/);
    });

    it("drops empty, null and undefined tag values", () => {
        const line = buildLine("speedtests", {a: "", b: null, c: undefined, d: "keep"}, fields, TIMESTAMP);
        assert.match(line, /^speedtests,d=keep /);
    });

    it("keeps only finite numeric fields", () => {
        const line = buildLine("m", {}, {ok: 1, text: "no", nan: NaN, inf: Infinity}, TIMESTAMP);
        assert.equal(line, `m ok=1 ${TIMESTAMP}`);
    });

    it("escapes spaces, commas and equals in tag keys and values", () => {
        const line = buildLine("m", {"my key": "a,b c=d"}, fields, TIMESTAMP);
        assert.match(line, /my\\ key=a\\,b\\ c\\=d/);
    });

    /**
     * Regression: escapeTag covered space, comma and equals but not the
     * backslash. A tag value ending in one emitted a trailing backslash right
     * before the comma the join inserts, so the parser read that comma as
     * escaped and swallowed the next tag into this value.
     */
    it("escapes a backslash so it cannot escape the delimiter", () => {
        const line = buildLine("m", {path: "C:\\\\", second: "kept"}, fields, TIMESTAMP);

        assert.match(line, /path=C:\\\\\\\\/);
        assert.match(line, /,second=kept/);
    });

    it("escapes a trailing backslash without swallowing the next tag", () => {
        const tagSection = buildLine("m", {first: "ends\\", second: "kept"}, fields, TIMESTAMP).split(" ")[0];

        // Every backslash is doubled, so no odd-length run can escape the comma.
        for (const run of tagSection.match(/\\+/g) ?? [])
            assert.equal(run.length % 2, 0, `odd backslash run "${run}" in ${tagSection}`);
    });

    // The measurement name was interpolated raw, so a name with a space or a
    // comma silently produced an unparseable write.
    it("escapes spaces and commas in the measurement name", () => {
        assert.match(buildLine("my speeds,eu", {}, fields, TIMESTAMP), /^my\\ speeds\\,eu /);
    });

    it("leaves the equals sign alone in a measurement name", () => {
        assert.match(buildLine("a=b", {}, fields, TIMESTAMP), /^a=b /);
    });
});
