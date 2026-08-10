import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as sass from "sass";
import fs from "node:fs";
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

const compile = (stylesheet) =>
    sass.compile(path.join(CLIENT_SRC, stylesheet), {importers: [aliasImporter]}).css;

const bar = compile("pages/Home/components/StatusBar/styles.sass");
const button = compile("pages/Home/components/StartTestButton/styles.sass");

const source = fs.readFileSync(
    path.join(CLIENT_SRC, "pages/Home/components/StatusBar/StatusBarComponent.jsx"), "utf8");

// Everything before the first @media, i.e. what a desktop actually gets.
const base = (css) => css.split("@media")[0];

const blockOf = (selector, css) => {
    for (const [, selectors, body] of base(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (selectors.trim() === selector) return body;
    }
    return null;
};

const remOf = (selector, property, css) => {
    const body = blockOf(selector, css);
    assert.notEqual(body, null, `${selector} has no rule of its own`);

    const match = body.match(new RegExp(`(?:^|;)\\s*${property}:\\s*([\\d.]+)rem`));
    assert.notEqual(match, null, `${selector} declares no ${property} in rem`);

    return Number(match[1]);
};

/**
 * What the bar used to be: the state line and its detail stacked in a column,
 * every part of it a size below the rows it sits above. The overview's own
 * measurements are set in 28pt, so a 1.1rem state line and a 0.9rem button read
 * as fine print above them.
 *
 * These are the sizes being replaced, kept here so "bigger" is an assertion
 * rather than a claim in a commit message.
 */
const PREVIOUS_STATE_SIZE = 1.1;
const PREVIOUS_DETAIL_SIZE = 0.9;
const PREVIOUS_BUTTON_SIZE = 0.9;

describe("the overview status bar reads at the size of the page around it", () => {
    it("sets the state line and its detail side by side, not stacked", () => {
        const body = blockOf(".status-text", bar);

        assert.notEqual(body, null, "the text column has no rule of its own");
        assert.match(body, /flex-direction:\s*row/);
        assert.doesNotMatch(body, /flex-direction:\s*column/);
    });

    // Side by side only works while there is room: the state line grows to
    // "Measuring download" and the detail carries a live speed beside it.
    it("lets them wrap rather than squeezing them onto one line", () => {
        assert.match(blockOf(".status-text", bar), /flex-wrap:\s*wrap/);
    });

    // Two sizes of text on one line sit on a shared baseline; centred, the
    // smaller one floats visibly high against the larger.
    it("aligns the two on a shared baseline", () => {
        assert.match(blockOf(".status-text", bar), /align-items:\s*baseline/);
    });

    it("enlarges the state line", () => {
        assert.ok(remOf(".status-text h2", "font-size", bar) > PREVIOUS_STATE_SIZE,
            "the state line is no larger than the size it replaced");
    });

    it("enlarges the detail beside it", () => {
        assert.ok(remOf(".status-detail", "font-size", bar) > PREVIOUS_DETAIL_SIZE,
            "the detail text is no larger than the size it replaced");
    });

    it("keeps the state line the largest text in the bar", () => {
        assert.ok(remOf(".status-text h2", "font-size", bar) > remOf(".status-detail", "font-size", bar));
    });
});

/**
 * The bar was as tall as a row in the list below it - same height, same corner,
 * same glass - so it read as a card rather than as the chrome above one, and
 * the two controls beside it looked stuck to its sides. Lifting the start
 * button out is what let it shrink: the button was the tallest thing in it, and
 * everything else in the bar is a single line of text.
 */
describe("the status bar after the start button moved out", () => {
    it("no longer renders the start button", () => {
        assert.doesNotMatch(source, /status-start|StartTestButton/);
    });

    it("keeps nothing behind that only the button needed", () => {
        for (const dead of ["startSpeedtest", "startBlockedReason", "START_BLOCKED_RUNNING"])
            assert.doesNotMatch(source, new RegExp(dead), `${dead} is still imported or used`);
    });

    // The bar still owns the run's progress and the last test's state - it is
    // the status bar, not a title bar.
    it("still owns the progress track and the recent failures", () => {
        assert.match(source, /status-progress/);
        assert.match(source, /status-failures/);
    });

    it("is no taller than the single line of text it now holds", () => {
        const padding = blockOf(".status-main", bar).match(/(?:^|;)\s*padding:\s*([\d.]+)rem/);

        assert.notEqual(padding, null, "the bar declares no vertical padding in rem");
        assert.ok(Number(padding[1]) < 1.25, "the bar keeps the padding it had while it held the button");
    });

    /**
     * The track used to sit below the content and add its own 4px, so every
     * control in the row - all stretched to the bar's height - grew by 4px the
     * moment a test started and shrank again when it finished. Taken out of the
     * flow it overlays the bar's bottom edge instead, and the row holds still.
     */
    it("overlays its progress track rather than growing by it", () => {
        assert.match(blockOf(".status-progress", bar), /position:\s*absolute/);
        assert.match(blockOf(".status-bar", bar), /position:\s*relative/);
    });
});

/**
 * The button sets the height of the whole toolbar row - it is the tallest
 * control in it - so its size is the one every other control is measured
 * against. It keeps the enlarged text it was given while it still lived in the
 * bar.
 */
describe("the start test button", () => {
    it("has a stylesheet of its own now that it has a component of its own", () => {
        assert.notEqual(blockOf(".start-test", button), null, "the button has no rule of its own");
    });

    it("keeps its enlarged text", () => {
        assert.ok(remOf(".start-test", "font-size", button) > PREVIOUS_BUTTON_SIZE,
            "the button text is no larger than the size it replaced");
    });

    it("still reads as the primary action rather than a link", () => {
        const body = blockOf(".start-test", button);

        assert.match(body, /border:/);
        assert.match(body, /font-weight:\s*[67]00/);
        assert.match(body, /cursor:\s*pointer/);
    });

    it("says when it cannot be pressed", () => {
        assert.match(button, /:disabled/);
    });
});
