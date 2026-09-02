import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readSource } from "../helpers/source.js";
import { compile, declarationsIn } from "../helpers/sass.mjs";
import { DEFAULT_THEME, normaliseTheme, resolveTheme, THEMES } from "../../client/src/common/contexts/Theme/themeChoice.js";
import { DEFAULT_PALETTE, normalisePalette, PALETTES } from "../../client/src/common/contexts/Theme/paletteChoice.js";

/**
 * The one copy of the theme rules that is not the modules.
 *
 * themeBoot.js is served straight out of public/ - not compiled, not bundled -
 * because it has to run before the app does and the CSP forbids an inline
 * script. So it cannot import themeChoice.js or paletteChoice.js, and it holds
 * the storage keys, the accepted values, the defaults and the resolution rule a
 * second time. That is the shape of every silent fault this codebase has had.
 *
 * This is what holds the two ends together. Not by comparing source text, which
 * would break on a rename that changed nothing: the script is executed against
 * a stubbed document for every combination that can reach it, and what it
 * stamps is compared with what the modules answer for the same input.
 */

const boot = readSource("client/public/themeBoot.js");
const html = readSource("client/index.html");
const context = readSource("client/src/common/contexts/Theme/ThemeContext.jsx");
const css = compile("common/styles/default.sass");

/**
 * Runs the real script against a stubbed window, and reports what it left on
 * the document.
 *
 * `prefersDark` is undefined for a browser with no matchMedia at all, which is
 * a case the resolution rule distinguishes - and `throws` is the blocked
 * localStorage the whole of Storage.js exists for.
 */
const run = ({stored = {}, prefersDark, matchMedia = true, unsupported = false, throws = false} = {}) => {
    const attributes = {};
    const meta = {content: "#000000", setAttribute: (name, value) => { meta[name] = value; }};

    const sandbox = {
        window: {
            localStorage: {
                getItem: (key) => {
                    if (throws) throw new Error("SecurityError");
                    return stored[key] ?? null;
                }
            },
            // An engine that parses the query to nothing serialises its media
            // as "not all" and answers matches: false forever - the shape the
            // unsupported case reproduces.
            ...(matchMedia ? {matchMedia: () => (unsupported
                ? {matches: false, media: "not all"}
                : {matches: prefersDark === true, media: "(prefers-color-scheme: dark)"})} : {})
        },
        document: {
            documentElement: {setAttribute: (name, value) => { attributes[name] = value; }},
            querySelector: () => meta
        }
    };

    vm.runInNewContext(boot, sandbox);
    return {...attributes, themeColor: meta.content};
};

describe("the pre-paint script", () => {
    it("is loaded before anything can paint", () => {
        assert.match(html, /<script src="\/themeBoot\.js"><\/script>/,
            "index.html does not load the boot script");

        const tag = /<script src="\/themeBoot\.js"[^>]*>/.exec(html)[0];

        assert.doesNotMatch(tag, /\bdefer\b|\basync\b|type="module"/,
            "a deferred or module script runs after the first paint, which is the flash it exists to remove");
        assert.ok(html.indexOf("/themeBoot.js") < html.indexOf("/src/index.jsx"),
            "the boot script has to run before the app, not after it");
    });

    /**
     * The CSP is `script-src 'self'` - see server/middlewares/securityHeaders.
     * An inline script would be refused, and refused silently as far as the
     * reader is concerned: the page would simply flash again.
     */
    /*
     * Every opening tag is examined for a `src`, rather than the script tags
     * being stripped out and the remainder searched. The stripping version was
     * the same assertion and CodeQL was right to fail it twice: a regexp that
     * removes `<script …></script>` and trusts what is left is the shape of a
     * broken HTML sanitiser, and `</script >` with a space walked straight
     * through it. Nothing untrusted reaches this - it reads a file out of the
     * repo - but a test that reads as a sanitiser is one somebody eventually
     * lifts into somewhere it matters, so it is worth writing as though it were.
     *
     * Case-insensitive because tag names are: `<SCRIPT>` is the same element,
     * and it was the second bypass CodeQL named. `\b` rather than a space, so
     * `<script/src=…>` - a slash is a valid attribute separator - is read as
     * the external script it is rather than reported as an inline one.
     */
    const inlineScriptsIn = (markup) => [...markup.matchAll(/<script\b([^>]*)>/gi)]
        .filter(([, attributes]) => !/\bsrc\s*=/i.test(attributes))
        .map(([tag]) => tag);

    it("is a file rather than an inline script", () => {
        assert.deepEqual(inlineScriptsIn(html), [],
            "an inline script cannot run under script-src 'self'");
    });

    // The check is only worth having if it catches the forms somebody would
    // actually write, so it is shown catching them.
    it("would catch one however it was written", () => {
        for (const inline of ["<script>go()</script>", "<SCRIPT>go()</SCRIPT>",
            '<script type="module">go()</script>', "<script >go()</script >"])
            assert.equal(inlineScriptsIn(html.replace("</head>", `${inline}</head>`)).length, 1, inline);

        for (const external of ['<script src="/a.js"></script>', '<script SRC="/a.js"></script>',
            '<script/src="/a.js"></script>', '<script defer src="/a.js"></script>'])
            assert.deepEqual(inlineScriptsIn(html.replace("</head>", `${external}</head>`)), [], external);
    });
});

