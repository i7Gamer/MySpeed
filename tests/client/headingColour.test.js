import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, walkSources } from "../helpers/source.js";

/**
 * Nothing in this application sets a document-level text colour.
 *
 * `body, html` in common/styles/default.sass sets the background, the family
 * and the weight and stops there, so every element that paints text has to say
 * what colour to paint it in. An element that does not inherits from an
 * ancestor that does not either, and lands on the browser's own default - which
 * is black, on a near-black dialog.
 *
 * That is not a hypothetical. The targets manager drew every target's name in
 * `rgb(0, 0, 0)` on `rgb(26, 32, 41)`: a contrast ratio of 1.28:1, against the
 * 4.5:1 the palettes are otherwise held to by paletteContrast.test.js. The
 * detail line *underneath* each name was brighter than the name itself, because
 * it had a colour and the heading did not. Eighteen heading rules in the client
 * declared one; that one did not, and nothing could see it, because the
 * contrast suite measures the palette rather than what uses it.
 */

const SASS = /\.sass$/;

/**
 * Every heading rule in a stylesheet, as its indented block.
 *
 * Sass is indentation-scoped, so a rule owns the lines indented further than
 * its selector, up to the first line that is not. Blank lines belong to the
 * block: a rule with a gap in the middle of it is still one rule.
 */
const headingRules = (source, file) => {
    const lines = source.split(/\r?\n/);
    const rules = [];

    for (let index = 0; index < lines.length; index++) {
        const selector = /^(\s*)(h[1-4](\s*,\s*h[1-4])*)\s*$/.exec(lines[index]);
        if (!selector) continue;

        const indent = selector[1].length;
        const body = [];

        for (let at = index + 1; at < lines.length; at++) {
            if (lines[at].trim() === "") continue;
            if (lines[at].match(/^\s*/)[0].length <= indent) break;
            body.push(lines[at].trim());
        }

        rules.push({file, line: index + 1, selector: selector[2], body});
    }

    return rules;
};

const declares = (body, property) =>
    body.some((line) => new RegExp(`^${property}\\s*:`).test(line));

describe("headings say what colour they are", () => {
    const rules = walkSources("client/src", SASS)
        .flatMap(({path, source}) => headingRules(source, path))
        // A rule that only positions - a margin reset, a nested layout tweak -
        // is not the one that paints the text, and the block that does carries
        // the size or the weight with it.
        .filter(({body}) => declares(body, "font-size") || declares(body, "font-weight"));

    it("finds the heading rules at all", () => {
        assert.ok(rules.length >= 15,
            `read ${rules.length} heading rules out of the stylesheets`);
    });

    it("gives every one of them a colour", () => {
        const bare = rules.filter(({body}) => !declares(body, "color"));

        assert.deepEqual(bare.map(({file, line, selector}) => `${file}:${line} ${selector}`), [],
            "a heading that styles its text but never colours it paints in the browser's "
            + "default, which is black - and no ancestor in this application sets one");
    });
});

/**
 * The wizard is the one dialog with no DialogHeader, so each step's own `h2` is
 * the only title on the screen. Three of the four painted it in the secondary
 * grey at a weight *lighter* than the paragraph beneath it - `body` is 600 and
 * they were 500 - so the title read as a caption and the step read as belonging
 * to a different application than the one behind it.
 */
describe("the wizard's steps agree on what a step title looks like", () => {
    const STEPS = ["Greetings", "ProviderChooser", "DataHelper", "OoklaLicense"];

    const titleOf = (step) => {
        const source = readSource(
            `client/src/common/components/WelcomeDialog/steps/${step}/styles.sass`);
        const rule = headingRules(source, step).find(({selector}) => selector === "h2");

        assert.ok(rule, `${step} draws no h2`);

        const value = (property) =>
            rule.body.find((line) => line.startsWith(`${property}:`))?.split(":")[1]?.trim();

        return {colour: value("color"), weight: value("font-weight")};
    };

    it("draws every step's title in the same colour and weight", () => {
        const titles = STEPS.map((step) => [step, titleOf(step)]);
        const [, first] = titles[0];

        for (const [step, title] of titles)
            assert.deepEqual(title, first,
                `${step}'s title is drawn differently from ${titles[0][0]}'s`);
    });

    // The point of the rule above: a title has to outrank the prose under it,
    // and `body, html` sets 600, so anything lighter is a title in caption's
    // clothing.
    it("does not draw a title lighter than the body text it sits above", () => {
        for (const step of STEPS) {
            const {weight} = titleOf(step);
            assert.ok(Number(weight) >= 600, `${step}'s title is ${weight}, lighter than the body`);
        }
    });
});
