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

    /*
     * The BASE_PATH prefix this script itself was served from - the client side
     * of the same finding Storage.js's scopedStorageKey exists for: two
     * MySpeeds behind different prefixes on one origin must not read or write
     * each other's theme and palette. Storage.js works this out from
     * BasePath.js, which reads import.meta.url - a signal this file has none
     * of, being plain ES5 loaded by a classic <script> tag rather than a
     * module.
     *
     * document.currentScript.src is the browser's own answer to "where was
     * this file fetched from", already resolved against whatever relative or
     * absolute form the built HTML shipped - the same kind of signal
     * BasePath.js reads off the entry module's import.meta.url, and for the
     * same reason. location.pathname or document.baseURI were the other
     * candidates and both were rejected: either one answers the SPA's current
     * client-side route, which a reader can reload three levels deep under the
     * prefix or navigate to after boot, not the directory this script was
     * itself served from - the one fact a router cannot move.
     *
     * The path is pulled out with a regexp rather than `new URL(src).pathname`:
     * this file runs before anything can be relied on, and a global that some
     * very old embedded webview - or a bare script sandbox - does not provide
     * would leave the document unstamped exactly as a thrown localStorage
     * access does above.
     */
    function scriptPrefix() {
        try {
            var src = document.currentScript && document.currentScript.src;
            if (!src) return "";

            // Strips "scheme://host[:port]" and any query or hash off the
            // front. `.src` is always the browser-resolved absolute URL, never
            // the raw attribute, so this always has an origin to strip.
            var pathname = src.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").split(/[?#]/)[0];

            var segments = pathname.split("/").filter(function (segment) {
                return segment.length > 0;
            });

            // The file itself is the last segment; whatever remains is the
            // directory it was served from. Unlike the bundled entry module -
            // which BasePath.js finds one level under "assets" or "src" - this
            // file sits at the served root, so nothing needs recognising here,
            // only popping.
            segments.pop();

            return segments.length === 0 ? "" : "/" + segments.join("/");
        } catch (_error) {
            // The safe way to be wrong, same as BasePath.js: no prefix, so a
            // layout this cannot work out costs a shared key rather than a
            // thrown error before anything can paint.
            return "";
        }
    }

    var PREFIX = scriptPrefix();

    // Mirrors Storage.js's BASE_PATH_KEY_SEPARATOR byte for byte: this script
    // reads whatever ThemeContext, through Storage.js, most recently wrote, and
    // a separator that disagreed would make every load flash the stale colours
    // this file exists to remove.
    var KEY_SEPARATOR = ":";

    function scopedKey(key) {
        return PREFIX === "" ? key : PREFIX + KEY_SEPARATOR + key;
    }

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
            var scoped = scopedKey(key);
            var value = window.localStorage.getItem(scoped);
            if (value !== null) return value;

            // Falls back to the bare key so an instance already running behind
            // BASE_PATH keeps the theme and palette it chose before this
            // scoping existed, until ThemeContext's own read through
            // Storage.js next writes the scoped name - the same rule
            // Storage.js's read applies for every other stored choice.
            return scoped === key ? null : window.localStorage.getItem(key);
        } catch (_error) {
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
        var query = window.matchMedia("(prefers-color-scheme: dark)");
        // An engine that cannot parse the query serialises its media as
        // "not all" and answers matches: false forever - a failure to answer,
        // not a preference for light. A list with no media at all - a stub, a
        // webview stranger still - has not answered either, which is the half
        // this copy was missing. mediaQueryAnswer in mediaQuery.js is the same
        // rule, written the same way round; this script runs before anything
        // can import, so themeBoot.test.js compares the two on every shape.
        if (typeof query.media !== "string" || query.media === "not all") return undefined;
        // `=== true`, not the value itself: a list that never filled matches in
        // handed undefined back, which resolveTheme reads as "no preference"
        // and the module reads as "not dark". One of them had to give.
        return query.matches === true;
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
