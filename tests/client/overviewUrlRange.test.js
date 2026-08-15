import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    TIMEFRAME_ALL,
    TIMEFRAME_CUSTOM,
    formatDateParam,
    rangeKey,
    rangeToParams,
    selectionFromParams
} from "../../client/src/common/utils/TimeframeUtil.js";

// A fixed "now" keeps every expectation deterministic. Local noon avoids any
// chance of the date rolling over under a different machine timezone.
const NOW = new Date(2026, 7, 7, 12, 0, 0);

const params = (search) => new URLSearchParams(search);

/**
 * The overview's range used to live only in the speedtest context, so it reset
 * on reload and could not be linked to - while the statistics page, showing the
 * same history, kept its range in the URL precisely so a view stays bookmarkable
 * and shareable. The overview now reads and writes the same parameters.
 *
 * The two ends of that round trip are pure so they can be checked here rather
 * than inferred from a component: what the URL means, and what a selection puts
 * back into it.
 */
describe("selectionFromParams", () => {
    it("reads a preset out of the URL", () => {
        const selection = selectionFromParams(params("range=30d"), NOW);

        assert.equal(selection.timeframe, "30d");
        assert.equal(formatDateParam(selection.to), "2026-08-07");
    });

    it("reads an explicit range out of the URL", () => {
        const selection = selectionFromParams(params("from=2026-07-01&to=2026-07-15"), NOW);

        assert.equal(selection.timeframe, TIMEFRAME_CUSTOM);
        assert.equal(formatDateParam(selection.from), "2026-07-01");
        assert.equal(formatDateParam(selection.to), "2026-07-15");
    });

    /**
     * The overview shows everything it has by default, so a bare URL has to
     * mean all-time rather than the statistics' seven days - otherwise merely
     * opening the page would hide most of the history.
     */
    it("means all time when the URL says nothing", () => {
        const selection = selectionFromParams(params(""), NOW);

        assert.equal(selection.timeframe, TIMEFRAME_ALL);
        assert.equal(selection.from, null);
        assert.equal(selection.to, null);
    });

    it("means all time when the URL says something it cannot use", () => {
        for (const search of ["range=fortnight", "from=2026-07-01", "to=not-a-date"])
            assert.equal(selectionFromParams(params(search), NOW).timeframe, TIMEFRAME_ALL,
                `"${search}" was not treated as all time`);
    });
});

describe("rangeToParams", () => {
    it("writes a preset as its id", () => {
        assert.deepEqual(rangeToParams("30d"), {range: "30d"});
    });

    it("writes a custom range as its two days", () => {
        const from = new Date(2026, 6, 1);
        const to = new Date(2026, 6, 15);

        assert.deepEqual(rangeToParams(TIMEFRAME_CUSTOM, from, to),
            {from: "2026-07-01", to: "2026-07-15"});
    });

    /**
     * All-time carries no dates at all, and serializing it as a range would
     * reach for a `from` that does not exist. Clearing the parameters says the
     * same thing and leaves a clean URL - which then reads back as all time.
     */
    it("writes all time as no parameters at all", () => {
        assert.deepEqual(rangeToParams(TIMEFRAME_ALL), {});
        assert.deepEqual(rangeToParams(TIMEFRAME_ALL, null, null), {});
    });

    it("round-trips every selection it writes", () => {
        for (const timeframe of [TIMEFRAME_ALL, "7d", "30d", "1y"]) {
            const written = params(new URLSearchParams(rangeToParams(timeframe)).toString());

            assert.equal(selectionFromParams(written, NOW).timeframe, timeframe,
                `${timeframe} did not survive the round trip`);
        }
    });
});

/**
 * Which part of the URL the overview's list actually depends on.
 *
 * SpeedtestProvider is mounted in the layout route, above the outlet, so it is
 * alive on every page - and it derived its query from `searchParams.toString()`,
 * the whole search string. The statistics page writes the same range keys to the
 * URL, so every timeframe click there rebuilt the provider's query and refetched
 * a page of overview rows; anything else that ever puts a parameter in the URL
 * would do the same. The list depends on three keys, and this is those three.
 */
describe("rangeKey", () => {
    it("is the range keys and nothing else", () => {
        const before = rangeKey(params("range=30d"));
        const after = rangeKey(params("range=30d&tab=integrations&highlight=42"));

        assert.equal(after, before, "an unrelated parameter changed the list's query");
    });

    it("changes when the preset changes", () => {
        assert.notEqual(rangeKey(params("range=30d")), rangeKey(params("range=7d")));
    });

    it("changes when an explicit range changes", () => {
        assert.notEqual(rangeKey(params("from=2026-08-01&to=2026-08-07")),
            rangeKey(params("from=2026-08-01&to=2026-08-08")));
    });

    it("does not depend on the order they appear in", () => {
        assert.equal(rangeKey(params("to=2026-08-07&from=2026-08-01")),
            rangeKey(params("from=2026-08-01&to=2026-08-07")));
    });

    // A key that is absent and a key that is empty are different URLs and have
    // to read back as they were written, or the selection they describe changes.
    it("keeps an absent key absent", () => {
        assert.equal(selectionFromParams(params(rangeKey(params(""))), NOW).timeframe, TIMEFRAME_ALL);
        assert.equal(selectionFromParams(params(rangeKey(params("range=30d"))), NOW).timeframe, "30d");
    });

    it("carries an explicit range through unchanged", () => {
        const selection = selectionFromParams(params(rangeKey(params("from=2026-08-01&to=2026-08-07"))), NOW);

        assert.equal(formatDateParam(selection.from), "2026-08-01");
        assert.equal(formatDateParam(selection.to), "2026-08-07");
    });
});

describe("the speedtest provider's query", () => {
    const source = fs.readFileSync(path.resolve(fileURLToPath(import.meta.url),
        "..", "..", "..", "client", "src", "common", "contexts", "Speedtests", "SpeedtestContext.jsx"), "utf8");

    it("is keyed on the range rather than on the whole search string", () => {
        assert.match(source, /rangeKey\(/,
            "the provider keys off every parameter in the URL, so unrelated pages refetch the list");
        assert.doesNotMatch(source, /searchParams\.toString\(\)/,
            "the whole search string is still what the query is derived from");
    });
});
