import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, seedTests } from "./helpers/boot.js";

let server;
let sendCurrent;

const PING_URL = "https://hc.example.net/ping/2f1c8a90";

const FAILED = {ping: -1, download: -1, upload: -1, error: "no route to host"};
const SUCCEEDED = {ping: 12, download: 100, upload: 50, error: null};

/**
 * Runs the minute job with fetch stubbed, and reports where it pinged.
 *
 * Stubbed only around the call and restored immediately: the harness talks to
 * its own server over fetch as well, so leaving it replaced would capture the
 * test's own requests instead of the integration's.
 */
const keepAlivePing = async () => {
    const realFetch = globalThis.fetch;
    const sent = [];

    globalThis.fetch = async (url) => {
        sent.push(String(url));
        return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
    };

    try {
        await sendCurrent();
    } finally {
        globalThis.fetch = realFetch;
    }

    return sent;
};

before(async () => {
    server = await bootServer();
    ({sendCurrent} = await import("../../server/tasks/integrations.js"));

    await api(server.baseUrl, "/integrations/healthChecks", {
        method: "PUT",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({url: PING_URL})
    });
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    await seedTests(server.tests, [{created: new Date().toISOString(), ...SUCCEEDED}]);
});

/**
 * Where the keep-alive goes while a failure stands.
 *
 * healthChecks pings the root URL every minute, and the root URL is
 * healthchecks.io's *success* endpoint - so within sixty seconds of a test
 * failing, the keep-alive reported the check up again and took back the /fail
 * ping. Withholding the keep-alive instead would have fixed the overwrite and
 * cost the other thing the ping is for: it is the only signal that MySpeed
 * itself is still running, so an instance that had failed a test and then died
 * would have looked exactly like one whose line was down.
 *
 * So it is routed rather than withheld. While the last test is a failure the
 * minute ping goes to /fail: the check stays down, and its last-ping time keeps
 * moving, which is what tells the two apart.
 *
 * The outcome is read from the stored tests on every ping rather than
 * remembered in the process. A restart between a failed test and the next one
 * would otherwise forget it and mark the check up - the same overwrite, just
 * waiting for a `docker restart`, which is exactly when an operator is looking.
 */
