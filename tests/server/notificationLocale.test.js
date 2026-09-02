import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
    DEFAULT_LANGUAGE, ENGLISH_PHRASES, NOTIFICATION_LANGUAGES, localeCodesIn, phrase
} from "../../server/util/notificationLocale.js";
import { ALERT_METRICS } from "../../server/util/alertThreshold.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

/**
 * The keys the server asks the section for, read off its source.
 *
 * The client's own key scanner cannot see these - they are never rendered by
 * the client, and it exempts the whole section - so without this a phrase
 * deleted from every locale, or a key misspelt in the code, prints as its
 * own key in a message and nothing fails. Three shapes: a literal handed to
 * phrase() or the modules' word(), a constant ending in _PHRASE, and the
 * crossing each alert metric names; the metric names are built from a prefix
 * and are listed from the metrics themselves.
 */
const phrasesTheServerAsksFor = () => {
    const files = ["server/util/alertThreshold.js", "server/util/notificationLocale.js",
        ...fs.readdirSync(path.join(ROOT, "server", "integrations"))
            .filter((name) => name.endsWith(".js") && name !== "index.js")
            .map((name) => `server/integrations/${name}`)];
    const source = files.map((file) => fs.readFileSync(path.join(ROOT, file), "utf8")).join("\n");

    const keys = new Set();
    for (const [, key] of source.matchAll(/\b(?:phrase\([^,)]+,|word\()\s*"([a-z_]+)"/g)) keys.add(key);
    for (const [, key] of source.matchAll(/_PHRASE = "([a-z_]+)"/g)) keys.add(key);
    for (const metric of ALERT_METRICS) keys.add(metric.crossing).add(`metric_${metric.key}`);

    return keys;
};

const englishNotification = () => JSON.parse(fs.readFileSync(
    path.join(ROOT, "client", "public", "assets", "locales", "en.json"), "utf8")).notification;

const englishSection = () => Object.keys(englishNotification());

/**
 * The module evaluated in a tree of its own, with the working directory
 * somewhere else again.
 *
 * It reads its sources once, while it is being evaluated, and this process has
 * the real files beside it - so an instance that finds a different set of them,
 * or none at all, can only be arranged in another process. `furnish` is handed
 * the sandbox and puts there whatever the case under test is about; the third
 * directory the probe runs from is what keeps the working-directory entry in
 * DIRECTORIES from being the one that answered.
 */
const inASandbox = (furnish) => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-sandbox-"));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-elsewhere-"));

    try {
        fs.mkdirSync(path.join(sandbox, "server", "util"), {recursive: true});
        fs.copyFileSync(path.join(ROOT, "server", "util", "notificationLocale.js"),
            path.join(sandbox, "server", "util", "notificationLocale.js"));
        furnish(sandbox);

        const probe = path.join(sandbox, "probe.mjs");
        fs.writeFileSync(probe,
            'import { NOTIFICATION_LANGUAGES, phrase, plainDefaults } '
            + 'from "./server/util/notificationLocale.js";\n'
            + 'console.log(JSON.stringify({languages: NOTIFICATION_LANGUAGES, '
            + 'finished: phrase("en", "finished"), target: phrase("de", "target"), '
            + 'summary: phrase("en", "crossed_limits", {clauses: "download 40 Mbps under 100"}), '
            + 'plain: plainDefaults(null).finished}));\n');

        const printed = execFileSync(process.execPath, [probe], {cwd: elsewhere, encoding: "utf8"});

        return JSON.parse(printed.trim().split("\n").at(-1));
    } finally {
        fs.rmSync(sandbox, {recursive: true, force: true});
        fs.rmSync(elsewhere, {recursive: true, force: true});
    }
};

/**
 * The words a notification is built from, in the recipient's language.
 *
 * They come from the same locale files the interface ships - the ones the
 * translators edit - rather than a second catalog kept beside the server. A
 * copy would be a second English to keep in step, and the one the translators
 * edit would not be the one a message is written from.
 *
 * Read in this process from client/public/assets/locales, which is where the
 * files are before a build; a running instance reads them from the build
 * beside it, or from the client embedded in the binary. The three sources hold
 * the same files, so the catalog is tested against the one that is always
 * here.
 */
