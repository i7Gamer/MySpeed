import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatLatency } from "@/common/utils/FormatUtil.js";
import {
    changeFrom, differenceFromTarget, percentOfTarget
} from "../../client/src/common/components/TestDetails/utils/details.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const pane = fs.readFileSync(
    path.join(CLIENT_SRC, "common", "components", "TestDetails", "TestDetails.jsx"), "utf8");
const row = fs.readFileSync(
    path.join(CLIENT_SRC, "pages", "Home", "components", "Speedtest", "SpeedtestComponent.jsx"), "utf8");

const beforeFacts = pane.slice(0, pane.indexOf('className="detail-facts"'));

const metricsBlock = pane.match(/const metrics = \[([\s\S]*?)\n {4}];/)?.[1] ?? "";
const metricSource = (key) => metricsBlock.split(/key: "/).slice(1)
    .find((part) => part.startsWith(`${key}"`)) ?? "";

const targetLabel = beforeFacts.slice(beforeFacts.indexOf("const latencyTargetLabel"),
    beforeFacts.indexOf("const qualityFigures"));
const quality = beforeFacts.slice(beforeFacts.indexOf("const qualityFigures"),
    beforeFacts.indexOf("const quality ="));
const loaded = beforeFacts.slice(beforeFacts.indexOf("const loadedLatency"),
    beforeFacts.indexOf("const metrics"));

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
 */
describe("a latency and everything read off it agree to the decimal", () => {
    // The pair from the bug report: two tests that print the same figure must
    // not claim a change between them.
    it("reports no change between two tests that print the same latency", () => {
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

describe("the ping card computes every figure from the one it prints", () => {
    const ping = metricSource("ping");

    it("finds the card to check", () => {
        assert.notEqual(ping, "", "the ping metric is gone");
    });

    it("trims the latency once, where the card can read it back", () => {
        assert.match(beforeFacts, /const ping = formatLatency\(test\.ping\)/);
        assert.match(beforeFacts, /const pingTarget = formatLatency\(targets\.ping\)/);
        assert.match(beforeFacts, /const earlierPing = formatLatency\(earlier\.ping\)/);
    });

    // The one assertion that catches a figure added later and wired to the raw
    // column: nowhere in the pane is a ping read without being trimmed first.
    it("lets no raw latency reach anything the reader sees", () => {
        assert.doesNotMatch(pane, /(?<!formatLatency\()\b(test|targets|earlier)\.ping\b/,
            "a ping is still read at the two decimals the column stores");
    });

    it("prints the trimmed figure", () => {
        assert.match(ping, /value: ping\b/);
    });

    it("compares against the previous test at that same precision", () => {
        assert.match(ping, /change: changeFrom\(ping, earlierPing\)/);
    });

    it("measures the target, the percentage and the colour against it too", () => {
        assert.match(ping, /level: getIconBySpeed\(ping, pingTarget, false\)/);
        assert.match(ping, /percent: percentOfTarget\(ping, pingTarget,/);
        assert.match(targetLabel, /differenceFromTarget\(ping, pingTarget\)/);
    });
});

/**
 * The two other latencies on the pane. Neither is measured against a target, so
 * nothing is read off them but the jitter's colour - what was wrong with both is
 * that they printed the stored two decimals beside a ping printed at one, the
 * same measurement in the same unit written two ways on one card.
 */
describe("the jitter and the latency under load are printed like latencies", () => {
    it("prints the jitter at the precision the ping is printed at", () => {
        assert.match(quality, /formatLatencyWithUnit\(test\.jitter, t\("latest\.jitter_unit"\)\)/);
        assert.doesNotMatch(quality, /formatWithUnit\(test\.jitter/,
            "the jitter still goes out at the two decimals the column stores");
    });

    /**
     * The colour is deliberately left on the stored figure. The overview row
     * draws the same jitter through the same helper, so grading it here on the
     * printed value would make one measurement change colour between a row and
     * the pane it expands to - the worse of the two faults, and one this test
     * exists to catch. Moving both at once is a change of its own.
     */
    it("grades it from the figure the row that expands to this pane grades it from", () => {
        const argument = (source) => source.match(/jitterColour\(([^)]*\)?)\)/)?.[1];

        const inPane = argument(quality);
        const inRow = argument(row);

        assert.notEqual(inPane, undefined, "the pane no longer grades the jitter");
        assert.notEqual(inRow, undefined, "the row no longer grades the jitter");
        assert.equal(inPane.replace("test.", ""), inRow.replace("props.", ""),
            "the same jitter is graded from one figure in the row and another in the pane it opens");
    });

    it("prints the latency under load the same way, in the label as well", () => {
        assert.equal((loaded.match(/formatLatencyWithUnit\(value, t\("latest\.ping_unit"\)\)/g) ?? []).length, 2,
            "the figure and the name the button is announced by disagree about its precision");
        assert.doesNotMatch(loaded, /formatWithUnit\(/);
    });

    // A percentage of lost packets is not a latency, and one decimal is not the
    // precision it is reported at.
    it("leaves the packet loss alone", () => {
        assert.doesNotMatch(pane, /formatLatency\w*\(test\.packetLoss/);
    });

    // The speeds have their own conversion and their own precision, and a
    // download rounded to one decimal would be a different figure entirely.
    it("leaves the speeds alone", () => {
        for (const key of ["download", "upload"])
            assert.doesNotMatch(metricSource(key), /formatLatency/,
                `the ${key} card lost its own precision`);
    });
});
