import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, seedTests } from "./helpers/boot.js";

let server;

before(async () => {
    server = await bootServer();
    await seedTests(server.tests, [
        {created: "2025-10-16T22:30:00.000Z"},
        {created: "2026-01-15T12:00:00.000Z"}
    ]);
});

after(async () => {
    await server?.close();
});

const statistics = (query) => api(server.baseUrl, `/speedtests/statistics?${query}`);

const RANGE = "from=2025-10-17&to=2026-01-15";

/**
 * The clock a request is answered on.
 *
 * `tz` is the accurate one: a bare offset is a snapshot of today, and a range
 * routinely reaches back across a daylight saving change, which anchors the far
 * end an hour off its real local midnight. `tzOffset` is still accepted, because
 * a parent proxies these requests to nodes that may only understand it.
 */
describe("the timezone parameters", () => {
    it("anchors the range at each end's own offset", async () => {
        const {status, body} = await statistics(`${RANGE}&tz=Europe/Berlin`);

        assert.equal(status, 200);
        // 17 October is summer time in Berlin (UTC+2), 15 January is not (UTC+1).
        assert.equal(body.dateRange.from, "2025-10-16T22:00:00.000Z");
        assert.equal(body.dateRange.to, "2026-01-15T22:59:59.999Z");
    });

    it("takes the hour a snapshot offset would have dropped", async () => {
        const named = await statistics(`${RANGE}&tz=Europe/Berlin`);
        const snapshot = await statistics(`${RANGE}&tzOffset=-60`);

        assert.equal(named.body.tests.total, 2);
        assert.equal(snapshot.body.tests.total, 1,
            "the fixture exists to be missed by the snapshot offset");
    });

    it("prefers the zone when both are sent", async () => {
        const {body} = await statistics(`${RANGE}&tz=Europe/Berlin&tzOffset=0`);

        assert.equal(body.dateRange.from, "2025-10-16T22:00:00.000Z");
    });

    it("still honours a bare offset from an older client", async () => {
        const {status, body} = await statistics(`${RANGE}&tzOffset=0`);

        assert.equal(status, 200);
        assert.equal(body.dateRange.from, "2025-10-17T00:00:00.000Z");
    });

    it("refuses a zone name it does not know", async () => {
        const {status} = await statistics(`${RANGE}&tz=Middle/Earth`);

        assert.equal(status, 400);
    });

    describe("the same answer on the all-time path", () => {
        /**
         * The offset bound lived inside parseDateRange, which `range=all`
         * skips - so the same parameter was refused with a 400 on one path,
         * silently accepted on the other, and crashed the request with a 500
         * when it was large enough to push the Date out of range.
         */
        it("refuses an offset no place on earth has", async () => {
            for (const query of [`${RANGE}&tzOffset=5000`, `range=all&tzOffset=5000`,
                `range=all&tzOffset=99999999999999`])
                assert.equal((await statistics(query)).status, 400, `${query} was not refused`);
        });

        it("refuses an unknown zone name", async () => {
            assert.equal((await statistics("range=all&tz=Middle/Earth")).status, 400);
        });

        it("accepts a real one", async () => {
            assert.equal((await statistics("range=all&tz=Europe/Berlin")).status, 200);
        });
    });

    describe("the other endpoints that take a range", () => {
        it("bounds the list by the zone", async () => {
            const {status, body} = await api(server.baseUrl,
                `/speedtests?${RANGE}&tz=Europe/Berlin&limit=30`);

            assert.equal(status, 200);
            assert.equal(body.length, 2);
        });

        it("bounds the export by the zone", async () => {
            const {status, body} = await api(server.baseUrl,
                `/speedtests/export?${RANGE}&tz=Europe/Berlin&format=json`);

            assert.equal(status, 200);
            assert.equal(body.length, 2);
        });

        it("refuses an unknown zone on both", async () => {
            assert.equal((await api(server.baseUrl, `/speedtests?${RANGE}&tz=Middle/Earth`)).status, 400);
            assert.equal((await api(server.baseUrl,
                `/speedtests/export?${RANGE}&tz=Middle/Earth&format=json`)).status, 400);
        });
    });
});
