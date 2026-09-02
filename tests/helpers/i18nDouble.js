import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import i18next from "i18next";

/**
 * What a component gets when it imports "@/i18n" under the test loader.
 *
 * The real module is the browser's bootstrap: it wires a language detector to
 * localStorage, an HTTP backend to the server, and every flag image through
 * `import.meta.glob` - a vite construct esbuild leaves as written and node then
 * refuses. None of that is what a component asks the module for. It asks for
 * the list of languages and the i18next instance, and those are answered here
 * with the instance the harness already initialised.
 *
 * The list is read off the locale directory rather than copied from the real
 * module, so a language added there appears here without anyone remembering
 * to - the names are the codes and there are no flags, which is fidelity
 * deliberately given away: a test built on this can count and choose
 * languages, and cannot assert on what the dialog prints beside each.
 */
const LOCALES = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..",
    "client", "public", "assets", "locales");

export const FALLBACK_LANGUAGE = "en";

// Directory order and code-for-name: a test must not read languages[0] or a
// name off this list and expect the real module's answer.
export const languages = fs.readdirSync(LOCALES)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .map((code) => ({name: code, code, flag: undefined}));

export default i18next;
