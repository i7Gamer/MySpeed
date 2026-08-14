import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import setupDiscord from "../../server/integrations/discord.js";
import setupPushover from "../../server/integrations/pushover.js";
import setupGotify from "../../server/integrations/gotify.js";
import setupHealthChecks from "../../server/integrations/healthChecks.js";
import setupWebhook from "../../server/integrations/webhook.js";
import setupTelegram from "../../server/integrations/telegram.js";
import setupNtfy from "../../server/integrations/ntfy.js";
import setupInfluxdb from "../../server/integrations/influxdb.js";

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

/**
 * A pattern that does not anchor itself is describing a substring, and every one
 * of these fields is a whole value.
 *
 * The comment above already named the hazard; five fields were still living with
 * it. `test` is unanchored, so `/https?:\/\/.+/` accepted "not a url
 * https://example.com" and `/\d+/` accepted "abc123def" - each stored verbatim
 * and each failing later, at send time, as a silent or half-explained delivery
 * error rather than as a form that would not save.
 *
 * The url fields matter most, because a URL is parsed by rules that are not the
 * ones a reader assumes. WHATWG parsing strips tabs and newlines out of the
 * input before it resolves anything, so "https://good.example\n@evil.com" - which
 * a pattern ending in `.+` and no `$` accepts, since `.` never matches the
 * newline it stops at - resolves to the host evil.com with "good.example" read
 * as a username. Only an operator can set these, so this is a foot-gun rather
 * than a hole; it is still a value the field claimed to have checked.
 */
describe("credential patterns describe the whole value", () => {
    const URL_FIELDS = [
        {module: "gotify", setup: setupGotify},
        {module: "healthChecks", setup: setupHealthChecks},
        {module: "webhook", setup: setupWebhook},
        {module: "ntfy", setup: setupNtfy},
        {module: "influxdb", setup: setupInfluxdb}
    ];

    for (const {module, setup} of URL_FIELDS) {
        it(`${module} still accepts an ordinary url`, () => {
            assert.equal(accepts(setup, "url", "https://example.com/hook"), true);
            assert.equal(accepts(setup, "url", "http://192.168.1.5:8080"), true);
        });

        it(`${module} rejects a url with something in front of it`, () => {
            assert.equal(accepts(setup, "url", "not a url https://example.com"), false,
                "the pattern matches the url inside the value rather than the value");
        });

        it(`${module} rejects a url carrying a newline`, () => {
            assert.equal(accepts(setup, "url", "https://good.example\n@evil.com"), false,
                "url parsing strips the newline, so this reaches a different host than it reads as");
        });

        it(`${module} rejects a url with a space in it`, () => {
            assert.equal(accepts(setup, "url", "https://example.com/a b"), false);
        });
    }

    describe("telegram", () => {
        it("accepts a token as BotFather issues it", () => {
            assert.equal(accepts(setupTelegram, "token", "123456789:AAF-dEfGhIjKlMnOpQrStUvWxYz_1234567"), true);
        });

        /**
         * The prefix is the mistake worth catching. The URL is built as
         * `/bot${token}/sendMessage`, so a token pasted with the "bot" already
         * on it produced `/botbot123.../sendMessage` - accepted by the form,
         * then answered 404 by Telegram for as long as it stayed configured.
         */
        it("rejects a token pasted with its bot prefix", () => {
            assert.equal(accepts(setupTelegram, "token", "bot123456789:AAF-dEfGhIjKlMnOpQrStUvWxYz_1234"), false);
        });

        // Interpolated into the path, so a value that walks out of it is a
        // request to somewhere else on the host.
        it("rejects a token that walks out of its path segment", () => {
            assert.equal(accepts(setupTelegram, "token", "123456789:AAF-dEf/../../getUpdates"), false);
        });

        it("accepts a chat id", () => {
            assert.equal(accepts(setupTelegram, "chat_id", "123456789"), true);
        });

        /**
         * Groups and channels are negative, and that is the common case for a
         * MySpeed alert - nobody sends their line's speedtests to themselves in
         * a private chat and then complains about it. Anchoring this to digits
         * alone would have rejected every group.
         */
        it("accepts the negative id a group or channel has", () => {
            assert.equal(accepts(setupTelegram, "chat_id", "-1001234567890"), true);
        });

        it("rejects a chat id with anything else in it", () => {
            for (const value of ["abc123def", "123 456", "@mychannel"])
                assert.equal(accepts(setupTelegram, "chat_id", value), false, `${value} was accepted`);
        });
    });
});

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
