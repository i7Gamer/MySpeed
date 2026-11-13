import { describe, it } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { createPasswordComparer, comparePassword } from "../../server/util/passwordComparison.js";

/**
 * One comparison at a time.
 *
 * bcryptjs hands its work to setImmediate, and every immediate queued by the
 * time the loop reaches that phase runs before the loop looks at a socket
 * again. So N comparisons started together are N comparisons' worth of blocked
 * event loop in one piece - /api/health included - where the same N run one
 * after another give the loop a turn between each.
 */
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });

    return {promise, resolve, reject};
};

const turn = () => new Promise((resolve) => setImmediate(resolve));

describe("comparing passwords", () => {
    it("never runs two comparisons at once", async () => {
        const gates = [deferred(), deferred(), deferred()];
        let running = 0;
        let most = 0;
        let started = 0;

        const compare = createPasswordComparer(async () => {
            const gate = gates[started++];
            most = Math.max(most, ++running);
            await gate.promise;
            running--;

            return true;
        });

        const results = [compare("a", "hash"), compare("b", "hash"), compare("c", "hash")];

        await turn();
        assert.equal(started, 1, "the second comparison did not wait for the first");

        gates[0].resolve();
        await turn();
        assert.equal(started, 2);

        gates[1].resolve();
        gates[2].resolve();
        await Promise.all(results);

        assert.equal(most, 1);
    });

    it("runs them in the order they were asked for", async () => {
        const order = [];
        const compare = createPasswordComparer(async (candidate) => { order.push(candidate); return false; });

        await Promise.all([compare("first", "hash"), compare("second", "hash"), compare("third", "hash")]);

        assert.deepEqual(order, ["first", "second", "third"]);
    });

    it("hands each caller its own answer", async () => {
        const compare = createPasswordComparer(async (candidate, hash) => candidate === hash);

        assert.deepEqual(await Promise.all([compare("a", "a"), compare("a", "b"), compare("c", "c")]),
            [true, false, true]);
    });

    // A malformed stored hash makes bcrypt throw. That is one caller's error,
    // and everyone queued behind it still has a password to be checked.
    it("fails only the comparison that threw", async () => {
        const compare = createPasswordComparer(async (candidate) => {
            if (candidate === "bad") throw new Error("malformed hash");

            return true;
        });

        const [bad, good] = await Promise.allSettled([compare("bad", "hash"), compare("good", "hash")]);

        assert.equal(bad.status, "rejected");
        assert.equal(bad.reason.message, "malformed hash");
        assert.deepEqual(good, {status: "fulfilled", value: true});
    });

    it("is bcrypt by default", async () => {
        const LOW_COST_FOR_A_FAST_TEST = 4;
        const hash = await bcrypt.hash("Hunter2!", LOW_COST_FOR_A_FAST_TEST);

        assert.equal(await comparePassword("Hunter2!", hash), true);
        assert.equal(await comparePassword("hunter2", hash), false);
    });
});

/**
 * The three places a password is checked. Read as text: a fourth entry point
 * calling bcrypt directly would run beside the queue rather than in it, and
 * nothing at runtime would say so.
 */
describe("every entry point", () => {
    it("compares through the queue rather than calling bcrypt itself", async () => {
        const fs = await import("node:fs");

        for (const file of ["server/middlewares/password.js", "server/routes/session.js", "server/routes/prometheus.js"]) {
            const source = fs.readFileSync(file, "utf-8");

            assert.doesNotMatch(source, /bcrypt\.compare\(/, `${file} compares outside the queue`);
            assert.match(source, /comparePassword\(/, `${file} no longer compares at all`);
        }
    });
});