describe("the healthChecks keep-alive", () => {
    /**
     * Whose failure the keep-alive is allowed to report.
     *
     * The five cases below run on an instance with no targets at all, which is
     * what a fresh boot has: nothing bootstraps one, and migration 0013 seeds
     * one only when a legacy `provider` config key names ookla, libre or
     * cloudflare. That made all five blind to the whole of this - they never
     * leave the instance-wide read, so the bug could be put back underneath
     * them without a single assertion moving, which is exactly what happened
     * when it was.
     *
     * The bug: the two per-test notifications are gated on `target.alerts`
     * (tasks/speedtest.js), and the keep-alive was not. So the diagnostic
     * iperf3 box models/Targets.js describes fails because the machine is
     * asleep, sends no failure notification exactly as the operator asked, and
     * is still the newest row in the table - and the minute ping went to /fail
     * on its behalf, for the whole hour until the next round, taking down the
     * check that watches the line somebody actually cares about.
     *
     * Declared before those five rather than after them, so that the `after`
     * hook below - which empties the targets table again - has run by the time
     * they start. node:test runs subtests in declaration order, and every one
     * of the five asserts the answer an instance with no targets gives.
     *
     * Targets are created through the controller rather than through boot.js's
     * seedTarget, which calls removeAll() and creates exactly one: these cases
     * need two, and the difference between the two is the point. Imported
     * inside the hook for the reason boot.js imports it there - the module
     * chain reaches config/database.js, which resolves the sqlite file against
     * a working directory bootServer() has not switched yet at module load.
     */
    describe("with targets configured", () => {
        let targetsController;

        // Two fixed stamps a minute apart, rather than two calls to Date.now():
        // rows written inside the same millisecond would leave "which of these
        // is newest" to the id tiebreak, and the ordering is the thing half of
        // these cases are about.
        const A_MINUTE_MS = 60_000;
        const EARLIER = new Date(Date.now() - A_MINUTE_MS).toISOString();
        const LATER = new Date().toISOString();

        // Well past the window a result speaks for - see the pair of cases
        // about a target nothing re-measures.
        const A_DAY_MS = 24 * 60 * 60 * 1000;
        const LONG_AGO = new Date(Date.now() - 3 * A_DAY_MS).toISOString();

        const NAS_ENDPOINT = "10.0.0.5:5201";

        const withTargets = async (specs) => {
            await targetsController.removeAll();

            const created = [];
            for (const spec of specs) created.push(await targetsController.create(spec));

            return created;
        };

        before(async () => {
            targetsController = await import("../../server/controller/targets.js");
        });

        after(async () => {
            await targetsController.removeAll();
        });

        it("ignores a failure from a target that does not alert", async () => {
            const [fibre, nas] = await withTargets([
                {name: "Fibre", provider: "ookla", alerts: true, sortOrder: 0},
                {name: "NAS", provider: "iperf3", endpoint: NAS_ENDPOINT, alerts: false, sortOrder: 1}
            ]);

            await seedTests(server.tests, [
                {created: EARLIER, targetId: fibre.id, ...SUCCEEDED},
                {created: LATER, targetId: nas.id, ...FAILED}
            ]);

            assert.deepEqual(await keepAlivePing(), [PING_URL],
                "the uptime check was put down by a target the operator switched alerting off on");
        });

        /**
         * The control that keeps the scope from being narrowed into uselessness.
         * Without it, a "fix" that reported nothing at all would pass the case
         * above and the one below it.
         */
        it("still reports a failure from a target that does alert", async () => {
            const [fibre, nas] = await withTargets([
                {name: "Fibre", provider: "ookla", alerts: true, sortOrder: 0},
                {name: "NAS", provider: "iperf3", endpoint: NAS_ENDPOINT, alerts: true, sortOrder: 1}
            ]);

            await seedTests(server.tests, [
                {created: EARLIER, targetId: fibre.id, ...SUCCEEDED},
                {created: LATER, targetId: nas.id, ...FAILED}
            ]);

            assert.deepEqual(await keepAlivePing(), [`${PING_URL}/fail`],
                "narrowing the scope threw away a failure that was reported to every notifier");
        });

        /**
         * Targets exist and none of them alert. Falling back to the
         * instance-wide latest here - which is what a single "nothing" value
         * meaning both "no targets" and "no alerting target" would do - returns
         * exactly the row that has to be ignored, and the operator who switched
         * alerts off on all of their targets is precisely the person this is
         * for.
         */
        it("reports nothing when every target has alerts switched off", async () => {
            const [nas] = await withTargets([
                {name: "NAS", provider: "iperf3", endpoint: NAS_ENDPOINT, alerts: false, sortOrder: 0}
            ]);

            await seedTests(server.tests, [{created: LATER, targetId: nas.id, ...FAILED}]);

            assert.deepEqual(await keepAlivePing(), [PING_URL],
                "an instance with alerting switched off everywhere still drove the check down");
        });

        /**
         * Any alerting target whose newest result is a failure keeps the check
         * down - not merely the target that happens to hold the newest row.
         * One check stands for every watched line, so it is down while any of
         * them is: reading only the single newest row had the backup line's
         * success take the check up while the fibre's failure still stood,
         * which on healthchecks' side reads as "everything recovered".
         */
        it("reports the newest alerting target's outcome, not the first one's", async () => {
            const [fibre, backup] = await withTargets([
                {name: "Fibre", provider: "ookla", alerts: true, sortOrder: 0},
                {name: "Backup", provider: "ookla", alerts: true, sortOrder: 1}
            ]);

            await seedTests(server.tests, [
                {created: EARLIER, targetId: fibre.id, ...SUCCEEDED},
                {created: LATER, targetId: backup.id, ...FAILED}
            ]);

            assert.deepEqual(await keepAlivePing(), [`${PING_URL}/fail`],
                "the leading target's success took back the /fail a second alerting target had earned");
        });

        // The discriminating half of the rule above: the failing line is the
        // one that tested first, and the other line's later success must not
        // speak for it.
        it("keeps the check down while an earlier alerting failure still stands", async () => {
            const [fibre, backup] = await withTargets([
                {name: "Fibre", provider: "ookla", alerts: true, sortOrder: 0},
                {name: "Backup", provider: "ookla", alerts: true, sortOrder: 1}
            ]);

            await seedTests(server.tests, [
                {created: EARLIER, targetId: fibre.id, ...FAILED},
                {created: LATER, targetId: backup.id, ...SUCCEEDED}
            ]);

            assert.deepEqual(await keepAlivePing(), [`${PING_URL}/fail`],
                "the backup line's success took the check up while the fibre's failure stands");
        });

        // And the failing line recovering is what takes the check up again -
        // the control that keeps "any failure stands" from meaning "down
        // forever once anything ever failed".
        it("takes the check up once the failing line recovers", async () => {
            const [fibre, backup] = await withTargets([
                {name: "Fibre", provider: "ookla", alerts: true, sortOrder: 0},
                {name: "Backup", provider: "ookla", alerts: true, sortOrder: 1}
            ]);

            const EARLIEST = new Date(Date.now() - 2 * A_MINUTE_MS).toISOString();

            await seedTests(server.tests, [
                {created: EARLIEST, targetId: fibre.id, ...FAILED},
                {created: EARLIER, targetId: backup.id, ...SUCCEEDED},
                {created: LATER, targetId: fibre.id, ...SUCCEEDED}
            ]);

            assert.deepEqual(await keepAlivePing(), [PING_URL],
                "a recovered line never clears the check");
        });

        /**
         * How long a result speaks for the line that produced it.
         *
         * A failure stands until something newer replaces it, and for a
         * scheduled target something newer arrives every round. A target that
         * only ever runs by hand is the case that has no next round:
         * `alertingScope` deliberately includes it - a disabled target still
         * alerts, so that its own failure can put the check down and its own
         * success can take it back up - and asking each watched target
         * separately means its last answer was standing forever. One failed
         * hand run months ago pinned the check to /fail for the life of the
         * install while every scheduled line measured perfectly.
         *
         * So a result speaks for a day and then falls silent. Nothing changes
         * for a scheduled target, whose newest row is at most an interval old;
         * what ends is a stale verdict about a line nobody is measuring.
         */
        it("lets a stale failure stop speaking for a line nothing re-measures", async () => {
            const [fibre, box] = await withTargets([
                {name: "Fibre", provider: "ookla", alerts: true, sortOrder: 0},
                {name: "Box", provider: "iperf3", endpoint: NAS_ENDPOINT, alerts: true,
                    enabled: false, sortOrder: 1}
            ]);

            await seedTests(server.tests, [
                {created: LONG_AGO, targetId: box.id, ...FAILED},
                {created: LATER, targetId: fibre.id, ...SUCCEEDED}
            ]);

            assert.deepEqual(await keepAlivePing(), [PING_URL],
                "a hand run that failed days ago still holds the check down for every line");
        });

        // The other half, and the reason the window is a day rather than a
        // round: a failure somebody has just seen is exactly what the check is
        // for, whether the target that reported it runs by hand or not.
        it("still reports a fresh failure from a line that only runs by hand", async () => {
            const [fibre, box] = await withTargets([
                {name: "Fibre", provider: "ookla", alerts: true, sortOrder: 0},
                {name: "Box", provider: "iperf3", endpoint: NAS_ENDPOINT, alerts: true,
                    enabled: false, sortOrder: 1}
            ]);

            await seedTests(server.tests, [
                {created: EARLIER, targetId: box.id, ...FAILED},
                {created: LATER, targetId: fibre.id, ...SUCCEEDED}
            ]);

            assert.deepEqual(await keepAlivePing(), [`${PING_URL}/fail`],
                "the failure of a manual-only target was taken back by another line's success");
        });

        /**
         * A target exists, and the rows predate the migration that introduced
         * targets - so they carry no targetId and belong to no scope. Nothing
         * that is being watched has failed, and the ping says so rather than
         * reporting a row it cannot attribute to any line.
         */
        it("reports nothing for rows that belong to no target", async () => {
            await withTargets([{name: "Fibre", provider: "ookla", alerts: true, sortOrder: 0}]);

            await seedTests(server.tests, [{created: LATER, ...FAILED}]);

            assert.deepEqual(await keepAlivePing(), [PING_URL]);
        });
    });

    it("pings the root url while the last test succeeded", async () => {
        assert.deepEqual(await keepAlivePing(), [PING_URL]);
    });

    it("pings /fail while the last test is a failure", async () => {
        await seedTests(server.tests, [{created: new Date().toISOString(), ...FAILED}]);

        assert.deepEqual(await keepAlivePing(), [`${PING_URL}/fail`],
            "the keep-alive reported the check up again a minute after it failed");
    });

    it("goes back to the root url once a test succeeds again", async () => {
        await seedTests(server.tests, [{created: new Date().toISOString(), ...FAILED}]);
        await keepAlivePing();

        await seedTests(server.tests, [{created: new Date().toISOString(), ...SUCCEEDED}]);

        assert.deepEqual(await keepAlivePing(), [PING_URL],
            "a recovered line never clears the check");
    });

    /**
     * The restart case, which is the whole reason this is read rather than
     * remembered. Nothing here restarts the process - the point is that no
     * process state is consulted at all, so a fresh one answers the same.
     */
    it("still knows the last test failed with no in-process state to help", async () => {
        await seedTests(server.tests, [{created: new Date().toISOString(), ...FAILED}]);

        // Two in a row: the second would be the one a remembered flag got wrong
        // after it had been cleared or never set.
        assert.deepEqual(await keepAlivePing(), [`${PING_URL}/fail`]);
        assert.deepEqual(await keepAlivePing(), [`${PING_URL}/fail`]);
    });

    // An install that has never run a test has no failure to report, and the
    // keep-alive is the only thing it can honestly say.
    it("pings the root url on an instance that has never tested", async () => {
        await seedTests(server.tests, []);

        assert.deepEqual(await keepAlivePing(), [PING_URL]);
    });
});
