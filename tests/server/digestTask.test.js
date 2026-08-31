import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import schedule from "node-schedule";
import { isValidCron } from "cron-validator";
import { runDigest } from "../../server/tasks/digestReport.js";
import * as timer from "../../server/tasks/timer.js";

/**
 * The tick's own matrix, every collaborator injected: what the schedule
 * fires is runDigest with the real database, aggregation and fan-out behind
 * it, and this file executes the branching between them without any of the
 * three.
 */
describe("runDigest", () => {
    const OPTED_WEEKLY = [{data: {digest_weekly: true}}];
    const NOBODY = [{data: {send_finished: true}}, {data: {}}];

    // Berlin summer, Monday 08:00 local.
    const NOW = new Date("2026-08-31T06:00:00.000Z");
    const TIMEZONE = "Europe/Berlin";

    const summary = (over = {}) => ({
        tests: {total: 10, failed: 1},
        download: {avg: 100}, upload: {avg: 50}, ping: {avg: 8},
        dataUsed: {total: null, download: null, upload: null},
        reliability: {longestFailureStreak: null, lastFailureAt: null, largestGap: null},
        ...over
    });

    const harness = (rows, aggregated = summary()) => {
        const calls = {aggregate: [], notify: []};

        return {
            calls,
            options: {
                now: NOW,
                timezone: TIMEZONE,
                active: async () => rows,
                aggregate: async (range, options) => {
                    calls.aggregate.push({range, options});
                    return aggregated;
                },
                notify: async (name, payload) => calls.notify.push({name, payload})
            }
        };
    };

    it("aggregates nothing on an instance where nobody opted in", async () => {
        const {calls, options} = harness(NOBODY);

        assert.equal(await runDigest("weekly", options), null);
        assert.equal(calls.aggregate.length, 0,
            "a whole-range scan ran for a digest nobody receives");
        assert.equal(calls.notify.length, 0);
    });

    it("treats the two opt-ins as different questions", async () => {
        const {calls, options} = harness([{data: {digest_monthly: true}}]);

        assert.equal(await runDigest("weekly", options), null,
            "a monthly opt-in received the weekly digest");
        assert.equal(calls.aggregate.length, 0);
    });

    it("asks once for the weekly window, previous included, and fans out the payload", async () => {
        const {calls, options} = harness(OPTED_WEEKLY,
            summary({previous: summary({tests: {total: 8, failed: 0}})}));

        const payload = await runDigest("weekly", options);

        assert.equal(calls.aggregate.length, 1, "the weekly kind aggregated a second window itself");
        assert.equal(calls.aggregate[0].options.compare, true,
            "the digest asks for a comparison by a name listStatistics does not read - "
            + "see tests/integration/digestComparison.test.js");
        assert.equal(calls.aggregate[0].range.days, 7);
        assert.equal(calls.aggregate[0].range.from.toISOString(), "2026-08-23T22:00:00.000Z",
            "the window left the Berlin calendar");

        assert.equal(calls.notify.length, 1);
        assert.equal(calls.notify[0].name, "digestReady");
        assert.equal(payload.kind, "weekly");
        assert.match(payload.text, /^MySpeed weekly digest \(2026-08-24 – 2026-08-30\)/);
        assert.match(payload.text, /vs previous week/,
            "the previous window the aggregation carried never reached the words");
        assert.equal(payload.from, "2026-08-23T22:00:00.000Z");
        assert.deepEqual(payload.tests, {total: 10, failed: 1});
    });

    it("aggregates the monthly compare window itself, never by previous", async () => {
        const {calls, options} = harness([{data: {digest_monthly: true}}]);

        const payload = await runDigest("monthly", options);

        assert.equal(calls.aggregate.length, 2, "the monthly kind leaned on comparePrevious");
        assert.equal(calls.aggregate[0].options.comparePrevious, undefined,
            "comparePrevious rode along and aggregated Jan 29 - Feb 28 as 'the previous month'");
        assert.equal(calls.aggregate[0].range.from.toISOString(), "2026-06-30T22:00:00.000Z",
            "July on the Berlin calendar");
        assert.equal(calls.aggregate[1].range.from.toISOString(), "2026-05-31T22:00:00.000Z",
            "June, the explicit compare month");
        assert.match(payload.text, /^MySpeed monthly digest/);
        assert.match(payload.text, /vs previous month/);
    });
});

/**
 * The schedules the timer arms beside its own: fixed rules, the config zone,
 * and a lifecycle that cannot be forgotten because it lives inside the two
 * functions every boot path, config change and test teardown already calls.
 */
describe("the digest schedules", () => {
    afterEach(() => timer.stopTimer());

    const jobCount = () => Object.keys(schedule.scheduledJobs).length;

    it("declares two valid fixed crons", () => {
        assert.ok(isValidCron(timer.DIGEST_WEEKLY_CRON));
        assert.ok(isValidCron(timer.DIGEST_MONTHLY_CRON));
    });

    it("arms both alongside the speedtest schedule and cancels both with it", () => {
        const before = jobCount();

        timer.startTimer("0 4 1 1 *");
        assert.equal(jobCount(), before + 3, "the speedtest job did not bring the two digests with it");

        timer.stopTimer();
        assert.equal(jobCount(), before, "stopTimer left a digest ticking - the shutdown and every test teardown leak it");
    });

    // The digests run on their own fixed rules: a broken stored cron must
    // not take the weekly summary down with it.
    it("arms the digests even when the speedtest cron is refused", () => {
        const before = jobCount();

        timer.startTimer("0 4 1 1 *");
        const withSchedule = jobCount();

        timer.startTimer("not a cron expression");
        assert.equal(jobCount(), withSchedule,
            "a refused reschedule dropped the digests along with the kept speedtest schedule");

        timer.stopTimer();
        assert.equal(jobCount(), before);
    });

    it("re-arms rather than stacks on a second start", () => {
        const before = jobCount();

        timer.startTimer("0 4 1 1 *");
        timer.startTimer("0 5 1 1 *");
        assert.equal(jobCount(), before + 3, "a reschedule stacked a second pair of digest jobs");

        timer.stopTimer();
    });
});
