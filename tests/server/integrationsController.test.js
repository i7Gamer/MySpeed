import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
    initialize, secretFieldNames, withoutSecrets, validateInput, getIntegrations, asDataObject
} from "../../server/controller/integrations.js";

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
