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
        const {id} = await controller.create({
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
        const {id} = await controller.create({
            ping: 4, download: 100, upload: 50, time: 20, serverId: 1,
            serverName: "Arcade Solutions AG", serverHost: "speedtest.arcade.ch"
        });

        const row = await stored(id);

        assert.equal(row.serverName, "Arcade Solutions AG");
        assert.equal(row.serverHost, "speedtest.arcade.ch");
    });

    it("stores the packet loss and the latency measured under load", async () => {
        const {id} = await controller.create({
            ping: 4, download: 2366.32, upload: 2202.56, time: 20, serverId: 1,
            packetLoss: 0, downloadLatency: 7.5, uploadLatency: 43.77
        });

        const row = await stored(id);

        // A packet loss of zero is a measurement, not a missing value.
        assert.equal(row.packetLoss, 0);
        assert.equal(row.downloadLatency, 7.5);
        assert.equal(row.uploadLatency, 43.77);
    });

    it("leaves the quality figures absent for a provider that cannot measure them", async () => {
        const {id} = await controller.create({ping: 4, download: 100, upload: 50, time: 20, serverId: 0});

        const row = await stored(id);

        assert.equal(row.packetLoss, null);
        assert.equal(row.downloadLatency, null);
        assert.equal(row.uploadLatency, null);
    });

    it("does not confuse the two directions' loaded latency", async () => {
        const {id} = await controller.create({
            ping: 4, download: 100, upload: 50, time: 20, serverId: 0,
            downloadLatency: 7.5, uploadLatency: 43.77
        });

        const row = await stored(id);

        assert.equal(row.downloadLatency, 7.5);
        assert.equal(row.uploadLatency, 43.77);
    });

    it("defaults everything the caller left out", async () => {
        const {id} = await controller.create({ping: 4, download: 100, upload: 50, time: 20, serverId: 0});

        const row = await stored(id);

        assert.equal(row.type, "auto");
        assert.equal(row.jitter, null);
        assert.equal(row.error, null);
        assert.equal(row.resultId, null);
        assert.equal(row.serverName, null);
        assert.equal(row.serverHost, null);
        assert.equal(row.provider, null);
        assert.equal(row.bytesDownloaded, null);
        assert.equal(row.bytesUploaded, null);
    });

    /**
     * Which provider measured the row, and what the run cost in traffic. The
     * first is what tells a reader that the packet loss below is absent because
     * the provider never measures it, rather than because the line lost nothing.
     */
    it("records the provider and the data the run transferred", async () => {
        const {id} = await controller.create({
            ping: 4, download: 100, upload: 50, time: 20, serverId: 0,
            provider: "cloudflare", bytesDownloaded: 1135809960, bytesUploaded: 917831105
        });

        const row = await stored(id);

        assert.equal(row.provider, "cloudflare");
        assert.equal(row.bytesDownloaded, 1135809960);
        assert.equal(row.bytesUploaded, 917831105);
    });

    // The counts run past what a 32-bit column holds: one Ookla test moves over
    // a gigabyte in each direction, and a truncated count is worse than none.
    it("keeps a byte count larger than a 32-bit integer", async () => {
        const huge = 9_007_199_254_740_991;
        const {id} = await controller.create({
            ping: 4, download: 100, upload: 50, time: 20, serverId: 0, bytesDownloaded: huge
        });

        assert.equal((await stored(id)).bytesDownloaded, huge);
    });

    it("stamps the row with the time it was recorded", async () => {
        const before = new Date().toISOString();
        const {id} = await controller.create({ping: 4, download: 100, upload: 50, time: 20, serverId: 0});

        assert.ok((await stored(id)).created >= before);
    });

    it("returns the id of the row it wrote", async () => {
        const {id} = await controller.create({ping: 4, download: 100, upload: 50, time: 20, serverId: 0});

        assert.equal(typeof id, "number");
        assert.notEqual(await stored(id), null);
    });

    /**
     * The timestamp comes back out with the id so the integrations can be told
     * when the test was recorded. Read off the same value the row was written
     * with rather than stamped again by the caller, so the notification names
     * the instant the record carries rather than one a moment later.
     */
    it("returns the timestamp it wrote, matching the row", async () => {
        const {id, created} = await controller.create({ping: 4, download: 100, upload: 50, time: 20, serverId: 0});

        assert.equal(typeof created, "string");
        assert.equal(new Date((await stored(id)).created).toISOString(), new Date(created).toISOString());
    });

    /**
     * A failure is stored as -1 placeholders plus the reason. The error must
     * survive as a string: storing undefined writes NULL, which marks the row as
     * successful and lets the placeholders poison every average built on it.
     */
    it("records a failure with its reason", async () => {
        const {id} = await controller.create({
            ping: -1, download: -1, upload: -1, time: null, serverId: 0,
            type: "auto", error: "Cannot open socket"
        });

        const row = await stored(id);

        assert.equal(row.error, "Cannot open socket");
        assert.equal(row.download, -1);
    });
});
