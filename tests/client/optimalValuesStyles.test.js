import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as sass from "sass";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const STYLESHEET = "common/components/OptimalValuesDialog/styles.sass";

// Stands in for the "@/" alias vite gives the client, which the stylesheets use
// to reach the shared colour definitions.
const aliasImporter = {
    findFileUrl(url) {
        if (!url.startsWith("@/")) return null;
        return pathToFileURL(path.join(CLIENT_SRC, url.slice(2)));
    }
};

const compiled = sass.compile(path.join(CLIENT_SRC, STYLESHEET), {importers: [aliasImporter]}).css;

// Everything before the first @media, i.e. the rules that apply on a desktop.
// The mobile block below repeats these selectors correctly, so asserting on the
// whole sheet would pass while the desktop layout was still unstyled.
const base = compiled.split("@media")[0];

/**
 * Regression: a top-level `.optimal-values-note` block was added directly above
 * the indented `.optimal-values-speeds` block, which in the indented syntax
 * silently reparented it - every rule for the three speed inputs compiled to
 * `.optimal-values-note .optimal-values-speeds`, a pair that are siblings in the
 * markup and so never match. The dialog lost its layout, its icon colour and its
 * input sizing, and nothing failed to build.
 *
 * Asserting on the compiled selectors is the only way to catch this: node cannot
 * render the component, and the stylesheet is valid either way.
 */
describe("the optimal values dialog stylesheet", () => {
    it("scopes the speeds row to the dialog content", () => {
        assert.match(base, /\.optimal-values-content \.optimal-values-speeds\b/);
    });

    it("never nests the speeds row under the explanatory note", () => {
        assert.doesNotMatch(compiled, /\.optimal-values-note\s+\.optimal-values-speeds/);
    });

    it("still styles the individual speed, its header and its input", () => {
        for (const selector of [
            /\.optimal-values-speeds \.optimal-values-speed\b/,
            /\.optimal-values-speed \.optimal-values-speed-header\b/,
            /\.optimal-values-speed input\b/
        ]) assert.match(base, selector);
    });

    it("lays the speeds out as a row rather than leaving them unstyled", () => {
        const speeds = base.match(/\.optimal-values-content \.optimal-values-speeds\s*\{[^}]*}/);

        assert.notEqual(speeds, null, "the speeds row has no rule of its own");
        assert.match(speeds[0], /display:\s*flex/);
    });

    it("keeps the note as a rule of its own", () => {
        assert.match(base, /(^|\})\s*\.optimal-values-note\s*\{/);
    });
});
