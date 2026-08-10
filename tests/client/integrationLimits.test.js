import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

const serverSource = read("server", "controller", "integrations.js");
const clientSource = read("client", "src", "common", "components", "IntegrationDialog", "IntegrationDialog.jsx");

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
    const match = source.match(new RegExp(`type === "${type}"[^\\n]*length > (\\d+)`));
    assert.ok(match, `no ${type} length check found`);
    return Number(match[1]);
};

describe("integration field limits", () => {
    it("agree between client and server for text fields", () => {
        assert.equal(limitOf(clientSource, "text"), limitOf(serverSource, "text"));
    });

    it("agree between client and server for textareas", () => {
        assert.equal(limitOf(clientSource, "textarea"), limitOf(serverSource, "textarea"));
    });
});
