import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, seedTests, setConfig } from "./helpers/boot.js";

let server;
let resetFailedAttempts;
let reserveAttempt;

before(async () => {
    server = await bootServer();
    ({resetFailedAttempts, reserveAttempt} = await import("../../server/middlewares/password.js"));
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    resetFailedAttempts();
    await setConfig(server.config, "password", "none");
    await seedTests(server.tests, [{created: new Date().toISOString()}]);
});

const metrics = (headers = {}) => api(server.baseUrl, "/prometheus/metrics", {headers});
const basic = (value) => ({authorization: `Basic ${Buffer.from(value).toString("base64")}`});

describe("GET /api/prometheus/metrics", () => {
    it("is open while no password is configured", async () => {
        assert.equal((await metrics()).status, 200);
    });

    it("challenges once a password is configured", async () => {
        await setConfig(server.config, "password", "Hunter2!");

        const {status, headers} = await metrics();
        assert.equal(status, 401);
        assert.match(headers.get("www-authenticate"), /^Basic /);
    });

    it("accepts the prometheus user with the configured password", async () => {
        await setConfig(server.config, "password", "Hunter2!");
        assert.equal((await metrics(basic("prometheus:Hunter2!"))).status, 200);
    });

    it("rejects a wrong password", async () => {
        await setConfig(server.config, "password", "Hunter2!");
        assert.equal((await metrics(basic("prometheus:nope"))).status, 401);
    });

    it("rejects a different username", async () => {
        await setConfig(server.config, "password", "Hunter2!");
        assert.equal((await metrics(basic("grafana:Hunter2!"))).status, 401);
    });

    /**
     * The scrape shares the failed-attempt counter with the password
     * middleware - the comment on authorizeMetrics says so, and until now no
     * test held it to that.
     *
     * Whether the counter is wired up at all is a different question from
     * whether simultaneous guesses race it, and only the second needs
     * concurrency - that one is pinned in passwordThrottle.test.js, once,
     * against the one function all three entry points spend the counter
     * through. So these are sequential, and the lockout is built through the
     * throttle helpers rather than twenty HTTP requests: this route sits
     * behind its own 60-per-minute rate limiter, and five tests of twenty
     * scrapes each tripped it, failing everything after them for the wrong
     * reason.
     * The one real wrong scrape in the first test is what proves the route
     * charges the shared counter; the 429s prove it checks it.
     */
    describe("the failed-attempt counter", () => {
        const MAX_FAILED_ATTEMPTS = 20;

        // The same identity the HTTP requests arrive as, so the charges and
        // the scrapes land on one counter.
        const sameCaller = {headers: {}, socket: {remoteAddress: "127.0.0.1"}};
        const spend = (attempts) => {
            for (let i = 0; i < attempts; i++) reserveAttempt(sameCaller).settle({failed: 1});
        };

        it("refuses to keep comparing after too many wrong passwords", async () => {
            await setConfig(server.config, "password", "Hunter2!");

            // One short of the limit, then one genuine wrong scrape: the 429
            // that follows proves the scrape recorded the twentieth.
            spend(MAX_FAILED_ATTEMPTS - 1);
            assert.equal((await metrics(basic("prometheus:nope"))).status, 401);

            assert.equal((await metrics(basic("prometheus:nope"))).status, 429,
                "the scrape either did not charge the counter or does not check it");
        });

        it("refuses even the correct password while locked out", async () => {
            await setConfig(server.config, "password", "Hunter2!");

            spend(MAX_FAILED_ATTEMPTS);
            assert.equal((await metrics(basic("prometheus:Hunter2!"))).status, 429);
        });

        it("clears the counter on a successful scrape", async () => {
            await setConfig(server.config, "password", "Hunter2!");

            spend(MAX_FAILED_ATTEMPTS - 1);
            assert.equal((await metrics(basic("prometheus:Hunter2!"))).status, 200);

            assert.equal((await metrics(basic("prometheus:nope"))).status, 401, "the counter was not reset");
        });

        // One counter for all three ways in, so an attacker cannot win a fresh
        // budget by switching to the scrape - the charges above came from the
        // middleware's own function, and here the header path is refused too.
        it("is the same counter the password header spends", async () => {
            await setConfig(server.config, "password", "Hunter2!");

            spend(MAX_FAILED_ATTEMPTS);
            const {status} = await api(server.baseUrl, "/speedtests?limit=1",
                {headers: {"x-password": "nope"}});
            assert.equal(status, 429);
        });

        /**
         * A request carrying no guess costs no bcrypt work, so it is never
         * throttled - the principle the middleware has always stated. A
         * locked-out caller with no credentials gets the 401 challenge that
         * tells them what is missing, not a 429 about guesses they did not make.
         */
        it("still challenges a locked-out caller who sent no credentials", async () => {
            await setConfig(server.config, "password", "Hunter2!");

            spend(MAX_FAILED_ATTEMPTS);
            assert.equal((await metrics()).status, 401);
        });
    });

    /**
     * Regression: credentials.split(':') on a value with no colon left the
     * password undefined, which bcrypt throws on - so a malformed header came
     * back as a 500 carrying a stack trace instead of a 401.
     */
    it("answers a colonless Basic value with 401, not 500", async () => {
        await setConfig(server.config, "password", "Hunter2!");

        const {status, text} = await metrics(basic("prometheus"));
        assert.equal(status, 401);
        assert.doesNotMatch(text, /at .*\.js:\d+/);
    });

    it("answers an empty Basic value with 401", async () => {
        await setConfig(server.config, "password", "Hunter2!");
        assert.equal((await metrics(basic(""))).status, 401);
    });

    it("answers a Basic header with no credentials at all with 401", async () => {
        await setConfig(server.config, "password", "Hunter2!");
        assert.equal((await metrics({authorization: "Basic "})).status, 401);
    });

    it("keeps a password with colons in it working", async () => {
        await setConfig(server.config, "password", "Aa1:b:c!");
        assert.equal((await metrics(basic("prometheus:Aa1:b:c!"))).status, 200);
    });
});