describe("what the pre-paint script accepts", () => {
    it("reads the keys the context writes", () => {
        for (const [name, key] of [["theme", "theme"], ["palette", "palette"]]) {
            assert.match(context, new RegExp(`_KEY = "${key}"`),
                `ThemeContext no longer stores the ${name} under "${key}"`);
            assert.match(boot, new RegExp(`_KEY = "${key}"`),
                `the boot script no longer reads the ${name} from "${key}"`);
        }
    });

    it("knows the same themes and palettes", () => {
        const listed = (name) => JSON.parse(new RegExp(`var ${name} = (\\[[^\\]]*\\]);`).exec(boot)[1]
            .replace(/'/g, '"'));

        assert.deepEqual(listed("THEMES"), [...THEMES]);
        assert.deepEqual(listed("PALETTES"), [...PALETTES]);
    });

    it("falls back to the same defaults", () => {
        // Nothing stored, so both sides start from the default and only the
        // machine's answer decides - which is what the default being "system"
        // means. The stored-value matrix below covers the rest.
        for (const prefersDark of [true, false, undefined]) {
            const stamped = run({prefersDark, matchMedia: prefersDark !== undefined});

            assert.equal(stamped["data-theme"], resolveTheme(DEFAULT_THEME, prefersDark));
            assert.equal(stamped["data-palette"], DEFAULT_PALETTE);
        }
    });

    /**
     * matchMedia present, prefers-color-scheme not: the query parses to
     * nothing, its media reads "not all", and matches is false forever. That
     * false is not a light preference - it is the machine failing to answer -
     * and the documented rule is that a machine which cannot answer stays
     * dark. Read bare, it flipped exactly the degraded embedded webviews
     * Storage.js exists for to light.
     */
    it("stays dark when the engine cannot parse the query at all", () => {
        assert.equal(run({unsupported: true})["data-theme"], "dark",
            "an unanswerable query was read as a preference for light");
    });
});

describe("what the pre-paint script stamps", () => {
    // Every stored value the modules would normalise, junk included: a palette
    // dropped in a later release is still in localStorage on the machines that
    // chose it, and both sides have to answer the same thing about it.
    const STORED_THEMES = [...THEMES, undefined, "", "sepia", "SYSTEM"];
    const STORED_PALETTES = [...PALETTES, undefined, "", "sepia", "SLATE"];

    it("agrees with normaliseTheme and resolveTheme on every input", () => {
        const disagreements = [];

        for (const theme of STORED_THEMES) {
            for (const prefersDark of [true, false, undefined]) {
                const stamped = run({stored: {theme}, prefersDark, matchMedia: prefersDark !== undefined});
                const expected = resolveTheme(normaliseTheme(theme), prefersDark);

                if (stamped["data-theme"] !== expected)
                    disagreements.push(`${theme}/${prefersDark}: boot ${stamped["data-theme"]} vs module ${expected}`);
            }
        }

        assert.deepEqual(disagreements, []);
    });

    it("agrees with normalisePalette on every input", () => {
        const disagreements = STORED_PALETTES
            .map((palette) => [palette, run({stored: {palette}})["data-palette"], normalisePalette(palette)])
            .filter(([, stamped, expected]) => stamped !== expected)
            .map(([palette, stamped, expected]) => `${palette}: boot ${stamped} vs module ${expected}`);

        assert.deepEqual(disagreements, []);
    });

    /**
     * Reading localStorage throws rather than answering null when the store is
     * blocked - which is what an embedded MySpeed in a cross-origin iframe runs
     * as. A throw here leaves the document unstamped, which is the state the
     * script exists to avoid.
     */
    it("still stamps when the store is refused", () => {
        const stamped = run({throws: true, prefersDark: true});

        assert.equal(stamped["data-palette"], DEFAULT_PALETTE);
        assert.equal(stamped["data-theme"], resolveTheme(DEFAULT_THEME, true));
    });

    it("still stamps where there is no matchMedia to ask", () => {
        assert.equal(run({stored: {theme: "system"}, matchMedia: false})["data-theme"], "dark",
            "no machine preference is not the same answer as a preference for light");
    });
});

/**
 * The meta tag drives the Android browser chrome and the PWA splash, so it is a
 * colour that has to match the page. It was a fixed #232835, which has not been
 * in this stylesheet since January and matches none of the eight combinations.
 */
describe("the theme-color the pre-paint script sets", () => {
    const background = (palette, mode) => (mode === "light"
        ? declarationsIn(css, `[data-palette=${palette}][data-theme=light]`)
        : declarationsIn(css, `[data-palette=${palette}]`))["background"];

    it("is the page colour the stylesheet actually paints", () => {
        const wrong = [];

        for (const palette of PALETTES) {
            for (const [mode, prefersDark] of [["dark", true], ["light", false]]) {
                const stamped = run({stored: {palette, theme: mode}, prefersDark});

                if (stamped.themeColor !== background(palette, mode))
                    wrong.push(`${palette} ${mode}: ${stamped.themeColor} vs ${background(palette, mode)}`);
            }
        }

        assert.deepEqual(wrong, [], "the browser chrome would not match the page under it");
    });

    it("leaves a value in the markup for a browser that refuses the script", () => {
        const fallback = /<meta name="theme-color" content="([^"]+)"/.exec(html)[1];

        assert.equal(fallback, background(DEFAULT_PALETTE, "dark"),
            "the static fallback is not the colour an unstamped document paints");
    });

    /**
     * The installed app does not read the meta at all. Its splash screen and
     * window chrome come from the manifest, which is served verbatim - so a
     * stale colour there survives everything the boot script fixes. It held
     * #232835, the very colour the script's comment calls dead. A manifest is
     * static, so the only honest value is the one an unstamped document paints.
     */
    it("matches the manifest the installed app launches from", () => {
        const manifest = JSON.parse(readSource("client/public/manifest.json"));

        for (const field of ["theme_color", "background_color"])
            assert.equal(manifest[field], background(DEFAULT_PALETTE, "dark"),
                `${field} is a colour no palette paints, so the installed app's splash matches nothing`);
    });

    /**
     * The boot script writes the meta once, before first paint - and nothing
     * wrote it again. A palette change in the dialog, or the machine flipping
     * at dusk under "system", repainted the page and left the Android chrome
     * bar in the outgoing colour until a full reload. The provider's commit
     * effect is where every later change already lands, so the meta follows
     * from there - read off the freshly stamped document rather than from a
     * third copy of the page colours, which would be one more pair of ends
     * for this file to hold together.
     */
    it("is restamped by the provider when the theme changes after boot", () => {
        assert.match(context, /meta\[name="theme-color"\]/,
            "ThemeContext never touches the meta, so a live change strands the browser chrome");
        assert.match(context, /getPropertyValue\("--background"\)/,
            "the provider should ask the stamped document for the page colour, not its own table");
        assert.doesNotMatch(context, /#[\da-fA-F]{6}\b/,
            "a hex literal in the provider is a page colour the stylesheet does not own");
    });
});
