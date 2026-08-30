import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSource } from "../helpers/source.js";

/**
 * What the integrations dialog says when there is nothing in it.
 *
 * It used to say "This integration is not active. Create" - a sentence about
 * one integration on a panel that appears only when there are none at all, and
 * a bare noun after it that duplicated the button 40px below.
 *
 * Neither was a translation error. The string carried markup - a line break and
 * a bold call to action - and every other markup-carrying string in this client
 * is rendered by a component that understands it. This one alone had its
 * renderer swapped for three `.replace()` calls at the call site, which turned
 * the break into a space and the bold prompt into a leftover word. What is
 * pinned here is the shape that cannot go wrong the same way: a plain sentence,
 * in the plural the panel actually means, rendered as it is written.
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const LOCALES = path.join(ROOT, "client", "public", "assets", "locales");

const codes = fs.readdirSync(LOCALES)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.basename(file, ".json"))
    .sort();

const read = (code) => JSON.parse(fs.readFileSync(path.join(LOCALES, `${code}.json`), "utf8"));

const dialog = readSource("client/src/common/components/IntegrationDialog/IntegrationDialog.jsx");

describe("the integrations empty state", () => {
    it("names the state the panel is actually in", () => {
        for (const code of codes) {
            const integrations = read(code).integrations ?? {};

            assert.equal(integrations.none_active, undefined,
                `${code} still carries the singular string, which named one integration `
                + "on a panel that is drawn when there are none");
            assert.ok(integrations.none_added,
                `${code} has nothing to say when the list is empty`);
        }
    });

    /**
     * The markup is the thing that broke, so there is none. A sentence with no
     * tags in it cannot be half-rendered, and needs nothing at the call site.
     */
    it("carries no markup for a call site to strip", () => {
        for (const code of codes)
            assert.doesNotMatch(read(code).integrations.none_added, /<[^>]+>/,
                `${code}'s empty state carries markup, which is what left a bare "Create" behind`);
    });

    it("is rendered as it is written", () => {
        const line = dialog.split("\n").find((text) => text.includes("none_added"));

        assert.ok(line, "the dialog no longer draws the empty state at all");
        assert.doesNotMatch(line, /\.replace\(/,
            "the string is being edited on its way to the screen again");
    });
});