/**
 * Every assertion above is about who may read the endpoint; none was about what
 * it says. The exporter could have emitted the wrong number, or stopped emitting
 * a series entirely, without failing anything - which is how the quality columns
 * came to be stored and stored only.
 */
describe("what the metrics endpoint reports", () => {
    const valueOf = (text, metric) => {
        // Three shapes: labelled, bare with a value, and bare on its own. The
        // trailing space keeps myspeed_server from matching myspeed_server_info.
        const line = text.split("\n").find((row) =>
            row.startsWith(`${metric}{`) || row.startsWith(`${metric} `) || row === metric);
        return line === undefined ? null : parseFloat(line.slice(line.lastIndexOf(" ") + 1));
    };

    const seedLatest = async (overrides) => await seedTests(server.tests,
        [{created: new Date().toISOString(), ...overrides}]);

    it("reports the latest measurement", async () => {
        await seedLatest({ping: 4, jitter: 0.27, download: 2366.32, upload: 2202.56});

        const {text} = await metrics();

        assert.equal(valueOf(text, "myspeed_ping"), 4);
        assert.equal(valueOf(text, "myspeed_jitter"), 0.27);
        assert.equal(valueOf(text, "myspeed_download"), 2366.32);
        assert.equal(valueOf(text, "myspeed_upload"), 2202.56);
    });

    it("reports the quality figures the latest test recorded", async () => {
        await seedLatest({packetLoss: 0, downloadLatency: 7.51, uploadLatency: 43.77});

        const {text} = await metrics();

        // Zero is a measurement of a clean line, not a missing series.
        assert.equal(valueOf(text, "myspeed_packet_loss"), 0);
        assert.equal(valueOf(text, "myspeed_download_latency"), 7.51);
        assert.equal(valueOf(text, "myspeed_upload_latency"), 43.77);
    });

    // An absent series is a gap in a graph; a zero is a claim the line was
    // flawless. Librespeed and cloudflare measure none of these.
    it("omits a quality figure the provider never measured", async () => {
        await seedLatest({packetLoss: null, downloadLatency: null, uploadLatency: null});

        const {text} = await metrics();

        assert.equal(valueOf(text, "myspeed_packet_loss"), null);
        assert.equal(valueOf(text, "myspeed_download_latency"), null);
        assert.equal(valueOf(text, "myspeed_upload_latency"), null);
    });

    it("carries the server it measured as labels", async () => {
        await seedLatest({serverId: 49631, serverName: "Arcade Solutions AG", serverHost: "speedtest.arcade.ch"});

        const {text} = await metrics();

        assert.match(text, /myspeed_ping\{[^}]*server_name="Arcade Solutions AG"/);
        assert.match(text, /myspeed_ping\{[^}]*server_host="speedtest\.arcade\.ch"/);
        assert.equal(valueOf(text, "myspeed_server_info"), 1);
    });

    /**
     * `currentServerGauge.set(latest.serverId)` passed the raw column value
     * while resolveServerLabels, fifty lines above, already defended the same
     * field with `?? 0`. prom-client 15 throws "Value is not a valid number"
     * for null, which took the whole scrape down with it.
     *
     * Not reachable from a normal run - the task always writes a number or the
     * default 0 - but PUT /api/storage/tests/history validates only ping,
     * download, upload and time, so one imported row with a null serverId
     * broke every scrape for as long as it stayed the newest.
     */
    it("scrapes a row whose server id was never recorded", async () => {
        await seedLatest({serverId: null, serverName: null, serverHost: null});

        const {status, text} = await metrics();

        assert.equal(status, 200);
        assert.equal(valueOf(text, "myspeed_server"), 0);
        assert.equal(valueOf(text, "myspeed_ping"), 10);
    });

    it("reports a test that succeeded as not having failed", async () => {
        await seedLatest({ping: 10, download: 100, upload: 50});

        assert.equal(valueOf((await metrics()).text, "myspeed_test_failed"), 0);
    });
});

