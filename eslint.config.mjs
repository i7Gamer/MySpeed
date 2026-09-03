import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * What the linter is here for.
 *
 * `no-undef`, first and foremost. `export {X} from "./y"` forwards X and binds
 * nothing locally, so a module that re-exports a constant and then uses it
 * throws at render while the build stays green - which took the whole app down
 * to the error boundary once, with 2300 passing tests. Nothing else in this
 * repo can see that: the suite reads the client's files as text rather than
 * evaluating them, and the bundler resolves the re-export happily.
 *
 * Deliberately no stylistic rules. The house style here is consistent and the
 * comments are load-bearing; a formatter would churn thousands of lines and
 * bury the history those comments explain.
 */

// The React-Compiler-era rules that ship with eslint-plugin-react-hooks. They
// are worth turning on, but not in the same change as the linter itself: they
// flag patterns this codebase uses deliberately and in volume - the staged
// mount effects in Statistics.jsx, the ref work in useClickOutside - and each
// one wants reading rather than a blanket disable. Twenty-three findings, which
// is a pass of its own.
const COMPILER_RULES_PENDING_A_PASS = {
    "react-hooks/set-state-in-effect": "off",
    "react-hooks/refs": "off",
    "react-hooks/immutability": "off",
    "react-hooks/preserve-manual-memoization": "off",
    "react-hooks/purity": "off",
    "react-hooks/static-components": "off",
    "react-hooks/use-memo": "off",
    "react-hooks/incompatible-library": "off"
};

// 2025 or later, or server/routes/system.js fails to parse: it imports
// package.json with the `with { type: "json" }` attribute the ESM spec requires.
const ECMA_VERSION = 2025;

const UNUSED_VARS = {
    // `const {server, ...rest} = result` is how a key is left out of an object,
    // so the named half is doing the work even though nothing reads it. Seven of
    // the eight findings this rule opened with were that idiom.
    ignoreRestSiblings: true,
    // The conventional mark for a parameter a signature requires and the body
    // does not want.
    argsIgnorePattern: "^_",
    // And the same mark for a caught error nothing reads. `catch {}` says that
    // without a name at all, but themeBoot.js is a classic ES5 script served
    // unbundled to whatever engine the reader has, and optional catch binding
    // is ES2019.
    caughtErrorsIgnorePattern: "^_"
};

export default [
    {ignores: ["**/node_modules/**", "**/build/**", "client/dev-dist/**", "**/dist/**"]},
    {
        files: ["client/src/**/*.{js,jsx}"],
        ...js.configs.recommended,
        languageOptions: {
            ecmaVersion: ECMA_VERSION,
            sourceType: "module",
            globals: {...globals.browser},
            parserOptions: {ecmaFeatures: {jsx: true}}
        },
        plugins: {"react-hooks": reactHooks},
        rules: {
            ...js.configs.recommended.rules,
            ...reactHooks.configs.recommended.rules,
            ...COMPILER_RULES_PENDING_A_PASS,
            // A warning, not an error. Several effects here narrow their
            // dependencies on purpose and say why in a comment - see the scroll
            // handler in TestArea, which listing `stickyDate` would rebuild on
            // every date the pill showed.
            "react-hooks/exhaustive-deps": "warn",
            // React is in scope through the automatic JSX runtime, so a file
            // that imports it for the classic transform is not unused code.
            "no-unused-vars": ["warn", {...UNUSED_VARS, varsIgnorePattern: "^React$"}]
        }
    },
    /*
     * The pre-paint script, which the block above cannot reach: it is served
     * straight out of public/ rather than bundled, so it is not under src/ -
     * and it is a classic script rather than a module, which is the whole
     * reason it can run before the parser reaches the app. Unlinted, it was the
     * one file in the client where the `no-undef` fault this config exists for
     * would have shipped in silence.
     */
    {
        files: ["client/public/*.js"],
        ...js.configs.recommended,
        languageOptions: {
            ecmaVersion: ECMA_VERSION,
            sourceType: "script",
            globals: {...globals.browser}
        },
        rules: {
            ...js.configs.recommended.rules,
            "no-unused-vars": ["warn", UNUSED_VARS]
        }
    },
    {
        // .jsx too: the suite renders components now, and the fixtures it
        // renders are written as JSX like the components they stand in for.
        //
        // The two .mjs configs are here as well. Under flat config a file that
        // no block claims is walked and linted with no rules at all, so it
        // passes whatever it contains - and one of the two decides whether the
        // client builds. `--print-config client/vite.config.mjs` showed an
        // empty rule set; no-undef, which this config's header calls the whole
        // reason it exists, was not applied to it.
        files: ["server/**/*.js", "scripts/**/*.js", "tests/**/*.{js,mjs,jsx}",
            "*.mjs", "client/*.mjs"],
        ...js.configs.recommended,
        languageOptions: {
            ecmaVersion: ECMA_VERSION,
            sourceType: "module",
            globals: {...globals.node},
            parserOptions: {ecmaFeatures: {jsx: true}}
        },
        rules: {
            ...js.configs.recommended.rules,
            "no-unused-vars": ["warn", UNUSED_VARS]
        }
    }
];
