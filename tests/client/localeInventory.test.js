import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSource } from "../helpers/source.js";

const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

const LOCALES_DIR = path.join(root, "client", "public", "assets", "locales");
const FLAGS_DIR = path.join(root, "client", "src", "common", "assets", "languages");

const localeCodes = () => fs.readdirSync(LOCALES_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.basename(file, ".json"))
    .sort();

/**
 * The codes i18n.js actually offers, read out of the `languages` list it builds
 * the dialog from.
 */
const offeredCodes = () => {
    const source = readSource("client/src/i18n.js");
    const list = source.slice(source.indexOf("export const languages"), source.indexOf("]", source.indexOf("export const languages")));

    return [...list.matchAll(/code:\s*'([a-z-]+)'/g)].map((match) => match[1]).sort();
};

/**
 * A locale file that ships and cannot be chosen.
 *
 * `ga.json` sat here for however long: 24 KB of Irish served from every
 * deployment, absent from the `languages` list, so nothing could ever request
 * it - and three quarters translated, with no flag asset, so offering it would
 * have shown a quarter of the interface in English beside a missing image.
 *
 * Deleting it is not the fix on its own. crowdin.yml maps en.json to
 * `%two_letters_code%.json`, so the next Crowdin download puts back whatever
 * languages that project has enabled, and the file would return unnoticed. This
 * is the part that notices: a new locale arriving fails here until somebody
 * decides what it is - a language to add properly, with its flag and its entry,
 * or one to turn off upstream.
 *
 * The friction is the point. A locale file is only worth its bytes if a reader
 * can pick it.
 */
describe("the locale files that ship", () => {
    it("finds both sides to compare", () => {
        assert.ok(localeCodes().length > 5, "no locale files were found at all");
        assert.ok(offeredCodes().length > 5, "the languages list could not be read out of i18n.js");
    });

    it("are exactly the languages the dialog offers", () => {
        const shipped = localeCodes();
        const offered = offeredCodes();

        assert.deepEqual(shipped.filter((code) => !offered.includes(code)), [],
            "these locale files are served but cannot be selected - add the language to i18n.js "
            + "with its flag, or stop shipping the file");

        assert.deepEqual(offered.filter((code) => !shipped.includes(code)), [],
            "these languages are offered with no locale file behind them, so choosing one "
            + "falls straight back to English");
    });

    /**
     * The flag is keyed by country and the locale by language, so the two are
     * not always the same word - "pt" is drawn with a Brazilian flag and "uk"
     * with a Ukrainian one. What matters is that every offered language has
     * *some* image, since the dialog renders one per entry.
     */
    it("each have a flag the dialog can draw", () => {
        const source = readSource("client/src/i18n.js");
        const imported = [...source.matchAll(/languages\/([a-z-]+)\.webp/g)].map((match) => match[1]);
        const present = fs.readdirSync(FLAGS_DIR).map((file) => path.basename(file, ".webp"));

        assert.deepEqual(imported.filter((code) => !present.includes(code)), [],
            "i18n.js imports a flag that is not in the assets directory");
        assert.equal(imported.length, offeredCodes().length,
            "the number of flags and the number of offered languages have drifted apart");
    });
});
