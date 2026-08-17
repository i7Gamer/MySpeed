import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createQueue } from "../../server/util/serialiseQueue.js";

/** A task that finishes when it is told to, so an overlap can be arranged exactly. */
const held = (log, name) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    return {
        release: () => release(),
        task: async () => {
            log.push(`${name} in`);
            await gate;
            log.push(`${name} out`);
            return name;
        }
    };
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * One at a time, in the order they were asked for.
 *
 * Written for the prometheus scrape, whose gauges are module-level and shared:
 * it clears them, reads the latest test, sets them and renders, and every step
 * but the clear is asynchronous. Two scrapes overlapping across those awaits
 * can leave one of them rendering gauges the other has just cleared, which
 * serves an empty exporter to a monitoring system - a gap in the data at a
 * moment chosen by whoever else happened to scrape.
 *
 * A queue rather than a snapshot built in locals: the registry is what
 * render reads from, so the values have to be *in* it while it renders. Nothing
 * else can be true at that moment either way, so serialising is the whole of
 * the fix.
 */
describe("createQueue", () => {
    it("does not start the second task until the first has finished", async () => {
        const log = [];
        const queue = createQueue();
        const first = held(log, "first");
        const second = held(log, "second");

        const running = [queue(first.task), queue(second.task)];
        await settle();

        assert.deepEqual(log, ["first in"], "the second task ran while the first was still going");

        first.release();
        await settle();

        assert.deepEqual(log, ["first in", "first out", "second in"]);

        second.release();
        await Promise.all(running);

        assert.deepEqual(log, ["first in", "first out", "second in", "second out"]);
    });

    it("keeps them in the order they were queued", async () => {
        const log = [];
        const queue = createQueue();

        await Promise.all([1, 2, 3, 4].map((n) => queue(async () => {
            await settle();
            log.push(n);
        })));

        assert.deepEqual(log, [1, 2, 3, 4]);
    });

    it("hands each caller its own result", async () => {
        const queue = createQueue();

        assert.deepEqual(await Promise.all([queue(async () => "a"), queue(async () => "b")]),
            ["a", "b"]);
    });

    /**
     * A task that throws is the caller's to handle, and only the caller's.
     *
     * The queue keeps a rejected promise as its tail otherwise, and every task
     * queued behind a single failure rejects without ever running - so one
     * scrape that fails would take out every scrape after it for the life of
     * the process.
     */
    it("rejects only the task that failed", async () => {
        const queue = createQueue();

        const failed = queue(async () => { throw new Error("boom"); });
        const after = queue(async () => "still here");

        await assert.rejects(failed, /boom/);
        assert.equal(await after, "still here");
    });

    it("carries on after a task that threw synchronously", async () => {
        const queue = createQueue();

        await assert.rejects(queue(() => { throw new Error("sync"); }), /sync/);
        assert.equal(await queue(async () => "next"), "next");
    });

    // Nothing is in flight, so there is nothing to wait behind - but it still
    // goes through the queue rather than running inline, or the ordering above
    // would depend on how busy the queue happened to be.
    it("runs a task on an idle queue", async () => {
        assert.equal(await createQueue()(async () => "alone"), "alone");
    });

    it("gives each queue its own line", async () => {
        const log = [];
        const [a, b] = [createQueue(), createQueue()];
        const blocked = held(log, "a");

        a(blocked.task);
        await settle();

        await b(async () => log.push("b ran"));

        assert.deepEqual(log, ["a in", "b ran"], "one queue held up another");

        blocked.release();
    });
});
