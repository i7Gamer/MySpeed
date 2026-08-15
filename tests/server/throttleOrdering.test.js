import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The failed-attempt counter is charged before the comparison, everywhere.
 *
 * Read at the top of a request and written only once bcrypt had finished, the
 * limit bounded turns rather than attempts: bcrypt.compare yields the event
 * loop in chunks - which is the whole reason the async one is used - so a batch
 * of requests arriving together all read the count before any of them raised
 * it, all passed the limit, and all ran their comparisons. Twenty guesses a
 * minute became as many as the outer rate limiter would carry, at the matching
 * cost in bcrypt work, which is the thing the throttle exists to bound.
 *
 * Three entry points share the one counter, so all three have to hold the
 * ordering: the password middleware, the session exchange, and the Prometheus
 * scrape's Basic auth. That the middleware holds it is proved behaviourally in
 * tests/integration/passwordThrottle.test.js, where the calls are driven
 * straight at it so they genuinely overlap. The other two authenticate inside a
 * route handler that is not exported on its own, and over HTTP the requests do
 * not actually overlap - undici holds a small per-origin pool, so a batch is
 * largely serialised and the assertion would pass either way. This reads the
 * source instead, which is a weaker check but an honest one, rather than a
 * behavioural test that cannot fail.
 */
const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const CALLERS = [
    {
        file: "server/middlewares/password.js",
        charges: /recordFailure\(key/,
        compares: /await bcrypt\.compare/
    },
    {
        file: "server/routes/session.js",
        charges: /recordFailedAttempt\(req\)/,
        compares: /await bcrypt\.compare|matchesSetupToken\(/
    },
    {
        file: "server/routes/prometheus.js",
        charges: /recordFailedAttempt\(req\)/,
        compares: /await bcrypt\.compare|matchesSetupToken\(/
    }
];

describe("a guess is counted before it is checked", () => {
    for (const {file, charges, compares} of CALLERS) {
        const source = read(file);

        it(`${path.basename(file)} charges the attempt`, () => {
            assert.match(source, charges, `${file} no longer records a failed attempt at all`);
        });

        it(`${path.basename(file)} charges it before the comparison it pays for`, () => {
            const charged = source.search(charges);
            const compared = source.search(compares);

            assert.notEqual(compared, -1, `${file} no longer compares anything`);
            assert.ok(charged < compared,
                `${file} records the failure after the comparison, so simultaneous guesses all read the count`
                + " before any of them raises it and the limit bounds only sequential attempts");
        });

        // Charging up front is only fair if a caller who gets it right is
        // refunded - otherwise an operator who mistypes once is one attempt
        // poorer for the rest of the window.
        it(`${path.basename(file)} refunds the caller who gets it right`, () => {
            assert.match(source, /failedAttempts\.delete\(key\)|clearFailedAttempts\(req\)/,
                `${file} charges for an attempt it never gives back`);
        });
    }
});
