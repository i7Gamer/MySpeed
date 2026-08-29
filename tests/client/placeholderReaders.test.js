import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withoutJsComments } from "../helpers/source.js";

/**
 * The tripwire against the next private placeholder reader.
 *
 * Four review rounds in a row found another spelling of "is this the -1 a
 * failed test stores?" hiding in a component - each one a place where a
 * legacy-restored row's text spelling, or the placeholder itself, was judged
 * by a rule the file beside it had already outgrown. The judgement has one
 * home (TestUtil's storedFigure and the readers built on it), so a new bare
 * -1 in the measurement-rendering trees is either a new private reader or a
 * new sentinel - and both belong in that home.
 *
 * Comments are stripped before scanning, so prose about the placeholder stays
 * free. The scan is a budget, not a proof: a reader can still hide behind a
 * named constant or an imported alias. What it does catch is exactly the
 * shape every one of the four found readers actually had - a bare -1 compared
 * or assigned in component code.
 */
const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const CLIENT_SRC = path.join(ROOT, "client", "src");

// The trees that render measurements. Dialogs, contexts and generic widgets
// use -1 as an index sentinel all over, legitimately; the budget watches the
// code that reads stored test rows.
const MEASUREMENT_TREES = [
    "pages/Statistics/charts",
    "pages/Home/components",
    "pages/Nodes/components",
    "common/components/TestDetails",
    "common/utils"
];

// Every allowed -1, with its reason. A new entry needs the same: a reason
// that is not "it reads a test column", because that reading lives in
// TestUtil.
const ALLOWED = new Map([
    ["common/utils/TestUtil.js", "the sentinel's home: FAILED_TEST and the readers built on it"],
    ["pages/Home/components/TestArea/TestAreaComponent.jsx", "a chart index for a row outside the drawn window"]
]);

const BARE_MINUS_ONE = /(?<![\w.])-1\b/;

const walk = (dir) => fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.jsx?$/.test(entry.name) ? [full] : [];
});

describe("the placeholder is read in one place", () => {
    for (const tree of MEASUREMENT_TREES) {
        it(`${tree} carries no bare -1 outside the allowed readers`, () => {
            for (const file of walk(path.join(CLIENT_SRC, tree))) {
                const relative = path.relative(CLIENT_SRC, file).replaceAll(path.sep, "/");
                if (ALLOWED.has(relative)) continue;

                const code = withoutJsComments(fs.readFileSync(file, "utf8"));

                assert.doesNotMatch(code, BARE_MINUS_ONE,
                    `${relative} carries a bare -1: a private placeholder reader or a new sentinel, ` +
                    "both of which belong in TestUtil - or an index sentinel, which belongs in ALLOWED with its reason");
            }
        });
    }

    it("keeps the allowed list honest", () => {
        for (const [relative] of ALLOWED) {
            const code = withoutJsComments(fs.readFileSync(path.join(CLIENT_SRC, relative), "utf8"));

            assert.match(code, BARE_MINUS_ONE,
                `${relative} no longer carries a -1; drop it from ALLOWED so the list stays a list of facts`);
        }
    });

    it("declares the sentinel once", () => {
        for (const tree of MEASUREMENT_TREES) {
            for (const file of walk(path.join(CLIENT_SRC, tree))) {
                const relative = path.relative(CLIENT_SRC, file).replaceAll(path.sep, "/");
                if (relative === "common/utils/TestUtil.js") continue;

                assert.doesNotMatch(withoutJsComments(fs.readFileSync(file, "utf8")),
                    /const\s+FAILED_TEST\s*=/,
                    `${relative} declares its own FAILED_TEST beside the shared one`);
            }
        }
    });
});
