/**
 * The words a notification is written in, in the recipient's language.
 *
 * The six shipped templates and the alert summary they end with were English
 * composed in the server, on an interface that speaks twenty-three languages -
 * so a German operator who never edited a template read every alert in a
 * language their screen does not use. The phrases now come from the same
 * locale files the interface ships, under a `notification` section, so the
 * translators who keep the screen in step keep the messages in step with the
 * same edit; a catalog kept beside the server would be a second English to
 * maintain, and the one the translators edit would not be the one a message
 * is written from.
 *
 * Read where the files are. A running instance has them in the build beside
 * it (Docker copies client/build to ./build; app.js serves the same
 * directory) or inside the client the binary embeds; this process, in tests
 * and in development, has them in client/public. The three hold the same
 * files, so the first that answers is the answer.
 *
 * i18next is not a server dependency and is not made one for a dozen strings:
 * the lookup is a section read off a JSON file, and the interpolation below is
 * the `{{name}}` form the client's strings already use, so a translator meets
 * one syntax.
 *
 * Deliberately a leaf: it imports nothing of the controllers, so the gate in
 * alertThreshold.js and the modules the controller's index loads can both read
 * it - see the import-cycle rule tasks/integrations.js follows.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The language a notifier that chose none writes in, and the one every key falls back to. */
export const DEFAULT_LANGUAGE = "en";

/**
 * The integration setting the language is stored under. Named here, beside
 * the reader, so the field the dialog offers and the key the gate reads are
 * one spelling.
 */
export const LANGUAGE_FIELD = "language";

/** Where the phrases sit inside a locale file. */
const SECTION = "notification";

/** Where the locale files sit inside the built client, and inside the embed. */
const LOCALES_PATH = ["assets", "locales"];

/** What a locale file is called, for the code it carries. */
const LOCALE_EXTENSION = ".json";

/** The `{{name}}` a phrase carries where a value goes. */
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

const ROOT = path.resolve(import.meta.dirname, "..", "..");

/*
 * The client the binary carries, generated before compilation and absent from
 * a source tree - the same import app.js makes, for the same reason: running
 * from source is the ordinary case rather than a failure.
 */
let embedded = null;
try {
    embedded = await import('../clientEmbed.js');
} catch {
    // Not a binary; the files are on disk.
}

/**
 * The directories a locale file may be read from, in the order they are
 * tried: the source tree first, then the build beside a running instance.
 * The embed comes last and is not a directory, so it is consulted by the
 * readers below rather than listed here.
 *
 * The source tree first, not last, and the order matters: a checkout that has
 * run build:binary keeps a ./build at the root that is as old as that build,
 * and read first it answered every phrase with its key while the file the
 * developer was editing sat beside it. A source tree is only ever present
 * where the code runs from source - the image copies the build alone, the
 * binary carries the embed alone - so preferring it changes nothing anywhere
 * else.
 *
 * The build is looked for twice, beside this file and beside the process. The
 * source archive ships `build`, `server` and a package.json side by side, and
 * a service unit or a shell that starts the server from somewhere other than
 * that directory - which is the ordinary way an init system starts anything -
 * leaves the working directory pointing elsewhere entirely. Anchored to ROOT
 * the build is found wherever the release was unpacked; the working directory
 * stays in the list because the image's own layout is exactly that, a ./build
 * beside the process rather than beside the server tree.
 */
const DIRECTORIES = [
    path.join(ROOT, "client", "public", ...LOCALES_PATH),
    path.join(ROOT, "build", ...LOCALES_PATH),
    path.join(process.cwd(), "build", ...LOCALES_PATH)
];

const localeFileName = (code) => `${code}${LOCALE_EXTENSION}`;

/**
 * The locale codes one directory holds, or null when it holds none - a
 * directory that exists and is empty is as much "not this source" as one
 * that is absent, and answering [] for it would stop the chain below on a
 * source with nothing in it while the next one had every file.
 *
 * Exported for the test alone.
 */
