import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import setupDiscord from "../../server/integrations/discord.js";
import setupPushover from "../../server/integrations/pushover.js";

const INTEGRATIONS_DIR = path.resolve(fileURLToPath(import.meta.url),
    "..", "..", "..", "server", "integrations");

/**
 * The patterns the integration modules declare for their credential fields.
 *
 * These are the only thing standing between a correct value and a form field
 * that refuses to save, and both of the ones exercised here rejected values the
 * provider actually issues - upstream #726 and #1297, each open for well over a
 * year with users working around them by mangling their own credentials.
 *
 * Asserted through `new RegExp(source).test(value)` because that is exactly how
 * both ends check them: controller/integrations.js serialises `field.regex` to
 * its `.source` and rebuilds it, and IntegrationDialog does the same in the
 * browser. `test` is unanchored, so a pattern that does not anchor itself is
 * matching a substring - which is a finding in its own right.
 */
const fieldOf = (setup, name) => {
    const definition = setup(() => {});
    const field = definition.fields.find((entry) => entry.name === name);

    assert.ok(field, `${name} is not a declared field`);

    return field;
};

const accepts = (setup, name, value) =>
    new RegExp(fieldOf(setup, name).regex.source).test(value);

describe("pushover credentials", () => {
    // Pushover issues 30-character keys from a case-sensitive alphanumeric
    // alphabet. The pattern allowed only lowercase, so anyone whose key held a
    // capital could not save the integration at all - the reporters worked
    // around it by lowercasing their own keys, which silently addresses a
    // different account.
    const UPPERCASE_USER_KEY = "uQiRzpo4DXghDmr9QzzfQu27cmVRsG";
    const LOWERCASE_APP_TOKEN = "azgdorepk8iddhrrtpjxosdxfdc19f";
    const MIXED_CASE_APP_TOKEN = "aZGDoRePK8iDdhrRTPjxosdXfdC19f";

    for (const name of ["user_key", "token"]) {
        it(`accepts the mixed-case ${name} pushover hands out`, () => {
            assert.equal(accepts(setupPushover, name, UPPERCASE_USER_KEY), true);
            assert.equal(accepts(setupPushover, name, MIXED_CASE_APP_TOKEN), true);
        });

        it(`still accepts an all-lowercase ${name}`, () => {
            assert.equal(accepts(setupPushover, name, LOWERCASE_APP_TOKEN), true);
        });

        it(`still holds ${name} to exactly thirty alphanumeric characters`, () => {
            assert.equal(accepts(setupPushover, name, LOWERCASE_APP_TOKEN.slice(0, 29)), false);
            assert.equal(accepts(setupPushover, name, LOWERCASE_APP_TOKEN + "a"), false);
            assert.equal(accepts(setupPushover, name, "aZGDoRePK8iDdhrRTPjxosdXfdC1-f"), false);
        });
    }
});

