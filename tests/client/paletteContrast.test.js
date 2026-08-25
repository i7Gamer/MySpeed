import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compile, declarationsIn } from "../helpers/sass.mjs";

/**
 * Every palette, held to the bar its own colours have to clear.
 *
 * The palettes are data now - one map entry in _colors.sass - so the thing that
 * has to be automatic is the checking. Nothing here names a palette, a theme or
 * a colour: the blocks are found in the compiled stylesheet and whatever they
 * declare is measured. A fifth palette is held to all of this on the day it is
 * added, by nobody remembering anything.
 *
 * This is the check the shipped light theme did not have. Its accents were
 * chosen against a near-black page and light mode simply kept them, so a grade
 * printed in the old green measured 2.42:1 - and the cyan three components
 * render links and badges in still measured 2.32:1 when this was written,
 * because it is not a grade and no list included it.
 */

const css = compile("common/styles/default.sass");

// ---------------------------------------------------------------- colour maths

const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

/**
 * A declared colour as three channels, in whichever notation it was written.
 *
 * Hex for the values a palette states outright, and rgb() for the ones sass
 * computes - color.mix returns a colour, and sass serialises that as rgb(). A
 * parser that only knew hex would not fail on those, it would skip them, which
 * is the quiet half of the same problem.
 */
const rgb = (value) => {
    const functional = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value);
    if (functional) return [1, 2, 3].map((i) => Number(functional[i]));

    const hex = value.length === 4
        ? [...value.slice(1)].map((digit) => digit + digit)
        : [1, 3, 5].map((i) => value.slice(i, i + 2));

    return hex.map((pair) => parseInt(pair, 16));
};

const luminance = (hex) => {
    const [r, g, b] = rgb(hex).map(channel);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a, b) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
};

/** Linear sRGB to OKLab. Perceptual, which is what a colour difference needs. */
const oklab = ([r, g, b]) => {
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    ];
};

const lightness = (hex) => oklab(rgb(hex).map(channel))[0];

const chroma = (hex) => {
    const [, a, b] = oklab(rgb(hex).map(channel));
    return Math.hypot(a, b);
};

/*
 * Machado et al. (2009) at full severity, applied to linear sRGB.
 *
 * Two kinds and not three. The same paper's tritanopia matrix is the one it
 * says least about, and it shows: checked against the reference model used to
 * pick these colours, a pair it puts at ΔE 9.7 comes out here at 34.8. Deutan
 * and protan agree with that model to the decimal, and between them they are
 * almost every reader who has this. A tritan number that cannot be trusted is
 * worse than no tritan number - it would report a pass on a pair that had
 * collapsed. The palettes were checked against a proper tritan model when they
 * were chosen; what is held here is what can be held honestly.
 *
 * The check itself is not optional. The first attempt at per-palette marks put
 * blue beside purple at ΔE 1.7 for a deutan reader while looking perfectly
 * distinct to everyone who looked at it.
 */
const CVD = {
    deutan: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881],
    protan: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998]
};

const simulate = (hex, matrix) => {
    const [r, g, b] = rgb(hex).map(channel);

    return [
        matrix[0] * r + matrix[1] * g + matrix[2] * b,
        matrix[3] * r + matrix[4] * g + matrix[5] * b,
        matrix[6] * r + matrix[7] * g + matrix[8] * b
    ].map((v) => Math.max(0, Math.min(1, v)));
};

/** How far apart two colours look, ×100 so the numbers read like the literature. */
const separation = (a, b, matrix) => {
    const [first, second] = [a, b].map((hex) => oklab(matrix ? simulate(hex, matrix) : rgb(hex).map(channel)));

    return Math.hypot(...first.map((v, i) => v - second[i])) * 100;
};

/** A colour laid over another at an alpha - what a glass card actually is. */
const composite = (over, alpha, under) => "#" + rgb(over)
    .map((v, i) => Math.round(alpha * v + (1 - alpha) * rgb(under)[i]).toString(16).padStart(2, "0"))
    .join("");

// ------------------------------------------------------------- the stylesheet

/**
 * Every property a selector's blocks declare, in source order - the shared
 * parser, bound to this file's stylesheet. Several blocks share a selector -
 * _colors.sass writes the chrome on `:root` and the default palette on
 * another `:root` - and the later one wins, exactly as the cascade decides.
 *
 * The private copy this replaces matched the selector as a substring, so
 * "default light" also swallowed every `[data-palette=…][data-theme=light]`
 * block and re-measured whichever palette was emitted last under the default
 * label. The helper compares the selector whole.
 */
const declaredIn = (selector) => declarationsIn(css, selector);

/** Follows var() to the value underneath, through however many hops. */
const resolve = (name, block, seen = new Set()) => {
    const value = block[name];
    if (!value || seen.has(name)) return null;

    const reference = /^var\(--([\w-]+)\)$/.exec(value);
    return reference ? resolve(reference[1], block, seen.add(name)) : value;
};

