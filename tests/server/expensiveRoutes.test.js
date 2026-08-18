import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

const appSource = readSource("server/app.js");

/**
 * The reads that cost the server more than a request should.
 *
 * The general /api limiter is a backstop against a stranger monopolising the
 * instance - its own comment says so - and it admits 300 a minute, which is the
 * right number for a dashboard poll and much too many for any of these. Each one
 * below walks the database or spends real CPU per call:
 *
 *   /api/opengraph          a query, a satori layout pass and a resvg raster
 *   /api/speedtests/export  can walk a year of rows and serialise all of them
 *   /api/speedtests/run     starts a speedtest
 *   /api/speedtests/statistics
 *                           reads *every* row in the range and aggregates it.
 *                           `all` has no upper bound at all - findEvery carries
 *                           no limit - so a year of five-minute tests is
 *                           ~105 000 rows materialised per request, and the
 *                           statistics module's own note puts that near 128 MB.
 *                           It sat behind the 300/min backstop alone while
 *                           /export, which reads the same rows and answers the
 *                           same page, sat behind 20 - and on a demo, where the
 *                           password middleware admits everyone, it is reachable
 *                           without a credential.
 *
 * The page loads statistics on demand rather than on a poll, so the expensive
 * limit is not something ordinary use can reach.
 */
const EXPENSIVE_PATHS = [
    "/api/opengraph",
    "/api/speedtests/export",
    "/api/speedtests/run",
    "/api/speedtests/statistics"
];

// Any limiter of its own, whatever the number: what matters is that the path is
// not left on the general backstop. Statistics deliberately carries a looser one
// than the other three - it answers an interactive page rather than a download,
// so being told to slow down for using it would cost more than the load it saved.
const mountedWith = (path) =>
    new RegExp(`app\\.use\\(\\s*["'\`]${path}["'\`]\\s*,\\s*(expensiveLimit\\(\\)|limited\\()`).test(appSource);

describe("the expensive read limiter", () => {
    for (const path of EXPENSIVE_PATHS) {
        it(`covers ${path}`, () => {
            assert.ok(mountedWith(path),
                `${path} is metered by the general 300/min backstop alone`);
        });
    }

    // The mounts and the list have to stay in step in both directions: a path
    // given a limit of its own without being written down here is a decision
    // nobody recorded, and the next person to read this file would not find it.
    it("has an entry for every path that is given one", () => {
        const mounted = [...appSource.matchAll(
            /app\.use\(\s*["'`]([^"'`]+)["'`]\s*,\s*(?:expensiveLimit\(\)|limited\()/g)]
            .map((match) => match[1])
            // The general backstop, which is the thing these are narrower than.
            .filter((path) => path !== "/api");

        assert.deepEqual(mounted.filter((path) => !EXPENSIVE_PATHS.includes(path)),
            ["/api/prometheus"],
            "a path was given its own limit without being written down here");
    });

    /**
     * Every limit has to be resettable, or adding one silently turns each test
     * of that route into a test of the limiter - which is what happened when
     * statistics was first given one: nineteen aggregation assertions started
     * failing on 429.
     */
    it("can be put back as it was, so a suite is not measuring it", () => {
        assert.match(appSource, /export const resetRateLimits/);
        assert.doesNotMatch(appSource, /app\.use\([^)]*createRateLimit\(/,
            "a limiter built outside `limited` is one resetRateLimits cannot reach");
    });
});
