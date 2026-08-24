import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, setConfig } from "./helpers/boot.js";

let server;
let nodeModel;
let integrationModel;
let recommendationModel;

before(async () => {
    server = await bootServer();
    nodeModel = (await import("../../server/models/Node.js")).default;
    integrationModel = (await import("../../server/models/IntegrationData.js")).default;
    recommendationModel = (await import("../../server/models/Recommendations.js")).default;
});

after(async () => {
    // An import that moves the schedule starts a real node-schedule job, and
    // that job keeps the event loop alive long after the assertions are done.
    (await import("../../server/tasks/timer.js")).stopTimer();
    await server?.close();
});

const EXISTING_NODE = {name: "living-room", url: "http://192.168.1.50:5216", password: null};
const EXISTING_INTEGRATION = {id: "keepme", name: "discord", displayName: "Alerts", data: {url: "https://hook"}};
const EXISTING_RECOMMENDATION = {ping: 8, download: 940, upload: 480};

const seedEverything = async () => {
    await nodeModel.destroy({where: {}});
    await integrationModel.destroy({where: {}});
    await recommendationModel.destroy({where: {}});

    await nodeModel.create(EXISTING_NODE);
    await integrationModel.create(EXISTING_INTEGRATION);
    await recommendationModel.create(EXISTING_RECOMMENDATION);
};

const counts = async () => ({
    nodes: await nodeModel.count(),
    integrations: await integrationModel.count(),
    recommendations: await recommendationModel.count()
});

const importConfig = (payload) => api(server.baseUrl, "/storage/config", {
    method: "PUT",
    headers: {"content-type": "application/json"},
    body: JSON.stringify(payload)
});

beforeEach(seedEverything);

