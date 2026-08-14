import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    bufferbloat, bufferbloatColour, bufferbloatTrend, connectionChange, failureRate, getIconBySpeed,
    gradeForIncrease, isFailedTest, jitterColour, latencyIncrease, packetLossColour, pingDeviationColour,
    previousConnection, TREND_LENGTH
} from "../../client/src/common/utils/TestUtil.js";

/**
 * A step in the numbers reads as the line degrading. Often it is not: the lease
 * was reassigned, a failover moved the traffic, the router was swapped. The
 * provider reports who the connection was on every test, so the change can be
 * pointed at instead of guessed at.
 */
describe("connectionChange", () => {
    const on = (isp, externalIp) => ({isp, externalIp});

    it("says nothing when the connection is the one it was", () => {
        assert.equal(connectionChange(on("Salt", "1.2.3.4"), on("Salt", "1.2.3.4")), null);
    });

    it("reports a changed address", () => {
        assert.deepEqual(connectionChange(on("Salt", "5.6.7.8"), on("Salt", "1.2.3.4")),
            {isp: false, externalIp: true});
    });

    it("reports a changed provider", () => {
        assert.deepEqual(connectionChange(on("Init7", "1.2.3.4"), on("Salt", "1.2.3.4")),
            {isp: true, externalIp: false});
    });

    it("reports both when both moved", () => {
        assert.deepEqual(connectionChange(on("Init7", "5.6.7.8"), on("Salt", "1.2.3.4")),
            {isp: true, externalIp: true});
    });

    // The first test of all has nothing to differ from, and neither does a test
    // recorded before these columns existed - an absent value is not a change.
    it("says nothing without something to compare against", () => {
        assert.equal(connectionChange(on("Salt", "1.2.3.4"), undefined), null);
        assert.equal(connectionChange(on("Salt", "1.2.3.4"), on(null, null)), null);
        assert.equal(connectionChange(on(null, null), on("Salt", "1.2.3.4")), null);
        assert.equal(connectionChange(undefined, on("Salt", "1.2.3.4")), null);
    });

    it("compares each field independently when only one is known", () => {
        assert.deepEqual(connectionChange(on("Init7", null), on("Salt", "1.2.3.4")),
            {isp: true, externalIp: false});
    });
});

/**
 * The row immediately before is the wrong thing to compare against: it may
 * carry no identity at all - every test recorded before the columns existed,
 * and every test from a provider that does not report them. Comparing to it
 * would report "no change" across exactly the gap a change hides in.
 */
describe("previousConnection", () => {
    const withIdentity = (created, isp) => ({created, isp, externalIp: "1.2.3.4"});
    const withoutIdentity = (created) => ({created, isp: null, externalIp: null});

    it("is the test immediately before when that one has an identity", () => {
        const tests = [withIdentity("3", "Init7"), withIdentity("2", "Salt"), withIdentity("1", "Salt")];

        assert.equal(previousConnection(tests, 0).created, "2");
    });

    // Newest first, so it searches forwards through the array to go backwards
    // through time.
    it("skips over tests that carry no identity", () => {
        const tests = [withIdentity("4", "Init7"), withoutIdentity("3"), withoutIdentity("2"),
            withIdentity("1", "Salt")];

        assert.equal(previousConnection(tests, 0).created, "1");
    });

    it("is null when nothing earlier carries one", () => {
        const tests = [withIdentity("2", "Salt"), withoutIdentity("1")];

        assert.equal(previousConnection(tests, 0), null);
    });

    it("is null for the oldest test in the list", () => {
        assert.equal(previousConnection([withIdentity("1", "Salt")], 0), null);
    });

    it("does not reach past the end or throw on a missing list", () => {
        assert.equal(previousConnection([], 0), null);
        assert.equal(previousConnection(undefined, 0), null);
    });
});

/**
 * A single grade says what the line did on the last test; the trend is where a
 * regression shows. Built from the list the API already returns - newest first -
 * and displayed oldest to newest, the way time reads.
 */
