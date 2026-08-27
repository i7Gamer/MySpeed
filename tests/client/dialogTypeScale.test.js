import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CLIENT_SRC, compile, mediaBlocks, read, rules } from "../helpers/sass.mjs";

/**
 * One text scale across every dialog.
 *
 * The dialogs had drifted to fifteen different sizes between 0.7rem and
 * 1.25rem, and the same role was drawn at four of them - a labelled row's
 * heading was 0.9rem in the preferences, 0.95rem in the frequency and targets
 * dialogs, 1rem in four more and 1.05rem when creating a node. Opening two
 * dialogs in turn showed the same kind of text at two sizes, which is what the
 * preferences dialog made obvious: it was the smallest of the set.
 *
 * This is asserted against the compiled stylesheets rather than their source,
 * so a dialog that reintroduces a literal is caught as surely as one that
 * invents a new token.
 *
 * Only the small end is pinned. Sizes above the lead step are headings and hero
 * text that were already at or above the body scale, and the rule this file
 * exists to keep is that nothing is drawn *smaller* than its peers - text that
 * is already comfortable must not shrink to meet text that was too small.
 */
const scale = (() => {
    const source = read("common/styles/_typography.sass");
    const value = (name) => {
        const match = source.match(new RegExp(`\\$${name}:\\s*([\\d.]+)rem`));
        assert.ok(match, `$${name} is not declared in _typography.sass`);
        return parseFloat(match[1]);
    };

    return {title: value("dialog-title"), lead: value("dialog-lead"),
        body: value("dialog-body"), hint: value("dialog-hint")};
})();

/**
 * The stylesheets a dialog is drawn from.
 *
 * Discovered rather than listed: a dialog added later is in scope the day it
 * exists, which a hand-kept list is exactly the wrong shape for.
 */
const dialogStylesheets = () => {
    const walk = (dir) => fs.readdirSync(path.join(CLIENT_SRC, dir), {withFileTypes: true})
        .flatMap((entry) => {
            const relative = `${dir}/${entry.name}`;
            if (entry.isDirectory()) return walk(relative);
            return entry.name === "styles.sass" ? [relative] : [];
        });

    return walk("common/components")
        .concat(walk("pages/Nodes/components"), ["common/contexts/Dialog/styles.sass"])
        .filter((file) => /Dialog|dialog|DateRangePicker|LockedNotice|FormField|SelectableOption|SegmentedControl/.test(file));
};

/**
 * A glyph is a picture, not a sentence.
 *
 * The arrows stacked two to a row in the targets dialog sit in a 1.1rem box and
 * answer to that box rather than to how readable a sentence is, so folding them
 * into a text scale would only break their rows.
 */
const GLYPH = /(^|[\s>])svg$|\.target-reorder .target-action/;

const REM = /^([\d.]+)rem$/;

/**
 * The base sizes only.
 *
 * A responsive override is one step every dialog takes together at the same
 * width, so it cannot make two of them disagree - and holding it to the scale
 * would mean either shrinking a title further than it already shrinks on a
 * narrow screen or growing it back to its desktop size on a 320px header.
 * What this file governs is the size a dialog is drawn at, not how it yields.
 */
const outsideMediaQueries = (file) => {
    const css = compile(file);
    const responsive = mediaBlocks(css).map(({body}) => body).join("\n");

    return rules(css).filter(({selector, body}) =>
        !responsive.includes(`${selector}{${body}}`) && !responsive.includes(body.trim()));
};

const textSizes = (file) => outsideMediaQueries(file)
    .filter(({selector}) => !GLYPH.test(selector))
    .flatMap(({selector, body}) => [...body.matchAll(/font-size:\s*([^;]+)/g)]
        .map((match) => ({selector, raw: match[1].trim()})))
    .map((entry) => ({...entry, rem: REM.test(entry.raw) ? parseFloat(REM.exec(entry.raw)[1]) : null}))
    .filter((entry) => entry.rem !== null);

describe("the dialog text scale", () => {
    const files = dialogStylesheets();

    it("covers every dialog stylesheet", () => {
        assert.ok(files.length >= 15, `only ${files.length} dialog stylesheets were found`);
    });

    it("declares four steps, largest to smallest", () => {
        assert.ok(scale.title > scale.lead, "the title is not above the lead");
        assert.ok(scale.lead > scale.body, "the lead is not above the body");
        assert.ok(scale.body > scale.hint, "the body is not above the hint");
    });

    /**
     * The whole of the complaint: no dialog may draw text smaller than the
     * quietest step. 0.7rem is below every browser's minimum for readable text
     * and was being used for a unit label a user has to read to know what a
     * number means.
     */
    it("draws no text smaller than the hint step", () => {
        const small = files.flatMap((file) => textSizes(file)
            .filter((entry) => entry.rem < scale.hint)
            .map((entry) => `${file} ${entry.selector} = ${entry.raw}`));

        assert.deepEqual(small, [], `text below ${scale.hint}rem:\n${small.join("\n")}`);
    });

    /**
     * And within the range the scale governs, only the steps themselves - so a
     * dialog cannot land halfway between two of them and reintroduce the drift.
     */
    it("uses only the steps at and below the lead", () => {
        const allowed = new Set([scale.hint, scale.body, scale.lead]);

        const offScale = files.flatMap((file) => textSizes(file)
            .filter((entry) => entry.rem <= scale.lead && !allowed.has(entry.rem))
            .map((entry) => `${file} ${entry.selector} = ${entry.raw}`));

        assert.deepEqual(offScale, [], `off the scale:\n${offScale.join("\n")}`);
    });

    // The dialog the complaint was about, named so the regression is obvious
    // rather than one line in a list of forty.
    it("draws the preferences dialog at the same sizes as the rest", () => {
        const sizes = textSizes("common/components/PreferencesDialog/styles.sass");

        assert.ok(sizes.length > 0, "the preferences dialog declares no text sizes at all");
        for (const entry of sizes)
            assert.ok(entry.rem >= scale.hint,
                `${entry.selector} is ${entry.raw}, below the hint step`);
    });
});
