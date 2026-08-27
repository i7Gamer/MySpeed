import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyIn, bodyOf, readSource } from "../helpers/source.js";

/**
 * The shutdown reaches the run in flight. It did not reach the round that run
 * is a member of.
 *
 * `terminateActiveProcess()` kills the child currently measuring, and the
 * retry path was taught to notice - `!isShuttingDown()` guards it, so a run
 * killed by the shutdown does not answer with a fresh one. But the loop over
 * the round's members never asked. The killed member's failure was handled,
 * the loop advanced, and the next target spawned a CLI *after* the one moment
 * terminateActiveProcess could reach it: the orphan trackProcess exists to
 * prevent, rebuilt one member further along. On the Windows service there is
 * no namespace to tear it down, so it outlives the server and finishes by
 * writing into a database handle onCleanup has closed.
 *
 * One target could not show this. It needs two, which is what this branch made
 * ordinary.
 */
describe("the round under shutdown", () => {
    const round = bodyIn("server/tasks/speedtest.js", "const executeRound =");

    it("stops rather than starting the next member", () => {
        assert.match(round, /if\s*\(\s*isShuttingDown\(\)\s*\)\s*break;/,
            "the round runs on after the shutdown has killed the member in flight");
    });

    /**
     * Above beginTarget, not below it. beginTarget is what /status reads to
     * name the target currently measuring, so a guard underneath it leaves the
     * status bar advertising a member that will never run - the round stops,
     * and the last thing it said was the name of a target it never started.
     */
    it("stops before it announces the member it will not run", () => {
        const guard = round.indexOf("isShuttingDown()");
        const announced = round.indexOf("beginTarget(");

        assert.notEqual(guard, -1, "the round never asks whether the server is leaving");
        assert.notEqual(announced, -1, "the round no longer announces its members");
        assert.ok(guard < announced,
            "the status bar is left naming a target the round stopped before running");
    });

    /**
     * The loop is one caller. The guard immediately before the spawn covers
     * every present and future one, including the manual run route and
     * anything a later change points at the runner.
     */
    it("refuses to spawn a CLI once the server is leaving", () => {
        const source = readSource("server/util/speedtest.js");
        const once = bodyOf(bodyOf(source, "export default async (mode"), "const runOnce = async");

        const guard = once.indexOf("isShuttingDown()");
        const spawned = once.indexOf("trackProcess(spawn(");

        assert.notEqual(guard, -1, "the runner spawns a child without asking whether it may");
        assert.ok(guard < spawned, "the guard sits after the child it is meant to prevent");
    });
});

/**
 * A round of several targets can outlast the schedule interval - one
 * unreachable iperf3 target costs two CLI timeouts before the round moves on -
 * and every tick that lands while the previous round is still going is
 * dropped by the latch.
 *
 * Dropped in silence, which from the outside is indistinguishable from the
 * scheduler having stopped: no failed row, no log line, and /status still
 * reporting a run in progress. The tick is still dropped - two rounds at once
 * would contend for the very line being measured - it just says so now.
 */
describe("a scheduled round that arrives while one is running", () => {
    const create = bodyIn("server/tasks/speedtest.js", "export const create = async");

    it("says that it was skipped", () => {
        const latch = bodyOf(create, "if (_isRunning)");

        assert.match(latch, /console\.warn\(/,
            "a dropped tick looks exactly like the scheduler having died");
    });

    // The latch itself is unchanged: it still refuses, and still with a 500.
    it("still refuses the overlapping round", () => {
        assert.match(create, /if\s*\(_isRunning\)[\s\S]*?return 500;/);
    });
});