export const localeCodesIn = (directory) => {
    try {
        if (!fs.existsSync(directory)) return null;

        const codes = fs.readdirSync(directory)
            .filter((name) => name.endsWith(LOCALE_EXTENSION))
            .map((name) => name.slice(0, -LOCALE_EXTENSION.length));

        return codes.length > 0 ? codes : null;
    } catch {
        /*
         * A directory that cannot be listed is not this source either.
         * existsSync answers true for one the process may not read, and for a
         * plain file sitting where a directory was expected - so the throw
         * came out of readdirSync, which runs while this module is still
         * being evaluated. An ESM evaluation that throws takes every importer
         * with it: the server did not start at all, over a locale directory
         * whose only job is to supply the wording of a notification.
         */
        return null;
    }
};

const embeddedLocalePrefix = `/${LOCALES_PATH.join("/")}/`;

const codesInEmbed = () => {
    if (typeof embedded?.embeddedPaths !== "function") return null;

    const codes = embedded.embeddedPaths()
        .filter((url) => url.startsWith(embeddedLocalePrefix) && url.endsWith(LOCALE_EXTENSION))
        .map((url) => url.slice(embeddedLocalePrefix.length, -LOCALE_EXTENSION.length));

    return codes.length > 0 ? codes : null;
};

/**
 * The languages a notifier may be set to: exactly the locale files that ship,
 * English first because it is the default and the one every other falls back
 * to. Read off the source rather than listed by hand, so a language added to
 * the interface is offered to the notifiers without a second edit, and one
 * that is offered is guaranteed to answer.
 *
 * Fixed at load: the files do not change while the process runs, and the
 * integration dialog's field definition is built from this once.
 */
export const NOTIFICATION_LANGUAGES = (() => {
    // The first directory that answers wins, and `??` short-circuits the call
    // for the rest - the list is walked rather than spelled out, so a source
    // added to DIRECTORIES is consulted without a second edit here.
    const onDisk = DIRECTORIES.reduce((found, directory) => found ?? localeCodesIn(directory), null);
    const codes = onDisk ?? codesInEmbed() ?? [];
    const sorted = codes.filter((code) => code !== DEFAULT_LANGUAGE).sort();

    return codes.includes(DEFAULT_LANGUAGE) ? [DEFAULT_LANGUAGE, ...sorted] : sorted;
})();

/** The bytes of one locale file, from whichever source holds it - or null. */
const readLocaleFile = (code) => {
    const name = localeFileName(code);

    for (const directory of DIRECTORIES) {
        const file = path.join(directory, name);
        if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
    }

    const inEmbed = embedded?.readEmbeddedFile?.(embeddedLocalePrefix + name);
    return inEmbed ? inEmbed.toString("utf8") : null;
};

/*
 * One read per language per process. The files do not change while it runs,
 * and a dispatch fans out to every integration on every finished test.
 */
const sections = new Map();

/**
 * The phrases one language defines - an empty object for a language that is
 * not shipped, so a stored value from a locale since dropped falls back
 * rather than throws.
 *
 * Only a code the list above offers is read at all: the code becomes a file
 * name, and the stored column is JSON somebody may have edited by hand. The
 * default is the one exception, being a literal of this module's own - so
 * English is read wherever a source holds it, and a list that came up empty
 * at load cannot turn every shipped template into its keys.
 */
const sectionOf = (code) => {
    if (code !== DEFAULT_LANGUAGE && !NOTIFICATION_LANGUAGES.includes(code)) return {};

    if (!sections.has(code)) {
        let phrases = {};

        try {
            const file = readLocaleFile(code);
            const section = file === null ? undefined : JSON.parse(file)?.[SECTION];
            if (section && typeof section === "object") phrases = section;
        } catch {
            // A file that does not parse answers nothing, and every key falls
            // back to English below - a broken translation must not stop a
            // notification.
        }

        sections.set(code, phrases);
    }

    return sections.get(code);
};