describe("discord webhook url", () => {
    const TOKEN = "8-x_qQqZ0vRk9pLmN3bV1cX2zY4wU5tS6rQ7pO8nM9lK0jI1hG2fE3dC4bA5";

    it("accepts the discord.com form", () => {
        assert.equal(accepts(setupDiscord, "url", `https://discord.com/api/webhooks/123456789/${TOKEN}`), true);
    });

    // The form the issue is about. Discord still serves and issues this host,
    // and the pattern's unescaped `.` did not save it: "discord" + any single
    // character + "com" never matches "discordapp.com". Reporters found they
    // could save only after deleting "app" from their own webhook URL.
    it("accepts the discordapp.com form", () => {
        assert.equal(accepts(setupDiscord, "url", `https://discordapp.com/api/webhooks/123456789/${TOKEN}`), true);
    });

    it("accepts the ptb and canary hosts", () => {
        assert.equal(accepts(setupDiscord, "url", `https://ptb.discord.com/api/webhooks/1/${TOKEN}`), true);
        assert.equal(accepts(setupDiscord, "url", `https://canary.discord.com/api/webhooks/1/${TOKEN}`), true);
    });

    it("accepts an explicitly versioned api path", () => {
        assert.equal(accepts(setupDiscord, "url", `https://discord.com/api/v10/webhooks/1/${TOKEN}`), true);
    });

    // Discord's own thread targeting is a query parameter on the webhook URL.
    it("accepts a query string", () => {
        assert.equal(accepts(setupDiscord, "url", `https://discord.com/api/webhooks/1/${TOKEN}?thread_id=42`), true);
    });

    it("rejects a host that merely ends in discord.com", () => {
        assert.equal(accepts(setupDiscord, "url", `https://notdiscord.com/api/webhooks/1/${TOKEN}`), false);
        assert.equal(accepts(setupDiscord, "url", `https://discord.com.evil.test/api/webhooks/1/${TOKEN}`), false);
    });

    // `test` matches anywhere in the string, so an unanchored pattern accepted
    // any URL at all that merely contained a webhook-shaped substring - and the
    // saved value is what the server then posts the speedtest results to.
    it("rejects a foreign url carrying a webhook url inside it", () => {
        assert.equal(accepts(setupDiscord, "url",
            `https://evil.test/collect?next=https://discord.com/api/webhooks/1/${TOKEN}`), false);
    });

    it("rejects a plaintext webhook url", () => {
        assert.equal(accepts(setupDiscord, "url", `http://discord.com/api/webhooks/1/${TOKEN}`), false);
    });

    it("rejects a url with no token", () => {
        assert.equal(accepts(setupDiscord, "url", "https://discord.com/api/webhooks/123456789/"), false);
    });

    it("rejects a url whose id is not a number", () => {
        assert.equal(accepts(setupDiscord, "url", `https://discord.com/api/webhooks/abc/${TOKEN}`), false);
    });
});

/**
 * A module may set `notifier: true`; it may not explain who else does.
 *
 * Which integrations abstain from the flag, and why, is a fact about the whole
 * set - and the same three-line rationale naming influxdb and healthChecks had
 * been pasted above the flag in all six notifiers, so a seventh integration, or
 * a change of heart about influxdb, was six edits in files that have no reason
 * to know about each other. That knowledge belongs where the flag is read:
 * isNotifier and suppressesEvent in controller/integrations.js.
 *
 * Asserted over the source text because the duplication was in comments, which
 * is precisely why nothing caught it drifting. Only the two abstainers' names
 * are forbidden, not cross-references in general: healthChecks legitimately
 * points at ntfy for a shared header quirk, and discord's own docblocks are full
 * of the word "webhook".
 *
 * The scanned set is read off the directory rather than listed here, because a
 * list here has the very defect the guard exists to catch: a seventh module
 * pasted in with the old comment is exactly the file a frozen list never names.
 * Every module is held to the ban regardless of its own notifier flag - only a
 * module's own name is its own business to mention.
 */
describe("the notifier flag", () => {
    const MODULE_FILES = fs.readdirSync(INTEGRATIONS_DIR)
        .filter((file) => file.endsWith(".js") && file !== "index.js");
    const ABSTAINERS = ["influxdb", "healthChecks"];

    // If an abstainer is renamed, the ban list above goes stale silently: the
    // old name matches no file, and comments naming the new one sail through.
    it("names abstainers that exist on disk", () => {
        for (const abstainer of ABSTAINERS)
            assert.ok(MODULE_FILES.includes(`${abstainer}.js`),
                `${abstainer}.js is not in server/integrations; update ABSTAINERS`);
    });

    for (const file of MODULE_FILES) {
        const module = path.basename(file, ".js");

        it(`${module} does not restate which integrations opt out`, () => {
            const source = fs.readFileSync(path.join(INTEGRATIONS_DIR, file), "utf8");

            for (const abstainer of ABSTAINERS) {
                if (abstainer === module) continue;

                assert.equal(source.includes(abstainer), false,
                    `${module}.js names ${abstainer}, so the make-up of the notifier set is `
                    + `recorded somewhere that cannot keep it current`);
            }
        });
    }
});
