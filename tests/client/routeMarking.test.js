import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import * as sass from "sass";
import { fileURLToPath, pathToFileURL } from "node:url";

/*
 * Whether the mark on a lossy hop reaches the screen.
 *
 * routeSection.test.js pins the class onto the row, which is where the
 * marking was believed to end - but a class only marks anything if its rule
 * outranks the one it is meant to override, and ".detail-hop-lost td" lost to
 * the ".detail-route table td" beside it on specificity alone. Every hop drew
 * in the ordinary colour and the preview pass is what caught it, because a
 * class assertion cannot see a rule that never applies.
 */

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const aliasImporter = {
    findFileUrl(url) {
        if (!url.startsWith("@/")) return null;
        return pathToFileURL(path.join(CLIENT_SRC, url.slice(2)));
    }
};

const css = sass.compile(path.join(CLIENT_SRC, "common/components/TestDetails/styles.sass"),
    {importers: [aliasImporter]}).css;

/**
 * The (ids, classes, elements) of one selector, which is what the cascade
 * compares before it falls back to source order. Enough for the selectors in
 * this file: classes, element names and descendant combinators, no ids and no
 * pseudo-classes that carry a specificity of their own.
 */
export const specificity = (selector) => {
    const ids = (selector.match(/#[\w-]+/g) ?? []).length;
    const classes = (selector.match(/\.[\w-]+/g) ?? []).length;
    const elements = (selector.match(/(?:^|[\s>+~])([a-z][\w-]*)/g) ?? []).length;

    return [ids, classes, elements];
};

const outranks = (a, b) => {
    const left = specificity(a);
    const right = specificity(b);

    for (let i = 0; i < left.length; i++) {
        if (left[i] !== right[i]) return left[i] > right[i];
    }

    return false;
};

/** Every rule that declares `color` on a `td`, as [selector, value]. */
const cellColourRules = [...css.matchAll(/([^{}]+)\{([^}]*)}/g)]
    .filter(([, selector]) => /\btd\b/.test(selector))
    .map(([, selector, body]) => [selector.trim(), body.match(/(?:^|[;\s])color:\s*([^;]+)/)?.[1]?.trim()])
    .filter(([, value]) => value !== undefined);

describe("the mark on a hop that lost probes", () => {
    it("is declared", () => {
        const marked = cellColourRules.filter(([selector]) => selector.includes(".detail-hop-lost"));

        assert.equal(marked.length, 1, "one rule colours the cells of a lost hop");
    });

    it("outranks every other rule that colours a cell of the table", () => {
        const [marked] = cellColourRules.filter(([selector]) => selector.includes(".detail-hop-lost"));
        const others = cellColourRules.filter(([selector]) => !selector.includes(".detail-hop-lost"));

        assert.ok(others.length > 0, "the table colours its cells at all");

        for (const [selector] of others) {
            assert.ok(outranks(marked[0], selector),
                `"${marked[0]}" must outrank "${selector}", or the mark never draws`);
        }
    });

    it("is a colour of its own, not the one every other cell already has", () => {
        const [marked] = cellColourRules.filter(([selector]) => selector.includes(".detail-hop-lost"));
        const others = cellColourRules.filter(([selector]) => !selector.includes(".detail-hop-lost"));

        for (const [, value] of others) assert.notEqual(marked[1], value);
    });
});