/**
 * A failed test is reported as one, rather than reported by failing.
 *
 * The scrape used to answer 500 whenever the newest test had failed. Prometheus
 * reads that as the target being down: it records no sample, every myspeed_*
 * series goes stale, and the alert that fires is "the exporter is unreachable" -
 * so the monitoring goes blind at exactly the moment the connection has a
 * problem worth seeing, and says the wrong thing about why.
 *
 * A failure is data. It is exported as myspeed_test_failed, and the measurement
 * series are left absent rather than carrying the -1 that every column of a
 * failed test holds - the same rule the quality figures above already follow,
 * since a gap in a graph is honest and a number is not.
 */
describe("a latest test that failed", () => {
    const valueOf = (text, metric) => {
        const line = text.split("\n").find((row) =>
            row.startsWith(`${metric}{`) || row.startsWith(`${metric} `) || row === metric);
        return line === undefined ? null : parseFloat(line.slice(line.lastIndexOf(" ") + 1));
    };

    const seedFailure = async () => await seedTests(server.tests, [{
        created: new Date().toISOString(), ping: -1, download: -1, upload: -1, jitter: -1,
        time: -1, serverId: 49631, serverName: "Arcade Solutions AG", error: "Cannot open socket"
    }]);

    it("still answers the scrape", async () => {
        await seedFailure();

        assert.equal((await metrics()).status, 200,
            "the exporter reports itself down when it is the line that is down");
    });

    it("says that it failed", async () => {
        await seedFailure();

        assert.equal(valueOf((await metrics()).text, "myspeed_test_failed"), 1);
    });

    // The whole reason the old branch refused: -1 metres per second is not a
    // reading, and a dashboard cannot tell it from one.
    it("exports no measurement for it", async () => {
        await seedFailure();

        const {text} = await metrics();

        for (const metric of ["myspeed_ping", "myspeed_download", "myspeed_upload", "myspeed_jitter"])
            assert.equal(valueOf(text, metric), null, `${metric} carries a placeholder from a failed test`);
        assert.doesNotMatch(text, /-1$/m, "a -1 placeholder reached the scrape");
    });

    // The attempt still happened, against a server, and knowing which one is
    // most of the diagnosis when a particular server is what is failing.
    it("still carries the server it tried", async () => {
        await seedFailure();

        const {text} = await metrics();

        assert.equal(valueOf(text, "myspeed_server_info"), 1);
        assert.match(text, /server_name="Arcade Solutions AG"/);
    });

    // A failure's duration column holds the same -1 as the rest of the row.
    it("does not export the failure's duration", async () => {
        await seedFailure();

        assert.equal(valueOf((await metrics()).text, "myspeed_time"), null,
            "the failed test's -1 duration is exported as a time");
    });

    /**
     * And an instance that has never run a test answers too. There is no
     * failure to report there - only nothing yet - so the series are simply
     * absent, which is what an empty metric family is for. Answering 500 said
     * the exporter was broken when it was working perfectly and had been
     * installed five minutes ago.
     */
    it("answers a scrape from an instance that has never tested", async () => {
        await seedTests(server.tests, []);

        const {status, text} = await metrics();

        assert.equal(status, 200, "a fresh install reports its exporter as broken");
        assert.equal(valueOf(text, "myspeed_ping"), null);
        assert.equal(valueOf(text, "myspeed_test_failed"), null,
            "an instance that never tested is reported as having failed a test");

        // Not zero: 0 is a server id a real instance can be pinned to, and an
        // unlabelled gauge that is reset rather than removed exports exactly
        // that - so this would read as "currently testing against server 0".
        assert.equal(valueOf(text, "myspeed_server"), null,
            "an instance that never tested reports a current server anyway");
    });

    // And it comes back once there is a test to report one for.
    it("reports the current server again after a test arrives", async () => {
        await seedTests(server.tests, []);
        await metrics();

        await seedTests(server.tests, [{created: new Date().toISOString(), serverId: 49631}]);

        assert.equal(valueOf((await metrics()).text, "myspeed_server"), 49631,
            "removing the series left it removed");
    });
});

