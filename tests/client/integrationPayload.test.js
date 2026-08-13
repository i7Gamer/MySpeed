import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    integrationPayload, isValidFieldValue
} from "@/common/components/IntegrationDialog/integrationPayload.js";

/**
 * What the dialog sends when a card is saved, and whether it marks a value bad
 * before sending it.
 *
 * Both were inline in IntegrationCard, where neither could be exercised without
 * a renderer - and both grew a threshold-shaped hole the moment the shared
 * alert settings were added to every notifier.
 */
const DEFINITION = {
    fields: [
        {name: "url", type: "text", required: true},
        {name: "send_finished", type: "boolean", required: false},
        {name: "interval", type: "number", required: false, min: 1, max: 1440},
        {name: "alert_only", type: "boolean", required: false},
        {name: "alert_download_below", type: "number", required: false, min: 0, decimals: true}
    ]
};

const build = (fields) => integrationPayload(DEFINITION, fields, "My webhook");

describe("integrationPayload", () => {
    it("carries the display name alongside the fields", () => {
        assert.equal(build({url: "https://example.test"}).integration_name, "My webhook");
    });

    it("sends every value the card holds", () => {
        const payload = build({url: "https://example.test", send_finished: true, interval: 5});

        assert.equal(payload.url, "https://example.test");
        assert.equal(payload.send_finished, true);
        assert.equal(payload.interval, 5);
    });

    /**
     * Clearing a number has to reach the server as something.
     *
     * An emptied number box used to be dropped from the payload entirely, and
     * the server's patch merges only the keys it was given - so blanking a
     * threshold and saving kept the old one. A mistyped limit was permanent
     * short of deleting the integration and building it again, and for a
     * threshold that silences an integration that is the difference between a
     * setting and a trap. An explicit null is the one value that says "clear
     * this" rather than "leave it alone".
     */
    it("sends an explicit null for a number that was cleared", () => {
        for (const emptied of ["", null, undefined]) {
            const payload = build({url: "https://example.test", alert_download_below: emptied});

            assert.ok("alert_download_below" in payload,
                `an emptied field (${JSON.stringify(emptied)}) was dropped instead of cleared`);
            assert.equal(payload.alert_download_below, null);
        }
    });

    // Zero is a value someone typed, not an empty box.
    it("keeps a zero rather than reading it as cleared", () => {
        assert.equal(build({url: "https://example.test", alert_download_below: 0}).alert_download_below, 0);
    });

    /**
     * A required number is left out when empty rather than nulled: the server
     * rejects null on a required field outright, so sending it would turn an
     * incomplete form into a flat error instead of a partial save.
     */
    it("omits a required number that is empty rather than nulling it", () => {
        const definition = {fields: [{name: "port", type: "number", required: true}]};

        assert.ok(!("port" in integrationPayload(definition, {port: ""}, "x")));
    });
});

describe("isValidFieldValue", () => {
    const field = (overrides) => ({name: "x", type: "text", required: false, ...overrides});

    it("requires the fields marked required", () => {
        assert.equal(isValidFieldValue(field({required: true}), ""), false);
        assert.equal(isValidFieldValue(field({required: true}), "set"), true);
        assert.equal(isValidFieldValue(field({required: false}), ""), true);
    });

    it("holds a value to its declared pattern", () => {
        assert.equal(isValidFieldValue(field({regex: "^\\d+$"}), "12"), true);
        assert.equal(isValidFieldValue(field({regex: "^\\d+$"}), "ab"), false);
    });

    it("holds a number to its bounds", () => {
        const interval = field({type: "number", min: 1, max: 1440});

        assert.equal(isValidFieldValue(interval, 5), true);
        assert.equal(isValidFieldValue(interval, 0), false);
        assert.equal(isValidFieldValue(interval, 5000), false);
    });

    // Whole numbers stay whole, as the server still insists.
    it("refuses a fraction where no decimals were declared", () => {
        assert.equal(isValidFieldValue(field({type: "number"}), 2.5), false);
    });

    /**
     * A threshold is compared against a measurement stored as a double, so it
     * has to be able to say 12.5. The client mirrors the server's validation to
     * mark a bad value before the save bounces, and a mirror that refused what
     * the server accepts would show a red border on a value that is fine.
     */
    it("accepts a fraction where decimals were declared", () => {
        assert.equal(isValidFieldValue(field({type: "number", decimals: true}), 12.5), true);
        assert.equal(isValidFieldValue(field({type: "number", decimals: true}), 12), true);
        assert.equal(isValidFieldValue(field({type: "number", decimals: true}), "not a number"), false);
    });
});
