import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootServer, seedTests } from "./helpers/boot.js";
import { listStatistics } from "../../server/controller/speedtests.js";
import { runDigest } from "../../server/tasks/digestReport.js";
import { digestRanges } from "../../server/util/digestReport.js";
import { zoneFromName } from "../../server/util/timezone.js";

/**
 * The weekly digest's "vs previous week" line, driven through the REAL
 * aggregate rather than a stub of it.
 *
 * This is the gap a stub left open. digestTask.test.js hands `runDigest` an
 * `aggregate` that records its options and returns a summary already carrying
 * `previous`, then asserts the option was named `comparePrevious` - so when the
 * controller's option was renamed to `compare`, the digest went on asking for a
 * comparison nobody was listening for, the summary came back without
 * `previous`, the line vanished from every weekly digest, and both suites
 * stayed green. A stub that answers the question it was asked cannot notice
 * that nothing else would have.
 *
 * So the contract is pinned here against the function that actually implements
 * it, twice over: what turns the comparison on, and that the digest asks for it
 * by that name.
 */
describe("the weekly digest's comparison", () => {
    let server;

    before(async () => { server = await bootServer(); });
    after(async () => { await server?.close(); });

    const NOW = new Date("2026-08-31T09:00:00.000Z");
    const ZONE_NAME = "Europe/Berlin";
    // The resolved zone object listStatistics wants - a bare name has no
    // offsetAt, which is what runDigest resolves for itself before aggregating.
    const ZONE = zoneFromName(ZONE_NAME);

    it("is turned on by the option name the controller reads", async () => {
        const {range} = digestRanges("weekly", NOW, ZONE);

        const asked = await listStatistics(range, {zone: ZONE, now: NOW, compare: true});
        assert.ok(Object.hasOwn(asked, "previous"),
            "the controller no longer answers a comparison for `compare`, so nothing the "
            + "digest can send will produce one");
    });

    /**
     * And the name it replaced buys nothing. Stated so the pair reads as a
     * contract rather than as one lucky assertion: an option the controller
     * ignores is exactly what the rename left behind, and it fails silently.
     */
    it("is not turned on by the name that was renamed away", async () => {
        const {range} = digestRanges("weekly", NOW, ZONE);

        const stale = await listStatistics(range, {zone: ZONE, now: NOW, comparePrevious: true});
        assert.equal(Object.hasOwn(stale, "previous"), false,
            "`comparePrevious` answers a comparison again - if it is back, the digest and the "
            + "route have two spellings for one question and only one of them is tested");
    });

    /**
     * The whole path, with nothing stubbed but the opt-in list and the sink:
     * seeded rows in both windows, the real aggregate, and the sentence a
     * reader would have missed.
     */
    it("names the previous week in the text it sends", async () => {
        const {range, compare} = digestRanges("weekly", NOW, ZONE);

        /*
         * A row in each window, so both have something to say and the sentence
         * between them has two figures to compare.
         *
         * The weekly kind carries no second window to seed - `compare` is null
         * for it, because seven days back IS the previous period and the
         * controller walks there itself. So the earlier row is placed by
         * stepping the range back its own length, which is the window
         * previousRange builds.
         */
        assert.equal(compare, null, "the weekly kind grew a second window; seed it too");

        const midway = (from, to) => new Date((from.getTime() + to.getTime()) / 2).toISOString();
        const week = range.to.getTime() - range.from.getTime();
        const earlier = (instant) => new Date(instant.getTime() - week);

        await seedTests(server.tests, [
            {created: midway(range.from, range.to), download: 200, upload: 100, ping: 10},
            {created: midway(earlier(range.from), earlier(range.to)),
                download: 100, upload: 100, ping: 10}
        ]);

        const payload = await runDigest("weekly", {
            now: NOW,
            timezone: ZONE_NAME,
            active: async () => [{data: {digest_weekly: true}}],
            aggregate: listStatistics,
            notify: async () => {}
        });

        assert.notEqual(payload, null, "the digest produced nothing for an instance that opted in");
        assert.match(payload.text, /previous week/i,
            "the digest lost the comparison line it exists to carry");
    });
});
