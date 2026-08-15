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
