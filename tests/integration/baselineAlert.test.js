import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, seedTarget, seedTests } from "./helpers/boot.js";
import { BASELINE_MIN_SAMPLES, BASELINE_WINDOW_DAYS } from "../../server/util/baselineAlert.js";
import { finishedPayload } from "../../server/util/notificationPayload.js";

/**
 * The baseline alert, the whole way through: the stored column, the window
 * query, the verdict, the payload it travels on, the gate that reads it and the
 * outbound request that either happens or does not.
 *
 * The unit suites pin each link - baselineAlert.test.js matrixes the judgement
 * with no database, alertThreshold.test.js the arming, baselineColumn.test.js
 * the whitelists and the wiring's shape. This is the only place they are
 * exercised together, which is where a column that is stored but never queried,
 * or a verdict that is reached but never carried, actually shows up.
 *
 * The run itself is the one thing not driven here: executeTarget spawns a CLI
 * and binds an interface. Everything from the row it would have measured
 * onwards is the genuine article, and baselineColumn.test.js pins that
 * executeTarget calls this with the reading it just parsed, before it writes
 * the row.
 */

let server;
let triggerEvent;
let baselineKeys;

const realFetch = globalThis.fetch;
let sent = [];

before(async () => {
    server = await bootServer();

    ({triggerEvent} = await import("../../server/controller/integrations.js"));
    ({baselineKeys} = await import("../../server/tasks/speedtest.js"));
});

after(async () => {
    globalThis.fetch = realFetch;
    await server?.close();
});

/**
 * Records what the integrations send, and only that - the requests setting a
 * scenario up go to the real server, or the created integration's id comes back
 * from an empty stub body instead of the assertion failing on what it meant to
 * check.
 */
