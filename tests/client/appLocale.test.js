import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import i18n from "i18next";
import { appLocale, formatCount, formatFullDay, formatMonth } from "@/common/utils/FormatUtil.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

/**
 * Dates and numbers follow the language the app is set to, not the one the
 * browser is set to.
 *
 * FormatUtil has had a `locale()` for exactly this since the overview's dates
 * were unified - "Passing undefined means whatever locale the browser is set
 * to, which ignores the language the user picked in the app" - and the chart
 * config wrote its own copy of it for the same reason. Three surfaces were still
 * asking the browser: the range picker's trigger, the calendar's month heading
 * and the sticky date pill on the overview. On a German instance running in an
 * en-US browser the calendar read "August 2026" in English directly above
 * weekday headers that were translated, and the overview's pill read "Saturday,
 * August 15, 2026" above rows the shared formatter had rendered in German.
 */
const GERMAN = "de";

before(() => {
    i18n.language = GERMAN;
});

after(() => {
    i18n.language = "en";
});

const AUGUST = new Date(Date.UTC(2026, 7, 15, 12, 0, 0));

describe("the formatters the app-wide locale was missing from", () => {
    it("names a month in the app's language", () => {
        assert.match(formatMonth(AUGUST), /August 2026/);

        i18n.language = "fr";
        assert.match(formatMonth(AUGUST), /août/i);
        i18n.language = GERMAN;
    });

    it("writes a full weekday date in the app's language", () => {
        assert.match(formatFullDay(AUGUST), /Samstag/);
    });

    it("groups a count the way the app's language does", () => {
        // 1.234 in German, 1,234 in English - the same digits and a different
        // separator, which is exactly the kind of difference nobody reports.
        assert.equal(formatCount(1234), "1.234");

        i18n.language = "en";
        assert.equal(formatCount(1234), "1,234");
        i18n.language = GERMAN;
    });

    it("says nothing rather than an invalid date", () => {
        for (const absent of [null, undefined, ""]) {
            assert.equal(formatMonth(absent), "");
            assert.equal(formatFullDay(absent), "");
        }
    });

    // The one place the language lives, so the chart config's private copy is
    // gone rather than merely agreeing today.
    it("reads the language from i18next", () => {
        assert.equal(appLocale(), GERMAN);
    });
});

/**
 * And nothing asks the browser any more.
 *
 * A scan rather than a list, because the fault is a call that was never
 * converted - naming the files that have one would have to be updated by the
 * same person who forgot.
 */
describe("nothing formats in the browser's locale", () => {
    const sources = [];

    const collect = (directory) => {
        for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
            const full = path.join(directory, entry.name);

            if (entry.isDirectory()) collect(full);
            else if (/\.jsx?$/.test(entry.name)) sources.push([path.relative(CLIENT_SRC, full), fs.readFileSync(full, "utf8")]);
        }
    };

    collect(CLIENT_SRC);

    /**
     * `toLocaleDateString()`, `toLocaleTimeString(undefined, …)` and
     * `toLocaleString("default")` are the three spellings of "ask the browser".
     * FormatUtil itself is the one file allowed to name a locale, since it is
     * the file that resolves it.
     */
    const ASKS_THE_BROWSER = /\.toLocale(?:Date|Time)?String\(\s*(?:\)|undefined|["']default["'])/;

    it("finds no component formatting in the browser's locale", () => {
        const offenders = sources
            .filter(([file]) => file !== path.join("common", "utils", "FormatUtil.js"))
            .filter(([, source]) => ASKS_THE_BROWSER.test(source))
            .map(([file]) => file);

        assert.deepEqual(offenders, [],
            "these render dates or numbers in the browser's locale, not the app's language");
    });

    // The second copy of the resolver, which is how the chart ticks and the
    // range picker ended up disagreeing about which language they were in.
    it("keeps one resolver rather than a copy per feature", () => {
        const copies = sources
            .filter(([file]) => file !== path.join("common", "utils", "FormatUtil.js"))
            .filter(([, source]) => /=>\s*i18n\.language\s*\|\|\s*undefined/.test(source))
            .map(([file]) => file);

        assert.deepEqual(copies, [], "these carry their own copy of the language lookup");
    });
});