/** The palettes the stylesheet actually emits, found rather than listed. */
const paletteNames = [...new Set([...css.matchAll(/\[data-palette=([\w-]+)\]/g)].map(([, name]) => name))];

// A block per palette per mode, plus the two the unstamped document falls back
// to. The light selector carries both attributes, so its properties have to be
// merged over the dark ones the same way the cascade merges them.
const BLOCKS = [
    ["default dark", declaredIn(":root")],
    ["default light", {...declaredIn(":root"), ...declaredIn("[data-theme=light]")}],
    ...paletteNames.flatMap((name) => [
        [`${name} dark`, {...declaredIn(":root"), ...declaredIn(`[data-palette=${name}]`)}],
        [`${name} light`, {
            ...declaredIn(":root"),
            ...declaredIn(`[data-palette=${name}]`),
            ...declaredIn(`[data-palette=${name}][data-theme=light]`)
        }]
    ])
];

// The same blocks unmerged. The merged ones above model the cascade, which is
// what a contrast check needs - and which is exactly why they cannot answer
// "does this block declare everything": every one of them is spread over
// :root, so the answer was always yes. Removing a key from a palette left the
// whole suite green.
const RAW = paletteNames.flatMap((name) => [
    [`${name} dark`, declaredIn(`[data-palette=${name}]`)],
    [`${name} light`, declaredIn(`[data-palette=${name}][data-theme=light]`)]
]);

// What a role answers to. Text is 4.5:1 because these are rendered with
// `color`; a mark and a 36px glyph are non-text at 3:1.
const AS_TEXT = ["white", "subtext", "accent-secondary",
    "grade-good", "grade-fair", "grade-poor", "grade-none", "grade-failed"];
// Non-text: a 36px glyph on an ungraded row, and the scrollbar thumb, which
// is a control and answers to the same 3:1. The thumb was $light-gray - a
// border colour - and measured 1.30:1 against a dialog surface, which is why
// nobody could see where they were in a scrolling list.
const AS_GLYPH = ["icon-neutral", "scrollbar-thumb"];
const ACCENTS = ["accent-primary", "accent-warning", "accent-danger"];

// Every mark, and which of them are told apart by colour alone. `average` is a
// dashed line and `failed` is a cross - they carry their own shape, so a
// categorical check would fail them for a difference no reader has to make.
const SERIES = ["chart-download", "chart-upload", "chart-ping", "chart-loaded", "chart-jitter",
    "chart-average", "chart-failed"];
const CATEGORICAL = [
    ["chart-download", "chart-upload", "chart-ping"],
    ["chart-ping", "chart-loaded", "chart-jitter"]
];

// The band is where a mark stays legible on its ground. `chart-failed` is not
// in it because it is not free to be: it is the failure verdict, which is also
// printed as a figure, and 4.5:1 as text on a dark card puts it above the band
// every time. Two floors, and the stricter one wins - it still has to clear 3:1
// as a mark, which is checked with the rest.
const BANDED = SERIES.filter((role) => role !== "chart-failed");

const TEXT_CONTRAST = 4.5;
const NONTEXT_CONTRAST = 3;
const CVD_SEPARATION = 8;
const CHROMA_FLOOR = 0.1;
const BAND = {dark: [0.48, 0.67], light: [0.43, 0.77]};

/** The surfaces anything in a block can land on, the glass card included. */
const surfacesOf = (block) => {
    const glass = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(resolve("glass-bg", block) ?? "");
    const page = resolve("background", block);

    const solid = glass
        ? "#" + [1, 2, 3].map((i) => Number(glass[i]).toString(16).padStart(2, "0")).join("")
        : null;

    return [page, resolve("darker-gray", block), resolve("dark-gray", block),
        solid ? composite(solid, Number(glass[4]), page) : null].filter(Boolean);
};

describe("the palettes the stylesheet declares", () => {
    it("are all there", () => {
        assert.ok(paletteNames.length >= 4, `only found ${paletteNames.length} palettes in the stylesheet`);
        assert.ok(BLOCKS.every(([, block]) => resolve("background", block)?.startsWith("#")),
            "a block has no background to measure against");
    });

    /**
     * A palette that leaves a key out does not fail the sass build by itself -
     * map.get answers null and `--dark-gray: #{null}` is `--dark-gray: `, which
     * compiles and ships and is invalid at computed-value time, so that surface
     * renders transparent. _colors.sass has a token() guard for that now; this
     * is the same claim held from the other end, on the emitted CSS.
     */
    it("declare every property the others do", () => {
        const [, reference] = RAW[0];
        const expected = Object.keys(reference);

        assert.ok(expected.length >= 25, `only ${expected.length} properties in the reference block`);

        for (const [name, block] of RAW) {
            const missing = expected.filter((property) => block[property] === undefined);

            assert.deepEqual(missing, [], `${name} never declares these, so it shows the outgoing palette's`);
        }
    });

    // `--dark-gray: ` parses as a declaration with an empty value, so a check
    // that only asks whether the property is present reads it as declared.
    it("declare a value with every property", () => {
        const empty = RAW.flatMap(([name, block]) => Object.entries(block)
            .filter(([, value]) => value === "")
            .map(([property]) => `${name} --${property}`));

        assert.deepEqual(empty, [], "these are declared with nothing, which is invalid and renders as unset");
    });
});