describe("PUT /api/storage/config", () => {
    /**
     * Regression: importConfig emptied the nodes, integrations and
     * recommendations tables *before* looking at the payload. A payload
     * missing so much as one of those keys made the following bulkCreate throw,
     * the bare catch returned false, and the rows were gone for good - nothing
     * here is soft-deleted and no transaction wrapped the work.
     */
    it("keeps existing rows when the payload has no nodes key", async () => {
        const {status} = await importConfig({config: {}, integrations: [], recommendations: []});

        assert.equal(status, 500);
        assert.deepEqual(await counts(), {nodes: 1, integrations: 1, recommendations: 1});
    });

    it("keeps existing rows when a table key is not a list", async () => {
        const {status} = await importConfig({config: {}, nodes: "all of them", integrations: [], recommendations: []});

        assert.equal(status, 500);
        assert.deepEqual(await counts(), {nodes: 1, integrations: 1, recommendations: 1});
    });

    it("keeps existing rows when the payload is not an object at all", async () => {
        assert.equal((await importConfig([])).status, 500);
        assert.deepEqual(await counts(), {nodes: 1, integrations: 1, recommendations: 1});
    });

    it("keeps existing rows when a config value is invalid", async () => {
        const {status} = await importConfig({
            config: {cron: "every second tuesday"}, nodes: [], integrations: [], recommendations: []
        });

        assert.equal(status, 500);
        assert.deepEqual(await counts(), {nodes: 1, integrations: 1, recommendations: 1});
    });

    // Rolled back as one unit: a row the database refuses partway through must
    // not leave the tables half-emptied.
    it("rolls the deletes back when a replacement row is rejected", async () => {
        const {status} = await importConfig({
            config: {},
            nodes: [{name: "new", url: "http://10.0.0.2:5216"}],
            integrations: [],
            recommendations: [{ping: null, download: null, upload: null}]
        });

        assert.equal(status, 500);
        assert.deepEqual(await counts(), {nodes: 1, integrations: 1, recommendations: 1});

        const [survivor] = await nodeModel.findAll();
        assert.equal(survivor.name, EXISTING_NODE.name);
    });

    /**
     * A table longer than any instance has is not a backup either.
     *
     * These three tables are small by their nature - the nodes an operator
     * added, one row per configured notifier, and the computed optimal values -
     * and nothing bounded them. The import body is parsed at a 50mb limit, so
     * `{"ping":1,"download":1,"upload":1}` at 34 bytes packs about 1.5 million
     * recommendations into one request, and bulkCreate writes them at 9-13us
     * each with the event loop held for all of it.
     *
     * Planted `integrations` rows outlive the request as well: triggerEvent
     * loops over every active one and awaits an outbound call for each, and the
     * minute job fires that loop for ever. One request would leave a permanent
     * outbound flood behind it.
     *
     * Refused with the table named, and refused *before* the deletes - which is
     * the property this file exists to protect.
     */
    it("keeps existing rows when a table is longer than any instance has", async () => {
        const {status, body} = await importConfig({
            config: {},
            nodes: [],
            integrations: [],
            recommendations: Array.from({length: 10_001},
                () => ({ping: 1, download: 1, upload: 1}))
        });

        assert.equal(status, 500);
        assert.match(body.message, /recommendations/,
            "the refusal does not say which table was too long");
        assert.deepEqual(await counts(), {nodes: 1, integrations: 1, recommendations: 1},
            "the tables were emptied before the payload was found to be unusable");
    });

    it("still accepts a table at the largest size it allows", async () => {
        const {status} = await importConfig({
            config: {},
            nodes: [],
            integrations: [],
            recommendations: Array.from({length: 10_000},
                () => ({ping: 1, download: 1, upload: 1}))
        });

        assert.equal(status, 200, "the ceiling is off by one and refuses a payload at the limit");
        assert.equal((await counts()).recommendations, 10_000);
    });

    it("replaces the tables when the payload is sound", async () => {
        const {status} = await importConfig({
            config: {retentionDays: "30"},
            nodes: [{name: "office", url: "http://10.0.0.3:5216", password: null}],
            integrations: [],
            recommendations: [{ping: 12, download: 500, upload: 250}]
        });

        assert.equal(status, 200);
        assert.deepEqual(await counts(), {nodes: 1, integrations: 0, recommendations: 1});

        const [replacement] = await nodeModel.findAll();
        assert.equal(replacement.name, "office");
        assert.equal(await server.config.getValue("retentionDays"), "30");
    });

    // includeSecrets is what makes an export a complete backup. Without it the
    // credentials are deliberately blanked, which is covered below.
    it("round-trips its own export", async () => {
        const {body: exported} = await api(server.baseUrl, "/storage/config?includeSecrets=true");

        const {status} = await importConfig(exported);
        assert.equal(status, 200);
        assert.deepEqual(await counts(), {nodes: 1, integrations: 1, recommendations: 1});

        const [restored] = await nodeModel.findAll();
        assert.equal(restored.name, EXISTING_NODE.name);

        // A raw query hands JSON columns back in whichever representation they
        // are stored in; what matters is that the content survived the trip.
        const [integration] = await integrationModel.findAll();
        const data = typeof integration.data === "string" ? JSON.parse(integration.data) : integration.data;
        assert.deepEqual(data, EXISTING_INTEGRATION.data);
    });

    /**
     * The default export is the one people download and share, so it must not
     * carry credentials - a Discord webhook URL is a bearer token. Everything
     * else about the integration still restores; only the secret comes back
     * blank and has to be re-entered.
     */
    it("restores the structure but not the credentials from a redacted export", async () => {
        const {body: exported} = await api(server.baseUrl, "/storage/config");
        assert.equal(exported.secretsRedacted, true);

        assert.equal((await importConfig(exported)).status, 200);
        assert.deepEqual(await counts(), {nodes: 1, integrations: 1, recommendations: 1});

        const [integration] = await integrationModel.findAll();
        const data = typeof integration.data === "string" ? JSON.parse(integration.data) : integration.data;

        assert.equal(integration.displayName, EXISTING_INTEGRATION.displayName);
        assert.equal(data.url, null);
    });

    it("never writes the password key from an imported payload", async () => {
        await importConfig({config: {password: "smuggled"}, nodes: [], integrations: [], recommendations: []});

        assert.equal(await server.config.getValue("password"), "none");
    });

    /**
     * Sequelize.DATE.prototype._stringify was overridden with a function taking
     * no argument at all - `() => new Date().toISOString()` - so every DATE
     * written was substituted with the moment of the write. The sqlite DATE
     * subclass inherits it, which makes integration_data.lastActivity the one
     * column it reaches: a restore brought every integration back reporting
     * "last run: a few seconds ago", whatever the backup said.
     */
    it("restores an integration's last activity rather than stamping it now", async () => {
        const lastActivity = "2024-03-01T10:00:00.000Z";

        await integrationModel.destroy({where: {}});
        await integrationModel.create({...EXISTING_INTEGRATION, lastActivity});

        const {body: exported} = await api(server.baseUrl, "/storage/config?includeSecrets=true");
        assert.equal((await importConfig(exported)).status, 200);

        const [restored] = await integrationModel.findAll();
        assert.equal(new Date(restored.lastActivity).toISOString(), lastActivity);
    });

    /**
     * A restore has to put back what the backup says, including the settings
     * that happen to sit at their shipped default.
     *
     * The skip that made this fail tested the *backup's* value against the
     * default rather than the stored one, so a restore was a no-op for exactly
     * the keys an operator most needs put back - and answered 200 while doing
     * nothing. Restoring a year of retention onto an instance pruning weekly
     * left it pruning weekly; restoring open access onto one locked to
     * read-only left it locked.
     */
    describe("a backup value that sits at the shipped default", () => {
        const restore = (config) => importConfig({config, nodes: [], integrations: [], recommendations: []});

        it("restores the default retention over a changed one", async () => {
            await setConfig(server.config, "retentionDays", "7");

            assert.equal((await restore({retentionDays: "365"})).status, 200);
            assert.equal(await server.config.getValue("retentionDays"), "365");
        });

        it("restores open access over read-only", async () => {
            await setConfig(server.config, "passwordLevel", "read");

            assert.equal((await restore({passwordLevel: "none"})).status, 200);
            assert.equal(await server.config.getValue("passwordLevel"), "none");
        });

        it("restores an unpinned server over a pinned one", async () => {
            await setConfig(server.config, "ooklaId", "49631");

            assert.equal((await restore({ooklaId: "none"})).status, 200);
            assert.equal(await server.config.getValue("ooklaId"), "none");
        });

        it("restores the default schedule over a changed one", async () => {
            await setConfig(server.config, "cron", "*/15 * * * *");

            assert.equal((await restore({cron: "0 * * * *"})).status, 200);
            assert.equal(await server.config.getValue("cron"), "0 * * * *");
        });

        /**
         * Why the skip existed. `provider: "none"` is the stored sentinel for
         * "not chosen yet" and validateInput refuses it as user input, so the
         * default has to be written without being validated - not skipped.
         */
        it("restores a sentinel default validateInput refuses as user input", async () => {
            await setConfig(server.config, "provider", "ookla");

            assert.equal((await restore({provider: "none"})).status, 200);
            assert.equal(await server.config.getValue("provider"), "none");
        });
    });
});

