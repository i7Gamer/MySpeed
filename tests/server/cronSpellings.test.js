import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as timer from "../../server/tasks/timer.js";
import { validateInput } from "../../server/controller/config.js";
import { walkSources } from "../helpers/source.js";

/**
 * The door and the scheduler, asked the same question about a cron.
 *
 * cron-validator's defaults are narrower than either engine behind it. Day
 * names and 7-for-Sunday are standard crontab spellings - they are what
 * crontab.guru prints, and the frequency dialog links to crontab.guru - and
 * node-schedule runs them, the cron-parser the dialog validates with parses
 * them, and the door alone refused them. So the dialog drew a "next test"
 * line, enabled Save, and the PATCH came back 400 naming the expression as
 * invalid, with nothing on screen to suggest what about it was wrong.
 *
 * Every spelling below is asked of all three doors an expression can arrive
 * through, because they are three separate calls and a widening that reaches
 * only one of them is worse than none: a cron the PATCH takes and startTimer
 * then refuses is a schedule silently replaced by the default, and one nextRun
 * refuses is a dashboard that says no test is coming while one is.
 */

// Standard crontab spellings both engines run, refused by cron-validator's
// defaults: a day name in either case, a range and a list of them, a month by
// name, and Sunday written as 7.
const ACCEPTED = ["0 0 * * MON", "5 4 * * sun", "0 0 * * 7", "0 0 * * MON-FRI",
    "0 0 * * mon,wed", "0 0 1 JAN *"];

/**
 * And what stays refused. `99 * * * *` and `0 0 * * 8` are out of range,
 * the two sentences are what somebody types when they have not read the
 * field - all four are pinned as refused by the integration suite too.
 *
 * `@hourly` is the interesting one: both engines take it, and it stays
 * refused all the same. cron-validator has no preset support of any kind and
 * refuses anything under five whitespace-separated fields, so no option pair
 * can reach it - it would need normalising to "0 * * * *" before the door sees
 * it, which is a different change from this one.
 */
const REFUSED = ["99 * * * *", "0 0 * * 8", "every hour please", "every second tuesday", "@hourly"];

describe("the cron spellings the server takes", () => {
    afterEach(() => timer.stopTimer());

    it("takes a day name or a seventh day at the door", async () => {
        for (const expression of ACCEPTED)
            assert.deepEqual(await validateInput("cron", expression), {value: expression},
                `the door refused ${JSON.stringify(expression)}, which the scheduler runs`);
    });

    it("schedules what the door let through", () => {
        for (const expression of ACCEPTED) {
            timer.startTimer(expression);

            assert.notEqual(timer.currentJob(), undefined,
                `${JSON.stringify(expression)} left no schedule at all`);
            assert.equal(timer.nextRun(), timer.currentJob().nextInvocation().toISOString(),
                `the countdown for ${JSON.stringify(expression)} does not match what will fire`);

            timer.stopTimer();
        }
    });

    it("still refuses what it always refused", async () => {
        for (const expression of REFUSED) {
            assert.equal(typeof await validateInput("cron", expression), "string",
                `the door took ${JSON.stringify(expression)}`);
            assert.equal(timer.nextRun(expression), null,
                `the countdown named a moment for ${JSON.stringify(expression)}`);
        }
    });

    /**
     * And every door asks with the same options, which is the whole point of
     * naming them once. Read from the source because the failure this catches
     * is a fourth call site added later with no options at all - behaviourally
     * invisible until an operator types a day name into whichever path that
     * one guards.
     */
    it("asks with the shared options wherever it asks", () => {
        // Found rather than listed, which is the difference between catching
        // the fourth call site and describing it: a hard-coded pair of files
        // passes over a door added in a third one, which is the whole failure
        // this is for. The declaration in util/ is not a door.
        const doors = walkSources("server")
            .map(({path, source}) => ({
                path,
                calls: source.split("\n").filter((line) => /(?<!const )\bisValidCron\(/.test(line))
            }))
            .filter((door) => door.calls.length > 0 && !/util\/cron\.js$/.test(door.path));

        assert.ok(doors.length >= 2,
            `only ${doors.length} cron doors found - the scan is reading the wrong tree`);

        for (const {path, calls} of doors)
            for (const call of calls)
                assert.match(call, /CRON_OPTIONS/,
                    `${path} asks a narrower question than the scheduler answers: ${call.trim()}`);
    });
});
