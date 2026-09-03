import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyIn, bodyOf, readSource } from "../helpers/source.js";
import {
    hasActiveRound, SHUTDOWN_ROUND_WAIT, trackRound, waitForActiveRound
} from "../../server/util/activeRound.js";
import { SHUTDOWN_EXIT_WAIT } from "../../server/util/speedtest.js";
import { SHUTDOWN_GRACE_MS } from "../../server/util/shutdown.js";

/** A round that ends when it is told to, so the wait can be observed mid-flight. */
const held = () => {
    let settle;
    const round = new Promise((resolve, reject) => { settle = {resolve, reject}; });

    return {round, ...settle};
};

/**
 * The shutdown waited for the CLI child and then closed the database. The
 * child's exit is not the end of the round: the row, the baseline keys and the
 * recommendations are all written after it, through the handle that close
 * took away. This is the round-level wait that the child-level one was not.
 */
describe("waiting for the active round", () => {
    it("resolves at once when no round is running", async () => {
        assert.equal(hasActiveRound(), false);
        assert.equal(await waitForActiveRound(), true);
    });

    it("waits for the tracked round to finish", async () => {
        const {round, resolve} = held();
        trackRound(round);

        let settled = false;
        const wait = waitForActiveRound().then((answer) => { settled = true; return answer; });

        await Promise.resolve();
        assert.equal(settled, false, "the wait ended while the round was still writing");
        assert.equal(hasActiveRound(), true);

        resolve();
        assert.equal(await wait, true);
        assert.equal(hasActiveRound(), false, "a finished round is still held as the active one");
    });

    // A round that failed still ended; the shutdown must not wait on it any
    // longer, and its rejection is the round's own to handle.
    it("treats a failed round as finished", async () => {
        const {round, reject} = held();
        trackRound(round);
        round.catch(() => undefined);

        const wait = waitForActiveRound();
        reject(new Error("the round fell over"));

        assert.equal(await wait, true);
        assert.equal(hasActiveRound(), false);
    });

    // A round that cannot end must not hold the shutdown: the deadline in
    // shutdown.js would exit regardless, and giving up here keeps the close
    // behind this wait on the ordinary path instead of skipped by that exit.
    it("gives up at its deadline and says so", async () => {
        const {round, resolve} = held();
        trackRound(round);

        assert.equal(await waitForActiveRound(1), false);

        resolve();
        await round;
    });

    it("forgets only its own round", async () => {
        const first = held();
        const second = held();

        trackRound(first.round);
        trackRound(second.round);

        first.resolve();
        await first.round;
        await Promise.resolve();

        assert.equal(hasActiveRound(), true, "an older round ending forgot the newer one");

        second.resolve();
        await second.round;
        await Promise.resolve();

        assert.equal(hasActiveRound(), false);
    });

    it("hands the round back so the caller can await it", () => {
        const {round, resolve} = held();

        assert.equal(trackRound(round), round);
        resolve();
    });

    /**
     * The two waits run in sequence on the way out, and the deadline that
     * outranks them both exits without closing the database. Sized together
     * so the ordinary path always finishes inside it.
     */
    it("fits inside the shutdown deadline beside the child's wait, with time for the close", () => {
        // What the close needs when both waits gave up: a mysql pool draining
        // is the slow case, and it is the case the whole wait exists for.
        const DB_CLOSE_BUDGET_MS = 1500;

        assert.ok(SHUTDOWN_EXIT_WAIT + SHUTDOWN_ROUND_WAIT + DB_CLOSE_BUDGET_MS <= SHUTDOWN_GRACE_MS,
            "the two waits together leave the close no time before the deadline skips it");
    });
});

/**
 * And the round is what gets tracked. index.js cannot be imported to be asked,
 * so the wiring is read, the way shutdown.test.js reads the cleanup hook.
 */
describe("the round the shutdown waits for", () => {
    it("is the one create() runs", () => {
        const create = bodyIn("server/tasks/speedtest.js", "export const create = async");

        assert.match(create, /trackRound\(executeRound\(/,
            "the round runs untracked, and the shutdown has nothing to wait for");
    });

    /**
     * Fire-and-forget put the recommendations write outside the round: the
     * round ended, the shutdown closed the handle, and the write landed on a
     * closed connection. Awaited, it is inside the round the shutdown waits on
     * - and still contained, so a failed recommendation cannot fail the test.
     */
    it("includes the recommendations write", () => {
        const member = bodyIn("server/tasks/speedtest.js", "const executeTarget = async");

        assert.match(member, /await createRecommendations\(\)\.catch\(/,
            "the recommendations are written after the round has already ended");
    });

    it("is waited for after the child and before the database closes", () => {
        const source = readSource("server/index.js");
        const cleanup = bodyOf(source, "onCleanup: async () =>");

        const child = cleanup.indexOf("waitForActiveProcessExit()");
        const round = cleanup.indexOf("waitForActiveRound()");
        const close = cleanup.indexOf("db.close()");

        assert.notEqual(round, -1, "the cleanup does not wait for the round");
        assert.ok(child < round, "the round is waited for before the child that is still measuring it");
        assert.ok(round < close, "the database closed while the round could still be writing into it");
    });
});
