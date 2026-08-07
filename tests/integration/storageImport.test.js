import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api } from "./helpers/boot.js";

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

    it("round-trips its own export", async () => {
        const {body: exported} = await api(server.baseUrl, "/storage/config");

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

    it("never writes the password key from an imported payload", async () => {
        await importConfig({config: {password: "smuggled"}, nodes: [], integrations: [], recommendations: []});

        assert.equal(await server.config.getValue("password"), "none");
    });
});
