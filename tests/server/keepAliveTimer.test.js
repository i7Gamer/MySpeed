import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

/**
 * The keep-alive's stop guard, the same as the schedule's.
 *
 * tasks/timer.js guards its cancel with `if (job)` because node-schedule
 * answers null, not undefined, for a schedule it cannot compile, and null
 * walked past `!== undefined` into a TypeError that took the shutdown's
 * remaining work with it. The keep-alive's spec is a literal that always
 * compiles, so null cannot reach this guard today - which is exactly the kind
 * of assumption a later edit to the spec breaks without noticing. The two
 * timers should read the same way.
 */
describe("the keep-alive timer", () => {
    const source = readSource("server/tasks/integrations.js");
    const stop = source.slice(source.indexOf("export const stopTimer"));

    it("guards its cancel on truthiness, like the schedule's", () => {
        assert.match(stop, /if \(job\) \{/, "stopTimer still compares against undefined");
        assert.doesNotMatch(stop, /job !== undefined/, "a null job walks past this guard");
    });
});
