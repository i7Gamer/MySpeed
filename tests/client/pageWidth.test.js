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

const layout = base(compile("common/styles/default.sass"));
const statistics = base(compile("pages/Statistics/styles.sass"));

const ruleFor = (css, selector) =>
    css.match(new RegExp(`(?:^|})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)}`));

/**
 * The overview and the statistics used to size themselves independently - the
 * overview was an unstyled shrink-to-fit container and the statistics were full
 * width with a 20rem inset each side - so the two pages never lined up. Both now
 * take one container from the layout, and neither may reintroduce a width of
 * its own.
 */
describe("page width", () => {
    it("gives every page the same container", () => {
        const rule = ruleFor(layout, "main > *");

        assert.notEqual(rule, null, "the layout defines no shared page container");
        assert.match(rule[1], /width:\s*100%/);
        assert.match(rule[1], /max-width:\s*\d+px/);
    });

    it("centres that container rather than letting it sit left", () => {
        const rule = ruleFor(layout, "main");

        assert.match(rule[1], /align-items:\s*center/);
    });

    it("does not let the statistics set a width of their own", () => {
        const rule = ruleFor(statistics, ".statistic-area");

        assert.notEqual(rule, null, "the statistics area has no rule");
        assert.doesNotMatch(rule[1], /max-width:/);
    });

    // The inset was what made the page narrower than the overview; padding is
    // the only thing that can reintroduce the difference now.
    it("does not inset the statistics from the shared container", () => {
        const rule = ruleFor(statistics, ".statistic-area");

        assert.doesNotMatch(rule[1], /padding-left:/);
        assert.doesNotMatch(rule[1], /padding-right:/);
    });
});

describe("the gap between cards", () => {
    const overview = base(compile("pages/Home/components/Speedtest/styles.sass"));

    const gapOf = (css, selector, property) => {
        const rule = ruleFor(css, selector);
        assert.notEqual(rule, null, `${selector} has no rule`);

        const match = rule[1].match(new RegExp(`${property}:\\s*([\\d.]+rem)`));
        assert.notEqual(match, null, `${selector} declares no ${property}`);

        return match[1];
    };

    // Two pages showing the same history should not be spaced differently, and
    // the two values live in different stylesheets - so they can only be kept
    // in step by something that fails when they drift.
    it("is the same on the overview and in the statistics", () => {
        assert.equal(gapOf(overview, ".speedtest-entry", "margin-bottom"),
            gapOf(statistics, ".statistic-area", "gap"));
    });
});
