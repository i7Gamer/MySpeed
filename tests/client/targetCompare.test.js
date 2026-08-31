import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { targetColour, targetSeriesToken } from "@/common/utils/TargetUtil.js";
import { mergedTimeline, overlaySeries, targetSummaries } from "@/pages/Statistics/charts/TargetCompareChart/targetCompare.js";

/**
 * The comparison card's figures, computed where node can execute them.
 *
 * Every per-target payload is server-fed and travels the same wire as the
 * page's own, so the reader doctrine applies whole: a proxied older node can
 * spell any average as text, and the counts stay strict because they are
 * array lengths on the server - the failed row's documented convention. The
 * table must keep a row for a target whose fetch failed or measured nothing:
 * a line that delivered no data is a finding, not a gap in the furniture.
 */
const TARGETS = [
    {id: 3, name: "Ookla"},
    {id: 7, name: "Backup line"},
    {id: 9, name: "LAN"}
];

const payload = (over = {}) => ({
    download: {avg: 900},
    upload: {avg: 500},
    ping: {avg: 8.4},
    tests: {total: 40, failed: 2},
    labels: ["2026-08-30T04:00:00.000Z", "2026-08-30T08:00:00.000Z"],
    data: {download: [890, 910], upload: [495, 505], ping: [8, 9]},
    ...over
});

describe("targetSummaries", () => {
    it("builds one row per target, in list order, with the coerced readings", () => {
        const rows = targetSummaries(TARGETS, {3: payload(), 7: payload({
            download: {avg: "440.5"}, upload: {avg: "220"}, ping: {avg: "15.2"},
            tests: {total: 10, failed: 0}
        })});

        assert.deepEqual(rows.map(({id}) => id), [3, 7, 9], "the rows left the list's order");
        assert.deepEqual(rows[0], {id: 3, name: "Ookla", colourIndex: 0, unavailable: false,
            download: 900, upload: 500, ping: 8.4, failureRate: 5, previous: null});
        assert.deepEqual(rows[1], {id: 7, name: "Backup line", colourIndex: 1, unavailable: false,
            download: 440.5, upload: 220, ping: 15.2, failureRate: 0, previous: null},
            "a text-spelled average dropped its row or went out unread");
    });

    it("keeps a row, all readings refused, for a target whose payload never came", () => {
        const [row] = targetSummaries([TARGETS[2]], {});

        assert.deepEqual(row, {id: 9, name: "LAN", colourIndex: 0, unavailable: false,
            download: null, upload: null, ping: null, failureRate: null, previous: null});
    });

    /**
     * A fetch that FAILED and a range the target measured nothing in are
     * different findings: null is the fetch's own sentinel, and the row says
     * "couldn't load" instead of wearing an honest N/A - the unmeasured/
     * unreadable separation the readers keep everywhere else.
     */
    it("marks a target whose fetch failed as unavailable, not as measured-nothing", () => {
        const rows = targetSummaries([TARGETS[0], TARGETS[1]], {3: null, 7: payload()});

        assert.equal(rows[0].unavailable, true, "a failed fetch wore the clean N/A of an empty range");
        assert.equal(rows[0].download, null);
        assert.equal(rows[1].unavailable, false);
    });

    it("refuses what no reader can read, figure by figure", () => {
        const [row] = targetSummaries([TARGETS[0]], {3: payload({
            download: {avg: -1}, upload: {avg: "auto"}, ping: {avg: NaN}
        })});

        assert.deepEqual({download: row.download, upload: row.upload, ping: row.ping},
            {download: null, upload: null, ping: null},
            "a placeholder or junk average printed as a reading");
        assert.equal(row.failureRate, 5, "junk beside the counts took the rate with it");
    });

    /**
     * The counts stay strict on purpose - they are array lengths on the
     * server, so a text spelling is a producer that changed shape, and the
     * row degrades to no rate rather than coercing: the OverviewChart failed
     * row's documented convention, kept here so the two surfaces cannot
     * disagree about the same payload.
     */
    it("degrades to no rate for counts failureRate refuses", () => {
        const [row] = targetSummaries([TARGETS[0]], {3: payload({tests: {total: "40", failed: 2}})});

        assert.equal(row.failureRate, null, "a text count coerced into a rate");
    });

    /**
     * The window before, per target and per figure.
     *
     * The card asks for each target's own previous window, so a row compares
     * against ITS line a week ago rather than against the page's mixture. The
     * figures are read exactly as the row's own are - averages through the
     * shared reader, counts strict - because reading the two sides two
     * different ways is how one ends up coercing what the other refuses.
     */
    it("carries the previous window's figures beside the row's own", () => {
        const [row] = targetSummaries([TARGETS[0]], {3: payload({previous: {
            download: {avg: 800}, upload: {avg: 400}, ping: {avg: 12},
            tests: {total: 30, failed: 3}
        }})});

        assert.deepEqual(row.previous, {download: 800, upload: 400, ping: 12, failureRate: 10});
        assert.equal(row.download, 900, "the row's own figures moved when the previous window arrived");
    });

    it("compares nothing where there is no window to compare against", () => {
        // No key at all - an older node, or an all-time range the server
        // refuses to compare - and the explicit null it sends for a window
        // that has not begun.
        assert.equal(targetSummaries([TARGETS[0]], {3: payload()})[0].previous, null);
        assert.equal(targetSummaries([TARGETS[0]], {3: payload({previous: null})})[0].previous, null);
        // A failed fetch has no previous either.
        assert.equal(targetSummaries([TARGETS[0]], {3: null})[0].previous, null);
    });

    // The page's own gate, per row: a window nobody tested in has no figures
    // to compare against, and its zeros must not colour a row.
    it("refuses a previous window nobody tested in", () => {
        const [row] = targetSummaries([TARGETS[0]], {3: payload({previous: {
            tests: {total: 0, failed: 0}, download: {avg: null}
        }})});

        assert.equal(row.previous, null);
    });

    it("reads the previous window's spellings the way it reads the row's", () => {
        const text = targetSummaries([TARGETS[0]], {3: payload({previous: {
            download: {avg: "800"}, tests: {total: 30, failed: 3}
        }})})[0];

        assert.equal(text.previous.download, 800, "a text-spelled previous average went out unread");
        assert.equal(text.previous.failureRate, 10);

        const refused = targetSummaries([TARGETS[0]], {3: payload({previous: {
            download: {avg: -1}, ping: {avg: -1}, tests: {total: 30, failed: 0}
        }})})[0];

        assert.equal(refused.previous.download, null, "a placeholder fed the arrow");
        assert.equal(refused.previous.ping, null);
        assert.equal(refused.previous.failureRate, 0,
            "the readable half of the window went missing with the unreadable half");

        const strict = targetSummaries([TARGETS[0]], {3: payload({previous: {
            tests: {total: "30", failed: 3}, download: {avg: 800}
        }})})[0];

        assert.equal(strict.previous.failureRate, null, "a text count coerced into a previous rate");
        assert.equal(strict.previous.download, 800, "the strict count took the readable average with it");
    });

    it("gives the fourth target a colour index past the cycle without wrapping here", () => {
        const four = [...TARGETS, {id: 11, name: "Fibre"}];
        const rows = targetSummaries(four, {});

        assert.deepEqual(rows.map(({colourIndex}) => colourIndex), [0, 1, 2, 3],
            "the index is the list position - the cycle wraps in the colour lookup, not here");
    });
});

