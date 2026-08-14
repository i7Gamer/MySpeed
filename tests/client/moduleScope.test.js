import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const sources = (dir) => fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);

    return /\.jsx?$/.test(entry.name) ? [{file: full, code: fs.readFileSync(full, "utf8")}] : [];
});

const NAMES_IN_BRACES = /\{([^}]*)}/;

// "A", "B as C" -> the name this module would have to refer to, which is the one
// on the left. `as` only renames what leaves the module.
const localNames = (list) => list.split(",")
    .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean);

const reExported = (code) => [...code.matchAll(/export\s*(\{[^}]*})\s*from\s*["']/g)]
    .flatMap(([, braces]) => localNames(braces.match(NAMES_IN_BRACES)[1]));

const imported = (code) => [
    ...[...code.matchAll(/import\s*(\{[^}]*})\s*from\s*["']/g)]
        .flatMap(([, braces]) => localNames(braces.match(NAMES_IN_BRACES)[1])),
    // The default and namespace forms bind a name too.
    ...[...code.matchAll(/import\s+(\w+)\s*(?:,|from)/g)].map(([, name]) => name),
    ...[...code.matchAll(/import\s*\*\s*as\s+(\w+)/g)].map(([, name]) => name)
];

const declared = (code) => [...code.matchAll(/(?:^|\s)(?:export\s+)?(?:const|let|var|function|class)\s+(\w+)/g)]
    .map(([, name]) => name);

// The statement itself mentions the name, so it is stripped before asking
// whether anything else does.
const withoutReExports = (code) => code.replace(/export\s*\{[^}]*}\s*from\s*["'][^"']*["'];?/g, "");

/**
 * A re-export is not an import.
 *
 * `export {GRADE_VALUES_OFF} from "./constants"` forwards the name to whoever
 * imports this module and binds nothing inside it - so a module that re-exports
 * a constant and then uses it throws a ReferenceError the first time the line
 * runs. Which is at render, not at build: rolldown resolves the re-export
 * happily, the bundle is written, and the whole app comes up as the error
 * boundary's "Something went wrong".
 *
 * There is no linter in this project to catch a `no-undef`, and the unit suite
 * reads these files as text rather than evaluating them. So this is the check:
 * cheap, narrow, and aimed at the one shape that has actually broken the app.
 */
describe("a module imports what it uses, rather than only re-exporting it", () => {
    const files = sources(CLIENT_SRC);

    it("finds the sources to check", () => {
        assert.ok(files.length > 50, `expected the client's modules, found ${files.length}`);
    });

    it("catches the shape it is written for", () => {
        const trap = `export {A} from "./x";\nconst use = () => A;`;

        assert.deepEqual(reExported(trap), ["A"]);
        assert.deepEqual(imported(trap), []);
        assert.match(withoutReExports(trap), /\bA\b/);
    });

    for (const {file, code} of files) {
        const forwarded = reExported(code);
        if (forwarded.length === 0) continue;

        const name = path.relative(CLIENT_SRC, file).replace(/\\/g, "/");

        it(`${name} binds every forwarded name it refers to`, () => {
            const bound = new Set([...imported(code), ...declared(code)]);
            const body = withoutReExports(code);

            const unbound = forwarded.filter((forward) =>
                !bound.has(forward) && new RegExp(`\\b${forward}\\b`).test(body));

            assert.deepEqual(unbound, [],
                `re-exported and then used without being imported: ${unbound.join(", ")}`);
        });
    }
});
