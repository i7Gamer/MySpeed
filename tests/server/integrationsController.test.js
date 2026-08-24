import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    initialize, secretFieldNames, withoutSecrets, validateInput, getIntegrations, asDataObject
} from "../../server/controller/integrations.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

/**
 * withoutSecrets is what stands between a downloadable config.json and every
 * downstream service's credentials, and validateInput is the only check applied
 * to integration settings before they are stored. Neither had a test.
 *
 * initialize() only runs each module's setup function, so none of this needs a
 * database.
 */
before(async () => {
    await initialize();
});

describe("secretFieldNames", () => {
    it("lists the fields a module flagged", () => {
        assert.deepEqual(secretFieldNames("pushover").sort(), ["token", "user_key"]);
        assert.deepEqual(secretFieldNames("telegram"), ["token"]);
    });

    /**
     * null and [] must stay distinguishable: [] means "this integration has no
     * credentials", while null means "there is no definition to ask". Treating
     * them alike would export a stale row for a removed integration in full.
     */
    it("returns null for an integration it does not know", () => {
        assert.equal(secretFieldNames("myspace"), null);
    });

    /**
     * A bare `integrations[name]` lookup answers a truthy value for every
     * member of Object.prototype, so these names read as known integrations
     * with no `fields` - which reaches `.filter` on undefined here, and skipped
     * the 404 in the route. The config controller had already fixed the
     * identical trap with Object.hasOwn.
     */
    it("returns null for a name off Object.prototype", () => {
        for (const name of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"])
            assert.equal(secretFieldNames(name), null, `${name} was treated as an integration`);
    });

    // withoutSecrets blanks everything it cannot identify, so a stored row with
    // one of these names must be redacted rather than throw.
    it("blanks a stored row named after one of them", () => {
        const [redacted] = withoutSecrets([{name: "toString", data: {url: "https://hook.example"}}]);

        assert.equal(redacted.data.url, null);
    });

    it("knows every integration that is loaded", () => {
        for (const name of Object.keys(getIntegrations()))
            assert.notEqual(secretFieldNames(name), null, `${name} has no definition`);
    });
});

/**
 * What each integration has to withhold to stop a stranger reaching its
 * endpoint.
 *
 * Written down per module rather than inferred, because the answer is not
 * "the field called token" - it is "whatever, together, is enough to send".
 * That differs by provider, and getting it wrong is silent: withoutSecrets
 * blanks exactly what a module flagged, so an unflagged field is disclosed by
 * both paths that call it - GET /api/integrations/active on a public demo, and
 * the config export that stamps itself `secretsRedacted: true` and is the file
 * people attach to bug reports.
 *
 * The two shapes:
 *
 *   A separate credential guards the address, so only the credential is
 *   withheld. gotify posts to `<url>/message?token=<key>` and influx to
 *   `<url>/api/v2/write` under a bearer token - the address alone sends
 *   nothing, and disclosing it costs the operator nothing an address does not
 *   already cost.
 *
 *   The address *is* the credential, so all of it is withheld. discord,
 *   webhook and healthChecks each carry an unguessable URL and nothing else,
 *   which is why their plain `url` was flagged. ntfy is the same capability
 *   split across two fields: send() posts to `<url>/<topic>` and only attaches
 *   an Authorization header when a token is set, and `token` is not required -
 *   so on the ntfy.sh default the topic name is the whole of the publish and
 *   subscribe control, exactly as an unguessable webhook path is.
 */
const ADDRESSING_FIELDS = {
    discord: ["url"],
    // email is the one entry here that is not only about capability. `username`
    // and `password` are the credential, in the usual way - but `from` and `to`
    // are somebody's mailboxes, withheld because a demo visitor has no business
    // reading the operator's address and a redacted export is a file people
    // attach to bug reports. The relay's own host and port stay in the clear:
    // a hostname is not a capability without the credentials above it, and
    // blanking it would cost the diagnosis such an export exists for.
    email: ["username", "password", "from", "to"],
    webhook: ["url"],
    healthChecks: ["url"],
    ntfy: ["token", "topic", "url"],
    gotify: ["key"],
    pushover: ["token", "user_key"],
    telegram: ["token"],
    influxdb: ["token"]
};

describe("what each integration withholds", () => {
    for (const [name, fields] of Object.entries(ADDRESSING_FIELDS)) {
        it(`${name} declares every field needed to reach it`, () => {
            assert.deepEqual(secretFieldNames(name)?.sort(), [...fields].sort());
        });
    }

    // The table is the decision, so a module that is not in it has not had one
    // made. Same rule as the read routes in previewReadOnly.test.js: a new
    // integration fails here until somebody says what it may disclose.
    it("has an answer for every integration that is loaded", () => {
        const undecided = Object.keys(getIntegrations())
            .filter((name) => !Object.hasOwn(ADDRESSING_FIELDS, name));

        assert.deepEqual(undecided, [],
            "an integration was added without deciding what a demo may disclose about it");
    });
});

/**
 * Regression: every read of the `data` column went through JSON.parse
 * unconditionally. sqlite hands the JSON column back as the string it stored,
 * but mysql2 parses JSON columns on the wire - so on MySQL every read arrived
 * as an object, JSON.parse threw on "[object Object]", and with it went
 * GET /api/integrations/active, PATCH /api/integrations/:id and every
 * notification the event fan-out tried to send.
 */
describe("asDataObject", () => {
    it("parses the string sqlite stores", () => {
        assert.deepEqual(asDataObject('{"url": "https://hook", "send_finished": true}'),
            {url: "https://hook", send_finished: true});
    });

    it("passes the object mysql already parsed through untouched", () => {
        const data = {url: "https://hook", send_finished: true};

        assert.equal(asDataObject(data), data);
    });

    it("leaves null alone rather than throwing", () => {
        assert.equal(asDataObject(null), null);
    });
});

describe("withoutSecrets", () => {
    const telegramRow = () => ({
        id: "abc", name: "telegram", displayName: "Telegram",
        data: {token: "123:supersecret", chat_id: "42", send_finished: true}
    });

    it("blanks the credential but keeps the key", () => {
        const [row] = withoutSecrets([telegramRow()]);

        assert.ok("token" in row.data, "the shape of the payload must not change");
        assert.equal(row.data.token, null);
    });

    it("leaves everything that is not a credential alone", () => {
        const [row] = withoutSecrets([telegramRow()]);

        assert.equal(row.data.chat_id, "42");
        assert.equal(row.data.send_finished, true);
        assert.equal(row.displayName, "Telegram");
    });

    it("handles data stored as a json string", () => {
        const [row] = withoutSecrets([{...telegramRow(), data: JSON.stringify(telegramRow().data)}]);

        assert.equal(row.data.token, null);
        assert.equal(row.data.chat_id, "42");
    });

    it("does not mutate the row it was given", () => {
        const original = telegramRow();
        withoutSecrets([original]);

        assert.equal(original.data.token, "123:supersecret");
    });

    /**
     * A credential does not stop being one for living inside a URL.
     *
     * Only fields flagged `secret` are blanked, and no integration flags its
     * endpoint - gotify's and influxdb's are plain text fields, and both accept
     * `https?://\S+`, which permits userinfo. So an operator fronting InfluxDB
     * with basic auth had `http://myspeed:hunter2@influx.lan:8086` written into
     * the file that blanks the token beside it and stamps secretsRedacted true.
     * The node URLs and libreUrl learned this; the integrations were the third
     * place the same value shape is stored.
     *
     * Applied to every string rather than to a list of URL fields, because the
     * next integration to arrive with an endpoint should not have to be
     * remembered here - and for anything that is not a URL with userinfo in it,
     * this returns the value unchanged.
     */
    it("strips a credential out of an integration's URL", () => {
        const [row] = withoutSecrets([{
            id: "i", name: "influxdb",
            data: {url: "http://myspeed:hunter2@influx.lan:8086", token: "supersecret", org: "home"}
        }]);

        assert.equal(row.data.url, "http://influx.lan:8086",
            "an endpoint's userinfo ships in clear in a redacted export");
        assert.equal(row.data.token, null, "the flagged credential is no longer blanked");
        assert.equal(row.data.org, "home", "a plain field was rewritten");
    });

    // Including one whose fields are all plain: that row used to be handed back
    // untouched, so a URL credential in it never reached the strip at all.
    it("strips it even when the integration flags nothing as secret", () => {
        const [row] = withoutSecrets([{
            id: "g", name: "gotify", data: {url: "https://admin:hunter2@gotify.lan", key: "abcdefghijklmno"}
        }]);

        assert.equal(row.data.url, "https://gotify.lan");
    });

    // Guessing which fields of an unknown integration are harmless is exactly
    // the mistake this function exists to prevent.
    it("blanks everything for an integration it does not recognise", () => {
        const [row] = withoutSecrets([{id: "x", name: "removed-plugin", data: {url: "https://hook", flag: true}}]);

        assert.equal(row.data.url, null);
        assert.equal(row.data.flag, null);
    });

    it("leaves a credential-free integration untouched", () => {
        const rows = withoutSecrets([{id: "y", name: "gotify", data: {url: "https://g", key: "k", priority: "5"}}]);

        assert.equal(rows[0].data.priority, "5");
        assert.equal(rows[0].data.key, null, "gotify's key is a credential");
    });

    it("survives an empty list", () => {
        assert.deepEqual(withoutSecrets([]), []);
    });

    // The whole point: nothing that was flagged may survive serialisation.
    it("leaves no flagged value anywhere in the serialised output", () => {
        const rows = [
            telegramRow(),
            {id: "d", name: "discord", data: {url: "https://discord.com/api/webhooks/1/leak", send_finished: true}},
            {id: "p", name: "pushover", data: {token: "a".repeat(30), user_key: "b".repeat(30)}}
        ];

        const serialised = JSON.stringify(withoutSecrets(rows));

        for (const secret of ["supersecret", "webhooks/1/leak", "a".repeat(30), "b".repeat(30)])
            assert.doesNotMatch(serialised, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });
});

describe("validateInput", () => {
    const telegram = (overrides = {}) => ({
        token: "123456:abcdefghijklmnop", chat_id: "42", send_finished: true, ...overrides
    });

    it("rejects an unknown integration", () => {
        assert.equal(validateInput("myspace", {}), false);
    });

    it("accepts a well-formed configuration", () => {
        assert.notEqual(validateInput("telegram", telegram()), false);
    });

    it("requires the fields marked required", () => {
        assert.equal(validateInput("telegram", telegram({token: undefined})), false);
        assert.equal(validateInput("telegram", telegram({token: ""})), false);
        assert.equal(validateInput("telegram", telegram({chat_id: null})), false);
    });

    it("enforces the declared pattern", () => {
        assert.equal(validateInput("telegram", telegram({chat_id: "not-a-number"})), false);
        assert.equal(validateInput("gotify", {url: "not a url", key: "123456789012345", priority: "5"}), false);
    });

    it("enforces the length limits", () => {
        assert.equal(validateInput("telegram", telegram({error_message: "x".repeat(2001)})), false);
        assert.notEqual(validateInput("telegram", telegram({error_message: "x".repeat(2000)})), false);
    });

    it("requires a boolean field to actually be boolean", () => {
        assert.equal(validateInput("telegram", telegram({send_finished: "yes"})), false);
    });

    /**
     * The length checks read `.length`, and `undefined > 250` is false - so a
     * number, an object or an array sailed past them and was whitelisted into
     * the stored data column. At send time replaceVariables calls
     * `message.replaceAll(...)` on it and throws, which used to abort the whole
     * fan-out, so every integration registered after it missed the event.
     *
     * The influxdb module already guarded against exactly this locally and
     * named the hazard in a comment; the validator that let it in did not.
     */
    it("requires a text field to actually be a string", () => {
        for (const value of [42, {}, [], true])
            assert.equal(validateInput("telegram", telegram({error_message: value})), false,
                `${JSON.stringify(value)} was accepted as a textarea value`);
    });

    /**
     * The display name, which is the one value here that no module declares.
     *
     * Every type and length cap lives inside the loop over `integration.fields`,
     * and integration_name is not one of them - it was copied onto the result
     * afterwards, unread. So it reached `displayName`, a bare Sequelize.STRING,
     * which is VARCHAR(255) on MySQL: an over-long name was ER_DATA_TOO_LONG
     * and a 500 there, while sqlite stored it whole. The two supported backends
     * answered the same request differently, and the one that failed did it
     * with a stack in the operator's log rather than the 400 every declared
     * field earns.
     *
     * A non-string went two ways, and only one of them was loud. Sequelize's
     * STRING validator refuses a boolean, an object or an array - the 500 - but
     * lets a number through, so `42` was stored as the text "42" with nothing
     * said at all. The quiet one is what the type check here is for.
     */
    describe("the display name", () => {
        it("accepts a name a text field would accept", () => {
            assert.notEqual(validateInput("telegram", telegram({integration_name: "Home line"})), false);
            assert.notEqual(validateInput("telegram", telegram({integration_name: "x".repeat(250)})), false);
        });

        // Optional, and it has to stay optional: the column names its own
        // default, and patch() reads undefined as "leave the name alone".
        it("accepts a configuration that names nothing", () => {
            const validated = validateInput("telegram", telegram());

            assert.notEqual(validated, false);
            assert.equal(validated.integration_name, undefined);
        });

        it("rejects a name past the length the column holds", () => {
            assert.equal(validateInput("telegram", telegram({integration_name: "x".repeat(251)})), false);
        });

        it("rejects a name that is not text", () => {
            for (const value of [42, {}, [], true, null])
                assert.equal(validateInput("telegram", telegram({integration_name: value})), false,
                    `${JSON.stringify(value)} was accepted as a display name`);
        });
    });

    // A text field with no declared pattern has nothing else standing in the
    // way - the pattern check is what happened to catch the others.
    it("requires a short text field to actually be a string", () => {
        const influx = (overrides) => validateInput("influxdb", {
            url: "https://influx.example", org: "myspeed", bucket: "speed", token: "abc", ...overrides
        });

        assert.notEqual(influx({}), false, "the baseline configuration must be accepted");

        for (const value of [42, {}, [], true])
            assert.equal(influx({org: value}), false,
                `${JSON.stringify(value)} was accepted as a text value`);
    });

    it("coerces a numeric field and holds it to its bounds", () => {
        const withinBounds = validateInput("webhook", {url: "https://hook.example", interval: "30"});
        assert.equal(withinBounds.interval, 30, "a numeric field should be stored as a number");

        assert.equal(validateInput("webhook", {url: "https://hook.example", interval: "0"}), false);
        assert.equal(validateInput("webhook", {url: "https://hook.example", interval: "1441"}), false);
        assert.equal(validateInput("webhook", {url: "https://hook.example", interval: "1.5"}), false);
    });

    // The returned object is what gets stored, so anything not declared by the
    // integration must not survive - that whitelist is what stops a caller
    // planting arbitrary keys in the data column.
    it("keeps only the declared fields", () => {
        const result = validateInput("telegram", telegram({surprise: "extra", integration_name: "Mine"}));

        assert.equal(result.surprise, undefined);
        assert.equal(result.integration_name, "Mine");
        assert.equal(result.token, "123456:abcdefghijklmnop");
    });
});

/**
 * A PATCH that changes one setting.
 *
 * validateInput is the same function for a create and an update, and it
 * rejected any body missing a required field - so changing just the message
 * template meant re-sending the token, the url and everything else or getting a
 * flat 400 "Invalid data". patch() in the same controller is built for the
 * opposite: it filters undefined keys out of the body and merges what is left
 * over the stored object, with a comment explaining that a field the caller
 * left out arrives as undefined. That can only happen if validation let it
 * through, so the two halves disagreed about their own contract.
 *
 * An explicit null or "" is still a rejection: that is not "leave it alone", it
 * is "clear a field that is required".
 */
describe("validateInput on a partial update", () => {
    const stored = {url: "https://ntfy.sh", topic: "myspeed", priority: "3"};

    it("rejects a body missing a required field when creating", () => {
        assert.equal(validateInput("ntfy", {topic: "myspeed"}), false);
    });

    it("accepts the same body when patching", () => {
        const result = validateInput("ntfy", {topic: "myspeed"}, true);

        assert.notEqual(result, false, "changing one setting demanded every other one back");
        assert.equal(result.topic, "myspeed");
    });

    it("leaves the fields it was not given undefined, for patch() to skip", () => {
        const result = validateInput("ntfy", {topic: "myspeed"}, true);

        assert.equal(result.url, undefined);
    });

    it("still rejects a required field explicitly blanked", () => {
        assert.equal(validateInput("ntfy", {...stored, topic: ""}, true), false);
        assert.equal(validateInput("ntfy", {...stored, topic: null}, true), false);
    });

    it("still validates the fields it was given", () => {
        assert.equal(validateInput("ntfy", {topic: "not a valid topic!!"}, true), false);
        assert.equal(validateInput("ntfy", {priority: "9"}, true), false);
    });

    it("still refuses an integration it does not know", () => {
        assert.equal(validateInput("myspace", {}, true), false);
    });

    it("is strict by default, so a create cannot reach the lenient path by accident", () => {
        assert.equal(validateInput("ntfy", {topic: "myspeed"}), false);
    });
});

/**
 * The order the field checks run in, which is the one thing about them a
 * functional test cannot see: every branch answers `false`, so a value refused
 * by the length cap and one refused by the regex are the same answer.
 *
 * It matters anyway. `field.regex` is compiled and run against the raw request
 * value, and the only bound on that value is app.js's 100kb body parser - so
 * with the regex first, every pattern a module declares is handed up to 100,000
 * characters. All eleven shipped patterns are linear and were timed to 80,000
 * characters, so nothing is wrong today; what this holds is that the next module
 * to declare one cannot be handed more than the column takes. The threshold
 * check in the config controller is what happens when that assumption is left
 * to whoever writes the pattern.
 *
 * Before the number branch, not merely last: that branch ends in
 * `data[field.name] = num`, so a regex moved past it would be testing the
 * coerced number rather than what arrived.
 */
describe("the order validateInput checks a field in", () => {
    const source = fs.readFileSync(
        path.join(ROOT, "server", "controller", "integrations.js"), "utf8");

    const at = (needle) => {
        const found = source.indexOf(needle);
        assert.notEqual(found, -1, `"${needle}" is no longer in validateInput`);

        return found;
    };

    it("bounds the value before compiling a pattern against it", () => {
        assert.ok(at("MAX_TEXT_LENGTH) return false") < at("new RegExp(field.regex)"),
            "a module's pattern is run against the whole request body rather than against a capped value");
        assert.ok(at("MAX_TEXTAREA_LENGTH) return false") < at("new RegExp(field.regex)"),
            "the textarea cap is applied after the pattern that already read the value");
    });

    it("still reads the value before the number branch rewrites it", () => {
        assert.ok(at("new RegExp(field.regex)") < at("data[field.name] = num"),
            "the pattern is tested against the coerced number rather than against what arrived");
    });

    // The reason the type check leads: the caps below it read `.length`, and
    // `undefined > 250` is false.
    it("checks the type before anything reads a length", () => {
        assert.ok(at('typeof data[field.name] !== "string"') < at("MAX_TEXT_LENGTH) return false"),
            "a non-string reaches a length comparison that silently passes it");
    });
});
