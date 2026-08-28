import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyOf, readSource } from "../helpers/source.js";

/**
 * A run that ends says so, however it ended.
 *
 * `setRunning(false, false)` sat at the end of the failure handler, behind an
 * awaited row write and an awaited notification. Either can reject - a database
 * that has gone away is the realistic one - and the call was then skipped, so
 * `setState("ping")` never ran and tasks/integrations.js stayed at
 * `currentState === "running"` for the life of the process. The minutePassed
 * keep-alive that webhook's send_alive and healthChecks are driven by stops
 * firing at that point, silently and permanently; the progress bar keeps a
 * stale phase and startedAt beside it.
 *
 * The `_isRunning` latch was never the problem - create() has cleared that in a
 * finally since the last time this bit - which is exactly why the second half
 * of the same guarantee went unnoticed.
 */
const source = readSource("server/tasks/speedtest.js");

// Named for what it is here: every slice below is a function in that file.
const bodyFrom = (declaration) => bodyOf(source, declaration);

describe("the failure handler", () => {
    const handler = bodyFrom("} catch (e) {");

    // The release moved up a level when runs became rounds: executeRound's
    // finally owns it now, which covers a throw from any member's failure
    // handler - the same guarantee, one home for however many targets run.
    //
    // The verdict is now read inside that finally, before the latch drops, so
    // the finally is no longer a single line: assert on its body rather than
    // on the brace that used to sit right in front of setRunning.
    it("clears the running state in the round's finally", () => {
        const round = bodyFrom("const executeRound");
        const release = round.slice(round.indexOf("} finally"));

        assert.match(release, /setRunning\(false,\s*false\)/,
            "the running state is released only on the path where nothing threw");

        // Read-before-drop only stays safe while the read cannot skip the
        // release: an await ahead of setRunning in the finally has to be
        // .catch-guarded, or a failed roundOutcome leaves the run marked
        // running for the life of the process - the very bug this file guards.
        const beforeRelease = release.slice(0, release.indexOf("setRunning(false"));
        if (/\bawait\b/.test(beforeRelease))
            assert.match(beforeRelease, /\.catch\(/,
                "an awaited read ahead of the release can skip it when it rejects");

        assert.match(round.slice(round.indexOf("try {"), round.indexOf("} finally")),
            /await executeTarget\(/,
            "the members run outside the guarded block, so the finally covers nothing");
    });

    /**
     * And the read ahead of the release must not be able to wait for ever.
     *
     * The catch above answers a read that *fails*; a database that has gone
     * away can instead black-hole it - no error, no answer, mysql2 waiting on
     * a socket the OS gives minutes to - and nothing here sets a query
     * timeout. The read sits ahead of the release on both latches (create()'s
     * finally is behind this same await), so with no deadline of its own a
     * wedged read wedged the schedule: every tick logged "still running -
     * skipping" and manual runs answered 409, indefinitely.
     */
    it("cannot be held open by a verdict read that never answers", () => {
        const round = bodyFrom("const executeRound");
        const release = round.slice(round.indexOf("} finally"));
        const beforeRelease = release.slice(0, release.indexOf("setRunning(false"));

        assert.match(beforeRelease, /Promise\.race\(/,
            "the verdict read has no deadline, so a black-holed database holds the run latch for ever");
        assert.match(source, /OUTCOME_READ_TIMEOUT_MS/,
            "the deadline is a bare number, or gone");
        assert.match(source, /\.unref\(\)/,
            "an idle deadline timer holds the process open past its shutdown");
    });

    it("still records the failed test and notifies", () => {
        assert.match(handler, /tests\.create\(/, "the failed row is no longer written");
        assert.match(handler, /sendError\(/, "the integrations are no longer told");
    });

    /**
     * Released when the run ends, not when the notification does.
     *
     * The finally always ran, so the latch was never lost - but it sat behind
     * an awaited sendError, and that is not a quick call. triggerEvent works
     * through the configured integrations one at a time, each with the ten
     * second outbound timeout in util/http.js, so a few endpoints that have
     * gone unreachable - which is the situation a *failure* notification is
     * being sent in - held the run open for the sum of their timeouts. The next
     * scheduled test is refused for all of it, and the progress bar keeps a
     * phase belonging to a run that is over.
     *
     * The success path never had this shape: it clears the flag and lets the
     * notification go on its own.
     */
    it("does not hold the run open while the integrations are told", () => {
        assert.doesNotMatch(handler, /await\s+sendError\(/,
            "the run is held open for as long as the notifications take");
    });

    it("still reports a notification that failed", () => {
        const notify = handler.slice(handler.indexOf("sendError("));

        assert.match(notify, /\.catch\(/,
            "an unawaited send with no catch is an unhandled rejection");
    });
});

/**
 * And the two paths out of a run agree about it.
 *
 * They had drifted once already - the failure path's release sat at the end
 * rather than in a finally - and the difference that leaves is invisible until
 * something is slow or throws. Written as one assertion over both, so a change
 * to either has to be a change to the pair.
 */
describe("both endings", () => {
    // The run itself. `create` above is only the latch around it; the two
    // notifications live in here, one round member at a time.
    const execute = bodyFrom("const executeTarget = async");

    it("tell the integrations without waiting for them", () => {
        for (const send of ["sendFinished", "sendError"]) {
            assert.match(execute, new RegExp(`\\b${send}\\(`), `${send} is no longer called`);
            assert.doesNotMatch(execute, new RegExp(`await\\s+${send}\\(`),
                `${send} holds the run open until the integrations answer`);
        }
    });
});

/**
 * The start of a run makes the same promise its two endings do.
 *
 * sendRunning was sent as `.then(undefined)`, which handles nothing: a
 * rejection - the same database read that can fail in triggerEvent's fan-out -
 * escaped to the process-level unhandledRejection hook and was logged as a
 * bare server fault, with nothing naming the notification that produced it.
 * sendFinished and sendError have carried a contextual catch all along.
 */
describe("the start of a run", () => {
    const start = bodyFrom("const setRunning");

    it("reports a notification that failed, the way both endings do", () => {
        assert.match(start, /sendRunning\(\)\.catch\(/,
            "the start notice has no handler, so its failure is a context-less server fault");
        assert.doesNotMatch(start, /\.then\(undefined\)/,
            "then(undefined) handles nothing and reads as though it did");
    });
});

/**
 * And the latch it shares the job with, which was already right - so that the
 * two halves of "this run is over" cannot drift apart again.
 */
describe("the run latch", () => {
    it("is still dropped in a finally", () => {
        const create = bodyFrom("export const create = async");

        assert.match(create, /finally\s*\{[\s\S]*?_isRunning = false/,
            "the latch is released only on the paths that were thought of");
    });
});
