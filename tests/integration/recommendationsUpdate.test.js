import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, seedTarget, seedTests } from "./helpers/boot.js";

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

    /**
     * And if two rows ever exist - importConfig restores this table wholesale
     * and bounds it only by a row cap, so a backup can carry more than one -
     * every read names the same one. An unordered findOne is free to return
     * either, so getCurrent could answer one row while update() wrote the
     * other, and the recommendation the card shows and the one the round
     * refreshes would drift apart.
     */
    it("reads the same row every time when the table holds more than one", async () => {
        await model.create({ping: 5, download: 111, upload: 11});
        await model.create({ping: 6, download: 222, upload: 22});

        const first = await controller.getCurrent();
        const second = await controller.getCurrent();
        assert.equal(first.id, second.id, "getCurrent answers with whichever row the driver felt like");

        const written = await controller.update(9, 333, 33);
        assert.equal(written.id, first.id, "update wrote a different row than getCurrent reads");
        assert.equal((await controller.getCurrent()).download, 333);
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
    /**
     * The writer is reached once per round member, and two members finishing
     * close together both read an empty table before either wrote. The row is
     * a singleton by intent and the reader copes with a stray - but a first
     * round with two targets should not leave one behind.
     */
    it("stores one row when two updates arrive together", async () => {
        await Promise.all([controller.update(10, 100, 50), controller.update(9, 200, 60)]);

        assert.equal(await model.count(), 1, "concurrent first writes each created a row");

        const stored = await controller.getCurrent();
        assert.equal(stored.download, 200, "the later update lost to the earlier one");
    });

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

/**
 * Which target createRecommendations samples.
 *
 * It prefers the first scheduled target that takes part in alerting - a
 * diagnostic box may lead the round with alerts off, and recommendations must
 * describe a line someone watches. But "prefers" must not mean "or nothing":
 * an instance whose targets all have alerts off - or all run by hand - used to
 * return before sampling anything, so the recommendation card sat frozen at
 * whatever the line looked like before the flags changed, for the life of the
 * database.
 */
describe("the target the sample describes", () => {
    let task;
    let targets;

    before(async () => {
        task = await import("../../server/tasks/speedtest.js");
        targets = await import("../../server/controller/targets.js");
    });

    after(async () => {
        await targets.removeAll();
        await seedTests(server.tests, []);
    });

    const MS_PER_HOUR = 3600000;

    const sampleRows = (targetId, download = 100) =>
        Array.from({length: task.RECOMMENDATION_SAMPLE}, (unused, index) => ({
            created: new Date(Date.now() - (index + 1) * MS_PER_HOUR).toISOString(),
            targetId, download
        }));

    it("prefers the alerting target over a faster one leading the round", async () => {
        const lan = await seedTarget({name: "lan", alerts: false});
        const wan = await targets.create({name: "wan", provider: "ookla"});

        await seedTests(server.tests, [...sampleRows(lan.id, 940), ...sampleRows(wan.id, 100)]);

        await task.createRecommendations();

        assert.equal((await controller.getCurrent()).download, 100,
            "the sample mixed in a line nobody is alerted about");
    });

    /**
     * A watched line that runs by hand still describes a line somebody
     * watches; the scheduled box beside it with alerts switched off does not.
     * Reaching for the round's leader first recommended the LAN box's gigabit
     * figures on an instance whose watched line is a WAN - the very mixture
     * the sampling rule exists to prevent, arrived at by its own fallback.
     */
    it("prefers a watched line that runs by hand over an unwatched scheduled one", async () => {
        const lan = await seedTarget({name: "lan", alerts: false});
        const wan = await targets.create({name: "wan", provider: "ookla", enabled: false});

        await seedTests(server.tests, [...sampleRows(lan.id, 940), ...sampleRows(wan.id, 100)]);

        await task.createRecommendations();

        assert.equal((await controller.getCurrent()).download, 100,
            "the sample described the line nobody asked to be told about");
    });

    /**
     * "Prefers" still must not mean "or nothing".
     *
     * A watched line that runs by hand leads the preference, and a hand-run line
     * may never reach a full sample - nobody is running it hourly. Sampling the
     * preferred line and giving up when it has too few tests left the card
     * frozen at whatever it held before, for the life of the database, while a
     * scheduled line beside it measured every hour. So the preference is walked
     * rather than resolved: the first line that can actually describe itself
     * wins, in the order the instance ranks them.
     */
    it("samples the line behind it when the preferred one has too few tests", async () => {
        const watched = await seedTarget({name: "watched", enabled: false});
        const scheduled = await targets.create({name: "scheduled", provider: "ookla", alerts: false});

        const TOO_FEW = 3;

        await seedTests(server.tests, [
            ...sampleRows(watched.id, 940).slice(0, TOO_FEW),
            ...sampleRows(scheduled.id, 100)
        ]);

        await task.createRecommendations();

        const stored = await controller.getCurrent();
        assert.ok(stored, "the card stayed frozen while a scheduled line measured every hour");
        assert.equal(stored.download, 100);
    });

    it("falls back to the round's first member when no target alerts", async () => {
        const quiet = await seedTarget({name: "quiet", alerts: false});
        await seedTests(server.tests, sampleRows(quiet.id));

        await task.createRecommendations();

        const stored = await controller.getCurrent();
        assert.ok(stored, "no target alerts, so the recommendations never learn anything again");
        assert.equal(stored.download, 100);
    });

    it("falls back to the first target on record when none is scheduled", async () => {
        const manual = await seedTarget({name: "manual", alerts: false, enabled: false});
        await seedTests(server.tests, sampleRows(manual.id));

        await task.createRecommendations();

        assert.ok(await controller.getCurrent(),
            "an instance run entirely by hand never updates its recommendations");
    });
});
