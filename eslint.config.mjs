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
            "no-unused-vars": ["warn", {varsIgnorePattern: "^React$", argsIgnorePattern: "^_"}]
        }
    },
    {
        files: ["server/**/*.js", "scripts/**/*.js", "tests/**/*.{js,mjs}"],
        ...js.configs.recommended,
        languageOptions: {
            ecmaVersion: ECMA_VERSION,
            sourceType: "module",
            globals: {...globals.node}
        },
        rules: {
            ...js.configs.recommended.rules,
            "no-unused-vars": ["warn", {argsIgnorePattern: "^_"}]
        }
    }
];