describe("mergedTimeline", () => {
    it("unions, sorts and dedupes the targets' label sets", () => {
        const merged = mergedTimeline([
            {labels: ["2026-08-30T08:00:00.000Z", "2026-08-30T04:00:00.000Z"]},
            {labels: ["2026-08-30T06:00:00.000Z", "2026-08-30T04:00:00.000Z"]}
        ]);

        assert.deepEqual(merged, ["2026-08-30T04:00:00.000Z", "2026-08-30T06:00:00.000Z",
            "2026-08-30T08:00:00.000Z"]);
    });

    it("drops what names no instant and survives a mangled series", () => {
        const merged = mergedTimeline([
            {labels: ["not a date", "2026-08-30T04:00:00.000Z"]},
            {labels: "n/a"},
            null
        ]);

        assert.deepEqual(merged, ["2026-08-30T04:00:00.000Z"],
            "an unparseable label reached the axis maths, or a mangled series crashed the merge");
    });

    it("answers empty for no series at all", () => {
        assert.deepEqual(mergedTimeline([]), []);
    });
});

describe("overlaySeries", () => {
    const BY_ID = {3: payload(), 7: payload({data: {download: [400], upload: [200], ping: [15]},
        labels: ["2026-08-30T06:00:00.000Z"]})};

    it("yields one series per target holding that metric, in list order", () => {
        const series = overlaySeries(TARGETS, BY_ID, "download");

        assert.deepEqual(series.map(({id}) => id), [3, 7],
            "a target with no payload grew a series, or one with data lost its place");
        assert.deepEqual(series[0].values, [890, 910]);
        assert.deepEqual(series[1].values, [400]);
        assert.deepEqual(series[1].labels, ["2026-08-30T06:00:00.000Z"]);
        assert.equal(series[0].name, "Ookla");
        assert.equal(series[0].colourIndex, 0, "the colour index is the LIST position, not the series position");
        assert.equal(series[1].colourIndex, 1);
    });

    it("switches metric without touching the shape", () => {
        assert.deepEqual(overlaySeries(TARGETS, BY_ID, "ping")[0].values, [8, 9]);
        assert.deepEqual(overlaySeries(TARGETS, BY_ID, "upload")[1].values, [200]);
    });

    it("contributes nothing for a series the payload mangles", () => {
        for (const mangled of [
            {3: payload({data: null})},
            {3: payload({data: {download: "n/a"}})},
            {3: payload({labels: null})},
            {3: null}
        ])
            assert.deepEqual(overlaySeries([TARGETS[0]], mangled, "download"), [],
                `${JSON.stringify(mangled[3]?.data ?? mangled[3])} produced a series`);
    });
});

/**
 * The one cycle, in one home: the chips' dots and the overlay's canvas lines
 * must resolve the same token for the same target, and the canvas cannot read
 * a var() - so the token is the shared fact and the var is derived from it.
 */
describe("the colour cycle", () => {
    it("keeps targetColour exactly the token wrapped in its var()", () => {
        for (const index of [0, 1, 2, 3, 4, 5, 6, 11, -1])
            assert.equal(targetColour(index), `var(--chart-${targetSeriesToken(index)})`,
                `index ${index} resolves two different tokens for dot and canvas`);
    });

    it("wraps past the cycle and normalises the missing-target -1", () => {
        assert.equal(targetSeriesToken(6), targetSeriesToken(0), "the cycle no longer wraps");
        assert.equal(targetSeriesToken(-1), targetSeriesToken(5),
            "roundIndexById's -1 stopped resolving to the cycle's last token, so a missing target draws var(--chart-undefined)");
    });
});
