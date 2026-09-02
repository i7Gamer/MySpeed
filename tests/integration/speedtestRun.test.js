import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, seedTarget, seedTests, setConfig, waitFor } from "./helpers/boot.js";

let server;

before(async () => {
    server = await bootServer();
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    await seedTests(server.tests, []);
});

/**
 * The speedtest CLI is never downloaded into the throwaway data directory, so
 * spawning it fails with ENOENT. That is exactly the path this exercises: the
 * failure has to end up as a stored row explaining itself, because a run that
 * dies without recording anything looks identical to one that never started.
 */
const NO_TEST_YET = "no test has been stored yet";

// null on the deadline only. A request that failed, or a body that could not
// be read, names itself rather than being reported as a test that never came.
const waitForTest = (timeoutMs = 15000) =>
    waitFor(async () => {
        const {body} = await api(server.baseUrl, "/speedtests?limit=1");
        return Array.isArray(body) && body.length > 0 ? body[0] : undefined;
    }, {timeout: timeoutMs, interval: 100, message: NO_TEST_YET}).catch((err) => {
        if (err?.message !== NO_TEST_YET) throw err;
        return null;
    });

/**
 * The round the scheduler starts when every target sits outside the schedule.
 *
 * POST /speedtests/run refuses that ahead of time now, but the cron does not go
 * through the route: it reaches create() directly, arrives at a round with no
 * members and answers 400 to a caller that discards it - timer.js. So the tick
 * left no row, no failure and nothing in the log, once an hour on the default
 * cron, which from the outside is exactly what a stopped scheduler looks like.
 */
describe("a round the schedule starts with nothing to run", () => {
    let task;

    before(async () => {
        task = await import("../../server/tasks/speedtest.js");
    });

    it("says why it measured nothing instead of giving up in silence", async () => {
        await seedTarget({provider: "cloudflare", enabled: false});

        const realWarn = console.warn;
        const messages = [];
        console.warn = (...args) => messages.push(args.join(" "));

        let code;
        try {
            code = await task.create("auto");
        } finally {
            console.warn = realWarn;
        }

        assert.equal(code, 400, "a round with no members ran something after all");
        assert.equal(await server.tests.count(), 0);
        assert.ok(messages.some((message) => /schedule switched off/i.test(message)),
            `the dropped tick was not explained - warnings were ${JSON.stringify(messages)}`);
    });
});

