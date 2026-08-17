import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isPreviewInstance } from "../../server/util/previewMode.js";

const ROUTES_DIR = "server/routes";

afterEach(() => {
    delete process.env.PREVIEW_MODE;
});

/**
 * Whether this instance is the public demo, asked once instead of spelled out.
 *
 * The comparison was written out wherever it was needed, and a route that spells
 * its own guard is a route nothing can scan for - which is the failure
 * previewReadOnly exists to end for mutations, and the one the read routes had
 * as well: the version route thought about preview mode and the interfaces
 * route two lines below it did not.
 */
describe("isPreviewInstance", () => {
    it("is true for the exact opt-in", () => {
        process.env.PREVIEW_MODE = "true";

        assert.equal(isPreviewInstance(), true);
    });

    it("is false when nothing is set", () => {
        assert.equal(isPreviewInstance(), false);
    });

    // An instance is not a demo by accident, which is the rule the rest of
    // preview mode already follows.
    it("is not switched on by a stray value", () => {
        for (const value of ["false", "1", "TRUE", "yes", ""]) {
            process.env.PREVIEW_MODE = value;

            assert.equal(isPreviewInstance(), false, `"${value}" made an ordinary instance a demo`);
        }
    });

    // Read per call, not captured at import: a container is configured after
    // the module graph is built, and the tests set it.
    it("reads the setting per call", () => {
        assert.equal(isPreviewInstance(), false);

        process.env.PREVIEW_MODE = "true";
        assert.equal(isPreviewInstance(), true, "the setting was captured at import");
    });
});

/**
 * And no route spells it out for itself.
 *
 * The routes are where forgetting costs something - a guard written by hand is
 * invisible to the scans that hold the others to their word. The plumbing is
 * deliberately not covered: config/database.js picks a filename, tasks/speedtest
 * generates a plausible result, setupToken stays quiet. Those are behaviours a
 * demo has, not decisions about what a stranger may be told.
 */
describe("the route files", () => {
    const files = fs.readdirSync(ROUTES_DIR).filter((name) => name.endsWith(".js"));

    it("finds the routes to check", () => {
        assert.ok(files.length >= 8, `only ${files.length} route files were found`);
    });

    for (const name of files)
        it(`${name} asks the predicate rather than the environment`, () => {
            const source = fs.readFileSync(path.join(ROUTES_DIR, name), "utf8");

            assert.doesNotMatch(source, /process\.env\.PREVIEW_MODE/,
                "the guard is written out by hand, where nothing scans for it");
        });
});