for (const [name, block] of BLOCKS) {
    const mode = name.endsWith("light") ? "light" : "dark";
    const surfaces = surfacesOf(block);
    const worst = (colour) => Math.min(...surfaces.map((surface) => contrast(colour, surface)));

    describe(`${name}`, () => {
        // Asserted rather than filtered. A role that resolves to something this
        // cannot measure has to fail loudly: the check it would otherwise skip
        // is the whole reason the file exists.
        it("states every colour it is measured on", () => {
            const unreadable = [...AS_TEXT, ...AS_GLYPH, ...ACCENTS, ...SERIES, "on-accent"]
                .map((role) => [role, resolve(role, block)])
                .filter(([, value]) => !/^(#[\da-fA-F]{3,8}|rgba?\()/.test(value ?? ""))
                .map(([role, value]) => `${role} = ${value ?? "undeclared"}`);

            assert.deepEqual(unreadable, [], "these cannot be measured, so nothing below checks them");
        });

        it("renders its text and its verdicts readably", () => {
            const failing = AS_TEXT
                .map((role) => [role, worst(resolve(role, block))])
                .filter(([, ratio]) => ratio < TEXT_CONTRAST)
                .map(([role, ratio]) => `${role} ${ratio.toFixed(2)}:1`);

            assert.deepEqual(failing, [], `below ${TEXT_CONTRAST}:1 on one of ${surfaces.join(", ")}`);
        });

        it("shows an ungraded glyph", () => {
            const failing = AS_GLYPH
                .map((role) => [role, worst(resolve(role, block))])
                .filter(([, ratio]) => ratio < NONTEXT_CONTRAST)
                .map(([role, ratio]) => `${role} ${ratio.toFixed(2)}:1`);

            assert.deepEqual(failing, []);
        });

        /**
         * The label on an accent-filled control.
         *
         * Three rules in DateRangePicker wrote `color: #fff` over
         * `background-color: $accent-primary`, which measures 2.54:1 on the
         * green MySpeed shipped with and 2.04:1 on a lighter one. --on-accent
         * is what makes that assumption a value a palette has to get right.
         */
        it("puts a readable label on its accents", () => {
            const ink = resolve("on-accent", block);

            const failing = ACCENTS
                .map((role) => [role, contrast(ink, resolve(role, block))])
                .filter(([, ratio]) => ratio < TEXT_CONTRAST)
                .map(([role, ratio]) => `${role} ${ratio.toFixed(2)}:1`);

            assert.deepEqual(failing, [], `--on-accent ${ink} is not readable on these`);
        });

        it("draws marks that stand off the card they are on", () => {
            const failing = SERIES
                .map((role) => [role, worst(resolve(role, block))])
                .filter(([, ratio]) => ratio < NONTEXT_CONTRAST)
                .map(([role, ratio]) => `${role} ${ratio.toFixed(2)}:1`);

            assert.deepEqual(failing, [], `a mark under ${NONTEXT_CONTRAST}:1 on the surface it is drawn on`);
        });

        /**
         * A mark too light for a dark ground - or too dark for a light one -
         * reads as washed out however much contrast it technically has. The
         * band is where a mark stays legible; the chroma floor is where it
         * stops reading as grey.
         */
        it("keeps its marks inside the lightness band", () => {
            const [low, high] = BAND[mode];

            const failing = BANDED
                .map((role) => [role, lightness(resolve(role, block)), chroma(resolve(role, block))])
                .filter(([, L, C]) => L < low || L > high || C < CHROMA_FLOOR)
                .map(([role, L, C]) => `${role} L=${L.toFixed(3)} C=${C.toFixed(3)}`);

            assert.deepEqual(failing, [], `outside L ${low}-${high} or under chroma ${CHROMA_FLOOR}`);
        });

        it("keeps the marks a reader tells apart by colour apart", () => {
            const failing = [];

            for (const group of CATEGORICAL) {
                for (let i = 0; i < group.length; i++) {
                    for (let j = i + 1; j < group.length; j++) {
                        const [a, b] = [resolve(group[i], block), resolve(group[j], block)];

                        for (const [kind, matrix] of Object.entries(CVD)) {
                            const delta = separation(a, b, matrix);

                            if (delta < CVD_SEPARATION)
                                failing.push(`${group[i]}/${group[j]} ΔE ${delta.toFixed(1)} (${kind})`);
                        }
                    }
                }
            }

            assert.deepEqual(failing, [], `under ΔE ${CVD_SEPARATION} - these are the same colour to some readers`);
        });
    });
}