describe("bufferbloatTrend", () => {
    const measured = (created, up) => ({created, ping: 4, downloadLatency: 6, uploadLatency: up});

    it("grades each measured test, oldest first", () => {
        const trend = bufferbloatTrend([measured("10:00", 300), measured("09:00", 40), measured("08:00", 6)]);

        assert.deepEqual(trend.map((entry) => entry.grade), ["A+", "B", "D"]);
        assert.deepEqual(trend.map((entry) => entry.created), ["08:00", "09:00", "10:00"]);
    });

    it("carries the increase for each entry", () => {
        const [entry] = bufferbloatTrend([measured("10:00", 44)]);

        assert.equal(entry.increase, 40);
    });

    it("skips tests that measured nothing rather than grading them", () => {
        const trend = bufferbloatTrend([
            measured("10:00", 20),
            {created: "09:00", ping: 5, downloadLatency: null, uploadLatency: null},
            {created: "08:00", ping: -1, downloadLatency: -1, uploadLatency: -1, error: "failed"},
            measured("07:00", 6)
        ]);

        assert.deepEqual(trend.map((entry) => entry.created), ["07:00", "10:00"]);
    });

    it("caps the trend at its display length", () => {
        const many = Array.from({length: TREND_LENGTH + 5}, (_, i) => measured(`t${i}`, 20));

        assert.equal(bufferbloatTrend(many).length, TREND_LENGTH);
    });

    // The list is newest first, so the cap must keep the newest entries - a
    // trend that dropped the most recent tests would show the past instead.
    it("keeps the newest tests when it truncates", () => {
        const many = Array.from({length: TREND_LENGTH + 5}, (_, i) => measured(`t${i}`, 20));

        const trend = bufferbloatTrend(many);

        assert.equal(trend.at(-1).created, "t0");
    });

    it("is empty for no tests and for none with data", () => {
        assert.deepEqual(bufferbloatTrend([]), []);
        assert.deepEqual(bufferbloatTrend(undefined), []);
        assert.deepEqual(bufferbloatTrend([{created: "x", ping: 4}]), []);
    });
});

/**
 * Bufferbloat is how much latency the line gains once it is saturated. It is the
 * figure that explains a call breaking up while something uploads, and it is
 * invisible in the three numbers MySpeed has always shown: a connection can be
 * fast in both directions and still unusable during a transfer.
 *
 * Graded on the worse of the two directions, because that is the one the reader
 * will notice.
 */
describe("bufferbloat", () => {
    const test = (ping, down, up) => bufferbloat({ping, downloadLatency: down, uploadLatency: up});

    it("is the latency the line gains under load", () => {
        assert.equal(test(4, 7.5, 20).increase, 16);
    });

    it("grades on the worse direction, not the average", () => {
        // Clean downstream, badly buffered upstream - the usual asymmetry, and
        // an average would hide it.
        assert.equal(test(4, 5, 44).increase, 40);
        assert.equal(test(4, 5, 44).grade, "B");
    });

    it("grades an unbuffered line at the top", () => {
        assert.equal(test(4, 5, 6).grade, "A+");
    });

    it("walks down the scale as the line gets worse", () => {
        assert.equal(test(4, 4, 20).grade, "A");
        assert.equal(test(4, 4, 50).grade, "B");
        assert.equal(test(4, 4, 150).grade, "C");
        assert.equal(test(4, 4, 300).grade, "D");
        assert.equal(test(4, 4, 900).grade, "F");
    });

    it("keeps the second decimal the server also works to", () => {
        // Not trimmed to the one decimal a latency is shown at: the server
        // averages this same quantity across a range, and the two are pinned to
        // the same arithmetic - so this figure answers to that agreement rather
        // than to how it is printed.
        assert.equal(test(10, 14.96, 0).increase, 4.96);
    });

    it("never reports a negative increase", () => {
        // Latency under load below the idle ping is noise, not an improvement.
        assert.equal(test(20, 5, 6).increase, 0);
        assert.equal(test(20, 5, 6).grade, "A+");
    });

    it("says nothing when the test did not measure it", () => {
        assert.equal(test(4, null, null), null);
        assert.equal(test(4, 7.5, null), null);
        assert.equal(test(null, 7.5, 20), null);
        assert.equal(bufferbloat(undefined), null);
    });

    it("says nothing for a failed test rather than grading its placeholders", () => {
        assert.equal(bufferbloat({ping: -1, downloadLatency: -1, uploadLatency: -1}), null);
    });
});

/**
 * The failed count has always been on the statistics page, but a bare number
 * says nothing without the total beside it: 23 failures is a rounding error
 * across a year and an outage across an afternoon.
 */
