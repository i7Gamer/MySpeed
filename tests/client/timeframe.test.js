import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    TIMEFRAMES,
    TIMEFRAME_ALL,
    TIMEFRAME_CUSTOM,
    DEFAULT_TIMEFRAME,
    formatDateParam,
    resolveTimeframe,
    timeframeFromRange,
    timeframeLabelKey,
    parseRangeParams,
    serializeRange
} from "../../client/src/common/utils/TimeframeUtil.js";

// A fixed "now" keeps every expectation deterministic. Local noon avoids any
// chance of the date rolling over under a different machine timezone.
const NOW = new Date(2026, 7, 7, 12, 0, 0);

const id = (timeframe) => timeframe.id;

describe("TIMEFRAMES", () => {
    it("exposes the presets in ascending span order", () => {
        assert.deepEqual(TIMEFRAMES.map(id), ["7d", "30d", "90d", "1y"]);
    });

    it("reuses translation keys that already ship in every locale", () => {
        assert.deepEqual(TIMEFRAMES.map(frame => frame.labelKey), [
            "calendar.last_7_days", "calendar.last_30_days",
            "calendar.last_90_days", "calendar.last_year"
        ]);
    });

    it("defaults to the seven day preset", () => {
        assert.equal(DEFAULT_TIMEFRAME, "7d");
    });
});

/**
 * What the picker's trigger shows. A chosen preset names itself - "Last 7
 * days" says more than the two dates it happens to resolve to today - and only
 * a custom range shows its concrete dates. All time already worked this way,
 * because it has no dates to fall back to; the bounded presets used to show
 * the resolved window instead.
 */
