import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    convertSpeed, formatLatency, formatLatencyWithUnit, formatWithUnit, roundsToZeroLatency
} from "@/common/utils/FormatUtil.js";
import {
    getIconBySpeed, isMeasured, jitterColour, measuredLatency, packetLossColour, readableFigure
} from "@/common/utils/TestUtil.js";
import {
    changeFrom, differenceFromTarget, percentOfTarget
} from "../../client/src/common/components/TestDetails/utils/details.js";
import { escapeRegExp, withoutJsComments } from "../helpers/source.js";

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
// The region opens at the loss chip's hoisted glue site: the chip's text and
// label both read it, so the executed strip below needs it in the slice.
const QUALITY_START = "const lossText";
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
const buildMetrics = ({test, limits = {}, earlier = {}}) => evaluate(
    `${derivations()}\n${metricsLiteral()}\nreturn metrics;`, {
        test, limits, earlier, t,
        formatLatency, formatWithUnit, roundsToZeroLatency, changeFrom, differenceFromTarget, percentOfTarget,
        getIconBySpeed, convertSpeed, measuredLatency,
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
        isMeasured, jitterColour, packetLossColour, readableFigure,
        formatLatencyWithUnit, formatWithUnit, formatLatency,
        faWaveSquare: null, jitterInfo: null, faLinkSlash: null, packetLossInfo: null
    });

