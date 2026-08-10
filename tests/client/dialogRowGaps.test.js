import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as sass from "sass";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

// Stands in for the "@/" alias vite gives the client, which the stylesheets use
// to reach the shared colour definitions.
const aliasImporter = {
    findFileUrl(url) {
        if (!url.startsWith("@/")) return null;
        return pathToFileURL(path.join(CLIENT_SRC, url.slice(2)));
    }
};

const compile = (stylesheet) =>
    sass.compile(path.join(CLIENT_SRC, stylesheet), {importers: [aliasImporter]}).css;

// Every rule block in the compiled sheet, as {selector, body} pairs.
const blocks = (css) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => ({selector: selector.trim(), body}));

/**
 * space-between spreads a row's ends apart only while there is room to spread;
 * the moment there is none, its two sides touch. Every such row needs a gap as
 * the floor - the overview and average stat rows already learnt this the hard
 * way, and these are the remaining rows of the same construction: a label
 * against an input or control, where a long German translation eats exactly
 * the room the layout assumed.
 */
const SHEETS = [
    "common/components/WelcomeDialog/steps/DataHelper/styles.sass",
    "common/components/OptimalValuesDialog/styles.sass",
    "common/contexts/Dialog/styles.sass"
];

describe("space-between rows keep a gap as their floor", () => {
    for (const sheet of SHEETS) {
        it(path.basename(path.dirname(sheet)), () => {
            const rows = blocks(compile(sheet))
                .filter(({body}) => /justify-content:\s*space-between/.test(body));

            assert.ok(rows.length > 0, `expected ${sheet} to lay out space-between rows`);
            for (const {selector, body} of rows)
                assert.match(body, /(^|;)\s*(column-)?gap:/m,
                    `"${selector}" spreads its ends apart with nothing keeping them apart`);
        });
    }
});