/**
 * A `{{name}}` filled in from the values given, and left standing when none
 * was - the way replaceVariables leaves an unknown %variable% - rather than
 * printed as "undefined".
 */
const interpolate = (template, values) => template.replace(PLACEHOLDER, (whole, name) =>
    Object.hasOwn(values, name) && values[name] !== undefined ? String(values[name]) : whole);

/**
 * The English phrases, as this module's own literal.
 *
 * Not a second catalog to maintain - the locale files stay the source every
 * key is read from, and the test beside this one holds the two equal
 * key-for-key so they cannot drift. This is the floor under them: when no
 * source answers at all, every shipped template used to render as its own
 * keys, so an operator whose instance could not find its locales was sent
 * "finished:" and "target: WAN" instead of a notification. A source can fail
 * to answer for reasons that are nobody's mistake - a release started from
 * the wrong directory, a build directory left by an older version, a locale
 * directory the service account cannot read - and a message written in keys
 * is worse than one written in a language the reader did not pick.
 *
 * Exported for the test that pins it against en.json.
 */
export const ENGLISH_PHRASES = Object.freeze({
    finished: "A speedtest is finished",
    failed: "A speedtest has failed",
    finished_subject: "MySpeed: speedtest finished",
    failed_subject: "MySpeed: speedtest failed",
    target: "Target",
    ping: "Ping",
    download: "Download",
    upload: "Upload",
    reason: "Reason",
    metric_ping: "ping",
    metric_download: "download",
    metric_upload: "upload",
    crossed_limits: "Crossed limits: {{clauses}}",
    limit_over: "{{metric}} {{value}} {{unit}} over {{limit}}",
    limit_under: "{{metric}} {{value}} {{unit}} under {{limit}}",
    not_measured: "{{metric}} (not measured)",
    below_usual: "Below its usual speed: {{crossings}} under",
    shortfall: "{{metric}} {{shortfall}}%",
    and: " and "
});

/**
 * One phrase, in the language asked for.
 *
 * Falls back one key at a time: a locale that has not caught up with a key
 * added later answers that key in English and the rest in its own, which is
 * how the interface's own strings behave. Then the literal above, for a key
 * no source could answer at all. When even that lacks the key the key itself
 * is answered, so a phrase asked for and never written is visible in the
 * message rather than an empty line nobody can trace.
 *
 * @param language  a locale code, or anything falsy for the default
 * @param key       a key under the locale's `notification` section
 * @param values    what the phrase's placeholders are filled with
 */
export const phrase = (language, key, values = {}) => {
    const own = sectionOf(language || DEFAULT_LANGUAGE)[key];
    const english = typeof own === "string" ? own : sectionOf(DEFAULT_LANGUAGE)[key];
    const template = typeof english === "string" ? english : ENGLISH_PHRASES[key];

    return interpolate(typeof template === "string" ? template : key, values);
};

/**
 * The plain-text pair three notifiers send when nothing was edited - gotify,
 * ntfy and pushover carry no markup, so their defaults are one text. Written
 * once here rather than once per module, for the reason the shared fields
 * are: three copies of the same sentence are three places for the next edit.
 *
 * The %variables% are the payload's and are substituted by the sender; the
 * words around them are the recipient's.
 */
export const plainDefaults = (language) => {
    const word = (key) => phrase(language, key);

    return {
        // One literal, however long: tests/server/integrationSends.test.js reads
        // the template off this source, and a literal ends at its first backtick.
        finished: `${word("finished")}:\n${word("target")}: %targetName%\n${word("ping")}: %ping% ms (±%jitter% ms)\n${word("upload")}: %upload% Mbps\n${word("download")}: %download% Mbps%alertSummary%`,
        failed: `${word("failed")}.\n${word("target")}: %targetName%\n${word("reason")}: %error%`
    };
};
