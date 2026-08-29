import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatLatency, formatLatencyWithUnit } from "@/common/utils/FormatUtil.js";
import { gradeForIncrease, readableFigure } from "@/common/utils/TestUtil.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const card = fs.readFileSync(path.join(CLIENT_SRC,
    "pages/Statistics/charts/ConsistencyChart/ConsistencyChart.jsx"), "utf8");

/**
 * The stability card, and the precision it prints its latencies at.
 *
 * The server averages the jitter over the range and sends it at the two
 * decimals the column stores, and the card printed it raw: "5.23 ms" on the
 * stability card, one panel away from a latest-test card reading "5.2 ms" for
 * the same measurement in the same unit. The expanded min-max spreads and the
 * ping deviation printed stored values the same way.
 *
 * A source scan, like the other rendering rules: node cannot parse JSX, and
 * every one of these renders perfectly - it renders a figure at a precision
 * the card beside it contradicts. The formatter itself is exercised on the
 * fixture from the report, so the scan and the behaviour cannot drift apart.
 */
describe("the stability card prints its latencies to one decimal", () => {
    it("finds the card to check", () => {
        assert.match(card, /data\.ping\.jitter/, "the card no longer draws a jitter at all");
        assert.match(card, /import \{[^}]*formatLatencyWithUnit[^}]*} from "@\/common\/utils\/FormatUtil"/,
            "the card cannot trim anything - it never imports the latency formatter");
    });

    it("prints the jitter average the way the latest-test card prints its jitter", () => {
        assert.match(card, /formatLatencyWithUnit\(data\.ping\.jitter, t\("latest\.jitter_unit"\)\)/,
            "the jitter average still goes out at the two decimals the server sends");
        assert.doesNotMatch(card, /formatWithUnit\(data\.ping\.jitter/,
            "the jitter average reaches the markup through the unit formatter alone");
    });

    // The fixture from the report: a stored average of 5.23 must read 5.2 on
    // screen - and a range in which nothing measured jitter is an explicit
    // null, which has to keep rendering as N/A rather than a bare unit.
    it("renders the stored two decimals as one", () => {
        assert.equal(formatLatencyWithUnit(5.23, "ms"), "5.2 ms");
        assert.equal(formatLatencyWithUnit(null, "ms"), "N/A");
    });

    // The enlarged view's "between 4.16 and 9.87" is made of raw stored
    // values, and both ends are latencies like the averages above them.
    it("trims both ends of the expanded spreads", () => {
        assert.match(card, /const latency = \(value\) => formatLatencyWithUnit\(value, t\("latest\.ping_unit"\)\)/,
            "the spread's ends still go out at the two decimals they are stored with");
        assert.equal(formatLatencyWithUnit(4.16, "ms"), "4.2 ms");
        assert.equal(formatLatencyWithUnit(9.87, "ms"), "9.9 ms");
    });

    // The ping deviation is milliseconds like the jitter beneath it. The null
    // a range without successes returns passes through the formatter
    // untouched, so the deviation helper still says N/A for it.
    it("trims the ping deviation it prints in the same unit", () => {
        assert.match(card, /deviation\(formatLatency\(data\.ping\.deviation\), t\("latest\.ping_unit"\)\)/,
            "the ping deviation still prints the stored two decimals");
        assert.equal(formatLatency(2.94), 2.9);
        assert.equal(formatLatency(null), null);
    });

    // The speeds have their own conversion and their own precision: a
    // deviation of ±34.16 Mbps trimmed to one decimal of milliseconds'
    // convention would be a different figure, and the consistency scores are
    // percentages.
    it("leaves the speeds and percentages alone", () => {
        assert.doesNotMatch(card, /formatLatency\w*\(data\.(download|upload)/,
            "a speed figure went through the latency formatter");
        assert.match(card, /const speed = \(value\) => formatWithUnit\(convertSpeed\(value, preferences\), speedUnit\)/,
            "the speed spread lost its own formatter");
    });

    // The bufferbloat increase keeps its two decimals by design: the figure is
    // pinned to the server's arithmetic by the loaded-latency agreement tests,
    // and the tooltips quote it verbatim.
    it("leaves the bufferbloat increase at the server's two decimals", () => {
        assert.doesNotMatch(card, /formatLatency\w*\((?:loaded\.increase|loadedIncrease)/,
            "the average increase was trimmed away from the pinned figure");
        assert.doesNotMatch(card, /formatLatency\w*\(entry\.increase/,
            "a trend dot's increase was trimmed away from the pinned figure");
    });
});

/**
 * The bufferbloat row's figures, built by the card's own statements and read
 * back. gradeForIncrease keeps its strict gate on purpose - its operands are
 * computed - so the card coerces at its boundary: the payload is server-fed,
 * and a proxied older node can spell the average increase or a dot's as
 * text. The strict gate behind the old read dropped the whole row for a
 * spelling the deviation beside it reads fine.
 */
describe("the bufferbloat row reads its figures through the shared reader", () => {
    const region = () => {
        const start = card.indexOf("const loaded = data.loadedLatency;");
        assert.notEqual(start, -1, "the card no longer derives the loaded row where this lift expects");
        const end = card.indexOf("\n    });", start);
        assert.notEqual(end, -1, "the loaded derivations are no longer a block this lift can close");

        return card.slice(start, end + "\n    });".length);
    };

    const loadedFigures = (loadedLatency) => new Function(
        "data", "readableFigure", "gradeForIncrease",
        `${region()}\nreturn {loadedIncrease, loadedGrade, trendDots};`)(
        {loadedLatency}, readableFigure, gradeForIncrease);

    it("grades a readable increase in either spelling", () => {
        const numeric = loadedFigures({increase: 12.5, tests: 40, trend: []});
        const text = loadedFigures({increase: "12.5", tests: 40, trend: []});

        assert.equal(numeric.loadedGrade, gradeForIncrease(12.5));
        assert.notEqual(numeric.loadedGrade, null);
        assert.equal(text.loadedGrade, numeric.loadedGrade,
            "a text-spelled increase drops the whole row - grade, dots and count");
        assert.equal(text.loadedIncrease, 12.5,
            "the tooltip states the raw spelling rather than the coerced reading");
    });

    it("still drops the row for what no reader can read", () => {
        for (const unreadable of ["auto", null, undefined, -1, "-1"])
            assert.equal(loadedFigures({increase: unreadable, tests: 4, trend: []}).loadedGrade, null,
                `an increase of ${JSON.stringify(unreadable)} graded as a reading`);

        assert.equal(loadedFigures(undefined).loadedGrade, null, "a payload without the block crashed or graded");
    });

    it("keeps a dot per readable increase and no dot for the rest", () => {
        const {trendDots} = loadedFigures({increase: 5, tests: 9, trend: [
            {increase: "3", created: "2026-08-01"},
            {increase: null, created: "2026-08-02"},
            {increase: 7, created: "2026-08-03"}
        ]});

        assert.deepEqual(trendDots.map(({increase}) => increase), [3, 7],
            "an unreadable dot renders - as a blue dot titled null - or a text one vanished");
        assert.deepEqual(trendDots.map(({created}) => created), ["2026-08-01", "2026-08-03"],
            "the dots lost the timestamps their keys and titles read");
    });

    /**
     * The block itself can be mangled, not only the figures in it: these
     * derivations run on every render, BEFORE the row's own gate, so a
     * trend that is not an array - or an entry that is not an object -
     * must come back as no dots rather than as a TypeError that unmounts
     * the whole statistics page. The old shape was accidentally safe here
     * (the iteration lived inside the hidden row); the hoist must be safe
     * on purpose.
     */
    it("survives a trend the payload mangles", () => {
        for (const mangled of [{}, "n/a", 0, null, undefined])
            assert.deepEqual(loadedFigures({increase: 12.5, tests: 4, trend: mangled}).trendDots, [],
                `a trend of ${JSON.stringify(mangled)} crashed the card or grew dots`);

        assert.deepEqual(loadedFigures({increase: 12.5, tests: 4,
            trend: [null, {increase: 7, created: "2026-08-03"}]})
            .trendDots.map(({increase}) => increase), [7],
            "a null entry crashed the card rather than dropping its dot");
    });

    // An all-refused trend is no strip at all: a childless role="img" span
    // announced as "trend:" with nothing after the colon is not a reading.
    it("draws the trend strip only when a dot survived", () => {
        assert.match(card, /\{trendDots\.length > 0 && \(/,
            "an all-refused trend renders an empty labelled image strip");
    });

    /**
     * The markup held to the bindings the lift executes: the lift's region
     * closes before the JSX, so without these a revert of the tooltip to
     * the raw column - or of a dot map to the raw trend - keeps every
     * executed case green while the screen shows the uncoerced payload.
     */
    it("renders the coerced figure and the filtered dots, not the raw payload", () => {
        assert.match(card, /\{increase: loadedIncrease, tests: loaded\.tests\}/,
            "the tooltip states a different figure than the one the grade was taken from");
        assert.equal((card.match(/trendDots\.map/g) ?? []).length, 2,
            "a dot map reads the raw trend again - the aria-label and the dots must both walk the filtered list");
        // The count catches a revert; this catches an ADDED inline map over
        // the raw block. The derivation's own read stays out because
        // ".map(" is not a substring of ".flatMap(" - if that derivation
        // ever legitimately ends in .map, this pin moves with it. Bounds:
        // a hoisted alias or the data.loadedLatency spelling are the
        // executed lift's job, not this line's.
        assert.doesNotMatch(card, /loaded\??\.trend[^\n]*\.map\(/,
            "an inline map walks the raw trend beside the filtered pair");
    });
});
