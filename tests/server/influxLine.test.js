import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildLine, parseTags } from "../../server/integrations/influxdb.js";

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
    /**
     * A newline is not an escapable character in line protocol - it is the
     * record separator, and the protocol has no spelling for one inside a tag.
     * So a value carrying one did not produce a tag with a newline in it: it
     * ended the line early and left the remainder to be parsed as a second
     * point, which influx answers with a 400. Every write from that integration
     * then failed, for a reason nothing on screen connects to the host field.
     *
     * The values here are typed by an operator into the integration's own form,
     * so this is a paste with a stray newline rather than an attack - but it is
     * also the only thing standing between a pasted hostname and an integration
     * that silently never works again.
     */
    describe("a tag value carrying a newline", () => {
        for (const [name, raw] of [["a line feed", "a\nb"], ["a carriage return", "a\rb"],
            ["a windows pair", "a\r\nb"]]) {
            it(`keeps ${name} on one line`, () => {
                const line = buildLine("m", {host: raw}, fields, TIMESTAMP);

                assert.equal(line.includes("\n"), false, "the point was split into two records");
                assert.equal(line.includes("\r"), false);
            });
        }

        it("keeps the text either side of it, separated and escaped", () => {
            const line = buildLine("m", {host: "a\nb"}, fields, TIMESTAMP);

            assert.match(line, /host=a\\ b/, "the newline took the rest of the value with it");
        });

        it("collapses a run of them into a single separator", () => {
            const line = buildLine("m", {host: "a\r\n\n\rb"}, fields, TIMESTAMP);

            assert.match(line, /host=a\\ b/);
        });

        it("handles one in a tag key as well", () => {
            const line = buildLine("m", {"a\nkey": "value"}, fields, TIMESTAMP);

            assert.equal(line.includes("\n"), false);
            assert.match(line, /a\\ key=value/);
        });

        it("handles one in the measurement name", () => {
            const line = buildLine("a\nname", {host: "h"}, fields, TIMESTAMP);

            assert.equal(line.includes("\n"), false);
            assert.match(line, /^a\\ name,/);
        });

        it("leaves a trailing newline behind as an ordinary trailing space", () => {
            const line = buildLine("m", {host: "server1\n"}, fields, TIMESTAMP);

            assert.equal(line.includes("\n"), false);
            assert.match(line, /host=server1\\ /);
        });

        /**
         * The escaping has to happen after the swap, or the space it
         * introduces ends the tag section early - the same break by a different
         * route. Asserted on the whole line rather than on a split at the first
         * space, because the escaped space is still a space: the tag that
         * follows has to survive, and the fields have to still begin where the
         * unescaped separator is.
         */
        it("escapes the separator it introduces", () => {
            const line = buildLine("m", {host: "a\nb", second: "kept"}, fields, TIMESTAMP);

            assert.match(line, /,second=kept download=/,
                "the tag section ended at the space that replaced the newline");
        });
    });

    it("escapes spaces and commas in the measurement name", () => {
        assert.match(buildLine("my speeds,eu", {}, fields, TIMESTAMP), /^my\\ speeds\\,eu /);
    });

    it("leaves the equals sign alone in a measurement name", () => {
        assert.match(buildLine("a=b", {}, fields, TIMESTAMP), /^a=b /);
    });
});

/**
 * The extra tags an operator types into the integration form, as
 * `key=value,key=value`.
 *
 * This split on every `=` and destructured the first two pieces, so a value
 * carrying one of its own lost everything from the second onwards: a perfectly
 * ordinary `source=http://nas.local/?id=1` was stored as
 * `source=http://nas.local/?id`. Silent, and wrong in the direction that
 * matters - the tag is what the series is grouped by in Grafana.
 */
describe("parseTags", () => {
    it("reads a single tag", () => {
        assert.deepEqual(parseTags("site=basement"), {site: "basement"});
    });

    it("reads several tags", () => {
        assert.deepEqual(parseTags("site=basement,rack=a"), {site: "basement", rack: "a"});
    });

    it("trims the whitespace around each part", () => {
        assert.deepEqual(parseTags(" site = basement , rack = a "), {site: "basement", rack: "a"});
    });

    it("keeps everything after the first equals sign", () => {
        assert.deepEqual(parseTags("source=http://nas.local/?id=1"),
            {source: "http://nas.local/?id=1"});
    });

    it("keeps a value that is nothing but equals signs", () => {
        assert.deepEqual(parseTags("padding=a==b=="), {padding: "a==b=="});
    });

    it("drops a fragment with no value", () => {
        assert.deepEqual(parseTags("site=basement,broken,rack=a"), {site: "basement", rack: "a"});
    });

    it("drops a fragment with no key", () => {
        assert.deepEqual(parseTags("=orphan,site=basement"), {site: "basement"});
    });

    /**
     * Only the form guarantees a string here. A hand-crafted PATCH can store a
     * number, and .split on that threw inside the event loop - aborting every
     * integration queued behind this one.
     */
    it("answers with nothing for a value that is not a string", () => {
        assert.deepEqual(parseTags(undefined), {});
        assert.deepEqual(parseTags(null), {});
        assert.deepEqual(parseTags(42), {});
        assert.deepEqual(parseTags(""), {});
    });
});

/**
 * A line with no field set is not a line.
 *
 * The field filter keeps only finite numbers, so a payload whose measurements
 * are all null or NaN left the middle section empty - `speedtests,host=x
 * 1786100000`, with two spaces where the fields belong. Influx answers that
 * with a 400, and the write is lost along with any legitimate points batched
 * beside it.
 *
 * Not reachable from the live path today: the only caller is testFinished,
 * whose payload carries finite download, upload and ping by the time a row has
 * been written, and jitter falls back to zero. buildLine is exported and
 * therefore has other callers ahead of it, and it should not be able to produce
 * something the database refuses - so it says so instead.
 */
describe("a line with nothing to record", () => {
    it("is not built at all when no field survives the filter", () => {
        assert.equal(buildLine("speedtests", {host: "server1"}, {ping: null, download: NaN}, TIMESTAMP), null);
    });

    it("is not built for an empty field set either", () => {
        assert.equal(buildLine("speedtests", {}, {}, TIMESTAMP), null);
    });

    it("is still built when a single field survives", () => {
        assert.equal(buildLine("speedtests", {}, {ping: 10, download: null}, TIMESTAMP),
            `speedtests ping=10 ${TIMESTAMP}`);
    });

    // Zero is a measurement, not an absence - the filter keeps it and so must
    // this, or a line that recorded a genuine outage would be dropped.
    it("is built for a field that is zero", () => {
        assert.match(buildLine("m", {}, {packetLoss: 0}, TIMESTAMP), /^m packetLoss=0 /);
    });
});
