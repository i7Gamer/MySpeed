import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Nothing is announced before it has happened.
 *
 * updateValue fired the `configUpdated` integration event and destroyed every
 * session *ahead* of the write they describe, and did not await the event. A
 * write the database refuses - a locked sqlite file, a MySQL connection that
 * dropped between the read and the write - had therefore already told every
 * subscribed webhook that the value changed, and for a password change had
 * already logged the operator out of an instance whose password was never
 * altered. The caller then gets a 500 for an operation whose side effects have
 * all happened.
 *
 * This is the ordering commit d499ad30 fixed in controller/recommendations.js.
 * It was left standing here, which is the argument for a test rather than a
 * second careful reading.
 */
const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const bodyOf = (source, name) => {
    const start = source.indexOf(`export const ${name}`);
    assert.notEqual(start, -1, `${name} is no longer exported`);

    const from = source.indexOf("{", source.indexOf("=>", start));
    let depth = 0;

    for (let index = from; index < source.length; index++) {
        if (source[index] === "{") depth++;
        else if (source[index] === "}" && --depth === 0) return source.slice(from, index + 1);
    }

    assert.fail(`${name} is never closed`);
};

describe("updateValue", () => {
    const body = bodyOf(read("server/controller/config.js"), "updateValue");

    const at = (pattern, what) => {
        const index = body.search(pattern);
        assert.notEqual(index, -1, `updateValue no longer ${what}`);
        return index;
    };

    it("writes before it tells the integrations", () => {
        assert.ok(at(/config\.update\(/, "writes the value") < at(/triggerEvent\(/, "announces the change"),
            "a refused write has already told every webhook the value changed");
    });

    it("writes before it revokes the sessions", () => {
        assert.ok(at(/config\.update\(/, "writes the value") < at(/destroyAllSessions\(/, "revokes sessions"),
            "a refused password change has already logged the operator out");
    });

    // Floating it meant a rejection from a subscriber had no handler at all and
    // escaped to the process-level hook.
    it("does not float the announcement", () => {
        assert.doesNotMatch(body, /triggerEvent\([^;]*\)\s*\n?\s*\.then\(undefined\)/,
            "the event is dispatched with its rejection thrown away");
    });
});

/**
 * And the controller that ordering came from, which floated its own.
 *
 * recommendations.update builds the announcement as
 * `() => triggerEvent(...).then(() => {})` and calls it without a handler. A
 * `then` with no second argument handles nothing: the promise it returns
 * carries the rejection on, and nothing is holding it. triggerEvent reads the
 * integration rows from the database before it dispatches, and that read is not
 * inside its per-module try - so a locked sqlite file or a dropped MySQL
 * connection rejects, and the rejection reaches the process-level
 * unhandledRejection hook, which logs it as a bare server fault naming nothing.
 *
 * The same hazard config.js:updateValue was fixed for, in the file whose
 * comments the fix there cites. It runs on the tail of a finished speedtest,
 * which is when a database under pressure is most likely to refuse.
 */
describe("recommendations.update", () => {
    const source = read("server/controller/recommendations.js");
    const announce = source.slice(source.indexOf("const announce"), source.indexOf("if (existing)"));

    it("still announces the change", () => {
        assert.match(announce, /triggerEvent\("recommendationsUpdated"/,
            "nothing tells the integrations the recommendations moved");
    });

    it("catches a dispatch that fails rather than floating it", () => {
        assert.match(announce, /\.catch\(/,
            "a failing dispatch escapes to the process-level hook as an unnamed server fault");
        assert.doesNotMatch(announce, /\.then\(\(\)\s*=>\s*\{\}\)\s*;?\s*$/,
            "the rejection is still passed on by a then that handles nothing");
    });

    it("says which announcement failed, as config.js does", () => {
        assert.match(announce, /console\.error\(/,
            "the failure is swallowed silently, which is worse than the bare hook it replaced");
        assert.match(announce, /recommendation/i,
            "the logged line does not say what could not be announced");
    });
});
