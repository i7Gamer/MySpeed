import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    bufferbloat, bufferbloatTrend, connectionChange, failureRate, getIconBySpeed, isFailedTest,
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
