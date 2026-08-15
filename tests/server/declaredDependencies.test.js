import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every package the tests import is a package somebody declared.
 *
 * Twenty-one client test files compile stylesheets with `import * as sass from
 * "sass"`, and no package.json in the repository asked for `sass`. The client
 * declares `sass-embedded` - commit 44d47a56 deliberately swapped one for the
 * other, a year before these tests were written - and the import resolved only
 * because the alias hook retries a failed bare specifier inside the client
 * package, where bun had materialised `sass` as an artifact of two
 * platform-filtered optional dependencies of sass-embedded.
 *
 * That is a package nobody chose, kept alive by a resolution accident. If
 * sass-embedded renames those fallbacks in a patch bump - and dependabot
 * auto-merges patch bumps - twenty-one files fail at import with
 * ERR_MODULE_NOT_FOUND naming a package that appears in no manifest, and a whole
 * class of styling regression coverage stops running.
 */
const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

const manifest = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

const declared = (file) => {
    const json = manifest(file);
    return new Set([...Object.keys(json.dependencies ?? {}), ...Object.keys(json.devDependencies ?? {})]);
};

const testFiles = (directory) => fs.readdirSync(path.join(root, directory))
    .filter((name) => name.endsWith(".test.js"))
    .map((name) => path.join(root, directory, name));

/*
 * The specifier of every import statement, and only those.
 *
 * Anchored at column zero and bounded to the statement: a pattern loose enough
 * to span lines matched prose inside block comments and quoted paths inside the
 * regex literals these tests are full of, and reported "reported as" and
 * "this size was" as missing packages.
 */
const IMPORT_FORMS = [
    // import x from "y" / import * as x from "y", on one line.
    /^import[^\n{]*?from\s*["']([^"']+)["']/gm,
    // import {a, b} from "y", where the braces may span lines.
    /^import\s*\{[^}]*\}\s*from\s*["']([^"']+)["']/gm,
    // import "y", for a side effect.
    /^import\s+["']([^"']+)["']/gm
];

/** The package a specifier names, or null if it names something local. */
const packageOf = (specifier) => {
    // "./merge", "../../server/...", and the client's own "@/" alias, which is a
    // path the resolver hook rewrites rather than a package.
    if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("@/")) return null;
    if (specifier.startsWith("node:")) return null;

    return specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
};

describe("what the tests import", () => {
    const available = new Set([...declared("package.json"), ...declared("client/package.json")]);

    for (const directory of ["tests/client", "tests/server", "tests/integration"]) {
        it(`${directory} imports only packages a manifest asks for`, () => {
            const undeclared = new Map();

            for (const file of testFiles(directory)) {
                const source = fs.readFileSync(file, "utf8");

                for (const form of IMPORT_FORMS) {
                    for (const [, specifier] of source.matchAll(form)) {
                        const name = packageOf(specifier);

                        if (name === null || available.has(name)) continue;

                        undeclared.set(name, [...new Set([...(undeclared.get(name) ?? []), path.basename(file)])]);
                    }
                }
            }

            assert.deepEqual([...undeclared.keys()], [],
                `these are imported by ${directory} and declared nowhere: `
                + [...undeclared].map(([name, files]) => `${name} (${files.length} file(s), e.g. ${files[0]})`).join(", "));
        });
    }

    // The specific one this was written for, named so the reason survives.
    it("declares the sass compiler the styling tests are written against", () => {
        assert.ok(available.has("sass"),
            "the stylesheet tests compile with `sass`, which resolves today only because bun materialises it"
            + " under sass-embedded's platform fallbacks");
    });

    it("keeps it out of what ships", () => {
        assert.equal(manifest("package.json").dependencies?.sass, undefined,
            "a test-only compiler is a runtime dependency of the server");
    });
});