describe("failureRate", () => {
    it("is the share of tests that failed", () => {
        assert.equal(failureRate(1000, 23), 2.3);
        assert.equal(failureRate(4, 1), 25);
    });

    it("is zero when everything succeeded", () => {
        assert.equal(failureRate(1000, 0), 0);
    });

    it("is a hundred when everything failed", () => {
        assert.equal(failureRate(48, 48), 100);
    });

    it("rounds to a single decimal", () => {
        assert.equal(failureRate(3, 1), 33.3);
    });

    // Nothing measured is not the same as nothing failed, and 0/0 is NaN.
    it("is absent when there were no tests at all", () => {
        assert.equal(failureRate(0, 0), null);
    });

    it("is absent rather than wrong for nonsense input", () => {
        for (const [total, failed] of [[undefined, 1], [10, undefined], [-1, 1], [10, null]])
            assert.equal(failureRate(total, failed), null, `failed for ${total}/${failed}`);
    });
});

const speed = (current, optimal) => getIconBySpeed(current, optimal, true);
const latency = (current, optimal) => getIconBySpeed(current, optimal, false);

describe("getIconBySpeed", () => {
    describe("throughput", () => {
        it("is green at or above three quarters of the optimum", () => {
            assert.equal(speed(100, 100), "green");
            assert.equal(speed(75, 100), "green");
        });

        it("is orange between a third and three quarters", () => {
            assert.equal(speed(74, 100), "orange");
            assert.equal(speed(30, 100), "orange");
        });

        it("is red below a third", () => {
            assert.equal(speed(29, 100), "red");
            assert.equal(speed(0, 100), "red");
        });
    });

    describe("latency, where higher is worse", () => {
        it("is green up to 130% of the target", () => {
            assert.equal(latency(25, 25), "green");
            assert.equal(latency(32, 25), "green");
        });

        it("is orange between 130% and 180%", () => {
            assert.equal(latency(33, 25), "orange");
            assert.equal(latency(44, 25), "orange");
        });

        it("is red at or above 180%", () => {
            assert.equal(latency(45, 25), "red");
        });
    });

    it("reports a failed test as an error", () => {
        assert.equal(speed(-1, 100), "error");
        assert.equal(latency(-1, 25), "error");
    });

    /**
     * Regression: with no tests yet the dashboard passes the "N/A" placeholder,
     * which made the percentage NaN. NaN fails every comparison, so download and
     * upload fell through to "red" - a fresh install reported a bad connection
     * before anything had been measured. Latency fell through to "green", so the
     * two halves of the dashboard even disagreed.
     */
    describe("before anything has been measured", () => {
        it("is neutral for the N/A placeholder", () => {
            assert.equal(speed("N/A", 100), "blue");
            assert.equal(latency("N/A", 25), "blue");
        });

        it("is neutral for a missing measurement", () => {
            for (const missing of [undefined, null, ""])
                assert.equal(speed(missing, 100), "blue", `failed for ${JSON.stringify(missing)}`);
        });

        it("is neutral when no optimum is configured", () => {
            assert.equal(speed(100, undefined), "blue");
            assert.equal(speed(100, 0), "blue");
        });

        it("never reports a real reading as neutral", () => {
            for (const value of [1, 50, 100, 1000])
                assert.notEqual(speed(value, 100), "blue");
        });
    });
});

/**
 * A failed test is stored with an error string and -1 in every numeric column.
 * The node list printed those placeholders straight out, so a node whose last
 * test failed advertised "-1 ms" and "-1 Mbps" as though they were readings.
 */
describe("isFailedTest", () => {
    it("recognises the row a failed test leaves behind", () => {
        assert.equal(isFailedTest({error: "Cannot open socket", ping: -1, download: -1, upload: -1}), true);
    });

    it("trusts the placeholders even when no message was recorded", () => {
        assert.equal(isFailedTest({error: null, ping: -1, download: -1, upload: -1}), true);
    });

    it("leaves a successful test alone", () => {
        assert.equal(isFailedTest({error: null, ping: 5, download: 2366.32, upload: 2202.56}), false);
    });

    it("does not call an empty error string a failure", () => {
        assert.equal(isFailedTest({error: "", ping: 12, download: 100, upload: 50}), false);
    });

    it("treats a genuine zero as a measurement rather than a failure", () => {
        assert.equal(isFailedTest({error: null, ping: 0, download: 0, upload: 0}), false);
    });

    it("is false when there is no test at all", () => {
        assert.equal(isFailedTest(undefined), false);
        assert.equal(isFailedTest(null), false);
    });
});