beforeEach(() => {
    sent = [];
    globalThis.fetch = async (url, init = {}) => {
        if (String(url).startsWith(server.baseUrl)) return realFetch(url, init);

        sent.push({url: String(url), body: init.body});
        return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
    };
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

const MS_PER_DAY = 86_400_000;

// Comfortably inside the window and comfortably above the floor, so a case that
// means to fall outside either has to say so.
const HISTORY_ROWS = BASELINE_MIN_SAMPLES;
const HOURS_APART = 1;
const MS_PER_HOUR = 3_600_000;

const NORMAL = {download: 500, upload: 200};

// 70% of a 500 Mbit median is 350, so this is a line delivering well under
// half of what it usually does - and 200 upload keeps the breach to one metric.
const PERCENT = 70;
const SLOW = {download: 300, upload: 200};

/**
 * A history of successful rows for one target, newest first and an hour apart.
 *
 * @param at how far back the newest row sits, in days
 */
const history = (targetId, count = HISTORY_ROWS, reading = NORMAL, at = 0) =>
    Array.from({length: count}, (unused, index) => ({
        ...reading,
        targetId,
        created: new Date(Date.now() - at * MS_PER_DAY - index * HOURS_APART * MS_PER_HOUR).toISOString()
    }));

const seedHistory = async (rows) => await seedTests(server.tests, rows);

const createTelegram = async (settings) => {
    const {status, body} = await api(server.baseUrl, "/integrations/telegram", {
        method: "PUT",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({
            token: "123456:abcdefghijklmnopqrstuvwxyz", chat_id: "42",
            send_finished: true, send_failed: true,
            integration_name: "baseline", ...settings
        })
    });

    assert.equal(status, 200, `could not create the integration: ${JSON.stringify(body)}`);

    return body.id;
};

const remove = async (id) => await api(server.baseUrl, `/integrations/${id}`, {method: "DELETE"});

describe("the verdict a stored history produces", () => {
    it("arms and fires on the test that drops below the median", async () => {
        const target = await seedTarget({name: "WAN", baselinePercent: PERCENT});
        await seedHistory(history(target.id));

        assert.deepEqual(await baselineKeys(target, SLOW), {
            baselineArmed: true, baselineBreached: true,
            // 300 against the 500 median the history above produces, with
            // upload holding, so the round names one direction.
            baselineDirection: "download", baselineShortfall: 40,
            baselineDownload: 500, baselineUpload: 200
        });
    });

    it("is armed and quiet while the line holds up", async () => {
        const target = await seedTarget({name: "WAN", baselinePercent: PERCENT});
        await seedHistory(history(target.id));

        const {baselineArmed, baselineBreached} = await baselineKeys(target, NORMAL);

        assert.equal(baselineArmed, true);
        assert.equal(baselineBreached, false);
    });

    /**
     * The storm rule, read from the stored rows rather than from a remembered
     * flag - so a restart between two bad tests cannot re-arm it, which is
     * exactly when somebody is looking.
     */
    it("goes quiet once the previous stored test was already below", async () => {
        const target = await seedTarget({name: "WAN", baselinePercent: PERCENT});
        await seedHistory([
            {...SLOW, targetId: target.id, created: new Date().toISOString()},
            ...history(target.id, HISTORY_ROWS, NORMAL, 1)
        ]);

        const {baselineArmed, baselineBreached} = await baselineKeys(target, SLOW);

        assert.equal(baselineArmed, true);
        assert.equal(baselineBreached, false, "a second bad test announced itself too");
    });

    /**
     * Most instances pay nothing. A target that named no percentage is not
     * asked about at all - no window query, and not one of the four keys on the
     * payload, which the gate reads as "no baseline" exactly as it reads a
     * payload from an older node.
     */
    it("answers nothing at all for a target with no baseline", async () => {
        const target = await seedTarget({name: "WAN"});
        await seedHistory(history(target.id));

        assert.deepEqual(await baselineKeys(target, SLOW), {});
    });

    // The floor, at the boundary. A fresh instance and one just past a
    // retention purge are the same shape, and a median over a handful of rows
    // moves with one bad afternoon.
    it("takes no median one row short of the sample it needs", async () => {
        const target = await seedTarget({name: "WAN", baselinePercent: PERCENT});
        await seedHistory(history(target.id, BASELINE_MIN_SAMPLES - 1));

        const {baselineArmed, baselineBreached, baselineDownload} =
            await baselineKeys(target, SLOW);

        assert.equal(baselineBreached, false, "a target with no median to judge against breached");
        assert.equal(baselineDownload, null, "a median was taken over too few rows");

        /*
         * Armed, though, which this asserted the opposite of. `armed` answers
         * "did the operator ask for this alert", and a target still gathering
         * its first twenty rows has been asked for. Reported unarmed, it put an
         * integration with the baseline on and the three fixed limits blank
         * into breachesThreshold's `return !armed` tail: every healthy test
         * notified, once per test, for the whole warm-up - and indefinitely on
         * a target run by hand, where twenty successes inside thirty days may
         * never arrive.
         */
        assert.equal(baselineArmed, true,
            "a warming-up target reports unarmed, which notifies on every healthy test");
    });

    // And that the window is a window. Rows older than it describe a line the
    // target may no longer have.
    it("does not count rows that fell out of the window", async () => {
        const target = await seedTarget({name: "WAN", baselinePercent: PERCENT});
        await seedHistory(history(target.id, HISTORY_ROWS, NORMAL, BASELINE_WINDOW_DAYS + 1));

        const {baselineBreached, baselineDownload} = await baselineKeys(target, SLOW);

        // Read on the median rather than on `armed`, which now says only that
        // the operator configured this - see the warm-up case above. A window
        // holding nothing recent has no median, so there is nothing to breach.
        assert.equal(baselineDownload, null, "rows older than the window fed the median");
        assert.equal(baselineBreached, false);
    });

    /**
     * And that it is this target's own line. Mixing a LAN box's gigabit rows
     * into a WAN target's median is how the yardstick stops meaning anything -
     * the reason listSuccessful takes a target too.
     */
    it("takes the median over this target's own rows alone", async () => {
        const target = await seedTarget({name: "WAN", baselinePercent: PERCENT});
        const other = await (await import("../../server/controller/targets.js"))
            .create({name: "LAN", provider: "cloudflare"});

        await seedHistory([...history(target.id), ...history(other.id, HISTORY_ROWS, {download: 1, upload: 1})]);

        assert.equal((await baselineKeys(target, SLOW)).baselineDownload, 500,
            "another target's rows moved this one's median");
    });

    /**
     * A failed run is excluded by the query, not merely by the reading it left
     * behind.
     *
     * The two are independent signals - SUCCESSFUL_TEST_FILTER exists because a
     * row can carry a recorded error while its numeric columns still hold
     * something plausible, which is what an imported history does - so the rows
     * here carry both a message and a readable speed. Counted, they drag the
     * median down until the target can never breach again, and nothing anywhere
     * says the yardstick is describing failures.
     */
    it("takes the median over successful rows alone", async () => {
        const target = await seedTarget({name: "WAN", baselinePercent: PERCENT});

        await seedHistory([
            ...history(target.id),
            ...history(target.id, HISTORY_ROWS, {download: 100, upload: 40}, 1)
                .map((row) => ({...row, error: "no route to host"}))
        ]);

        assert.equal((await baselineKeys(target, SLOW)).baselineDownload, 500,
            "the rows a failed run wrote moved the median");
    });
});

/**
 * And the chain from that verdict to the message that does or does not go out.
 *
 * alert_only on with no fixed limit anywhere is the setup this feature exists
 * for, and it is also the shape breachesThreshold deliberately fires on when
 * nothing is armed - so an operator wanting baseline alerts only would have got
 * every test, hourly, if the baseline did not count as an arm.
 */
describe("what the notifier is actually told", () => {
    const announce = async (target, reading) =>
        await triggerEvent("testFinished", finishedPayload({
            ...reading, ping: 12, jitter: 2, time: 14,
            targetId: target.id, targetName: target.name, alerts: true,
            ...await baselineKeys(target, reading)
        }));

    it("says nothing about a healthy test, with the baseline the only thing armed", async () => {
        const target = await seedTarget({name: "WAN", baselinePercent: PERCENT});
        await seedHistory(history(target.id));

        const id = await createTelegram({alert_only: true});
        try {
            await announce(target, NORMAL);

            assert.deepEqual(sent, [], "every healthy test would have been announced");
        } finally {
            await remove(id);
        }
    });

    /**
     * And what that announcement is able to say. The verdict is decided over
     * the rows, the two keys ride the payload, and the template is where they
     * become a sentence - so this is the only place the whole chain is visible
     * at once.
     */
    it("can say which direction crossed and by how much", async () => {
        const target = await seedTarget({name: "WAN", baselinePercent: PERCENT});
        await seedHistory(history(target.id));

        const id = await createTelegram({alert_only: true,
            finished_message: "%targetName%: %baselineDirection% %baselineShortfall%% under"});
        try {
            await announce(target, SLOW);

            assert.equal(sent.length, 1, "the drop below the line went unreported");
            assert.match(String(sent[0].body), /WAN: download 40% under/,
                "the message could not name what crossed");
        } finally {
            await remove(id);
        }
    });

    it("announces the test that crossed under the baseline", async () => {
        const target = await seedTarget({name: "WAN", baselinePercent: PERCENT});
        await seedHistory(history(target.id));

        const id = await createTelegram({alert_only: true});
        try {
            await announce(target, SLOW);

            assert.equal(sent.length, 1, "the drop below the line went unreported");
            assert.match(sent[0].url, /api\.telegram\.org/);
        } finally {
            await remove(id);
        }
    });

    /**
     * The whole point of the storm rule, end to end: a line that stays down
     * announces itself once, not once per test. The second run's window already
     * holds the first bad row, so the edge has been crossed and stays crossed.
     */
    it("stays quiet for the second equally bad test", async () => {
        const target = await seedTarget({name: "WAN", baselinePercent: PERCENT});
        await seedHistory(history(target.id));

        const id = await createTelegram({alert_only: true});
        try {
            await announce(target, SLOW);
            assert.equal(sent.length, 1, "the first drop should have been announced");

            // The row that first run would have written, which is what the
            // next run reads as its previous test.
            await server.tests.create({...SLOW, ping: 12, type: "auto", targetId: target.id,
                provider: "ookla", serverId: 0, created: new Date().toISOString()});

            sent = [];
            await announce(target, SLOW);

            assert.deepEqual(sent, [], "the bad afternoon sent a message an hour");
        } finally {
            await remove(id);
        }
    });

    // The two reasons compose. A fixed limit still fires on its own while the
    // baseline is quiet, which is every integration configured before this.
    it("leaves the fixed limits deciding on their own", async () => {
        const target = await seedTarget({name: "WAN", baselinePercent: PERCENT});
        await seedHistory(history(target.id));

        const id = await createTelegram({alert_only: true, alert_upload_below: 400});
        try {
            await announce(target, NORMAL);

            assert.equal(sent.length, 1, "a fixed limit stopped firing once a baseline existed");
        } finally {
            await remove(id);
        }
    });

    // And a target with no baseline behaves exactly as it did: the payload
    // carries null for all four keys and the gate reads them as no baseline.
    it("leaves a target with no baseline exactly as it was", async () => {
        const target = await seedTarget({name: "WAN"});
        await seedHistory(history(target.id));

        const id = await createTelegram({alert_only: true});
        try {
            await announce(target, SLOW);

            assert.equal(sent.length, 1,
                "an integration with no limits set and no baseline went quiet");
        } finally {
            await remove(id);
        }
    });
});
