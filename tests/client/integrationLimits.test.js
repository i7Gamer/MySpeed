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
