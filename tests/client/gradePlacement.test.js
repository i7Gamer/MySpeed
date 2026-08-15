import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as sass from "sass";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const aliasImporter = {
    findFileUrl(url) {
        if (!url.startsWith("@/")) return null;
        return pathToFileURL(path.join(CLIENT_SRC, url.slice(2)));
    }
};

const compile = (file) => sass.compile(path.join(CLIENT_SRC, file), {importers: [aliasImporter]}).css;

/**
 * Every view that states a graded measurement, and the two things each of them
 * has to get right: the row publishes its grade, and the figure inside it is not
 * itself painted with one.
 *
 * Four views drew this three different ways before anyone noticed. The statistics
 * panels coloured their figures, the overview rows and node cards coloured only
 * their glyphs, and the detail pane did both - glyphs on its three cards, whole
 * parts on the two sub-figures beside the ping. So the assertion is written once,
 * against every view at once, rather than left to each view's own test file where
 * a fifth view could be added without meeting it.
 */
const VIEWS = [
    {
        name: "the overview row",
        file: "pages/Home/components/Speedtest/SpeedtestComponent.jsx",
        styles: "pages/Home/components/Speedtest/styles.sass",
        // Three measurements, plus the date and the failure line - neither is a
        // verdict, but both draw a glyph that reads whatever its container
        // publishes, so both have to publish something.
        publishes: 5,
        value: ".speedtest-text"
    },
    {
        name: "the node card",
        file: "pages/Nodes/components/NodeContainer/NodeContainer.jsx",
        styles: "pages/Nodes/components/NodeContainer/styles.sass",
        publishes: 3,
        value: ".speed-item h1"
    },
    {
        name: "the statistics panels",
        file: "pages/Statistics/components/PanelRow/PanelRow.jsx",
        styles: "pages/Statistics/components/PanelRow/styles.sass",
        // One component, drawn once per row by all four panels.
        publishes: 1,
        value: ".panel-row-value"
    },
    {
        name: "the detail pane",
        file: "common/components/TestDetails/TestDetails.jsx",
        styles: "common/components/TestDetails/styles.sass",
        publishes: 1,
        value: ".detail-metric-value"
    }
];

// The colours a grade resolves to. A figure painted with one of these is a
// figure making a claim the glyph beside it is already making.
const GRADE_PROPERTIES = /var\(--grade(-good|-fair|-poor|-none|-failed)?\)/;

// Sass drops the quotes from an attribute selector's value, so a test written
// against the source spelling never matches the stylesheet it compiled to.
const attribute = (name, value) => `\\[${name}=["']?${value}["']?\\]`;

describe("a grade is worn by a glyph, not by a figure", () => {
    for (const {name, file, styles, publishes, value} of VIEWS) {
        const source = read(file);
        const css = compile(styles);

        it(`${name} publishes its grade on the row`, () => {
            const stated = source.match(/data-grade=/g) ?? [];

            assert.equal(stated.length, publishes,
                `expected ${publishes} row(s) to state a grade, found ${stated.length}`);
        });

        it(`${name} states its figure in a colour of its own`, () => {
            const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const base = css.match(new RegExp(`(?<![\\w-])${escaped}\\s*\\{([^}]*)}`));

            assert.notEqual(base, null, `${value} is no longer a rule of its own`);
            assert.doesNotMatch(base[1], GRADE_PROPERTIES,
                `${value} paints itself with the grade, so the reading states it twice`);
        });

        /**
         * And it can be opted in, which is the point of publishing the grade
         * rather than handing it to each part: turning this on is a preference,
         * not a revert.
         */
        it(`${name} can be set to state it twice`, () => {
            const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

            assert.match(css, new RegExp(`:root${attribute("data-grade-values", "on")} ${escaped}\\s*\\{[^}]*color:\\s*var\\(--grade,`),
                `${value} cannot follow the setting - the mixin is not applied to it`);
        });

        /**
         * And a row that earned no grade keeps the colour it had.
         *
         * `--grade` is published by the [data-grade] rules, and a row with no
         * verdict deliberately omits the attribute - PanelRow renders
         * `data-grade={level || undefined}`. A bare var(--grade) is then invalid
         * at computed-value time, which for an inherited property means the
         * declaration is thrown away *and* the rule's own `color` with it, so
         * the figure inherits - and nothing up to body sets a colour, so every
         * ungraded row rendered black on the dark ground the moment the setting
         * was turned on. The glyph mixin beside it always took a fallback; this
         * one has to as well, and it has to be the row's own colour rather than
         * an arbitrary one, or turning the setting on restyles rows that have
         * nothing to state.
         */
        it(`${name} keeps its own colour on a row that earned no grade`, () => {
            const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

            const base = css.match(new RegExp(`(?<![\\w-])${escaped}\\s*\\{([^}]*)}`));
            const ownColour = base?.[1].match(/color:\s*([^;\n}]+)/)?.[1].trim();

            assert.notEqual(ownColour, undefined, `${value} states no colour of its own`);

            // Lazily to the paren that closes the var(), not to the first one:
            // every one of these falls back to a custom property, so the
            // fallback has a nested pair of its own.
            const optIn = css.match(new RegExp(
                `:root${attribute("data-grade-values", "on")} ${escaped}\\s*\\{[^}]*color:\\s*var\\(--grade,\\s*(.+?)\\)\\s*[;}]`));

            assert.notEqual(optIn, null, `${value} falls back to nothing when the row published no grade`);
            assert.equal(optIn[1].trim(), ownColour,
                `${value} changes colour on an ungraded row when the setting is turned on`);
        });
    }
});

