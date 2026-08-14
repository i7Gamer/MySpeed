import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    convertSpeed, formatLatency, formatLatencyWithUnit, formatWithUnit
} from "@/common/utils/FormatUtil.js";
import { getIconBySpeed, isMeasured, jitterColour, packetLossColour } from "@/common/utils/TestUtil.js";
import {
    changeFrom, differenceFromTarget, percentOfTarget
} from "../../client/src/common/components/TestDetails/utils/details.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const pane = fs.readFileSync(
    path.join(CLIENT_SRC, "common", "components", "TestDetails", "TestDetails.jsx"), "utf8");
const row = fs.readFileSync(
    path.join(CLIENT_SRC, "pages", "Home", "components", "Speedtest", "SpeedtestComponent.jsx"), "utf8");

/**
 * The pane's figure-building code, taken out of the JSX and run.
 *
 * The trimmed ping consts, the target label, the quality strip's entries and
 * the metrics array are plain JavaScript - the JSX around them is what node
 * cannot parse - so the alternative is asserting on the shape of their source,
 * which passes for any spelling that happens to contain the right words and
 * breaks on any that does not. What went wrong here is which figure the pane
 * handed to each helper, and that is only observable by building the cards and
 * reading the figures back. Same approach as escapeTopmost.test.js.
 */
const indexOrFail = (source, anchor, from = 0) => {
    const index = source.indexOf(anchor, from);
    assert.notEqual(index, -1, `the pane no longer contains "${anchor}"`);
    return index;
};

const between = (source, from, to) => {
    const start = indexOrFail(source, from);
    return source.slice(start, indexOrFail(source, to, start));
};

const DERIVATIONS_START = "const ping = formatLatency";
const QUALITY_START = "const qualityFigures";
const QUALITY_END = "const quality =";
const METRICS_START = "const metrics = [";
const METRICS_END = "\n    ];";

// The trimmed ping, its target and its predecessor, plus latencyTargetLabel -
// everything between them is comments, so the slice evaluates as it stands.
const derivations = () => between(pane, DERIVATIONS_START, QUALITY_START);

const qualityRegion = () => between(pane, QUALITY_START, QUALITY_END);

const metricsLiteral = () => {
    const start = indexOrFail(pane, METRICS_START);
    return pane.slice(start, indexOrFail(pane, METRICS_END, start) + METRICS_END.length);
};

const evaluate = (body, closure) => {
    const names = Object.keys(closure);
    return new Function(...names, body)(...names.map((name) => closure[name]));
};

// i18next reduced to something assertable: a bare key comes back as itself, and
// a key with values keeps them attached - so a label carries the exact numbers
// the pane put into it rather than a translation of them.
const t = (key, values) => values === undefined ? key : {key, ...values};

/**
 * The metrics array for one test, built by the pane's own statements.
 *
 * formatLatency, the comparison helpers and getIconBySpeed are the real ones,
 * so these tests fail if either side of the wiring moves. formatWithUnit is
 * supplied although the pane no longer calls it: the regression this file
 * guards is exactly that spelling coming back, and it should come back as a
 * failed assertion rather than as a ReferenceError.
 *
 * quality and loadedLatency are rendered markup the slices skip; the figures
 * the quality strip carries are built from their own region below.
 */
const buildMetrics = ({test, targets = {}, earlier = {}}) => evaluate(
    `${derivations()}\n${metricsLiteral()}\nreturn metrics;`, {
        test, targets, earlier, t,
        formatLatency, formatWithUnit, changeFrom, differenceFromTarget, percentOfTarget,
        getIconBySpeed, convertSpeed,
        preferences: {}, speedUnit: "Mbit/s",
        quality: null, loadedLatency: () => null,
        faPingPongPaddleBall: null, faArrowDown: null, faArrowUp: null,
        pingInfo: null, downloadInfo: null, uploadInfo: null
    });

const pingCard = (fixture) => {
    const card = buildMetrics(fixture).find((metric) => metric.key === "ping");
    assert.notEqual(card, undefined, "the ping metric is gone");
    return card;
};

const qualityEntries = (test) => evaluate(
    `${qualityRegion()}\nreturn qualityFigures;`, {
        test, t,
        isMeasured, jitterColour, packetLossColour,
        formatLatencyWithUnit, formatWithUnit, formatLatency,
        faWaveSquare: null, jitterInfo: null, faLinkSlash: null, packetLossInfo: null
    });

// The pair from the bug report: 25.44 after 25.36, against a target typed into
// the settings dialog - which stores what was typed, a string.
const BUG_REPORT = {test: {ping: 25.44}, targets: {ping: "25"}, earlier: {ping: 25.36}};

/**
 * A latency is shown at one decimal, and everything read off it used to be
 * computed at the two the column stores.
 *
 * The pane printed the ping through formatLatency and then handed the raw value
 * to every figure derived from it: 25.44 and 25.36 gave two cards both reading
 * "25.4 ms" with "+0.08 ms" of change between them, and a displayed 25.4 was
 * called "0.44 ms over" a target of 25. The jitter and the latency under load
 * went out raw beside that one-decimal ping.
 *
 * So the rule is one figure per latency: the value the card prints is the value
 * the change, the distance from target, the percentage and the colour are all
 * taken from - which means formatting both sides of every comparison, not only
 * the one being displayed.
 *
 * These first tests call the helpers directly, so they document the arithmetic
 * of that rule - what it yields for the bug report's pair, for the guards and
 * for a string target. They would pass whether or not TestDetails composed the
 * calls this way, which is why the pane's own wiring is executed further down
 * rather than inferred from these.
 */