/**
 * Six scrapes at once, all of which must get a complete answer.
 *
 * The gauges are module-level and shared by every request, and the scrape
 * clears them before it has anything to put back. The order that hurts is
 * clear-after-set: one scrape sets its values and starts rendering, another
 * enters and clears, and the first then serves empty families - which reads as
 * an instance that has never tested rather than as a concurrent scrape. A
 * Prometheus HA pair scrapes the same target by design, and one `curl` during a
 * scheduled scrape does it just as well.
 *
 * This is the end-to-end check that queueing them did not break the ordinary
 * case; the queue's own guarantee is asserted directly in serialiseQueue's
 * tests, because the interleaving above cannot be provoked to order over a real
 * socket.
 */
describe("concurrent scrapes", () => {
    const CONCURRENT = 6;

    const pingOf = (text) => {
        const line = text.split("\n").find((row) => row.startsWith("myspeed_ping{"));
        return line === undefined ? null : parseFloat(line.slice(line.lastIndexOf(" ") + 1));
    };

    it("all answer with the measurement, not with an empty exporter", async () => {
        await seedTests(server.tests, [{created: new Date().toISOString(), ping: 17}]);

        const scrapes = await Promise.all(Array.from({length: CONCURRENT}, () => metrics()));

        for (const [index, {status, text}] of scrapes.entries()) {
            assert.equal(status, 200, `scrape ${index} failed outright`);
            assert.equal(pingOf(text), 17,
                `scrape ${index} of ${CONCURRENT} was served while another had cleared the gauges`);
        }
    });

    // Queued, not dropped or merged: every caller gets its own answer.
    it("answers every one of them", async () => {
        const scrapes = await Promise.all(Array.from({length: CONCURRENT}, () => metrics()));

        assert.equal(scrapes.length, CONCURRENT);
        for (const {text} of scrapes) assert.match(text, /myspeed_/);
    });
});
