import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

const serverSource = read("server", "controller", "integrations.js");
// The client's half moved out of IntegrationDialog.jsx when it was extracted so
// it could be exercised without a renderer; the cross-check follows it.
const clientSource = read("client", "src", "common", "components", "IntegrationDialog", "integrationPayload.js");

/**
 * The client re-implements the server's field validation so it can mark a bad
 * value before the save bounces. Two copies only work while they agree - the
 * client used to allow text up to 255 while the server refused above 250, so a
 * 251-character value showed no red border and then failed with a generic
 * error and no explanation.
 *
 * Scanned from both sources rather than asserted as numbers, so the next
 * change to either side has to move both.
 */
const limitOf = (source, type) => {
    const match = source.match(new RegExp(`type === "${type}"[^\\n]*length > (\\w+)`));
    assert.ok(match, `no ${type} length check found`);

    // Either side may spell its ceiling as a literal or as a named constant.
    // Resolving both keeps the comparison honest without dictating which.
    if (/^\d+$/.test(match[1])) return Number(match[1]);

    const named = source.match(new RegExp(`\\b${match[1]}\\s*=\\s*(\\d+)`));
    assert.ok(named, `${type} limit is named ${match[1]}, which is defined nowhere`);

    return Number(named[1]);
};

describe("integration field limits", () => {
    it("agree between client and server for text fields", () => {
        assert.equal(limitOf(clientSource, "text"), limitOf(serverSource, "text"));
    });

    it("agree between client and server for textareas", () => {
        assert.equal(limitOf(clientSource, "textarea"), limitOf(serverSource, "textarea"));
    });
});

/**
 * And the display name, which is the one value on this form that no module
 * declares - so it fell outside both halves of that parity.
 *
 * The server caps it at the same 250 a declared text field wears. The client
 * checked nothing, and the dialog always resends it whether or not the user
 * touched it: an integration created against sqlite before that cap existed can
 * hold a longer name, and every later save of it is then a 400 whose only sign
 * is the card's generic error. No field is marked, nothing names the length,
 * and the name in question is one the user never edited - so there is nothing
 * on screen to act on.
 *
 * The same dead end meets anyone who simply types a 251st character.
 */
describe("the integration display name", () => {
    const dialogSource = read("client", "src", "common", "components", "IntegrationDialog", "IntegrationDialog.jsx");

    it("is checked against a limit on the client too", () => {
        assert.match(clientSource, /export const isValidDisplayName/,
            "nothing on the client judges the display name, so an over-long one fails with no field marked");
    });

    it("uses the same ceiling as a declared text field", () => {
        const check = clientSource.match(/export const isValidDisplayName[^\n]*\n?[^\n]*/)?.[0] ?? "";

        assert.match(check, /TEXT_LIMIT/,
            "the display name carries a ceiling of its own, which is the drift this file exists to catch");
    });

    it("marks the field when it is too long", () => {
        const field = dialogSource.slice(dialogSource.indexOf("integrations.display_name"));

        assert.match(field.slice(0, field.indexOf("/>")), /error=\{!isValidDisplayName\(displayName\)}/,
            "the display name is the one field on this form rendered without an error state");
    });
});