describe("the arithmetic: helpers fed the printed figure agree to the decimal", () => {
    it("reports no change between two values that print the same latency", () => {
        assert.deepEqual(changeFrom(formatLatency(25.44), formatLatency(25.36)),
            {difference: 0, direction: "same"});
    });

    it("still reports a change that survives the rounding", () => {
        assert.deepEqual(changeFrom(formatLatency(25.44), formatLatency(24.36)),
            {difference: 1, direction: "up"});
    });

    it("measures the distance from the target against the printed figure", () => {
        assert.deepEqual(differenceFromTarget(formatLatency(25.44), formatLatency(25)),
            {difference: 0.4, direction: "over"});
    });

    // A ping that rounds onto its target is on it, rather than a hundredth over.
    it("calls a latency that rounds onto the target on target", () => {
        assert.equal(differenceFromTarget(formatLatency(25.04), formatLatency(25)).direction, "same");
    });

    /**
     * formatLatency hands back anything that is not a positive number untouched,
     * so the -1 a failed run stores and the null a provider that measured
     * nothing leaves both reach the helpers exactly as they did before - where
     * isUsable and asTarget refuse them.
     */
    it("leaves the failure placeholder and an absent value to the guards", () => {
        for (const absent of [-1, null, undefined, NaN]) {
            assert.equal(changeFrom(formatLatency(absent), formatLatency(20)), null,
                `change from ${String(absent)}`);
            assert.equal(changeFrom(formatLatency(20), formatLatency(absent)), null,
                `change to ${String(absent)}`);
            assert.equal(differenceFromTarget(formatLatency(absent), formatLatency(20)), null,
                `target distance for ${String(absent)}`);
            assert.equal(percentOfTarget(formatLatency(absent), formatLatency(20), {higherIsBetter: false}),
                null, `percentage for ${String(absent)}`);
        }
    });

    // The target is what the config holds, which is whatever was typed into the
    // settings dialog - a string. Formatting it has to leave that alone, or the
    // bar and the label lose the target altogether.
    it("leaves a target stored as a string usable", () => {
        assert.equal(percentOfTarget(formatLatency(25.44), formatLatency("25"), {higherIsBetter: false}), 98);
        assert.deepEqual(differenceFromTarget(formatLatency(25.44), formatLatency("25")),
            {difference: 0.4, direction: "over"});
    });
});

// The wiring itself: the card the pane builds, with every figure read back off
// it. Each fixture is chosen so that a card rebuilt from the raw column gives a
// different answer - a fixture both spellings agree on would prove nothing.
describe("the ping card computes every figure from the one it prints", () => {
    it("prints the stored two decimals as one", () => {
        assert.equal(pingCard(BUG_REPORT).value, 25.4);
    });

    it("reports no change between two tests that print the same latency", () => {
        assert.deepEqual(pingCard(BUG_REPORT).change, {difference: 0, direction: "same"},
            "two cards both reading 25.4 claim a change between them");
    });

    it("still reports a change that survives the rounding", () => {
        assert.deepEqual(pingCard({...BUG_REPORT, earlier: {ping: 24.36}}).change,
            {difference: 1, direction: "up"});
    });

    it("measures the distance from the target against the printed figure", () => {
        assert.deepEqual(pingCard(BUG_REPORT).targetLabel,
            {key: "test.details.over_target", amount: 0.4, unit: "latest.ping_unit"},
            "a displayed 25.4 is called 0.44 ms over a target of 25 again");
    });

    it("calls a latency that rounds onto the target on target", () => {
        assert.equal(pingCard({...BUG_REPORT, test: {ping: 25.04}}).targetLabel,
            "test.details.on_target");
    });

    // 2.04 prints as 2 against a target of 2: the bar has to say the target is
    // met, not that the reader is 2% short of a figure they cannot see.
    it("fills the bar from the printed figure", () => {
        assert.equal(pingCard({test: {ping: 2.04}, targets: {ping: "2"}}).percent, 100);
    });

    // 12.96 prints as 13, and 13 against a target of 10 is exactly the 130%
    // where the colour turns - the card is graded on the figure it shows.
    it("colours the card from the printed figure", () => {
        assert.equal(pingCard({test: {ping: 12.96}, targets: {ping: "10"}}).level, "orange");
    });

    // The -1 a failed run stores reaches the guards untouched, so everything
    // derived stays off the card and the icon keeps its failure state.
    it("hands the failure placeholder through to the guards", () => {
        const card = pingCard({...BUG_REPORT, test: {ping: -1}});

        assert.equal(card.value, -1, "the interface recognises a failure by the placeholder");
        assert.equal(card.change, null);
        assert.equal(card.percent, null);
        assert.equal(card.targetLabel, null);
        assert.equal(card.level, "error");
    });

    it("shows no target figures when no target is configured", () => {
        const card = pingCard({test: {ping: 25.44}});

        assert.equal(card.percent, null);
        assert.equal(card.targetLabel, null);
        assert.equal(card.level, "blue");
    });

    // The speeds have their own conversion and their own precision, and a
    // download rounded to one decimal would be a different figure entirely.
    it("leaves the speeds their stored precision", () => {
        const metrics = buildMetrics({test: {ping: 25.44, download: 100.13, upload: 20.06},
            earlier: {download: 90.02}});
        const card = (key) => metrics.find((metric) => metric.key === key);

        assert.equal(card("download").value, 100.13);
        assert.deepEqual(card("download").change, {difference: 10.11, direction: "up"});
        assert.equal(card("upload").value, 20.06);
    });
});

