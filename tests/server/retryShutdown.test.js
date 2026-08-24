import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyOf, readSource } from "../helpers/source.js";
import { isShuttingDown, markShutdown } from "../../server/util/speedtest.js";

/**
 * The shutdown kills the run in flight - and the run answers by starting
 * another one.
 *
 * A failed first attempt retries itself: `create(type, true)`. Nothing told
 * that path the failure *was* the shutdown, so terminateActiveProcess() ended
 * the child, the kill surfaced as an ordinary run error, and the catch spawned
 * a fresh CLI - after the one moment the shutdown could reach it. trackProcess
 * exists precisely because an unreachable child outlives the server under the
 * Windows service and finishes by writing into a closed database handle; the
 * retry rebuilt that orphan one line further down.
 *
 * The latch is a module flag rather than something terminateActiveProcess
 * infers, because ending the active run is not the same statement as "the
 * process is leaving": the shutdown says so itself, before it kills anything.
 */
describe("the retry under shutdown", () => {
    const catchBlock = bodyOf(readSource("server/tasks/speedtest.js"), "} catch (e) {");

    it("is guarded by the shutdown latch, not just the attempt count", () => {
        assert.match(catchBlock,
            /if\s*\(\s*!retried\s*&&\s*!isShuttingDown\(\)[^)]*\)\s*return\s+await\s+create\(type,\s*true\)/,
            "a run killed by the shutdown starts a fresh child the shutdown can no longer reach");
    });
});

describe("the shutdown sequence", () => {
    const onStop = bodyOf(readSource("server/index.js"), "onStop:");

    it("latches before it kills, so the kill cannot answer with a retry", () => {
        const latched = onStop.indexOf("markShutdown()");
        const killed = onStop.indexOf("terminateActiveProcess()");

        assert.notEqual(latched, -1, "the shutdown never sets the latch at all");
        assert.notEqual(killed, -1, "the shutdown no longer ends the run in flight");
        assert.ok(latched < killed, "the child is killed before the retry path is told why");
    });
});

/**
 * Last, because flipping the latch is one-way for the life of the process -
 * which is the point: nothing un-shuts-down a server.
 */
describe("the latch itself", () => {
    it("starts open and closes when the shutdown says so", () => {
        assert.equal(isShuttingDown(), false, "a freshly started server believes it is leaving");

        markShutdown();

        assert.equal(isShuttingDown(), true);
    });
});