/**
 * A backup carrying a threshold that is no longer a legal value.
 *
 * ping, download and upload were guarded by a negated character class until
 * 1.3.5 - "is every character a digit or a dot" - so "1.2.3", ".." and a lone
 * "." were all stored behind a 200 by `PATCH /api/config/:key`. Anchoring that
 * check is right, and it made every one of those backups unrestorable: the
 * validate loop refuses the first one it meets and abandons the whole import,
 * so the nodes, the integrations and the recommendations are all left behind by
 * a display preference no server code even reads.
 *
 * The default is written instead. It is the same trade the check itself already
 * makes for ".5" and "1." - a value that was legal when it was saved must not
 * take the rest of a restore down - except that these cannot be kept, because
 * Number() cannot read them and a threshold it cannot read greys every speed on
 * the dashboard. So the restore completes and the unreadable preference is the
 * one thing that does not survive it.
 */
describe("PUT /api/storage/config with a threshold an older version accepted", () => {
    const restore = (config) => importConfig({
        config, nodes: [{name: "new", url: "http://10.0.0.9:5216"}], integrations: [], recommendations: []
    });

    ["1.2.3", "..", ".", "1..2"].forEach((stored) => {
        it(`restores everything else when download is ${JSON.stringify(stored)}`, async () => {
            const {status} = await restore({download: stored});

            assert.equal(status, 200, "the whole backup is refused over one unreadable threshold");
            assert.equal(await server.config.getValue("download"), "100",
                "the unreadable threshold was kept, so every speed on the dashboard stays grey");
            // The row's identity, not the count: seedEverything leaves exactly
            // one node and the payload carries exactly one, so a count of 1 is
            // what a refused restore answers too.
            assert.equal((await nodeModel.findOne()).name, "new", "the nodes were not restored");
        });
    });

    it("still refuses a value that is not a threshold at all", async () => {
        assert.equal((await restore({cron: "every second tuesday"})).status, 500,
            "any invalid value now passes, not only the three thresholds");
    });

    it("keeps a threshold it can still read", async () => {
        assert.equal((await restore({download: ".5"})).status, 200);
        assert.equal(await server.config.getValue("download"), ".5",
            "a value the check accepts was replaced by the default anyway");
    });
});

