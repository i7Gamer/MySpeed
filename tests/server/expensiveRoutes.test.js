import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

const appSource = readSource("server/app.js");

/**
 * Comments removed before a source is scanned for a call.
 *
 * storage.js explains in prose that two of its routes "answer with
 * tests.listAll() untouched", so a scan for that call finds it in the sentence
 * describing it and credits it to whichever route the sentence happens to sit
 * above - which is what the completeness check below reported first time round.
 *
 * Block comments go whole; a line comment only where the line is nothing else,
 * so a `//` inside a string is left alone. Enough for the one file read through
 * it, and deliberately not a lexer: telling a regex from a division needs a
 * parser, which is not a dependency worth taking on for an assertion.
 */
const withoutComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

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
 *   /api/storage/tests/history
 *                           the export's unbounded sibling. /json and /csv
 *                           under here answer with tests.listAll(), a findAll
 *                           with no limit at all, and hand the whole result to
 *                           res.send - at 200 000 rows, 2.0 s to read and 0.5 s
 *                           to serialise into a 122 MiB string. So the two that
 *                           read *every* row sat behind the 300/min backstop
 *                           while /export, which reads a date range, sat behind
 *                           20. The prefix rather than the two leaves: the PUT
 *                           that restores a history and the DELETE that empties
 *                           it are the other expensive things on this path.
 *
 * The page loads statistics on demand rather than on a poll, so the expensive
 * limit is not something ordinary use can reach.
 */
const EXPENSIVE_PATHS = [
    "/api/opengraph",
    "/api/speedtests/export",
    "/api/speedtests/run",
    "/api/speedtests/statistics",
    "/api/storage/tests/history"
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
     * And each limiter is registered before the router that answers the path.
     *
     * Express runs middleware in the order it was mounted and a router that
     * handles the request ends the chain, so a limiter mounted after one never
     * runs at all - it would sit in this file looking correct and metering
     * nothing. Every entry above happens to be in the same block today; this is
     * what keeps the next one there.
     */
    it("registers each limit before the router that serves the path", () => {
        const routers = [...appSource.matchAll(/app\.use\(\s*["'`](\/api[^"'`]*)["'`]\s*,\s*\w+Routes\)/g)];

        assert.notEqual(routers.length, 0, "no routers are mounted the way this expects");

        for (const path of EXPENSIVE_PATHS) {
            const limiter = appSource.search(
                new RegExp(`app\\.use\\(\\s*["'\`]${path}["'\`]\\s*,\\s*(?:expensiveLimit\\(\\)|limited\\()`));
            const router = routers.find((match) => path.startsWith(match[1]));

            assert.notEqual(limiter, -1, `${path} has no limit to order`);
            assert.notEqual(router, undefined, `nothing serves ${path}, so this entry is stale`);
            assert.ok(limiter < router.index,
                `${path} is limited after ${router[1]} is mounted, so the limiter never runs`);
        }
    });

    /**
     * And the list is complete for the shape that keeps recurring: a route that
     * serialises the entire table in one response.
     *
     * Both entries above that read everything were found by asking which
     * handlers reach for a findAll with no limit, rather than by remembering to
     * write them down. Asked here so the next one has to answer too - the list
     * is a record of decisions, and this is the check that no decision was
     * skipped.
     */
    it("covers every route that serialises a whole table", () => {
        const storage = withoutComments(readSource("server/routes/storage.js"));
        const declarations = [...storage.matchAll(/app\.(?:get|put|post|delete|all)\("([^"]*)"/g)];

        const unbounded = declarations
            .filter((declaration, index) => storage
                .slice(declaration.index, declarations[index + 1]?.index ?? storage.length)
                .includes("tests.listAll()"))
            .map((declaration) => `/api/storage${declaration[1]}`);

        assert.deepEqual(unbounded.sort(),
            ["/api/storage/tests/history/csv", "/api/storage/tests/history/json"],
            "a storage route reads the whole table that this file has not been told about");

        for (const route of unbounded)
            assert.ok(EXPENSIVE_PATHS.some((path) => route.startsWith(path)),
                `${route} reads every row there is on the general 300/min backstop, `
                + "while /api/speedtests/export reads a date range on 20");
    });

    /**
     * Every limit has to be resettable, or adding one silently turns each test
     * of that route into a test of the limiter - which is what happened when
     * statistics was first given one: nineteen aggregation assertions started
     * failing on 429, and again when the history download was given one: twelve
     * import assertions did.
     */
    it("can be put back as it was, so a suite is not measuring it", () => {
        assert.match(appSource, /export const resetRateLimits/);
        assert.doesNotMatch(appSource, /app\.use\([^)]*createRateLimit\(/,
            "a limiter built outside `limited` is one resetRateLimits cannot reach");
    });
});
