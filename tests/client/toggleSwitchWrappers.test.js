import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSource } from "../helpers/source.js";

/**
 * ToggleSwitch draws a <label htmlFor> of its own, so nothing that holds one
 * may itself be a <label>: HTML forbids a label inside a label, two labels
 * claimed the one click, and a screen reader announced the control twice.
 * The export-secrets row in the storage dialog was the one place that did.
 * Checked across every component, so the next row copies the right one.
 */
const componentsDir = fileURLToPath(new URL("../../client/src", import.meta.url));

const jsxFilesUnder = (dir) => fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? jsxFilesUnder(full) : entry.name.endsWith(".jsx") ? [full] : [];
});

describe("every ToggleSwitch", () => {
    const holders = jsxFilesUnder(componentsDir)
        .map((file) => path.relative(path.join(componentsDir, ".."), file).split(path.sep).join("/"))
        .filter((file) => !file.endsWith("ToggleSwitch/ToggleSwitch.jsx"))
        .filter((file) => readSource(`client/${file}`).includes("<ToggleSwitch"));

    it("is held by something", () => {
        assert.ok(holders.length > 0, "no component renders a ToggleSwitch");
    });

    it("sits in no <label> of its holder's", () => {
        for (const file of holders) {
            const source = readSource(`client/${file}`);
            let cursor = source.indexOf("<ToggleSwitch");

            while (cursor !== -1) {
                const before = source.slice(0, cursor);
                const opened = before.lastIndexOf("<label");
                const closed = before.lastIndexOf("</label>");

                assert.ok(opened === -1 || closed > opened,
                    `${file} wraps a ToggleSwitch in a <label> of its own`);
                cursor = source.indexOf("<ToggleSwitch", cursor + 1);
            }
        }
    });
});