/**
 * The grade for an increase that did not come from a single test.
 *
 * The consistency panel reports the average added latency across a whole range,
 * and grading it means applying the same thresholds a per-test grade uses -
 * from one table, so an averaged B and a per-test B mean the same thing.
 */
describe("gradeForIncrease", () => {
    it("grades each band at its own threshold", () => {
        assert.equal(gradeForIncrease(0), "A+");
        assert.equal(gradeForIncrease(4.9), "A+");
        assert.equal(gradeForIncrease(5), "A");
        assert.equal(gradeForIncrease(29.9), "A");
        assert.equal(gradeForIncrease(30), "B");
        assert.equal(gradeForIncrease(60), "C");
        assert.equal(gradeForIncrease(200), "D");
        assert.equal(gradeForIncrease(400), "F");
        assert.equal(gradeForIncrease(10000), "F");
    });

    // Absent is not zero: a range in which nothing measured loaded latency has
    // no grade to give, and "A+" would be the most flattering possible lie.
    it("has no grade for anything that is not a measurement", () => {
        for (const value of [null, undefined, NaN, Infinity, -1, "30", {}])
            assert.equal(gradeForIncrease(value), null, `${String(value)} must not grade`);
    });

    // The per-test grade has to come from the same table, or the headline and
    // the dots beneath it could disagree about what a B is.
    it("agrees with the grade a single test is given", () => {
        const test = {ping: 10, downloadLatency: 50, uploadLatency: 22, error: null};
        const {increase, grade} = bufferbloat(test);

        assert.equal(gradeForIncrease(increase), grade);
    });
});

/**
 * How much latency one transfer added.
 *
 * Lifted out of bufferbloat() because the detail pane grades each direction on
 * its own: the single grade beside those two figures is deliberately the worse
 * of them, so it cannot say which direction is the bad one - and a line that is
 * clean downstream and badly buffered upstream is the usual asymmetry.
 */
describe("latencyIncrease", () => {
    it("is what the transfer added over the idle ping", () => {
        assert.equal(latencyIncrease(50, 10), 40);
    });

    // Under the idle ping is measurement noise, not an improvement.
    it("floors at zero rather than reporting a negative", () => {
        assert.equal(latencyIncrease(8, 10), 0);
    });

    it("keeps the two decimals the grade thresholds are read at", () => {
        assert.equal(latencyIncrease(28.13, 10.01), 18.12);
    });

    // A failed run stores -1 in both columns; a provider that measures no loaded
    // latency stores nothing at all. Neither is an increase of zero.
    it("has no answer for anything that is not a pair of measurements", () => {
        for (const value of [null, undefined, NaN, Infinity, -1, "30", {}]) {
            assert.equal(latencyIncrease(value, 10), null, `loaded ${String(value)}`);
            assert.equal(latencyIncrease(50, value), null, `ping ${String(value)}`);
        }
    });

    // One expression for the quantity, so a per-direction icon and the grade it
    // sits under cannot be computed differently.
    it("is the quantity the single grade is built from", () => {
        const test = {ping: 10, downloadLatency: 50, uploadLatency: 22, error: null};

        assert.equal(bufferbloat(test).increase,
            latencyIncrease(Math.max(test.downloadLatency, test.uploadLatency), test.ping));
    });

    /**
     * Both directions have to be present before the worse of them means
     * anything. Math.max(null, 22) is 22, not "no reading", so a test that
     * measured one direction only would otherwise be graded as though that one
     * were the whole story.
     */
    it("leaves a test that measured only one direction ungraded", () => {
        for (const absent of [null, undefined]) {
            assert.equal(bufferbloat({ping: 10, downloadLatency: absent, uploadLatency: 22}), null,
                `download ${String(absent)}`);
            assert.equal(bufferbloat({ping: 10, downloadLatency: 50, uploadLatency: absent}), null,
                `upload ${String(absent)}`);
        }
    });
});

/**
 * The colour a bufferbloat grade wears.
 *
 * Blue for the absence of one, the way every other grader here answers for a
 * figure nobody measured: "F" is what a bad line earns, and red for a provider
 * that reported no loaded latency would say the same thing about it. It fell
 * through to red until the detail pane started grading each direction on its
 * own, which is the first call site that can be handed a null.
 */
