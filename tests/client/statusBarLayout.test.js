import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as sass from "sass";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

// Stands in for the "@/" alias vite gives the client, which the stylesheets use
// to reach the shared colour and layout definitions.
const aliasImporter = {
    findFileUrl(url) {
        if (!url.startsWith("@/")) return null;
        return pathToFileURL(path.join(CLIENT_SRC, url.slice(2)));
    }
};

const compiled = sass.compile(
    path.join(CLIENT_SRC, "pages/Home/components/StatusBar/styles.sass"),
    {importers: [aliasImporter]}
).css;

// Everything before the first @media, i.e. what a desktop actually gets.
const base = compiled.split("@media")[0];

const blockOf = (selector, css = base) => {
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (selectors.trim() === selector) return body;
    }
    return null;
};

const remOf = (selector, property) => {
    const body = blockOf(selector);
    assert.notEqual(body, null, `${selector} has no rule of its own`);

    const match = body.match(new RegExp(`(?:^|;)\\s*${property}:\\s*([\\d.]+)rem`));
    assert.notEqual(match, null, `${selector} declares no ${property} in rem`);

    return Number(match[1]);
};

/**
 * What the bar used to be: the state line and its detail stacked in a column,
 * every part of it a size below the rows it sits above. The overview's own
 * measurements are set in 28pt, so a 1.1rem state line and a 0.9rem button read
 * as fine print above them - and the start button is the page's primary action.
 *
 * These are the sizes being replaced, kept here so "bigger" is an assertion
 * rather than a claim in a commit message.
 */
const PREVIOUS_STATE_SIZE = 1.1;
const PREVIOUS_DETAIL_SIZE = 0.9;
const PREVIOUS_BUTTON_SIZE = 0.9;
const PREVIOUS_BUTTON_PADDING_Y = 0.6;
const PREVIOUS_BUTTON_PADDING_X = 1.1;

describe("the overview status bar reads at the size of the page around it", () => {
    it("sets the state line and its detail side by side, not stacked", () => {
        const body = blockOf(".status-text");

        assert.notEqual(body, null, "the text column has no rule of its own");
        assert.match(body, /flex-direction:\s*row/);
        assert.doesNotMatch(body, /flex-direction:\s*column/);
    });

    // Side by side only works while there is room: the state line grows to
    // "Measuring download" and the detail carries a live speed beside it.
    it("lets them wrap rather than squeezing them onto one line", () => {
        assert.match(blockOf(".status-text"), /flex-wrap:\s*wrap/);
    });

    // Two sizes of text on one line sit on a shared baseline; centred, the
    // smaller one floats visibly high against the larger.
    it("aligns the two on a shared baseline", () => {
        assert.match(blockOf(".status-text"), /align-items:\s*baseline/);
    });

    it("enlarges the state line", () => {
        assert.ok(remOf(".status-text h2", "font-size") > PREVIOUS_STATE_SIZE,
            "the state line is no larger than the size it replaced");
    });

    it("enlarges the detail beside it", () => {
        assert.ok(remOf(".status-detail", "font-size") > PREVIOUS_DETAIL_SIZE,
            "the detail text is no larger than the size it replaced");
    });

    it("enlarges the start button's text", () => {
        assert.ok(remOf(".status-start", "font-size") > PREVIOUS_BUTTON_SIZE,
            "the button text is no larger than the size it replaced");
    });

    it("enlarges the start button itself, not only its text", () => {
        const padding = blockOf(".status-start").match(/(?:^|;)\s*padding:\s*([\d.]+)rem\s+([\d.]+)rem/);

        assert.notEqual(padding, null, "the button declares no padding in rem");
        assert.ok(Number(padding[1]) > PREVIOUS_BUTTON_PADDING_Y, "the button grew no taller");
        assert.ok(Number(padding[2]) > PREVIOUS_BUTTON_PADDING_X, "the button grew no wider");
    });

    // The state line is what the eye should land on first, and the button is
    // the page's primary action - neither may end up the smallest thing here.
    it("keeps the state line the largest text in the bar", () => {
        const state = remOf(".status-text h2", "font-size");

        assert.ok(state > remOf(".status-detail", "font-size"));
        assert.ok(state >= remOf(".status-start", "font-size"));
    });

    it("never lets the button read smaller than the detail beside it", () => {
        assert.ok(remOf(".status-start", "font-size") >= remOf(".status-detail", "font-size"));
    });

    // The narrow layout drops the button onto a full-width row of its own; that
    // arrangement is what keeps the enlarged text from crowding the state line.
    it("still gives the button its own row on a phone", () => {
        const narrow = compiled.split("@media").slice(1).join("@media");

        assert.match(narrow, /\.status-start\s*\{[^}]*flex:\s*1 1 100%/);
    });
});