/**
 * A glyph resolves the grade rather than racing an icon-* class for it.
 *
 * The utilities and a component's own glyph rule are both a single class, so
 * which of them wins came down to which the bundler emitted last. That is not a
 * theoretical fragility: moving the utilities to the top of default.sass was
 * enough to un-grade every glyph on the overview row at once, and
 * .panel-row-icon had been losing the same race from the day it was written -
 * so the statistics panels stated their grade on the figure alone, which is the
 * inconsistency this whole change started from.
 */
describe("a glyph resolves its grade rather than racing for it", () => {
    // Every glyph rule that states a colour of its own. A grade has to be able
    // to override each of them, whatever order the bundle happens to be in.
    const GLYPHS = [
        {name: ".speedtest-icon", styles: "common/styles/default.sass"},
        {name: ".container-icon", styles: "common/styles/default.sass"},
        {name: ".panel-row-icon", styles: "pages/Statistics/components/PanelRow/styles.sass"}
    ];

    for (const {name, styles} of GLYPHS) {
        it(`${name} reads the grade its row published`, () => {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const rule = compile(styles).match(new RegExp(`(?<![\\w-])${escaped}\\s*\\{([^}]*)}`));

            assert.notEqual(rule, null, `${name} is no longer a rule of its own`);
            assert.match(rule[1], /color:\s*var\(--grade,\s*[^)]+\)/,
                `${name} states a colour a grade has to outweigh to be seen`);
        });
    }
});

/**
 * The palette is one file, so a theme is one file.
 *
 * Nothing under components/ names a colour for a grade: the icon-* utilities
 * every glyph wears resolve through --grade-*, and those resolve through the
 * accent palette that the [data-theme] blocks already override. A palette in
 * which "good" is not green is a change to _grade-palette.sass alone.
 */
describe("what a grade looks like is stated in one place", () => {
    const palette = compile("common/styles/default.sass");

    it("defines a property per verdict rather than a colour per utility", () => {
        for (const property of ["--grade-good", "--grade-fair", "--grade-poor", "--grade-none", "--grade-failed"])
            assert.match(palette, new RegExp(`${property}:`), `${property} is not defined`);
    });

    it("paints the glyph utilities from those properties", () => {
        for (const [utility, property] of [
            [".icon-green", "--grade-good"], [".icon-orange", "--grade-fair"],
            [".icon-red", "--grade-poor"], [".icon-blue", "--grade-none"],
            [".icon-error", "--grade-failed"]
        ]) {
            const rule = palette.match(new RegExp(`\\${utility}\\s*\\{([^}]*)}`));

            assert.notEqual(rule, null, `${utility} is gone`);
            assert.match(rule[1], new RegExp(`color:\\s*var\\(${property}\\)`),
                `${utility} names a colour instead of reading ${property}`);
        }
    });

    // "Not measured" and "bad" are different claims, and a grader that has no
    // reading returns the blue token rather than the red one.
    it("keeps an unmeasured figure apart from a bad one", () => {
        const none = palette.match(/--grade-none:\s*([^;\n}]*)/)?.[1]?.trim();
        const poor = palette.match(/--grade-poor:\s*([^;\n}]*)/)?.[1]?.trim();

        assert.notEqual(none, undefined);
        assert.notEqual(none, poor, "a figure nobody measured is painted like a bad one");
    });

    /**
     * Including the two progress bars, which were the one part of the interface
     * a retheme did not reach.
     *
     * `.value-bar-fill` and `.detail-target-fill` each carried their own
     * icon-* -> $accent-* table, so editing --grade-good moved every glyph and
     * every graded figure while both bars kept the old accent - a green bar
     * under an orange-graded icon.
     */
    it("paints the graded fills from those properties too", () => {
        for (const [file, selector] of [
            ["pages/Statistics/charts/AverageChart/styles.sass", ".value-bar-fill"],
            ["common/components/TestDetails/styles.sass", ".detail-target-fill"]
        ]) {
            const css = compile(file);

            for (const [utility, property] of [
                ["icon-green", "--grade-good"], ["icon-orange", "--grade-fair"],
                ["icon-red", "--grade-poor"], ["icon-blue", "--grade-none"],
                ["icon-error", "--grade-failed"]
            ]) {
                const rule = css.match(new RegExp(
                    `\\${selector}\\.${utility}\\s*\\{([^}]*)}`));

                assert.notEqual(rule, null, `${selector}.${utility} is not a rule in ${file}`);
                assert.match(rule[1], new RegExp(`background-color:\\s*var\\(${property}\\)`),
                    `${selector}.${utility} names a colour instead of reading ${property}`);
            }
        }
    });

    // Written out per stylesheet is how the two came to differ from the palette
    // in the first place.
    it("keeps the table in one place", () => {
        for (const file of [
            "pages/Statistics/charts/AverageChart/styles.sass",
            "common/components/TestDetails/styles.sass"
        ])
            assert.match(read(file), /\+graded-fill/,
                `${file} carries its own grade-to-colour table again`);
    });

    it("resolves a row's grade from the same properties", () => {
        for (const [token, property] of [
            ["green", "--grade-good"], ["orange", "--grade-fair"], ["red", "--grade-poor"],
            ["blue", "--grade-none"], ["error", "--grade-failed"]
        ])
            assert.match(palette,
                new RegExp(`${attribute("data-grade", token)}\\s*\\{\\s*--grade:\\s*var\\(${property}\\)`),
                `a row graded "${token}" resolves to something other than ${property}`);
    });
});
