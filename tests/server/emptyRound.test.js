import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emptyRoundReason } from "../../server/tasks/speedtest.js";

/**
 * A round that found nothing to run used to end in silence.
 *
 * executeRound answers 400 when roundMembers comes back empty, and nobody reads
 * that code: timer.js discards it, and POST /speedtests/run deliberately does
 * not await the round it starts. So an instance whose targets all have
 * Scheduled switched off wrote no row, reported no failure and logged nothing,
 * on every tick of the cron - which from the outside is indistinguishable from
 * the scheduler having stopped. The route refuses that ahead of time now; the
 * scheduled tick still arrives at the empty round, and this line is the only
 * place it can say so.
 *
 * Pure and exported for the reason memberFailure is: the suite cannot mock
 * modules, so the wording - which is the whole of the fix here - has to be
 * askable without a database or a spawned CLI.
 */
describe("what an empty round says for itself", () => {
    /*
     * The two empty rounds are different situations and must not be reported
     * the same way. A fresh install has no targets at all and is waiting to be
     * set up; an instance with targets that are all outside the schedule is
     * configured and has switched itself off. Telling the first operator that
     * "every target has its schedule switched off" would be a false statement
     * about an install with no targets, repeated once an hour by the default
     * cron.
     */
    it("tells a fresh install apart from one that switched every target off", () => {
        const nothingConfigured = emptyRoundReason(undefined, 0);
        const nothingScheduled = emptyRoundReason(undefined, 2);

        assert.notEqual(nothingConfigured, nothingScheduled,
            "an install with no targets is reported as one that unscheduled them");
        assert.match(nothingConfigured, /no target is configured/i);
        assert.match(nothingScheduled, /schedule/i);
    });

    /**
     * The named run reaches the same empty answer by a different route: the
     * target was deleted between the route's existence check and roundMembers
     * reading it. That is a race about one row, not a statement about the
     * schedule, and it names the id so the log says which one.
     */
    it("names the target of a run whose row went away underneath it", () => {
        const reason = emptyRoundReason(7, 3);

        assert.match(reason, /7/);
        assert.doesNotMatch(reason, /schedule/i,
            "a deleted target was reported as the schedule being switched off");
    });
});
