import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyIn, readSource } from "../helpers/source.js";
import { TARGET_SETTLE_MS, settleLine } from "../../server/tasks/speedtest.js";

/**
 * The quiet the round leaves between two of its members.
 *
 * A speed test saturates the line, and the buffers along it - the modem's, the
 * ISP's - are still draining when the CLI exits. Run back to back, the first
 * member of a round measures an idle line and the third measures one that has
 * had two saturating transfers pushed through it seconds earlier. Latency is
 * where that shows worst, which is precisely what this app measures as
 * bufferbloat and reports as "under load".
 *
 * So the position of a target in the round was quietly part of its reading -
 * and the comparison panels put those readings side by side and invite the
 * operator to read a difference between the LINES. Target order was a
 * confound sitting inside the one feature that exists to compare them.
 */
describe("the pause between a round's members", () => {
    it("is ten seconds", () => {
        assert.equal(TARGET_SETTLE_MS, 10_000);
    });

    it("waits the time it is given", async () => {
        const started = Date.now();
        await settleLine(120, {stopped: () => false, slice: 20});

        assert.ok(Date.now() - started >= 110,
            `returned after ${Date.now() - started}ms of a 120ms settle`);
    });

    /**
     * And it does not hold the shutdown open for ten seconds.
     *
     * The shutdown is a flag rather than an event here, so the wait is taken
     * in slices and the flag read between them - a single sleep would leave
     * the process ignoring SIGTERM for as long as the settle lasts, on a
     * Windows service where that is exactly the window the supervisor gives up
     * in and kills it.
     */
    it("stops early when the server is leaving", async () => {
        const started = Date.now();
        await settleLine(10_000, {stopped: () => true, slice: 20});

        assert.ok(Date.now() - started < 500,
            `held the shutdown for ${Date.now() - started}ms of a ten second settle`);
    });

    it("stops early when the flag turns over mid-wait", async () => {
        const started = Date.now();
        let leaving = false;
        setTimeout(() => { leaving = true; }, 60).unref();

        await settleLine(10_000, {stopped: () => leaving, slice: 20});

        assert.ok(Date.now() - started < 800,
            `kept waiting ${Date.now() - started}ms after the shutdown began`);
    });

    it("waits for nothing when asked for nothing", async () => {
        const started = Date.now();
        await settleLine(0, {stopped: () => false, slice: 20});

        assert.ok(Date.now() - started < 100);
    });
});

/**
 * Where the round takes it: after a member that actually measured, and not
 * after the last one.
 */
describe("the round's use of the pause", () => {
    const round = bodyIn("server/tasks/speedtest.js", "const executeRound =");

    /**
     * After the run, not before it. Before, the round would open with ten
     * seconds of nothing on every tick - and on the shortest cron preset that
     * is a sixth of the interval spent waiting for a line no test has touched
     * yet.
     */
    it("settles after a member has measured", () => {
        const ran = round.indexOf("await executeTarget(");
        const settled = round.indexOf("settleLine(");

        assert.notEqual(ran, -1, "the member's own run moved; re-anchor this");
        assert.notEqual(settled, -1, "the round no longer pauses between its members");
        assert.ok(settled > ran, "the round waits before measuring rather than after");
    });

    /**
     * Only between members. A settle after the last one delays the round's
     * completion event, its healthchecks ping and the release of the latch
     * that lets the next round start - all to leave a line quiet that nothing
     * is about to measure.
     */
    it("does not settle after the last member", () => {
        assert.match(round, /if \(index < members\.length - 1\) await settleLine\(\);/,
            "the round pauses after its final member, delaying its own completion for nothing");
    });

    /**
     * And only after a member that ran. The guards above - a held target, an
     * unscheduled one, a paused round - reach the next member by `continue`,
     * which steps over this: a target that never measured has not disturbed
     * the line, so there is nothing to let settle.
     */
    it("is inside the run, past every guard that skips a member", () => {
        const settled = round.indexOf("settleLine(");
        const guard = round.lastIndexOf("continue;", settled);

        assert.notEqual(guard, -1, "no skip guard precedes the settle; re-anchor this");
        assert.ok(round.slice(guard, settled).includes("await executeTarget("),
            "a skipped member settles a line it never touched");
    });
});

/**
 * The one thing this cannot fix, recorded rather than hidden: the round gets
 * longer, and the shortest cron preset runs every minute.
 */
describe("what the pause costs", () => {
    const source = readSource("server/tasks/speedtest.js");

    it("says in the source what a longer round means for the shortest preset", () => {
        const at = source.indexOf("export const TARGET_SETTLE_MS");
        const docs = source.slice(Math.max(0, at - 1600), at);

        assert.match(docs, /minute|overlap|skip/i,
            "the settle lengthens every round and nothing beside it says what that costs "
            + "on an every-minute schedule");
    });
});
