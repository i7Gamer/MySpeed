import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as sass from "sass";

/**
 * The one sass scaffold and the one set of CSS parsers for the stylesheet
 * tests.
 *
 * Each of these lived as a private copy per test file, and the copies had
 * drifted: two rules() implementations disagreed about @media nesting, two
 * ceiling extractors disagreed about squeeze blocks, and every copy of the
 * alias importer restated the "@/ means client/src" policy that
 * aliasResolver.mjs already encodes for the module loader. A parser bug fixed
 * here is fixed for every suite at once; sassTestHelpers.test.js pins the
 * cases that separated the old copies.
 */
export const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

// The stylesheet-side twin of aliasResolver.mjs: sass resolves its own
// imports, so the loader hook cannot help it.
export const aliasImporter = {
    findFileUrl(url) {
        if (!url.startsWith("@/")) return null;
        return pathToFileURL(path.join(CLIENT_SRC, url.slice(2)));
    }
};

export const compile = (file) => sass.compile(path.join(CLIENT_SRC, file), {importers: [aliasImporter]}).css;

export const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

/**
 * Every @media block, as its raw condition and body.
 *
 * The block is captured by counting braces rather than by looking for a
 * close-brace on its own line: a body may nest arbitrary rules, and the
 * old newline heuristic only held for one compiler output style.
 */
export const mediaBlocks = (css) => {
    const blocks = [];
    const opener = /@media([^{]*)\{/g;

    let match;
    while ((match = opener.exec(css)) !== null) {
        let depth = 1;
        let index = opener.lastIndex;

        while (depth > 0 && index < css.length) {
            if (css[index] === "{") depth++;
            else if (css[index] === "}") depth--;
            index++;
        }

        blocks.push({condition: match[1], body: css.slice(opener.lastIndex, index - 1)});
    }

    return blocks;
};

/** The body of every media query whose condition mentions the given text. */
export const queriesMentioning = (css, condition) => mediaBlocks(css)
    .filter((block) => block.condition.includes(condition))
    .map((block) => block.body);

/**
 * Every max-width ceiling a stylesheet reflows on, in declaration order.
 *
 * Blocks that also state a min-width are skipped: a squeeze zone is bounded at
 * both ends, so it is placed by neither and is not a stage.
 */
export const ceilings = (css) => mediaBlocks(css)
    .map(({condition}) => condition)
    .filter((condition) => !condition.includes("min-width"))
    .map((condition) => Number(condition.match(/max-width:\s*(\d+)px/)?.[1]))
    .filter(Number.isFinite);

/**
 * Every rule as a flat selector-and-body pair, wherever it is nested.
 *
 * The @media and @container headers are dropped rather than parsed so the
 * rules inside them are seen individually - a naive single pass reads a whole
 * nested block as one rule. Selectors are trimmed, whitespace-collapsed and
 * quote-stripped: sass emits `[data-compact=all]` for a source that wrote
 * quotes, and a comparison has to land on one spelling.
 */
export const rules = (css) => [...css.replace(/@(media|container)[^{]*\{/g, "").matchAll(/([^{}]+)\{([^}]*)}/g)]
    .map(([, selector, body]) => ({
        selector: selector.replace(/["']/g, "").replace(/\s+/g, " ").trim(),
        body
    }))
    .filter(({selector}) => selector.length > 0);
