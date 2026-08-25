/*
 * The theme and the palette, on the document before anything is painted.
 *
 * The stylesheet is render-blocking and the app is a module script, which is
 * deferred - so the browser painted `body { background-color: var(--background) }`
 * from the unstamped :root block, which is Slate dark, and only then did React
 * mount and ThemeContext stamp the attributes. Every reader whose choice is not
 * Slate dark - seven of the eight combinations - began each load in the wrong
 * colours, and an Ember-light reader got a near-black flash every time.
 *
 * This runs where that gap is: a classic, non-deferred script in <head>, which
 * blocks the parser until it has finished. It is a separate file and not inline
 * because the CSP is `script-src 'self'` - see server/middlewares/securityHeaders
 * - and an inline script would be refused without a nonce.
 *
 * It is served straight out of public/, so it is not compiled, not bundled and
 * not hashed: plain ES5, no imports. That means the facts below are a second
 * copy of what themeChoice.js and paletteChoice.js hold, which is exactly the
 * shape of bug this codebase keeps finding. themeBoot.test.js is what holds the
 * two ends together - it reads this file, reads those modules, and compares the
 * keys, the accepted values, the defaults and the resolution rule.
 *
 * Being wrong here costs a flash and nothing else: React re-stamps both
 * attributes on mount from the same storage, so a stale cached copy of this
 * file degrades to the behaviour that existed before it.
 */
(function () {
    "use strict";

    var THEME_KEY = "theme";
    var PALETTE_KEY = "palette";

    var THEMES = ["system", "dark", "light"];
    var DEFAULT_THEME = "system";

    var PALETTES = ["slate", "nord", "carbon", "ember"];
    var DEFAULT_PALETTE = "slate";

    // The page colour each palette paints, for the meta tag below. Only the one
    // value per combination, because that is all the browser chrome asks for.
    var BACKGROUNDS = {
        slate: {dark: "#0f1419", light: "#f8fafc"},
        nord: {dark: "#272c36", light: "#eceff4"},
        carbon: {dark: "#0a0a0a", light: "#ffffff"},
        ember: {dark: "#1a1614", light: "#faf6f1"}
    };

    /*
     * Reading localStorage throws a SecurityError rather than answering null
     * when the store is blocked - Chrome with third-party cookies off, which is
     * what an embedded MySpeed in Homepage or Heimdall runs as. See Storage.js,
     * which exists for the same reason. A throw here would leave the document
     * unstamped, which is the state this file was written to avoid.
     */
    function stored(key) {
        try {
            return window.localStorage.getItem(key);
        } catch (error) {
            return null;
        }
    }

    function oneOf(list, value, fallback) {
        return list.indexOf(value) === -1 ? fallback : value;
    }

    /*
     * Undefined where the machine cannot be asked, not false: "the machine
     * prefers light" and "there is no machine preference to have" are different
     * answers, and the second must not flip an instance to light. resolveTheme
     * in themeChoice.js makes the same distinction, and the test compares them.
     */
    function prefersDark() {
        if (typeof window.matchMedia !== "function") return undefined;
        return window.matchMedia("(prefers-color-scheme: dark)").matches;
    }

    function resolveTheme(theme, dark) {
        if (theme !== "system") return theme;
        return dark === false ? "light" : "dark";
    }

    var theme = oneOf(THEMES, stored(THEME_KEY), DEFAULT_THEME);
    var palette = oneOf(PALETTES, stored(PALETTE_KEY), DEFAULT_PALETTE);
    var resolved = resolveTheme(theme, prefersDark());

    document.documentElement.setAttribute("data-theme", resolved);
    document.documentElement.setAttribute("data-palette", palette);

    // The Android chrome bar and the PWA splash. It was a fixed #232835, a
    // colour that has not been in this stylesheet since January and matches no
    // palette; left alone it would now disagree with all eight combinations.
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", BACKGROUNDS[palette][resolved]);
})();