describe("bufferbloatColour", () => {
    it("colours each band the way the thresholds read", () => {
        assert.equal(bufferbloatColour("A+"), "green");
        assert.equal(bufferbloatColour("A"), "green");
        assert.equal(bufferbloatColour("B"), "orange");
        assert.equal(bufferbloatColour("C"), "orange");
        assert.equal(bufferbloatColour("D"), "red");
        assert.equal(bufferbloatColour("F"), "red");
    });

    it("has no verdict on a figure that was never measured", () => {
        for (const absent of [null, undefined])
            assert.equal(bufferbloatColour(absent), "blue", `failed for ${String(absent)}`);

        assert.equal(bufferbloatColour(gradeForIncrease(null)), "blue",
            "a provider that measured no loaded latency is called a bad line");
    });
});

/**
 * Packet loss and jitter are the two figures on the statistics with no
 * configured optimum to be measured against - there is no setting for either
 * anywhere - so their thresholds are read against what a voice or video call
 * needs, which is the first thing either one breaks.
 */
describe("packetLossColour", () => {
    it("calls a clean line green", () => {
        assert.equal(packetLossColour(0), "green");
        assert.equal(packetLossColour(0.9), "green");
    });

    it("warns from a percent, and condemns from two and a half", () => {
        assert.equal(packetLossColour(1), "orange");
        assert.equal(packetLossColour(2.4), "orange");
        assert.equal(packetLossColour(2.5), "red");
        assert.equal(packetLossColour(40), "red");
    });

    // Absent is not perfect: only Ookla reports a loss rate, and green would
    // claim a clean line for every provider that measures none.
    it("has no colour for anything that is not a measurement", () => {
        for (const value of [null, undefined, NaN, Infinity, -1, "0", {}])
            assert.equal(packetLossColour(value), "blue", `${String(value)} must not grade`);
    });
});

describe("jitterColour", () => {
    it("calls a steady line green", () => {
        assert.equal(jitterColour(0), "green");
        assert.equal(jitterColour(4.9), "green");
    });

    it("warns from five milliseconds, and condemns from twenty", () => {
        assert.equal(jitterColour(5), "orange");
        assert.equal(jitterColour(19.9), "orange");
        assert.equal(jitterColour(20), "red");
    });

    // The server returns an explicit null for a range in which no test measured
    // jitter, which is not a jitter of zero.
    it("has no colour for anything that is not a measurement", () => {
        for (const value of [null, undefined, NaN, -1, "5"])
            assert.equal(jitterColour(value), "blue", `${String(value)} must not grade`);
    });
});

/**
 * How far apart two tests' pings were, graded.
 *
 * The stability card printed this figure in a fixed orange - the value never
 * entered into the colour at all - so the best reading there is, ±0 ms, was
 * shown in the warning colour, sitting among four rows whose colours *are*
 * verdicts. A tighter scale than the jitter beside it: jitter is the spread
 * within one test and this is the spread between tests, and a line whose ping
 * wanders by five milliseconds from hour to hour is not the steady one that
 * five milliseconds of jitter describes.
 */
describe("pingDeviationColour", () => {
    it("calls a line that holds its latency green", () => {
        assert.equal(pingDeviationColour(0), "green");
        assert.equal(pingDeviationColour(1.9), "green");
    });

    it("warns from two milliseconds, and condemns from ten", () => {
        assert.equal(pingDeviationColour(2), "orange");
        assert.equal(pingDeviationColour(9.9), "orange");
        assert.equal(pingDeviationColour(10), "red");
        assert.equal(pingDeviationColour(140), "red");
    });

    // The card's own reason for existing: a null here is the server saying the
    // range held fewer than two successful tests, which is not a spread of zero.
    it("has no colour for anything that is not a measurement", () => {
        for (const value of [null, undefined, NaN, Infinity, -1, "2", {}])
            assert.equal(pingDeviationColour(value), "blue", `${String(value)} must not grade`);
    });

    // The thresholds are exact, so the card that trims the figure to one decimal
    // has to trim before it grades - see the stability card's own test.
    it("grades on the value it is handed, to the threshold", () => {
        assert.equal(pingDeviationColour(1.99), "green");
        assert.equal(pingDeviationColour(2.0), "orange");
    });
});
