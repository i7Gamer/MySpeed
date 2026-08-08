import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, seedTests } from "./helpers/boot.js";

let server;
let controller;

before(async () => {
    server = await bootServer();
    controller = await import("../../server/controller/speedtests.js");
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    await seedTests(server.tests, []);
});

// Rows come back raw rather than as model instances - see the `query: {raw: true}`
// the database config sets - so there is no .get() to unwrap.
const stored = async (id) => await server.tests.findByPk(id);

/**
 * create() used to take eleven positional parameters, and its caller in
 * tasks/speedtest.js already had to pass a filler `null` for `error` just to
 * reach `jitter` behind it. Every further column widened a signature where the
 * only thing keeping a measurement in the right column was argument order, and
 * nothing in the suite pinned that order.
 *
 * Naming the fields is what makes the next column safe to add, so these assert
 * on the mapping itself rather than on any one caller.
 */
describe("recording a speedtest", () => {
    it("puts every named field in its own column", async () => {
        const id = await controller.create({
            ping: 4, jitter: 0.26, download: 2366.32, upload: 2202.56, time: 20,
            serverId: 49631, type: "auto", resultId: "c63aac06", error: null,
            serverName: "Arcade Solutions AG", serverHost: "speedtest.arcade.ch"
        });

        const row = await stored(id);

        assert.equal(row.ping, 4);
        assert.equal(row.jitter, 0.26);
        assert.equal(row.download, 2366.32);
        assert.equal(row.upload, 2202.56);
        assert.equal(row.time, 20);
        assert.equal(row.serverId, 49631);
        assert.equal(row.type, "auto");
        assert.equal(row.resultId, "c63aac06");
        assert.equal(row.serverName, "Arcade Solutions AG");
        assert.equal(row.serverHost, "speedtest.arcade.ch");
        assert.equal(row.error, null);
    });

    // The two string columns sit next to each other and hold values of the same
    // shape, so a transposition here is invisible in every other assertion.
    it("does not confuse the server's name with its host", async () => {
        const id = await controller.create({
            ping: 4, download: 100, upload: 50, time: 20, serverId: 1,
            serverName: "Arcade Solutions AG", serverHost: "speedtest.arcade.ch"
        });

        const row = await stored(id);

        assert.equal(row.serverName, "Arcade Solutions AG");
        assert.equal(row.serverHost, "speedtest.arcade.ch");
    });

    it("defaults everything the caller left out", async () => {
        const id = await controller.create({ping: 4, download: 100, upload: 50, time: 20, serverId: 0});

        const row = await stored(id);

        assert.equal(row.type, "auto");
        assert.equal(row.jitter, null);
        assert.equal(row.error, null);
        assert.equal(row.resultId, null);
        assert.equal(row.serverName, null);
        assert.equal(row.serverHost, null);
    });

    it("stamps the row with the time it was recorded", async () => {
        const before = new Date().toISOString();
        const id = await controller.create({ping: 4, download: 100, upload: 50, time: 20, serverId: 0});

        assert.ok((await stored(id)).created >= before);
    });

    it("returns the id of the row it wrote", async () => {
        const id = await controller.create({ping: 4, download: 100, upload: 50, time: 20, serverId: 0});

        assert.equal(typeof id, "number");
        assert.notEqual(await stored(id), null);
    });

    /**
     * A failure is stored as -1 placeholders plus the reason. The error must
     * survive as a string: storing undefined writes NULL, which marks the row as
     * successful and lets the placeholders poison every average built on it.
     */
    it("records a failure with its reason", async () => {
        const id = await controller.create({
            ping: -1, download: -1, upload: -1, time: null, serverId: 0,
            type: "auto", error: "Cannot open socket"
        });

        const row = await stored(id);

        assert.equal(row.error, "Cannot open socket");
        assert.equal(row.download, -1);
    });
});
