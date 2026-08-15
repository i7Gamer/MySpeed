import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const source = fs.readFileSync(path.join(root, "server/tasks/speedtest.js"), "utf8");

const bodyFrom = (open) => {
    const start = source.indexOf(open);
    assert.notEqual(start, -1, `${open} is no longer in tasks/speedtest.js`);

    const from = source.indexOf("{", start);
    let depth = 0;

    for (let index = from; index < source.length; index++) {
        if (source[index] === "{") depth++;
        else if (source[index] === "}" && --depth === 0) return source.slice(from, index + 1);
    }

    assert.fail(`${open} is never closed`);
};

describe("the failure handler", () => {
    const handler = bodyFrom("} catch (e) {");

    it("clears the running state in a finally", () => {
        assert.match(handler, /finally\s*\{[^}]*setRunning\(false,\s*false\)/s,
            "the running state is released only on the path where nothing threw");
    });

    it("still records the failed test and notifies", () => {
        assert.match(handler, /tests\.create\(/, "the failed row is no longer written");
        assert.match(handler, /sendError\(/, "the integrations are no longer told");
    });

    // The write and the notification are inside the guarded block, or the
    // finally has nothing to guard.
    it("guards the write and the notification, not just the log", () => {
        const guarded = handler.slice(handler.indexOf("try {"), handler.indexOf("} finally"));

        assert.match(guarded, /tests\.create\(/);
        assert.match(guarded, /sendError\(/);
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
