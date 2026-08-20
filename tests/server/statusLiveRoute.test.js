import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findMounts, readSource } from "../helpers/source.js";

const source = readSource("server/routes/speedtests.js");

/**
 * The hot half of /status, split out for the poll that follows a run.
 *
 * The full status route does two database queries, three config reads and a
 * cron computation per call - the last test, the failure count, the next
 * scheduled run. While a test ran, the client polled all of that once a second
 * to read the four fields that actually move: running, phase, progress and
 * speed. Those four live in memory - tasks/speedtest.js keeps them for
 * exactly this - so the run is followed from a route that answers without
 * touching anything else, at a rate the full route could not afford.
 */
describe("GET /status/live", () => {

    const mounts = findMounts(source, ["get"]);
    const live = mounts.find((mount) => mount.route === "/status/live");

    // The window from this mount to the next one, i.e. the handler and nothing
    // else's - the same bound mountText draws.
    const handler = () => {
        const following = mounts.find((mount) => mount.at > live.at);
        return source.slice(live.at, following ? following.at : source.length);
    };

    it("is mounted", () => {
        assert.notEqual(live, undefined, "the live status route is not registered");
    });

    // The same gate as /status: readable with view-mode access. The payload
    // carries no identity and no schedule - nothing /status withholds from an
    // untrusted reader.
    it("stands behind the same read gate as /status", () => {
        assert.match(live.text, /password\(true\)/,
            "the live route is not gated the way /status is");
    });

    it("answers from the running task's memory", () => {
        assert.match(handler(), /testTask\.isRunning\(\)/);
        assert.match(handler(), /testTask\.getProgress\(\)/);
    });

    /**
     * The point of the split, held: the handler must not grow a database read
     * or a config lookup, because it is polled twice a second for the length
     * of every run. `await` is the tell - everything the full route reads is
     * async, and this route has nothing to wait for.
     */
    it("reads neither the database, nor the config, nor the schedule", () => {
        const body = handler();

        for (const reach of ["tests.", "config.", "timer.", "await ", "isUntrustedReader"])
            assert.ok(!body.includes(reach),
                `the live route reaches for ${reach.trim()} - the full route is where that belongs`);
    });
});