/**
 * And the same for a librespeed URL an older version accepted.
 *
 * That value was checked with a bare `new URL()` until the scheme check was
 * added, and `new URL("localhost:8080")` does not throw - it reads "localhost:"
 * as the scheme. So a bare host and port, which is a natural thing to type for a
 * backend on the LAN, was stored behind a 200 and carried verbatim into every
 * backup taken since. Restoring one of those files now refused the whole import:
 * the nodes, the integrations and the recorded history were all left behind by a
 * URL the instance could never have fetched anyway.
 *
 * The default is written instead, which for this key means "choose a server
 * automatically" - the same trade the thresholds above make, and for the same
 * reason. A value the current validator cannot read is one this instance cannot
 * act on, so the restore completes without it and the setting is the one thing
 * that does not survive.
 */
describe("PUT /api/storage/config with a librespeed URL an older version accepted", () => {
    const restore = (config) => importConfig({
        config, nodes: [{name: "new", url: "http://10.0.0.9:5216"}], integrations: [], recommendations: []
    });

    ["localhost:8080", "speed.lan:8080/backend", "nas:3000"].forEach((stored) => {
        it(`restores everything else when libreUrl is ${JSON.stringify(stored)}`, async () => {
            await setConfig(server.config, "libreUrl", "none");

            const {status} = await restore({libreUrl: stored});

            assert.equal(status, 200, "the whole backup is refused over one unusable backend URL");
            assert.equal(await server.config.getValue("libreUrl"), "none",
                "a URL the CLI cannot fetch was restored anyway");
            // Its identity rather than the count, for the reason given above.
            assert.equal((await nodeModel.findOne()).name, "new", "the nodes were not restored");
        });
    });

    it("keeps a URL it can still read", async () => {
        assert.equal((await restore({libreUrl: "https://speed.example.net/backend"})).status, 200);
        assert.equal(await server.config.getValue("libreUrl"), "https://speed.example.net/backend",
            "a URL the check accepts was replaced by the default anyway");
    });

    // The sentinel is the default, so it takes the shipped-default path rather
    // than the validator at all - but it still has to come back as itself.
    it("keeps the unset sentinel", async () => {
        assert.equal((await restore({libreUrl: "none"})).status, 200);
        assert.equal(await server.config.getValue("libreUrl"), "none");
    });

    // Tolerating this one must not tolerate the next thing that cannot be read:
    // a cron the scheduler cannot parse still takes the restore down, because
    // guessing at it would restore an instance on a different schedule.
    it("still refuses a value that is not one of the tolerated keys", async () => {
        assert.equal((await restore({cron: "every second tuesday"})).status, 500);
    });
});

/**
 * And a refused restore says which value it refused.
 *
 * The import walks every stored key back through the validator and abandons the
 * whole thing on the first refusal - the nodes, the integrations and the
 * recorded history with it - and answered "Error importing config" and nothing
 * else. The operator is holding a file they cannot import, with no way to learn
 * which of sixteen values is the problem short of bisecting it by hand.
 *
 * Only where there is a key to name: a payload that is not an object, or a
 * database that refused the write, have no one value to blame and still say so
 * plainly.
 */
describe("PUT /api/storage/config names what it refused", () => {
    const restore = (config) => importConfig({config, nodes: [], integrations: [], recommendations: []});

    it("names the key whose value was rejected", async () => {
        const {status, body} = await restore({cron: "every second tuesday"});

        assert.equal(status, 500);
        assert.match(body.message, /cron/,
            "the restore fails without saying which of the stored values it could not read");
    });

    it("names a password that is not a stored one", async () => {
        const {status, body} = await restore({password: "hunter2"});

        assert.equal(status, 500);
        assert.match(body.message, /password/);
    });

    it("still answers plainly when nothing in particular is to blame", async () => {
        const {status, body} = await importConfig([]);

        assert.equal(status, 500);
        assert.match(body.message, /Error importing config/);
    });
});
