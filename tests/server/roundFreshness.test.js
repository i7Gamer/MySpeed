import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cancelReservation, isRunning, staleMemberReason, tryReserve }
    from "../../server/tasks/speedtest.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

/**
 * The member as the round reaches it, not as the round snapshot had it.
 *
 * The member list is read once at round start, so a target edited, disabled or
 * deleted mid-round used to be measured with its old configuration and the row
 * filed under its id - the old box's numbers attributed to whatever the id
 * names now. The loop re-reads each member as it arrives; this is the judgement
 * it applies to what it finds.
 */
describe("staleMemberReason", () => {
    const fresh = {id: 3, name: "WAN", provider: "ookla", enabled: true};

    it("skips a member that was deleted mid-round", () => {
        assert.equal(typeof staleMemberReason(null, false), "string");
        assert.equal(typeof staleMemberReason(undefined, false), "string");
    });

    it("skips a member a scheduled round reached after it left the schedule", () => {
        assert.equal(typeof staleMemberReason({...fresh, enabled: false}, false), "string");
    });

    // sqlite hands booleans back as 0/1 under the global raw:true, and a 0
    // read as "still scheduled" would defeat the check exactly where it runs.
    it("reads the flag the way the database spells it", () => {
        assert.equal(typeof staleMemberReason({...fresh, enabled: 0}, false), "string");
        assert.equal(staleMemberReason({...fresh, enabled: 1}, false), null);
    });

    // A named run of a disabled target is the manual-only shape working as
    // designed - the one way such a target ever runs.
    it("still runs a disabled target when it was asked for by name", () => {
        assert.equal(staleMemberReason({...fresh, enabled: false}, true), null);
    });

    it("passes a live scheduled member through", () => {
        assert.equal(staleMemberReason(fresh, false), null);
    });
});

/**
 * The round latch, taken synchronously by the route that cannot await the
 * round.
 *
 * POST /speedtests/run answers before the round ends - a proxy would time out
 * otherwise - and create() *returns* its refusals rather than throwing, so a
 * second click landing between the route's awaits got a success toast for a
 * round create() then refused into the void. The route takes the latch before
 * it answers; a caller that cannot take it is told 409 instead of 200.
 */
describe("the round reservation", () => {
    it("is exclusive until cancelled", () => {
        assert.equal(tryReserve(), true);
        assert.equal(isRunning(), true);
        assert.equal(tryReserve(), false, "two callers hold the round at once");

        cancelReservation();
        assert.equal(isRunning(), false);
        assert.equal(tryReserve(), true, "a cancelled reservation could not be retaken");

        cancelReservation();
    });
});

/**
 * The wiring, read rather than exercised - the way sessionRevocation.test.js
 * reads factoryReset - because driving a real round through these branches
 * spawns real CLIs on timing the test cannot hold still.
 */
describe("what the round loop consults between members", () => {
    const source = read("server/tasks/speedtest.js");

    const loop = () => {
        const start = source.indexOf("for (const [index, target] of members.entries())");
        assert.notEqual(start, -1, "the round no longer walks its members in the loop this reads");

        const end = source.indexOf("executeTarget(", start);
        assert.notEqual(end, -1);

        return source.slice(start, end);
    };

    it("re-reads each member from the table as the round reaches it", () => {
        assert.match(loop(), /targetsController\.getOne\(target\.id\)/,
            "the round still measures the snapshot, so a mid-round edit runs the old endpoint");
        assert.match(loop(), /staleMemberReason\(/,
            "the fresh read is not judged, so a deleted member still runs");
    });

    it("hands the fresh row on, not the snapshot", () => {
        assert.match(source, /await executeTarget\(fresh, type\)/,
            "executeTarget still receives the round-start snapshot");
        assert.match(loop(), /beginTarget\(fresh/,
            "/status names the snapshot while the run measures the fresh row");
    });

    it("stops for a pause, whoever started the round", () => {
        assert.match(loop(), /pauseController\.currentState/,
            "a pause mid-round keeps spawning CLIs until the members run out");
    });

    it("stops a scheduled round when the quiet hours begin", () => {
        assert.match(loop(), /type === "auto" && await withinQuietHours\(\)/,
            "quiet hours beginning mid-round do not stop the members still queued");
    });
});

describe("what the manual-run route does before it answers", () => {
    const route = read("server/routes/speedtests.js");

    it("takes the round latch before promising a round", () => {
        assert.match(route, /if \(!testTask\.tryReserve\(\)\)/,
            "the route still answers 200 on a latch create() will refuse into the void");
        assert.match(route, /\{reserved: true}/,
            "the route reserves and create() then latches a second time");
    });
});
