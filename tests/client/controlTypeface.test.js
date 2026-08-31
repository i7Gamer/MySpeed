import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile, rules } from "../helpers/sass.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const CLIENT_SRC = path.join(ROOT, "client", "src");

/**
 * The typeface every control is drawn in.
 *
 * A browser does not let a form control inherit the page's font. `input`,
 * `button`, `select` and `textarea` are given the operating system's UI font
 * instead - Arial here - and nothing about setting a font on `body` changes
 * that. So a control is in the app's typeface only where somebody wrote
 * `font-family: inherit` on it by hand, and the ones nobody thought of are
 * quietly in another face entirely.
 *
 * That is what happened. Found on screen, in the app's own dialogs: the Save
 * button of every dialog, the custom cron field and its disclosure, and the
 * header's icon buttons - all Arial, beside labels in Inter. Each had a
 * font-size and a font-weight set, which is what makes the miss so easy: the
 * rule looks like it has settled the type.
 *
 * One reset says it for all of them, and for the ones written next year. The
 * per-component `font-family: inherit` lines that were already there stay
 * correct and are now merely redundant, which is the right way round.
 */
describe("controls are drawn in the page's typeface", () => {
    const globals = fs.readFileSync(path.join(CLIENT_SRC, "common", "styles", "default.sass"), "utf8");

    // The four elements a browser hands its own font to. `optgroup` and
    // `option` inherit from `select` in every engine this app supports.
    const CONTROLS = ["input", "button", "select", "textarea"];

    it("resets the font on every element the browser overrides", () => {
        const compiled = compile("common/styles/default.sass");
        const reset = rules(compiled).filter(({body}) => /font-family:\s*inherit/.test(body));

        assert.notEqual(reset.length, 0,
            "no rule gives the controls the page's font, so each is in the browser's UI font "
            + "until somebody remembers to say otherwise on it");

        const covered = reset.flatMap(({selector}) => selector.split(",").map((one) => one.trim()));

        for (const control of CONTROLS)
            assert.ok(covered.includes(control),
                `<${control}> keeps the browser's own font, so its text does not match the page`);
    });

    /**
     * And it is stated once, globally, rather than per component. The four
     * places this was missed all had a rule of their own that set the size and
     * the weight and stopped there - a shape that reads as finished.
     */
    it("says it in the one stylesheet the app always loads", () => {
        assert.match(globals, /font-family:\s*inherit/,
            "the reset lives somewhere a component has to opt into rather than in the global sheet");
    });
});