describe("timeframeLabelKey", () => {
    it("names every picker preset, all time included", () => {
        assert.equal(timeframeLabelKey(TIMEFRAME_ALL), "calendar.all_time");
        assert.equal(timeframeLabelKey("7d"), "calendar.last_7_days");
        assert.equal(timeframeLabelKey("1y"), "calendar.last_year");
    });

    it("answers null for a custom range, whose dates are the honest label", () => {
        assert.equal(timeframeLabelKey(TIMEFRAME_CUSTOM), null);
    });

    it("answers null for anything it does not know", () => {
        assert.equal(timeframeLabelKey(undefined), null);
        assert.equal(timeframeLabelKey("last-fortnight"), null);
    });

    it("is what the picker's trigger renders", () => {
        const source = fs.readFileSync(path.resolve(fileURLToPath(import.meta.url), "..", "..", "..",
            "client", "src", "common", "components", "DateRangePicker", "DateRangePicker.jsx"), "utf8");

        assert.match(source, /timeframeLabelKey\(/, "the trigger does not ask for the preset's name");
    });
});

describe("formatDateParam", () => {
    it("formats as YYYY-MM-DD", () => {
        assert.equal(formatDateParam(new Date(2026, 7, 7)), "2026-08-07");
    });

    it("zero-pads single digit months and days", () => {
        assert.equal(formatDateParam(new Date(2026, 0, 5)), "2026-01-05");
    });

    // Regression guard: toISOString() would shift the day for anyone east or
    // west of UTC, which is exactly the mismatch the server had to work around.
    it("uses local calendar fields rather than UTC", () => {
        assert.equal(formatDateParam(new Date(2026, 7, 7, 23, 30)), "2026-08-07");
        assert.equal(formatDateParam(new Date(2026, 7, 7, 0, 30)), "2026-08-07");
    });
});

describe("resolveTimeframe", () => {
    it("ends the range today", () => {
        assert.equal(formatDateParam(resolveTimeframe("7d", NOW).to), "2026-08-07");
    });

    // "Last 7 days" must span 7 calendar days inclusive, not 8.
    it("spans exactly seven inclusive days for 7d", () => {
        assert.equal(formatDateParam(resolveTimeframe("7d", NOW).from), "2026-08-01");
    });

    it("spans exactly thirty inclusive days for 30d", () => {
        assert.equal(formatDateParam(resolveTimeframe("30d", NOW).from), "2026-07-09");
    });

    it("spans exactly ninety inclusive days for 90d", () => {
        assert.equal(formatDateParam(resolveTimeframe("90d", NOW).from), "2026-05-10");
    });

    it("spans a year for 1y", () => {
        assert.equal(formatDateParam(resolveTimeframe("1y", NOW).from), "2025-08-08");
    });

    it("crosses a year boundary correctly", () => {
        const range = resolveTimeframe("7d", new Date(2026, 0, 3, 12));
        assert.equal(formatDateParam(range.from), "2025-12-28");
    });

    it("falls back to the default for an unknown id", () => {
        assert.deepEqual(
            formatDateParam(resolveTimeframe("nonsense", NOW).from),
            formatDateParam(resolveTimeframe(DEFAULT_TIMEFRAME, NOW).from)
        );
    });

    it("falls back to the default for a custom id", () => {
        assert.equal(
            formatDateParam(resolveTimeframe(TIMEFRAME_CUSTOM, NOW).from),
            formatDateParam(resolveTimeframe(DEFAULT_TIMEFRAME, NOW).from)
        );
    });
});

describe("timeframeFromRange", () => {
    it("recognises each preset from its resolved range", () => {
        for (const frame of TIMEFRAMES) {
            const {from, to} = resolveTimeframe(frame.id, NOW);
            assert.equal(timeframeFromRange(from, to, NOW), frame.id, `expected ${frame.id}`);
        }
    });

    it("ignores the time of day when matching", () => {
        const {from, to} = resolveTimeframe("30d", NOW);
        from.setHours(3, 14);
        to.setHours(22, 45);
        assert.equal(timeframeFromRange(from, to, NOW), "30d");
    });

    it("reports custom for a range that ends before today", () => {
        assert.equal(timeframeFromRange(new Date(2026, 6, 1), new Date(2026, 6, 20), NOW), TIMEFRAME_CUSTOM);
    });

    it("reports custom for an arbitrary span ending today", () => {
        assert.equal(timeframeFromRange(new Date(2026, 7, 4), new Date(2026, 7, 7), NOW), TIMEFRAME_CUSTOM);
    });

    it("reports custom when either boundary is missing", () => {
        assert.equal(timeframeFromRange(null, new Date(2026, 7, 7), NOW), TIMEFRAME_CUSTOM);
        assert.equal(timeframeFromRange(new Date(2026, 7, 1), null, NOW), TIMEFRAME_CUSTOM);
    });
});

describe("parseRangeParams", () => {
    const parse = (query) => parseRangeParams(new URLSearchParams(query), NOW);

    it("resolves a preset id", () => {
        const result = parse("range=30d");
        assert.equal(result.timeframe, "30d");
        assert.equal(formatDateParam(result.from), "2026-07-09");
    });

    it("resolves an explicit custom range", () => {
        const result = parse("from=2026-01-01&to=2026-02-01");
        assert.equal(result.timeframe, TIMEFRAME_CUSTOM);
        assert.equal(formatDateParam(result.from), "2026-01-01");
        assert.equal(formatDateParam(result.to), "2026-02-01");
    });

    it("labels an explicit range that matches a preset with that preset", () => {
        assert.equal(parse("from=2026-08-01&to=2026-08-07").timeframe, "7d");
    });

    it("returns null for no parameters", () => {
        assert.equal(parse(""), null);
    });

    it("returns null for an unknown preset id", () => {
        assert.equal(parse("range=42x"), null);
    });

    it("returns null for a malformed date", () => {
        assert.equal(parse("from=01-01-2026&to=2026-02-01"), null);
    });

    it("returns null for an impossible date", () => {
        assert.equal(parse("from=2026-02-30&to=2026-03-01"), null);
    });

    it("returns null when only one boundary is given", () => {
        assert.equal(parse("from=2026-01-01"), null);
    });

    it("swaps an inverted custom range", () => {
        const result = parse("from=2026-02-01&to=2026-01-01");
        assert.equal(formatDateParam(result.from), "2026-01-01");
        assert.equal(formatDateParam(result.to), "2026-02-01");
    });

    it("prefers an explicit preset over from/to", () => {
        assert.equal(parse("range=90d&from=2026-01-01&to=2026-02-01").timeframe, "90d");
    });
});

describe("serializeRange", () => {
    it("writes a preset as a single range parameter", () => {
        assert.deepEqual(serializeRange("30d"), {range: "30d"});
    });

    it("writes a custom range as from and to", () => {
        assert.deepEqual(
            serializeRange(TIMEFRAME_CUSTOM, new Date(2026, 0, 1), new Date(2026, 1, 1)),
            {from: "2026-01-01", to: "2026-02-01"}
        );
    });

    it("round-trips a preset", () => {
        const params = new URLSearchParams(serializeRange("90d"));
        assert.equal(parseRangeParams(params, NOW).timeframe, "90d");
    });

    it("round-trips a custom range", () => {
        const from = new Date(2025, 3, 2);
        const to = new Date(2025, 4, 9);
        const params = new URLSearchParams(serializeRange(TIMEFRAME_CUSTOM, from, to));
        const parsed = parseRangeParams(params, NOW);
        assert.equal(formatDateParam(parsed.from), "2025-04-02");
        assert.equal(formatDateParam(parsed.to), "2025-05-09");
    });
});