describe("a speedtest that cannot start", () => {
    beforeEach(async () => {
        await seedTarget({provider: "ookla"});
    });

    after(async () => {
        await seedTarget({provider: "cloudflare"});
    });

    /**
     * Regression: util/speedtest.js rejected the CLI's 'error' event as
     * {message: errorInstance}. The wrapper had a `message` key, so the
     * `?? String(e)` fallback never ran and the Error object itself was passed
     * to tests.create(). Sequelize validates a TEXT column with _.isObject(),
     * which an Error trips, so the write threw inside the catch block and the
     * failed test was silently lost.
     */
    it("records the failure as a stored test", async () => {
        assert.equal((await api(server.baseUrl, "/speedtests/run", {method: "POST"})).status, 200);

        const test = await waitForTest();
        assert.notEqual(test, null, "the failed speedtest was never written to the database");
    });

    it("stores the reason as a readable string", async () => {
        await api(server.baseUrl, "/speedtests/run", {method: "POST"});
        const test = await waitForTest();

        assert.equal(typeof test.error, "string");
        assert.notEqual(test.error, "");
        assert.notEqual(test.error, "[object Object]");
        assert.doesNotMatch(test.error, /^undefined$/);
    });

    /**
     * Nothing was parsed, so the provider comes from the setting - and it has to
     * be recorded here of all places: the first question about a failure is
     * which provider could not complete, and the setting may well have been
     * changed to a different one by the time anyone reads the row.
     */
    it("records which provider it was that failed", async () => {
        await api(server.baseUrl, "/speedtests/run", {method: "POST"});
        const test = await waitForTest();

        assert.equal(test.provider, "ookla");
    });

    // Against a second provider as well, or the assertion above is satisfied by
    // any implementation that writes the string "ookla" - which is exactly what
    // it exists to rule out. The LibreSpeed CLI is equally absent here, so this
    // run fails through the same handler.
    it("names the provider it actually ran, not a fixed one", async () => {
        await seedTarget({provider: "libre"});

        await api(server.baseUrl, "/speedtests/run", {method: "POST"});
        const test = await waitForTest();

        assert.equal(test.provider, "libre");
    });

    it("marks the row as failed rather than as a real measurement", async () => {
        await api(server.baseUrl, "/speedtests/run", {method: "POST"});
        const test = await waitForTest();

        // A NULL error would present the -1 placeholders as a genuine result
        // and poison every average built on top of them.
        assert.ok(test.error);
        assert.equal(test.download, -1);
    });

    it("releases the run lock so the next test can start", async () => {
        await api(server.baseUrl, "/speedtests/run", {method: "POST"});
        await waitForTest();

        const {body} = await api(server.baseUrl, "/speedtests/status");
        assert.equal(body.running, false);
    });

    /**
     * Regression: the CLI's watchdog was spawn's own `timeout` option, and when
     * a spawn fails outright node emits 'error' within milliseconds but never
     * clears that timer. Every failed run therefore left a three-minute timer
     * holding the event loop open - which is invisible in production, where the
     * server runs forever anyway, but held every test process alive for the
     * full 180 seconds after its last assertion. This file took 181 seconds to
     * run 884ms of tests, and the whole suite ran no faster than its timeout.
     */
    it("leaves no timer running once the failure is recorded", async () => {
        const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

        await api(server.baseUrl, "/speedtests/run", {method: "POST"});
        await waitForTest();

        // Settle the tail of the request itself before counting.
        await new Promise((resolve) => setTimeout(resolve, 250));

        assert.ok(timeouts() <= 1,
            `${timeouts()} timers still pending - a failed run is holding its watchdog open`);
    });

    // The lock is cleared in a finally rather than on the paths that were
    // thought of, so a second failure is still able to start and be recorded.
    it("still accepts a run after an earlier one failed", async () => {
        await api(server.baseUrl, "/speedtests/run", {method: "POST"});
        await waitForTest();
        await seedTests(server.tests, []);

        const {status} = await api(server.baseUrl, "/speedtests/run", {method: "POST"});
        assert.equal(status, 200);

        assert.notEqual(await waitForTest(), null, "the second failure was never recorded");
    });
});

/**
 * The guards the round consults between members, exercised at member one -
 * where they are reachable without racing a real CLI. A pause or a quiet
 * window that stands when create() is reached directly - the cron's path, and
 * the route's un-awaited one - must stop the round before it spawns anything.
 * The route and runTask refuse ahead of time, but both stop looking the moment
 * the round starts, and a round of several members can outlast either answer.
 */
