import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as sass from "sass";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const aliasImporter = {
    findFileUrl(url) {
        if (!url.startsWith("@/")) return null;
        return pathToFileURL(path.join(CLIENT_SRC, url.slice(2)));
    }
};

const compile = (stylesheet) =>
    sass.compile(path.join(CLIENT_SRC, stylesheet), {importers: [aliasImporter]}).css;

// The rules outside any @media, i.e. what a desktop actually gets.
const base = (css) => css.split("@media")[0];

const ruleFor = (css, selector) =>
    css.match(new RegExp(`(?:^|})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)}`));

const marginTopOf = (css, selector) => {
    const rule = ruleFor(css, selector);
    assert.notEqual(rule, null, `${selector} has no rule`);

    const match = rule[1].match(/margin-top:\s*([\d.]+rem)/);
    assert.notEqual(match, null, `${selector} declares no margin-top`);

    return match[1];
};

const header = base(compile("common/components/Header/styles.sass"));
const toolbar = base(compile("common/components/PageToolbar/styles.sass"));

/**
 * The header is framed by two gaps that nothing draws in common: its own top
 * margin above it, and the page toolbar's top margin below it. They were 3rem
 * and 2rem, so the header sat visibly low in its own band. The two live in
 * different stylesheets and can only be kept in step by something that fails
 * when they drift.
 */
describe("the space around the header", () => {
    it("is the same above it as below it", () => {
        assert.equal(marginTopOf(header, ".header-main"), marginTopOf(toolbar, ".page-toolbar"));
    });
});