// The pair from the bug report: 25.44 after 25.36, against a target typed into
// the settings dialog - which stores what was typed, a string.
const BUG_REPORT = {test: {ping: 25.44}, limits: {ping: "25"}, earlier: {ping: 25.36}};

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

    // The target is what the config holds, which is whatever was typed into
    // the settings dialog - a string, handed over RAW. The pane used to trim
    // its copy through formatLatency, and once the formatter learned to read
    // strings that trim made the pane the odd view out: every other view
    // grades against the exact typed target, so a boundary ping wore one
    // colour on the row and another on the pane it opens - for every target
    // with more than one decimal.
    //
    // Two targets, because the colour and the sentence answer two different
    // questions. The COLOUR answers "is this line meeting the target every
    // view grades against" - raw, or the pane disagrees with the row it
    // opened from. The SENTENCE answers "how far from the target is the
    // figure I just printed" - printed against printed, or a numeric
    // per-target optimum of 25.44 beside a ping printed 25.4 reads "0.04 ms
    // under" when the line is exactly on target.
    it("hands the colour the target as typed, and the sentence the target as printed", () => {
        assert.match(pane, /const pingTarget = limits\.ping;/,
            "the pane's colour grades a different target than the three views beside it");
        // The sentence's operands travel as a PAIR - one destructure picks
        // both, so a branch cannot mix a printed ping with a raw target:
        // like-against-unlike is the exact pairing the printed-vs-printed
        // rule exists to forbid.
        assert.match(pane, /\{sentenceTarget: formatLatency\(limits\.ping\), sentenceFigure: ping\}/,
            "the sentence has no printed target to compare its printed ping against");
        assert.match(pane, /\{sentenceTarget: limits\.ping, sentenceFigure: measuredLatency\(test\.ping\)\}/,
            "the sub-resolution branch lost its stored-against-stored pair - a sub-0.05 target prints "
            + "as 0, which asTarget refuses, and the sentence silently vanishes");
        assert.match(pane, /differenceFromTarget\(sentenceFigure, sentenceTarget\)/,
            "the sentence no longer reads the paired operands");
        assert.match(pane, /getIconBySpeed\(ping, pingTarget, false\)/,
            "the colour no longer grades against the typed target");
    });

    it("keeps a target stored as a string usable", () => {
        assert.equal(percentOfTarget(formatLatency(25.44), "25", {higherIsBetter: false}), 98);
        assert.deepEqual(differenceFromTarget(formatLatency(25.44), "25"),
            {difference: 0.4, direction: "over"});
        assert.deepEqual(differenceFromTarget(formatLatency(25.44), formatLatency("25.44")),
            {difference: 0, direction: "same"},
            "a ping exactly on a fractional target reads as beating it by the decimal the screen never shows");
    });

    // The fractional-target cases that separate the two wirings - whole-number
    // fixtures cannot, because formatLatency returns them unchanged.
    it("colours a boundary ping the same as the row, for a fractional target", () => {
        assert.equal(getIconBySpeed(formatLatency(25.96), "20.01", false), "green",
            "the pane grades 26.0/20 where every other view grades 26.0/20.01");
        assert.equal(getIconBySpeed(25.96, "20.01", false), "green");
    });

    // The percent bar stays on the raw target: whole-percent rounding absorbs
    // the trim at this magnitude, and the destination is what is asserted.
    it("fills the bar to one hundred for a ping exactly on its fractional target", () => {
        assert.equal(percentOfTarget(formatLatency(25.44), "25.44", {higherIsBetter: false}), 100);
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
        assert.equal(pingCard({test: {ping: 2.04}, limits: {ping: "2"}}).percent, 100);
    });

    // 12.96 prints as 13, and 13 against a target of 10 is exactly the 130%
    // where the colour turns - the card is graded on the figure it shows.
    it("colours the card from the printed figure", () => {
        assert.equal(pingCard({test: {ping: 12.96}, limits: {ping: "10"}}).level, "orange");
    });

    // A wholly failed run has no facts grid, so the ping card only ever shows
    // a placeholder in a MIXED row - one real reading beside it. The reader
    // refuses the -1, so the card holds nothing, prints as unmeasured, and
    // wears the unmeasured blue rather than a failure red beside "N/A".
    it("hands the failure placeholder through to the guards", () => {
        const card = pingCard({...BUG_REPORT, test: {ping: -1}});

        assert.equal(card.value, null, "the placeholder reached the card as a figure");
        assert.equal(card.change, null);
        assert.equal(card.percent, null);
        assert.equal(card.targetLabel, null);
        assert.equal(card.level, "blue");
    });

    // The sentinel a successful run stores when nobody measured the latency
    // used to print as "0 ms", "100% of target" and green.
    it("treats an unmeasured latency exactly like a placeholder", () => {
        const card = pingCard({...BUG_REPORT, test: {ping: 0}});

        assert.equal(card.value, null);
        assert.equal(card.percent, null);
        assert.equal(card.level, "blue");
    });

    it("shows no target figures when no target is configured", () => {
        const card = pingCard({test: {ping: 25.44}});

        assert.equal(card.percent, null);
        assert.equal(card.targetLabel, null);
        assert.equal(card.level, "blue");
    });

    /**
     * A target below the display's resolution must not lose its sentence.
     * formatLatency("0.04") prints 0, and asTarget refuses a zero target, so
     * the label silently vanished while the bar and the colour - raw-target
     * readers - stayed. roundsToZeroLatency exists for exactly this reading:
     * real but too small to print. The sentence gets the raw target then; it
     * prints only the difference, never the target itself, so nothing
     * unprintable reaches the screen.
     */
    it("keeps the sentence for a target below the printable resolution", () => {
        // Stored against stored in this branch: the target cannot print, so
        // the printed ping is no like operand either - 5.24 minus 0.04, not
        // the trimmed 5.2 minus the raw 0.04.
        assert.deepEqual(pingCard({test: {ping: 5.24}, limits: {ping: "0.04"}}).targetLabel,
            {key: "test.details.over_target", amount: 5.2, unit: "latest.ping_unit"},
            "the one target that cannot be printed loses its sentence entirely");
    });

    // The distance the branch states is the TRUE stored distance: printed
    // 0.1 against raw 0.04 read "0.06 ms over" where the line sits 0.02 from
    // its target - three times the real figure, in a pane whose thesis is
    // that both sides of a comparison come from one domain.
    it("states the stored distance when the target is below resolution", () => {
        assert.deepEqual(pingCard({test: {ping: 0.06}, limits: {ping: "0.04"}}).targetLabel,
            {key: "test.details.over_target", amount: 0.02, unit: "latest.ping_unit"});
    });

    it("calls a ping exactly on a sub-resolution target on target", () => {
        assert.equal(pingCard({test: {ping: 0.04}, limits: {ping: "0.04"}}).targetLabel,
            "test.details.on_target");
    });

    /**
     * The whole card for the awkwardest pair: a ping that prints 0 against a
     * target too small to print. The sentence is the one informative element
     * - stored against stored, 0.02 over - while the bar refuses the printed
     * zero (a zero figure is no divisor) and the icon grades 0-over-target as
     * the best ratio there is, green. Coherent, if lopsided: no element
     * claims a different distance, and the one that can state a figure states
     * the true one.
     */
    it("keeps the sentence informative for a printed-zero ping on a sub-resolution target", () => {
        const card = pingCard({test: {ping: 0.03}, limits: {ping: "0.01"}});

        assert.deepEqual(card.targetLabel,
            {key: "test.details.over_target", amount: 0.02, unit: "latest.ping_unit"});
        assert.equal(card.value, 0, "formatLatency prints a 0.03 ping as 0");
        assert.equal(card.percent, null, "the bar divides by a printed zero");
        assert.equal(card.level, "green");
    });

    // A target of exactly zero stays unset - asTarget refuses it on every
    // path, and the percent bar refuses the same value, so the pane keeps
    // saying nothing rather than "on target" against a target nobody set.
    it("still treats a zero target as no target", () => {
        assert.equal(pingCard({test: {ping: 5.24}, limits: {ping: "0"}}).targetLabel, null);
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
     * A packet loss readableFigure refuses is no measurement, and this row
     * prints the stored column RAW - so junk that showed rendered "auto%" or
     * a bare "%" beside the blue never-measured colour the grader gives it.
     * The row does not render at all then; decided by what is correct to
     * show, and applied to the card view the same way. (The jitter chip
     * differs on purpose: its label prints through formatLatencyWithUnit,
     * which says N/A for what it cannot read, so showing-with-N/A is that
     * chip's honest form - this row's raw label has no such word.)
     */
    it("drops the packet-loss row for a value nothing can read", () => {
        for (const junk of ["auto", "", "0,5", -1, "-1", NaN])
            assert.equal(qualityEntries({jitter: null, packetLoss: junk})
                .find((figure) => figure.key === "packetLoss"), undefined,
                `a packet loss of ${JSON.stringify(junk)} rendered as a reading`);
    });

    it("keeps the packet-loss row for a real reading in either spelling", () => {
        for (const measured of [0, 1.25, "0.5"])
            assert.notEqual(qualityEntries({jitter: null, packetLoss: measured})
                .find((figure) => figure.key === "packetLoss"), undefined,
                `a packet loss of ${JSON.stringify(measured)} vanished`);
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

        // The row grades a hoisted const now; what the belt compares is the
        // expression behind the name, so a hoist cannot satisfy it with a
        // different reading under the same label.
        const resolved = (source, expression) => {
            const declaration = expression && source.match(
                new RegExp(`const ${escapeRegExp(expression)} = ([^;]+);`))?.[1];

            return declaration ?? expression;
        };

        const inPane = argument(qualityRegion());
        const inRow = resolved(row, argument(row));

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
     * The reads the tripwire below excepts, one construct per line - and one
     * LINE per construct, because the guard blanks them by literal
     * replacement and a multi-line entry silently stops matching the CRLF
     * source, which reads as the construct having gone away.
     *
     * None is a displayed figure. The grade on the loaded latency's glyph is
     * worked out from what that direction added over the idle ping, and that
     * arithmetic is shared three ways - with bufferbloat(), which the facts
     * row's grade comes from, and with the server's average of the same
     * quantity across a range; all three read the stored value, and trimming
     * it here alone would let this icon disagree with the grade printed
     * under it. The TARGET is handed over raw because it is config, not a
     * measurement: every view grades against the typed value, and the pane
     * trimming its copy alone made a boundary ping wear two colours between
     * the row and the pane it opens. And the sub-resolution machinery reads
     * raw on purpose - the predicate deciding whether the printed form
     * survives, and the stored-against-stored pair for the target the trim
     * would erase - all handed to the sentence's guards, never to the screen.
     */
    const RAW_TARGET_READS = [
        ["latencyIncrease(value, test.ping)", 1],
        ["const pingTarget = limits.ping;", 1],
        ["roundsToZeroLatency(limits.ping)", 1],
        ["{sentenceTarget: limits.ping, sentenceFigure: measuredLatency(test.ping)}", 1]
    ];

    // The counts and the guard read the pane's CODE, comments stripped: the
    // pane's own prose already names its constructs, and counted raw, an
    // ordinary comment quoting a granted read broke the build - while a
    // construct surviving only in a comment satisfied the facts test with
    // the code gone.
    const paneCode = withoutJsComments(pane);

    // Each entry is a fact about the pane before it is an exception to the
    // tripwire - one that stops appearing exempts nothing and must go - and
    // an EXACT count: the guard below blanks every occurrence, so a second
    // copy of a granted construct would be a second, never-reviewed raw
    // read riding a one-time grant.
    it("keeps the excepted reads a list of facts, each granted exactly once", () => {
        for (const [read, count] of RAW_TARGET_READS) {
            const seen = paneCode.split(read).length - 1;

            assert.equal(seen, count, seen === 0
                ? `"${read}" is no longer in the pane; drop it from RAW_TARGET_READS`
                : `"${read}" appears ${seen} times in the pane where ${count} was granted; a second copy is `
                + "a second construct, and the blanking exempts both");
        }
    });

    /**
     * A raw read in either chaining spelling, however a refactor writes it.
     * The lookbehind exempts the one formatted read - with or without the
     * unit half - and the optional `?` matters: the hardened siblings two
     * files over write house-style optional chaining, so the next defensive
     * pass over this pane will too, and a guard that only knows the bare
     * dot lets exactly that edit walk out of it. The names are the pane's
     * whole row-holding scope: test, limits, earlier - and previous and
     * previousConnection, the props earlier aliases and the guard only ever
     * watched through the alias.
     */
    // measuredLatency is the other exempt reader: it refuses the unmeasured
    // sentinel and the placeholders, and what it answers is what the pane
    // then trims. The sub-resolution branch hands the sentence the stored
    // figure through it, so a stored-against-stored pair is still no raw
    // read.
    const RAW_LATENCY_READ =
        /(?<!(?:formatLatency(?:WithUnit)?|measuredLatency)\()\b(test|limits|earlier|previousConnection|previous)\??\.ping\b/;

    it("reads a raw ping in either chaining spelling, and only a raw one", () => {
        for (const raw of ["const x = test.ping;", "const x = test?.ping;", "limits?.ping", "earlier?.ping;",
            "previous.ping", "previous?.ping", "previousConnection.ping"])
            assert.match(raw, RAW_LATENCY_READ, `"${raw}" no longer reads as a raw latency`);

        for (const guarded of ["formatLatency(test.ping)", "formatLatency(test?.ping)",
            "formatLatencyWithUnit(test.ping, ms)", "measuredLatency(test.ping)",
            "formatLatency(measuredLatency(earlier.ping))", "other?.ping", "latest.ping_unit", "test.pinged"])
            assert.doesNotMatch(guarded, RAW_LATENCY_READ, `"${guarded}" is formatted or no latency read at all`);
    });

    /**
     * The dot is not the only spelling of a read: `const {ping} = test;` -
     * this codebase's own house form, bufferbloat() writes it - takes the
     * raw column without ever writing "test.ping". One prefix level is
     * admitted, in either chaining (props.test, props?.test); two levels, a
     * parameter destructure (`({ping}) => ...`) and a nested one
     * (`{test: {ping}}`) are the stated bounds.
     */
    const RAW_LATENCY_DESTRUCTURE =
        /[{,]\s*ping\b[^}]*\}\s*=\s*(?:[\w$]+\??\.)?(?:test|limits|earlier|previousConnection|previous)\b/;

    it("reads a destructured ping, and only from a test-shaped object", () => {
        for (const raw of ["const {ping} = test;", "const {ping: raw} = test;", "const {download, ping} = test;",
            "const {ping} = limits;", "const {ping} = earlier;", "let {ping, jitter} = test;",
            "const { ping } = test;", "const {ping} = props.test;", "const {ping} = props?.test;",
            "const {ping: previousPing} = previous;", "const {ping} = previousConnection;"])
            assert.match(raw, RAW_LATENCY_DESTRUCTURE, `"${raw}" no longer reads as a raw latency`);

        for (const clean of ["const {pingTarget} = config;", "({ping: 25.44})", "const {ping} = other;",
            "const {pinged} = test;", "const {jitter} = test;", "const {ping} = testUtil;",
            "formatLatency(test.ping)",
            // The stated bounds, pinned as bounds: a parameter destructure
            // and a nested one stay out of this pattern's reach.
            "const row = ({ping}) => formatLatency(ping);",
            "const {test: {ping}} = props;"])
            assert.doesNotMatch(clean, RAW_LATENCY_DESTRUCTURE, `"${clean}" is no raw latency read`);
    });

    /**
     * The one assertion that catches a figure added later and wired to the
     * raw column: nowhere in the pane is a ping read without being trimmed
     * first, the listed constructs aside.
     */
    it("lets no raw latency reach anything the reader sees", () => {
        const displayed = RAW_TARGET_READS.reduce(
            (source, [read]) => source.replaceAll(read, ""), paneCode);

        assert.doesNotMatch(displayed, RAW_LATENCY_READ,
            "a ping is still read at the two decimals the column stores");
        assert.doesNotMatch(displayed, RAW_LATENCY_DESTRUCTURE,
            "a ping is destructured out of its row at the two decimals the column stores");
    });
});