describe("the notification phrases", () => {
    it("answers English by default", () => {
        assert.equal(DEFAULT_LANGUAGE, "en");
        assert.equal(phrase(undefined, "finished"), "A speedtest is finished");
        assert.equal(phrase(null, "finished"), "A speedtest is finished");
        assert.equal(phrase("", "finished"), "A speedtest is finished");
    });

    it("answers in the language asked for", () => {
        assert.equal(phrase("de", "finished"), "Ein Speedtest ist abgeschlossen");
    });

    // A language the interface does not ship, or a stored value from a
    // language since dropped, is English rather than a thrown lookup.
    it("falls back to English for a language it does not know", () => {
        assert.equal(phrase("tlh", "finished"), "A speedtest is finished");
        assert.equal(phrase("../../etc/passwd", "finished"), "A speedtest is finished");
    });

    // Per key, not per language: a locale that has not caught up with a key
    // added later answers that one key in English and the rest in its own.
    it("falls back to English one key at a time", () => {
        assert.equal(phrase("de", "a_key_no_locale_defines"), phrase("en", "a_key_no_locale_defines"));
        assert.equal(phrase("de", "finished"), "Ein Speedtest ist abgeschlossen");
    });

    it("answers the key itself when even English lacks it", () => {
        assert.equal(phrase("en", "a_key_no_locale_defines"), "a_key_no_locale_defines");
    });

    /**
     * The rung between English and the key: the phrases as this module's own
     * literal, for the instance where no source answers at all.
     *
     * That instance is not hypothetical. The client tree is absent from a
     * release, the build is looked for beside the process as well as beside
     * the server, and a directory can be there and unreadable - so a server
     * started from the wrong place, or by an account that cannot read its own
     * assets, found nothing. Every shipped template then rendered as its own
     * keys, and the operator was sent "finished:" over "target: WAN" instead
     * of a notification.
     *
     * Run in a sandbox holding the module and nothing else, with the working
     * directory there too, because that is the only way to have every source
     * genuinely answer nothing: the module reads its directories once, while
     * it is being evaluated, and this process has the real files.
     */
    it("writes the shipped English when no source answers at all", () => {
        const answered = inASandbox(() => undefined);

        assert.deepEqual(answered.languages, [], "the sandbox found a locale source after all");
        assert.equal(answered.finished, "A speedtest is finished");
        assert.equal(answered.target, "Target");
        assert.equal(answered.summary, "Crossed limits: download 40 Mbps under 100");
        assert.match(answered.plain, /^A speedtest is finished:\nTarget: %targetName%\n/,
            "the shipped template rendered as its own keys");
    });

    /**
     * The build is looked for beside the server tree, not only beside the
     * process.
     *
     * The source archive ships `build`, `server` and a package.json side by
     * side and no client tree at all, so on that layout the build is the only
     * source there is. An init system starts a service from wherever it
     * pleases - a unit file with no WorkingDirectory starts it from `/` - and
     * with the build looked for against the working directory alone, that
     * instance had no languages to offer and every phrase to fall back for.
     *
     * The probe runs from a third directory here, so the working-directory
     * entry cannot be the one that answers.
     */
    it("reads the build beside the server tree, wherever the process was started", () => {
        const answered = inASandbox((sandbox) => {
            const locales = path.join(sandbox, "build", "assets", "locales");
            fs.mkdirSync(locales, {recursive: true});
            fs.writeFileSync(path.join(locales, "en.json"),
                JSON.stringify({notification: {finished: "The release build's own words"}}));
            fs.writeFileSync(path.join(locales, "de.json"), JSON.stringify({notification: {}}));
        });

        assert.deepEqual(answered.languages, ["en", "de"], "the build beside the server was not read");
        assert.equal(answered.finished, "The release build's own words");
    });

    /**
     * The literal and the locale file say the same thing, key for key.
     *
     * A copy of English is exactly the second catalog this module's header
     * argues against keeping, and it is only tolerable while it cannot drift:
     * a phrase reworded in en.json and not here would leave the fallback
     * quoting the wording of an older release, which is worse to diagnose
     * than the keys it replaces because it reads like a real message.
     */
    it("keeps its English literal in step with the locale file", () => {
        assert.deepEqual({...ENGLISH_PHRASES}, englishNotification());
    });

    it("fills the placeholders a phrase carries", () => {
        assert.equal(phrase("en", "limit_over", {metric: "ping", value: 62, unit: "ms", limit: 50}),
            "ping 62 ms over 50");
    });

    // A placeholder nothing was given for is left standing rather than
    // printed as "undefined", the way replaceVariables leaves an unknown
    // %variable%.
    it("leaves a placeholder it was given nothing for", () => {
        assert.equal(phrase("en", "limit_over", {metric: "ping"}), "ping {{value}} {{unit}} over {{limit}}");
    });

    it("defines in English every phrase the server asks for, and no phrase it does not", () => {
        const asked = phrasesTheServerAsksFor();
        const defined = englishSection();

        assert.ok(asked.size >= 15, `only ${asked.size} phrases found in the source; the scan stopped seeing them`);
        assert.deepEqual([...asked].filter((key) => !defined.includes(key)), [],
            "the server asks for phrases en.json does not define - they would print as their own key");
        assert.deepEqual(defined.filter((key) => !asked.has(key)), [],
            "en.json defines phrases nothing asks for - dead strings every translator still has to carry");
    });

    /**
     * The sources are tried in turn and the first that answers wins - so a
     * directory that exists and holds no locale must answer nothing, not an
     * empty list, or the chain stops there while the next source had every
     * file: a `build/` left by a partial build beside a full source tree,
     * or the reverse.
     */
    it("reads an empty directory as no source at all", () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-locales-"));
        const full = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-locales-"));
        fs.writeFileSync(path.join(full, "en.json"), "{}");
        fs.writeFileSync(path.join(full, "readme.txt"), "not a locale");

        try {
            assert.equal(localeCodesIn(path.join(empty, "absent")), null);
            assert.equal(localeCodesIn(empty), null, "an empty directory answered a list");
            assert.deepEqual(localeCodesIn(full), ["en"]);
        } finally {
            fs.rmSync(empty, {recursive: true, force: true});
            fs.rmSync(full, {recursive: true, force: true});
        }
    });

    /**
     * A directory that cannot be listed is not this source either.
     *
     * existsSync answers true for a path the process may not read, and for a
     * plain file sitting where a directory was expected - and the throw came
     * out of readdirSync, which runs while the module is still being
     * evaluated. An ESM evaluation that throws takes every importer down with
     * it, so the server did not start at all over a locale directory whose
     * only job is the wording of a notification.
     *
     * A file rather than a directory with its permissions taken away: the
     * throw is the same shape, and it is the one this suite can arrange on
     * every platform it runs on, Windows included.
     */
    it("reads a path it cannot list as no source at all", () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-locales-"));
        const file = path.join(directory, "en.json");
        fs.writeFileSync(file, "{}");

        try {
            assert.equal(localeCodesIn(file), null, "a file where a directory belongs threw instead of answering");
        } finally {
            fs.rmSync(directory, {recursive: true, force: true});
        }
    });

    /**
     * The languages a notifier may be set to are exactly the locale files that
     * ship, read off the directory rather than listed by hand - a language
     * added to the interface is offered to the notifiers without a second
     * edit, and one that is offered is guaranteed to answer.
     */
    it("offers every language the interface ships, English first", () => {
        assert.equal(NOTIFICATION_LANGUAGES[0], "en");
        assert.ok(NOTIFICATION_LANGUAGES.includes("de"));
        assert.ok(NOTIFICATION_LANGUAGES.length >= 20, "fewer languages than the interface ships");

        for (const code of NOTIFICATION_LANGUAGES)
            assert.match(code, /^[a-z]{2}(-[a-z]{2})?$/, `${code} is not a locale code`);
    });
});
