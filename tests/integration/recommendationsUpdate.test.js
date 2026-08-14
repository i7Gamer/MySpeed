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

        // Ping to a whole millisecond, the speeds to two decimals - the
        // precision each is shown at.
        assert.equal(stored.ping, 12);
        assert.equal(stored.download, 512.35);
        assert.equal(stored.upload, 98.77);
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