/**
 * The other latency beside the ping. Nothing is read off the jitter but its
 * colour - what was wrong with it is that it printed the stored two decimals
 * beside a ping printed at one, the same measurement in the same unit written
 * two ways on one card. 19.96 is the fixture because it prints as 20 and the
 * two figures grade differently, so the strip cannot pass by feeding either
 * figure to both places.
 */
describe("the quality strip beside the ping", () => {
    const entry = (key) => {
        const found = qualityEntries({jitter: 19.96, packetLoss: 1.25})
            .find((figure) => figure.key === key);
        assert.notEqual(found, undefined, `the ${key} figure is gone from the strip`);
        return found;
    };

    it("prints the jitter at the precision the ping is printed at", () => {
        assert.equal(entry("jitter").text, "20 latest.jitter_unit",
            "the jitter still goes out at the two decimals the column stores");
        assert.equal(entry("jitter").label, "latest.jitter 20 latest.jitter_unit",
            "the name the button is announced by disagrees with the figure it shows");
    });

    /**
     * The colour grades the printed figure, exactly as the ping's does. A
     * stored 19.96 prints "20", and a green icon beside a printed 20 - the very
     * number the scale calls orange - reads as the interface disagreeing with
     * itself. The row, this pane and the consistency card all moved together,
     * so no measurement changes colour between two views either - the fault
     * the previous version of this test held the raw grading in place against.
     */
    it("grades it from the printed figure, not the stored one", () => {
        assert.equal(entry("jitter").level, jitterColour(formatLatency(19.96)));
        assert.notEqual(jitterColour(19.96), jitterColour(formatLatency(19.96)),
            "a fixture both gradings agree on proves nothing here");
    });

    // Belt to the executed braces: the row and the pane read their argument
    // from the same column in source too, so a change to either spelling shows
    // up as the pair drifting apart rather than as two green files.
    it("grades it from the figure the row that expands to this pane grades it from", () => {
        const argument = (source) => source.match(/jitterColour\(([^)]*\)?)\)/)?.[1];

        const inPane = argument(qualityRegion());
        const inRow = argument(row);

        assert.notEqual(inPane, undefined, "the pane no longer grades the jitter");
        assert.notEqual(inRow, undefined, "the row no longer grades the jitter");
        assert.equal(inPane.replace("test.", ""), inRow.replace("props.", ""),
            "the same jitter is graded from one figure in the row and another in the pane it opens");
    });

    // A percentage of lost packets is not a latency, and one decimal is not the
    // precision it is reported at.
    it("leaves the packet loss alone", () => {
        assert.equal(entry("packetLoss").text, "1.25%");
    });
});

/**
 * The honest remainder of the source assertions.
 *
 * The latency under load appears only inside JSX, which the extraction cannot
 * run, so its precision is still pinned by its spelling; and no execution of
 * today's cards can see a figure added tomorrow, so the tripwire for a new read
 * of the raw column stays too.
 */
describe("what the extraction cannot run, read from the source", () => {
    it("prints the latency under load like a latency, in the label as well", () => {
        const loaded = between(pane, "const loadedLatency", METRICS_START);

        assert.equal((loaded.match(/formatLatencyWithUnit\(value, t\("latest\.ping_unit"\)\)/g) ?? []).length, 2,
            "the figure and the name the button is announced by disagree about its precision");
        assert.doesNotMatch(loaded, /formatWithUnit\(/);
    });

    /**
     * The one assertion that catches a figure added later and wired to the raw
     * column: nowhere in the pane is a ping read without being trimmed first.
     *
     * With one exception, and it is not a displayed figure. The grade on the
     * loaded latency's glyph is worked out from what that direction added over
     * the idle ping, and that arithmetic is shared three ways - with
     * bufferbloat(), which the facts row's grade comes from, and with the
     * server's average of the same quantity across a range. All three read the
     * stored value; trimming it here alone would let this icon disagree with the
     * grade printed under it.
     */
    it("lets no raw latency reach anything the reader sees", () => {
        const displayed = pane.replaceAll("latencyIncrease(value, test.ping)", "");

        assert.doesNotMatch(displayed, /(?<!formatLatency\()\b(test|targets|earlier)\.ping\b/,
            "a ping is still read at the two decimals the column stores");
    });
});
