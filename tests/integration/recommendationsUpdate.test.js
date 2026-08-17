import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer } from "./helpers/boot.js";

let server;
let controller;
let model;

before(async () => {
    server = await bootServer();
    controller = await import("../../server/controller/recommendations.js");
    ({default: model} = await import("../../server/models/Recommendations.js"));
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    await model.destroy({where: {}});
});

/**
 * The recommendations the overview grades against, learned from the fastest
 * tests in the newest sample.
 *
 * Nothing here was covered: the route only reads them, and the writer is
 * reached from the tail of a speedtest.
 */
describe("updating the recommendations", () => {
    it("stores the first set it is given", async () => {
        await controller.update(12.4, 512.345, 98.765);

        const stored = await controller.getCurrent();

        // All three to two decimals. The ping used to be rounded to a whole
        // millisecond, by an INTEGER column and a Math.round to match - which
        // is most of the reading on a fast line, and took anything under half a
        // millisecond to 0.
        assert.equal(stored.ping, 12.4);
        assert.equal(stored.download, 512.35);
        assert.equal(stored.upload, 98.77);
    });

    /**
     * The damaging case, end to end. 0 reads as the best latency ever measured
     * on the line, and createRecommendations only ever replaces the stored
     * figure with something lower - so no later test could beat it and the
     * recommendation stayed wrong for the life of the database.
     */
    it("keeps a sub-millisecond ping rather than storing nothing", async () => {
        await controller.update(0.3, 940, 880);

        assert.equal((await controller.getCurrent()).ping, 0.3);
    });

    /**
     * Migration 0012 deliberately skips sqlite, on the grounds that its INTEGER
     * affinity is numeric rather than integral and stores a fractional value as
     * REAL whatever the column says. This suite runs on sqlite, so it is where
     * that claim is actually checked - the column here was never altered.
     */
    it("round-trips a fraction through sqlite, whose column was left alone", async () => {
        await controller.update(1.25, 100, 50);

        assert.equal((await controller.getCurrent()).ping, 1.25,
            "sqlite truncated the latency, so migration 0012 cannot skip it after all");
    });

    // One row, replaced. A second row would leave getCurrent answering with
    // whichever findOne happened to return.
    it("replaces the set rather than adding another", async () => {
        await controller.update(12, 500, 100);
        await controller.update(8, 900, 200);

        assert.equal(await model.count(), 1);
        assert.equal((await controller.getCurrent()).download, 900);
    });

    it("hands back the row it wrote", async () => {
        const created = await controller.update(12, 500, 100);
        assert.equal(created.download, 500);

        const replaced = await controller.update(8, 900, 200);
        assert.equal(replaced.download, 900, "the update answers with the row as it was before the write");
    });

    /**
     * The write happens before the announcement, which it did not.
     *
     * triggerEvent used to be called above the write, so a database that then
     * refused it had already told every configured webhook that the
     * recommendations had changed - and told them the figures it was about to
     * fail to store. A notification is not retractable.
     */
    it("does not announce a set it failed to store", async () => {
        const create = model.create;
        model.create = async () => {
            throw new Error("database is locked");
        };

        try {
            await assert.rejects(controller.update(12, 500, 100), /database is locked/);
        } finally {
            model.create = create;
        }

        assert.equal(await model.count(), 0, "a set that could not be stored is on record anyway");
    });
});
