import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSource, tagHolding, withoutJsComments } from "../helpers/source.js";

const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

const i18nSource = readSource("client/src/i18n.js");
const appSource = readSource("client/src/App.jsx");

/**
 * One missing locale file took the whole interface down, and then kept taking it
 * down.
 *
 * Upstream #725 and #1330. Every language was fetched over HTTP at boot -
 * `/assets/locales/{{lng}}.json` - and i18next's `failedLoading` event set the
 * state that renders the error page. That page counts five seconds down and
 * assigns window.location, so the reload fetched the same missing file and
 * failed again: the "infinite reload loop" in #725's title, and the
 * "infinite re-rendering loop" in #1330's.
 *
 * Two things were wrong and both are fixed here. `fallbackLng: 'en'` was already
 * set, so a *non*-English locale failing was survivable and was killed anyway -
 * which is exactly #1330, where the missing file was da.json. And English itself
 * was fetched like any other, so there was no floor: nothing to render with when
 * that one request was the one that failed.
 *
 * Upstream answered #1330 by adding the missing da.json, which fixes that day's
 * outage and leaves the fault in place.
 */
describe("the English locale", () => {
    const withoutComments = withoutJsComments(i18nSource);

    it("travels with the bundle rather than being fetched", () => {
        assert.match(withoutComments, /^\s*import\s+\w+\s+from\s+["'][^"']*locales\/en\.json["']/m,
            "the language everything else falls back to is still one failed request away");
    });

    it("is handed to i18next as a resource", () => {
        assert.match(withoutComments, /resources:/,
            "the bundled locale is imported and then not given to i18next");
    });

    /**
     * Without this, `resources` replaces the backend rather than seeding it and
     * no other language is ever fetched - a fifteen-language interface reduced
     * to English, which the language dialog would still offer to change.
     */
    it("does not stop the other languages being loaded", () => {
        assert.match(withoutComments, /partialBundledLanguages:\s*true/,
            "bundling English turned off the HTTP backend the other fourteen need");
    });

    /**
     * The bundled language and the fallback language have to be the same one.
     * Bundling a language nothing falls back to would leave the floor exactly
     * where it was.
     */
    it("is the language i18next falls back to", () => {
        const bundled = /import\s+\w+\s+from\s+["'][^"']*locales\/(\w+)\.json["']/.exec(withoutComments);
        const fallback = /fallbackLng:\s*([^,\n]+)/.exec(withoutComments);

        assert.ok(bundled, "no locale is imported at all");
        assert.ok(fallback, "no fallback language is configured");
        assert.match(fallback[1], new RegExp(`['"]${bundled[1]}['"]|FALLBACK`),
            `the bundled locale is ${bundled[1]} but the fallback is ${fallback[1].trim()}`);
    });

    /**
     * Read rather than imported: i18n.js pulls in the flag images and the
     * browser language detector, neither of which a node process can load. So
     * the specifier is resolved by hand and the file behind it is checked for
     * real - a rename or a move would otherwise only surface as a failed client
     * build.
     */
    it("points at a file that exists and parses", () => {
        const specifier = /import\s+\w+\s+from\s+["']([^"']*locales\/\w+\.json)["']/.exec(withoutComments)[1];
        const resolved = path.resolve(root, "client", "src", specifier);

        assert.ok(fs.existsSync(resolved), `${specifier} does not resolve to a file`);

        const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));

        assert.ok(Object.keys(parsed).length > 0, "the bundled locale is empty");
    });

    // Crowdin's source file, per crowdin.yml. Bundling a copy of it would leave
    // two Englishes to keep in step, and the one the translators edit would not
    // be the one the app ships.
    it("is the file crowdin translates, not a copy of it", () => {
        const specifier = /import\s+\w+\s+from\s+["']([^"']*locales\/\w+\.json)["']/.exec(withoutComments)[1];
        const resolved = path.resolve(root, "client", "src", specifier);
        const crowdinSource = path.resolve(root, "client", "public", "assets", "locales", "en.json");

        assert.equal(resolved, crowdinSource,
            "the bundled English is a second copy that translators do not edit");
    });
});

describe("a locale that will not load", () => {
    /**
     * The whole of #1330: the file that failed was da.json, English was fine,
     * and the interface died anyway.
     */
    it("is only fatal when there is nothing left to render with", () => {
        const failed = /const\s+failed\s*=\s*\(\)\s*=>\s*\{?([^;]*(?:;[^}]*)?)/.exec(appSource);

        assert.ok(failed, "App.jsx no longer has a failedLoading handler");
        assert.match(failed[1], /hasResourceBundle|isInitialized/,
            "any one language failing to load still takes the whole interface down");
    });

    /**
     * The residual case, and the loop in both issue titles. If i18next somehow
     * fails outright there is nothing a reload can fix, and the error page
     * reloads by default - which is what turned one failure into a page that
     * never stops reloading.
     */
    it("does not leave the error page reloading itself forever", () => {
        const tag = tagHolding(appSource, "Failed to load translations");

        assert.match(tag, /disableReload/,
            "the translation failure still renders the error page in its self-reloading mode");
    });
});
