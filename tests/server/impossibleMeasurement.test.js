import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import { impossibleMeasurement, usableFigure, FAILED_TEST } from "../../server/util/testOutcome.js";

/**
 * A speed below zero, which is upstream #875 - and, on the evidence of the
 * screenshot, #792.
 *
 * The neighbouring case is already handled: a run that measured *nothing* is
 * refused by isFailedTest before it can be written as a success. But that
 * predicate asks whether all three of ping, download and upload are the failure
 * placeholder, so a run that measured *something impossible* - one negative
 * upload beside two good figures - is not a failure by any reading and is stored
 * as an ordinary result.
 *
 * From there every reader believes it. It drags the average, it colours a grade,
 * the CSV export carries it, and the alert gate reads it as a measurement far
 * below the threshold and raises an outage that never happened. Nothing on the
 * page says the number is impossible, because nothing knows.
 */
describe("a required measurement below zero", () => {
    const good = {ping: 12, download: 100, upload: 50};

    it("is not treated as a measurement", () => {
        assert.equal(impossibleMeasurement({...good, upload: -0.5}), "upload");
        assert.equal(impossibleMeasurement({...good, download: -3}), "download");
        assert.equal(impossibleMeasurement({...good, ping: -1.5}), "ping");
    });

    it("leaves an ordinary run alone", () => {
        assert.equal(impossibleMeasurement(good), null);
    });

    /**
     * Zero is a measurement. A line that carried nothing in the time allowed is
     * a real and useful thing to record, and it is what an outage looks like -
     * clamping it away would hide the very reading the instance exists to catch.
     */
    it("does not object to zero", () => {
        assert.equal(impossibleMeasurement({ping: 0, download: 0, upload: 0}), null);
    });

    /**
     * The failure placeholder is negative, and a row carrying it in all three is
     * a failed run rather than an impossible one. isFailedTest already names
     * that and says so in its own words; two guards answering the same row would
     * make which message the operator sees a matter of ordering.
     */
    it("leaves a failed run to the predicate that owns it", () => {
        assert.equal(impossibleMeasurement({ping: FAILED_TEST, download: FAILED_TEST, upload: FAILED_TEST}), null);
    });

    // A single placeholder among real figures is not a failure - it is one
    // column that came back impossible, which is exactly this guard's business.
    it("catches a lone placeholder among real figures", () => {
        assert.equal(impossibleMeasurement({...good, upload: FAILED_TEST}), "upload");
    });

    /**
     * Read the way every other consumer reads these columns: sqlite hands back
     * whatever it was given, so a history imported before importTests validated
     * its columns can hold "-1" as text - which `< 0` on a string answers false
     * for.
     */
    it("reads a stored string the way the rest of the row is read", () => {
        assert.equal(impossibleMeasurement({...good, upload: "-4"}), "upload");
    });

    it("is unbothered by a value that is not a number at all", () => {
        for (const value of [null, undefined, "", {}, NaN])
            assert.equal(impossibleMeasurement({...good, upload: value}), null,
                `${JSON.stringify(value)} was reported as impossible`);
    });
});

/**
 * The optional figures are a different question with a different answer.
 *
 * They are nullable, and null already means "nobody measured this" - so a
 * negative one has an honest home to go to. Failing the whole run over a jitter
 * of -0.2 would throw away a perfectly good throughput measurement, which is the
 * opposite of what #875 is about.
 */
describe("an optional figure below zero", () => {
    it("is read as unmeasured rather than as a figure", () => {
        assert.equal(usableFigure(-0.2), null);
        assert.equal(usableFigure("-3"), null);
    });

    it("keeps a measured zero", () => {
        assert.equal(usableFigure(0), 0);
    });

    it("keeps an ordinary figure", () => {
        assert.equal(usableFigure(2.5), 2.5);
        assert.equal(usableFigure("2.5"), 2.5);
    });

    it("passes absence straight through", () => {
        assert.equal(usableFigure(null), null);
        assert.equal(usableFigure(undefined), null);
    });
});

/**
 * The writer, which is the only place either judgement does anything: past
 * tests.create the row exists and the notification has already been chosen.
 */
describe("the writer", () => {
    const source = readSource("server/tasks/speedtest.js");

    const betweenParseAndWrite = source.slice(
        source.indexOf("parseData.parseData("),
        source.indexOf("await tests.create("));

    it("refuses to write an impossible run as a success", () => {
        assert.match(betweenParseAndWrite, /impossibleMeasurement\(/,
            "a negative speed is still stored as an ordinary result");
        assert.match(betweenParseAndWrite, /throw /,
            "the run is recognised as impossible and written down anyway");
    });

    /**
     * By the failure door, which is the same one an unmeasurable run leaves by:
     * it records the reason, tells the integrations the test failed, and retries
     * once - which a run that came back with a negative reading deserves as much
     * as one that came back with nothing.
     */
    it("names which figure it refused", () => {
        assert.match(betweenParseAndWrite, /impossible/i,
            "the stored reason does not say what was wrong with the run");
    });

    it("asks the module that owns the question", () => {
        assert.match(source,
            /import\s*\{[^}]*impossibleMeasurement[^}]*\}\s*from\s*['"][^'"]*testOutcome\.js['"]/,
            "the writer judges an impossible reading by a rule of its own");
    });

    /**
     * Read at the write rather than in the window above, because that is where
     * it belongs: these figures are not a reason to refuse the run, so they are
     * cleaned as the row is assembled rather than judged before it.
     */
    it("keeps the optional figures rather than failing over one", () => {
        const write = source.slice(source.indexOf("await tests.create("));
        const call = write.slice(0, write.indexOf("});") + 1);

        for (const figure of ["jitter", "packetLoss", "downloadLatency", "uploadLatency"])
            assert.match(call, new RegExp(`${figure}:\\s*usableFigure\\(`),
                `a negative ${figure} is stored as a figure`);
    });
});