describe("a round overtaken before its first member", () => {
    let task;
    let pause;
    let target;

    before(async () => {
        task = await import("../../server/tasks/speedtest.js");
        pause = await import("../../server/controller/pause.js");
    });

    beforeEach(async () => {
        target = await seedTarget({provider: "ookla"});
    });

    afterEach(async () => {
        pause.updateState(false);
        await setConfig(server.config, "quietHoursStart", "none");
        await setConfig(server.config, "quietHoursEnd", "none");
    });

    const warningsOf = async (round) => {
        const realWarn = console.warn;
        const messages = [];
        console.warn = (...args) => messages.push(args.join(" "));

        try {
            await round();
        } finally {
            console.warn = realWarn;
        }

        return messages;
    };

    // On the wall clock the instance itself runs on, so the window is honest
    // about containing "now" whatever zone the host is set to.
    const hhmm = (date) =>
        `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

    const MS_PER_HOUR = 3600000;

    const quietWindowAroundNow = async () => {
        await setConfig(server.config, "quietHoursStart", hhmm(new Date(Date.now() - 2 * MS_PER_HOUR)));
        await setConfig(server.config, "quietHoursEnd", hhmm(new Date(Date.now() + 2 * MS_PER_HOUR)));
    };

    it("stops for a pause, whoever started the round", async () => {
        pause.updateState(true);

        const warnings = await warningsOf(() => task.create("custom", target.id));

        assert.equal(await server.tests.count(), 0,
            "a paused round still spawned its CLI and recorded the failure");
        assert.ok(warnings.some((message) => /paused/i.test(message)),
            `the stopped round was not explained - warnings were ${JSON.stringify(warnings)}`);
    });

    it("stops a scheduled round when the quiet hours have begun", async () => {
        await quietWindowAroundNow();

        const warnings = await warningsOf(() => task.create("auto"));

        assert.equal(await server.tests.count(), 0,
            "the quiet hours held and the round still spawned its CLI");
        assert.ok(warnings.some((message) => /quiet hours/i.test(message)),
            `the stopped round was not explained - warnings were ${JSON.stringify(warnings)}`);
    });

    // The rule the quiet hours have always followed: a test started by hand is
    // somebody asking for one now.
    it("lets a run started by hand ignore the quiet hours", async () => {
        await quietWindowAroundNow();

        await warningsOf(() => task.create("custom", target.id));

        assert.ok(await server.tests.count() > 0,
            "the quiet hours silenced a run somebody asked for by name");
    });
});

/**
 * Two clicks of the start button in the same instant.
 *
 * The route answers before the round ends and create() *returns* its refusals
 * rather than throwing, so the second request used to be told 200 "successfully
 * created" while its round was refused into the void - a success toast for a
 * test that never existed. The route takes the round latch synchronously before
 * it answers; whichever request loses the race is told 409, the same answer a
 * click during a visible run has always got.
 */
describe("two manual runs racing for the same round", () => {
    beforeEach(async () => {
        // The demo provider, deliberately: its round simulates a run for
        // PREVIEW_RUN_MS instead of failing in the first tick, so both
        // requests are in flight together whatever this machine's timing. A
        // CLI provider's ENOENT round can be over before the second request
        // reaches the latch, and then there is no race to observe.
        await seedTarget({provider: "preview"});
    });

    // The loser of the race is refused, but the winner's round is real and
    // holds the latch until it ends - later tests must not inherit it.
    const untilIdle = (timeoutMs = 15000) =>
        waitFor(async () => {
            const {body} = await api(server.baseUrl, "/speedtests/status");
            return !body.running;
        }, {timeout: timeoutMs, interval: 100, message: "the promised round never finished"});

    it("promises the round to exactly one of them", async () => {
        try {
            const [first, second] = await Promise.all([
                api(server.baseUrl, "/speedtests/run", {method: "POST"}),
                api(server.baseUrl, "/speedtests/run", {method: "POST"})
            ]);

            assert.deepEqual([first.status, second.status].sort((a, b) => a - b), [200, 409],
                "both clicks were promised a round, but only one round can run");
        } finally {
            await untilIdle();
        }
    });
});

/**
 * Which member the instance-wide surfaces speak for - the base MQTT topic,
 * and with it every Home Assistant entity discovered from it.
 *
 * Resolved from the round's own order, this moved the moment a target was
 * unscheduled: the next line's results landed on the topic the first one's
 * sensors read, so an entity carrying months of one line's history silently
 * continued with another's, and the discovery configs are retained per topic
 * - nothing ever announced a correction. A Prometheus series is a view that
 * re-derives on every scrape; a recorder history is written once and cannot
 * be re-attributed afterwards.
 *
 * So it is the instance's first line on record, which only deleting it or
 * deliberately reordering the list can move. The cost is the honest one:
 * while that line is unscheduled the base topic goes quiet, which Home
 * Assistant shows for what it is, rather than filling with numbers from a
 * line nobody said it was watching.
 */
describe("which member the base topics speak for", () => {
    let task;
    let targets;

    before(async () => {
        task = await import("../../server/tasks/speedtest.js");
        targets = await import("../../server/controller/targets.js");
    });

    after(async () => {
        await targets.removeAll();
    });

    it("is the first line on record", async () => {
        await targets.removeAll();
        const first = await targets.create({name: "WAN", provider: "ookla", sortOrder: 0});
        const second = await targets.create({name: "LAN", provider: "ookla", sortOrder: 1});

        assert.equal(await task.isPrimaryMember(first), true);
        assert.equal(await task.isPrimaryMember(second), false);
    });

    it("does not move to another line when the first is unscheduled", async () => {
        await targets.removeAll();
        const first = await targets.create({name: "WAN", provider: "ookla", sortOrder: 0});
        const second = await targets.create({name: "LAN", provider: "ookla", sortOrder: 1});

        await targets.update(first.id, {enabled: false});

        assert.equal(await task.isPrimaryMember(second), false,
            "unscheduling one line handed its Home Assistant entities to another");
        assert.equal(await task.isPrimaryMember(first), true);
    });

    // The demo target is no row at all, and the only member of its round.
    it("is the demo target, which stands for the whole of its instance", async () => {
        assert.equal(await task.isPrimaryMember({id: null, name: null}), true);
    });

    /**
     * And what the payload says when the table cannot be read at all.
     *
     * The notification is built after the row is already committed, so a
     * rejection here would land in executeTarget's catch - whose first act is
     * to measure the whole member again and write a second row for one
     * scheduled test. So it degrades. But degrading to `true` is not a shrug:
     * it is the claim "this member owns the base topic", made by a secondary,
     * which publishes its numbers where the first line's Home Assistant sensors
     * read. The last answer this member actually got is the honest fallback.
     */
    describe("when the targets table cannot be read", () => {
        let model;

        before(async () => {
            ({default: model} = await import("../../server/models/Targets.js"));
        });

        const blinded = async (body) => {
            const findAll = model.findAll;
            model.findAll = async () => {
                throw new Error("database is locked");
            };

            try {
                return await body();
            } finally {
                model.findAll = findAll;
            }
        };

        it("keeps the answer the member last got", async () => {
            await targets.removeAll();
            const first = await targets.create({name: "WAN", provider: "ookla", sortOrder: 0});
            const second = await targets.create({name: "LAN", provider: "ookla", sortOrder: 1});

            // Both asked once while the table is readable, which is what every
            // round does before anything goes wrong. Both, rather than only the
            // secondary: sqlite hands the same ids back out after a delete, so
            // an answer left over from an earlier case in this file would
            // otherwise be what the fallback returned.
            assert.equal(await task.wasPrimaryMember(first), true);
            assert.equal(await task.wasPrimaryMember(second), false);

            await blinded(async () => {
                assert.equal(await task.wasPrimaryMember(second), false,
                    "a database blip handed the base topic - and its Home Assistant entities - to a secondary line");
                assert.equal(await task.wasPrimaryMember(first), true);
            });
        });

        // Never answered, so there is nothing to keep: the payload's own
        // contract says an absent flag reads as the primary, and a member that
        // has never been placed is treated as one. An id no row in this file
        // ever wore, so the answer cannot be one left behind by another case.
        it("falls back to the primary for a member it has never placed", async () => {
            await blinded(async () => {
                assert.equal(await task.wasPrimaryMember({id: 987654, name: "Unseen"}), true);
            });
        });

        // The demo target has no row to read in the first place, so nothing
        // here can fail for it - pinned so that stays true of the fallback too.
        it("still answers for the demo target, which reads no row at all", async () => {
            await blinded(async () => {
                assert.equal(await task.wasPrimaryMember({id: null, name: null}), true);
            });
        });
    });
});

/**
 * The healthchecks lifecycle across a real round of two members.
 *
 * healthchecks.io models one check as one monitored thing: /start opens a run
 * and the next ping closes it. The per-member events fire once per target, so
 * a two-member round used to answer its one /start with two pings and the
 * last member won - here, the demo member's success ping took the check back
 * up seconds after the WAN's failure put it down, and the check ended the
 * round "up" while the watched line was still failing.
 *
 * A real round on purpose: the WAN member fails the way every round in this
 * file fails (its CLI is never downloaded here), and the demo provider is the
 * one member that can succeed without a network.
 */
describe("the round and its healthchecks check", () => {
    const PING_URL = "https://hc.example.net/ping/round";
    let task;
    let integrationId;

    before(async () => {
        task = await import("../../server/tasks/speedtest.js");

        const {body} = await api(server.baseUrl, "/integrations/healthChecks", {
            method: "PUT",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({url: PING_URL})
        });
        integrationId = body.id;
    });

    // Removed again, whatever happened: every other describe in this file
    // runs rounds too, and a leftover integration would aim their
    // notifications at hc.example.net over the real network.
    after(async () => {
        await api(server.baseUrl, `/integrations/${integrationId}`, {method: "DELETE"});
    });

    /**
     * Runs a round with fetch stubbed and answers the pings it made.
     *
     * The pings are fired without being awaited - the round must not wait on a
     * notifier - so the stub stays in place until they have stopped arriving:
     * restoring it while one is still in flight would let that ping loose on
     * the real network, and this file's history says exactly where that ends.
     */
    const EXPECTED_PINGS = 2;
    const PING_TIMEOUT_MS = 8000;
    const QUIET_POLLS = 3;
    const POLL_MS = 150;

    const pingsOf = async (round) => {
        const realFetch = globalThis.fetch;
        const sent = [];
        globalThis.fetch = async (url) => {
            sent.push(String(url));
            return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
        };

        const pings = () => sent.filter((url) => url.startsWith(PING_URL));

        try {
            await round();

            const deadline = Date.now() + PING_TIMEOUT_MS;
            let quiet = 0;
            while (Date.now() < deadline && (pings().length < EXPECTED_PINGS || quiet < QUIET_POLLS)) {
                const before = sent.length;
                await new Promise((resolve) => setTimeout(resolve, POLL_MS));
                quiet = sent.length === before ? quiet + 1 : 0;
            }
        } finally {
            globalThis.fetch = realFetch;
        }

        return pings();
    };

    it("answers its start with the round's one outcome", async () => {
        const targets = await import("../../server/controller/targets.js");
        await seedTarget({provider: "ookla", name: "WAN"});
        await targets.create({name: "Demo", provider: "preview"});

        assert.deepEqual(await pingsOf(() => task.create("auto")),
            [`${PING_URL}/start`, `${PING_URL}/fail`],
            "the demo member's success took the check back up over the WAN's standing failure");
    });

    /**
     * And the round's verdict is about the watched lines, not about the
     * members this particular round got round to.
     *
     * A provider that refused for too many requests holds its targets out of
     * the round entirely, so a round can end without measuring the very line
     * that is down: it counted no failures, pinged the success URL and took
     * the check up - and a minute later the keep-alive read the standing
     * failure from the stored rows and pinged /fail again. On the minutely
     * cron the installer scripts hand out that is a check flapping once a
     * minute for the whole hold. The two now ask one question.
     */
    it("keeps the check down for a watched failure this round skipped", async () => {
        const targets = await import("../../server/controller/targets.js");
        const {clearBackoff, recordRateLimit} = await import("../../server/util/rateLimitBackoff.js");

        const wan = await seedTarget({provider: "ookla", name: "WAN"});
        await targets.create({name: "Demo", provider: "preview"});

        // The WAN is down and its provider has just refused, so this round
        // skips it and measures only the demo member, which cannot fail.
        await seedTests(server.tests, [{created: new Date().toISOString(), targetId: wan.id,
            ping: -1, download: -1, upload: -1, error: "no route to host"}]);
        recordRateLimit("ookla");

        try {
            assert.deepEqual(await pingsOf(() => task.create("auto")),
                [`${PING_URL}/start`, `${PING_URL}/fail`],
                "a round that skipped the failing line reported itself clean");

            // The premise, which nothing here asserted. Without the hold the
            // WAN member runs, its CLI is not on disk, and the failure it
            // records earns the same /fail - so this case passed with the two
            // lines above it deleted and never exercised the clause it exists
            // for. One row is the seeded failure; a second would be this
            // round's.
            assert.equal(await server.tests.count({where: {targetId: wan.id}}), 1,
                "the hold did not skip the WAN, so this round measured the failing line itself");
        } finally {
            clearBackoff("ookla");
        }
    });

    /**
     * And a round that could not read its own guards is not a line going down.
     *
     * The guards the loop consults before each member - the pause, the quiet
     * hours, the re-read of the row - moved inside the per-member handler so a
     * failing one could not drop the rest of the round. Every one of them is a
     * database read, and the handler then counted the refusal as the member
     * having failed: one flaky read pinged /fail on an instance whose every
     * stored row was a success, and error.log said a line "could not record its
     * result" about a run that never started.
     */
    it("keeps the check up when a guard, not the line, is what failed", async () => {
        const targets = await import("../../server/controller/targets.js");
        const {default: model} = await import("../../server/models/Targets.js");

        const wan = await seedTarget({provider: "ookla", name: "WAN"});
        await seedTests(server.tests, [{created: new Date().toISOString(), targetId: wan.id,
            ping: 12, download: 100, upload: 50, error: null}]);

        // The round's re-read of the member, and nothing else: findAll still
        // answers, so the round still has members to walk.
        const findOne = model.findOne;
        model.findOne = async () => {
            throw new Error("database is locked");
        };

        try {
            assert.deepEqual(await pingsOf(() => task.create("auto")),
                [`${PING_URL}/start`, PING_URL],
                "a transient read failure was reported as the watched line going down");
        } finally {
            model.findOne = findOne;
            await targets.removeAll();
        }
    });
});
