import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

/**
 * A universal selector carrying a font size - `.header-main *` was the one that
 * kept biting - matches every descendant directly, so a component's own size
 * never reaches its children by inheritance, and a single-class rule ties on
 * specificity and wins or loses by bundling order. It ambushed the timeframe
 * menu (24pt items behind a nested-selector workaround), then the menu's label
 * span (24pt inside a 0.9rem button), and left the header tooltips readable
 * only because their stylesheet happened to load later.
 *
 * The size belongs on the container instead: inheritance gives every child that
 * sets nothing the same value, and loses - always, regardless of order - to any
 * child that sets its own.
 */
const sourcesIn = (directory) => fs.readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourcesIn(full);

    return entry.name.endsWith(".sass") ? [full] : [];
});

const indentOf = (line) => line.length - line.trimStart().length;

// A selector line ending in the universal selector: `.header-main *`, `div *`,
// or a nested `& *`. Property lines never end in `*`, so the shape is enough.
const UNIVERSAL_SELECTOR = /(^|[\s&>+~])\*\s*$/;

const offendersIn = (file) => {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const offenders = [];

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!UNIVERSAL_SELECTOR.test(line) || line.trim().startsWith("//")) continue;

        // The block is every following line indented deeper than the selector.
        const base = indentOf(line);
        for (let inner = index + 1; inner < lines.length; inner++) {
            const body = lines[inner];
            if (body.trim() === "") continue;
            if (indentOf(body) <= base) break;

            if (/font(-size)?\s*:/.test(body))
                offenders.push({file: path.relative(CLIENT_SRC, file), line: index + 1, selector: line.trim()});
        }
    }

    return offenders;
};

describe("sizing text through a universal selector", () => {
    it("finds stylesheets to check", () => {
        assert.ok(sourcesIn(CLIENT_SRC).length > 10, "the stylesheet scan found almost nothing - has the path moved?");
    });

    it("never sets a font through *", () => {
        const offenders = sourcesIn(CLIENT_SRC).flatMap(offendersIn)
            .map((entry) => `${entry.file}:${entry.line}  ${entry.selector}`);

        assert.equal(offenders.length, 0,
            `a universal selector carries a font size, which overrides descendants that meant to inherit - ` +
            `set the size on the container and let inheritance do it:\n${offenders.join("\n")}`);
    });

    // The scan is worthless if its own pattern stops matching the thing it
    // hunts, so it is checked against the rule that actually shipped.
    it("still recognises the shape it exists to catch", () => {
        assert.match(".header-main *", UNIVERSAL_SELECTOR);
        assert.match("  & *", UNIVERSAL_SELECTOR);
    });

    it("does not object to an honest selector", () => {
        assert.doesNotMatch(".header-main", UNIVERSAL_SELECTOR);
        assert.doesNotMatch(".pagination-item p", UNIVERSAL_SELECTOR);
    });
});
