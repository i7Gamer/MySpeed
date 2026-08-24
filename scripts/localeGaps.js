/**
 * What a locale file is missing, and the writer that fills it in.
 *
 * Every locale but German arrives from upstream's Crowdin project, which
 * exports only the strings its translators have been round: a language sits at
 * 434 of English's 599 keys not because anything is broken but because that is
 * what has been translated so far. i18next covers the hole - the missing key
 * falls back to English - so nothing fails, nothing is logged, and the gap is
 * invisible from inside the running interface. It is only visible by comparing
 * the files, which is what this does.
 *
 * The second half of the gap does not show up in a key count at all: a value
 * that is present and still holds the English text. Crowdin writes those when a
 * string was approved unchanged, and three locales here carry about a hundred
 * and forty each. To a reader they are indistinguishable from a missing key.
 *
 * Kept apart from the script that prints the report for the same reason
 * registrySource.js is kept apart from its generators: this half is pure, so a
 * test can import it without a readdirSync or a writeFileSync happening on the
 * way in.
 */

/** Locale JSON as dotted key -> value, in the order the file lists them. */
export const flatten = (object, prefix = "") => {
    const entries = {};

    for (const [key, value] of Object.entries(object)) {
        const full = prefix ? `${prefix}.${key}` : key;

        if (value && typeof value === "object") Object.assign(entries, flatten(value, full));
        else entries[full] = value;
    }

    return entries;
};

/** The inverse: nested JSON, with each level in the order the flat keys arrived. */
export const nest = (entries) => {
    const root = {};

    for (const [key, value] of Object.entries(entries)) {
        const parts = key.split(".");
        const leaf = parts.pop();
        let node = root;

        for (const part of parts) node = node[part] ??= {};

        node[leaf] = value;
    }

    return root;
};

/**
 * Locale JSON in the shape the files on disk are in: two-space indent, one
 * trailing newline, and whatever line ending the file being replaced already
 * used. The ending is asked for rather than assumed - the tree is checked out
 * CRLF on Windows and LF everywhere else, and a writer with an opinion would
 * rewrite all nine hundred lines of a file on one platform or the other.
 */
export const serialise = (object, eol = "\n") =>
    `${JSON.stringify(object, null, 2)}\n`.replace(/\n/g, eol);

/**
 * Values that are the same string in every language MySpeed ships: the product
 * and protocol names, and the URLs and numbers shown as placeholders in a field
 * the reader is about to overwrite anyway.
 *
 * Allowing identity rather than requiring it - except that here, identity is
 * what a reader wants. Three of these were translated and should not have been:
 * de and nl render the ntfy integration as "nackt" and "kant-en-klare", pt
 * renders Discord as "Discórdia", and uk dropped the "<uuid>" out of the
 * healthchecks URL that shows what the field's shape is. A brand name handed to
 * a translator is a brand name somebody will eventually translate.
 *
 * What is deliberately NOT here, though it looks like it belongs:
 *
 *  - the units. "ms" is "мс" in Russian and "毫秒" in Chinese, "Mbps" is
 *    "Mbit/s" across most of Europe and "Мбіт/с" in Ukrainian, and "MB/s" is
 *    "Mo/s" in French. These are translations, not oversights.
 *  - the notification templates. The variable names between percent signs are
 *    read by the sender rather than by a person, but the units sitting between
 *    them are not: zh writes "%ping% 毫秒" and uk "%download% Мбіт/с".
 *  - the example hostnames - nodes.placeholder.url, and the webhook's. Every
 *    locale localises them on purpose: "dein-server.de", "su-servidor.es".
 *
 * Listed one by one rather than matched by a pattern. The rule that would cover
 * most of them - a value with no lowercase words in it, say - also covers "OK",
 * "Ping" and "Jitter", which several languages do translate, and the whole
 * value of the check is that it fails on the ones nobody got to.
 */
export const UNIVERSAL_SHARED = [
    "dialog.provider.custom_url_placeholder",
    "about.github",
    "header.title",
    "storage.csv",
    "storage.json",
    "storage.retention_days_placeholder",
    "test.details.open_result",
    "integrations.discord.title",
    "integrations.discord.fields.url_placeholder",
    "integrations.gotify.title",
    "integrations.pushover.title",
    "integrations.healthChecks.title",
    "integrations.healthChecks.fields.url_placeholder",
    "integrations.healthChecks.fields.interval_placeholder",
    "integrations.influxdb.title",
    "integrations.influxdb.fields.url_placeholder",
    "integrations.mqtt.title",
    "integrations.ntfy.title",
    "integrations.ntfy.fields.url_placeholder",
    "integrations.ntfy.fields.priority_placeholder",
    "integrations.ntfy.fields.error_priority_placeholder",
    "integrations.telegram.title",
    "integrations.webhook.title",
    "integrations.webhook.fields.interval_placeholder"
];

/**
 * Values a particular language leaves as the English text on purpose, because
 * that is the word it uses. German keeps "Server", "Download" and "Ping";
 * Chinese keeps almost nothing.
 *
 * Filled in as each language is translated, and read by the parity test - so
 * the list is the record of a decision someone made about that string, and an
 * untranslated value that is not on it fails.
 */
export const LANGUAGE_SHARED = {
    de: [
        "welcome.ms", "dialog.okay", "dialog.provider.server", "update.ping_placeholder",
        "storage.speedtests", "storage.tests", "statistics.failed.label",
        "statistics.hourly.sample_count", "preview.info",
        // The metrics keep their English names in German, in the interface and
        // out of it, and the units keep their symbols.
        "latest.ping", "latest.ping_unit", "latest.jitter", "latest.jitter_unit",
        "latest.down", "latest.up", "latest.byte_speed_unit",
        "info.ping.title", "info.jitter.title", "info.bufferbloat.title",
        "test.details.server", "test.details.seconds",
        "test.details.bufferbloat", "test.details.bufferbloat_value",
        // Field labels that are the same word in German, and the templates whose
        // German differs from the English only in the unit - which is "ms" here
        // too.
        "integrations.discord.fields.url", "integrations.gotify.fields.url",
        "integrations.healthChecks.fields.url", "integrations.influxdb.fields.url",
        "integrations.influxdb.fields.token", "integrations.ntfy.fields.url",
        "integrations.ntfy.fields.title_placeholder", "integrations.ntfy.fields.tags",
        "integrations.telegram.fields.token", "integrations.telegram.fields.chat_id",
        "integrations.webhook.fields.url", "integrations.email.fields.port",
        "integrations.mqtt.fields.port",
        ...["discord", "email", "gotify", "pushover", "ntfy", "telegram"]
            .map((name) => `integrations.${name}.fields.finished_message_placeholder`)
    ]
};

/** Every value `code` is allowed to leave as the English text. */
export const sharedKeys = (code) => new Set([...UNIVERSAL_SHARED, ...(LANGUAGE_SHARED[code] ?? [])]);

/**
 * What stands between a locale and its source.
 *
 * `missing` is what has to be written, `untranslated` is what has to be looked
 * at, and `extra` is a key that outlived the English it was translated from -
 * usually a rename, and always something to delete rather than to fill in.
 */
export const localeGaps = (english, locale, shared = new Set()) => {
    const source = flatten(english);
    const target = flatten(locale);
    const has = (key) => key in target && String(target[key]).trim() !== "";

    return {
        missing: Object.keys(source).filter((key) => !has(key)),
        untranslated: Object.keys(source)
            .filter((key) => has(key) && target[key] === source[key] && !shared.has(key)),
        extra: Object.keys(target).filter((key) => !(key in source))
    };
};

/**
 * A locale with a patch of translations written into it, in English's key order.
 *
 * The order is the point. Every Crowdin-managed locale is already a subsequence
 * of English, so following English means a translation pass shows up as the
 * lines it added and nothing else, and a reviewer who does not read the target
 * language can still see exactly what changed.
 *
 * @param english  the source locale, nested
 * @param locale   the locale being edited, nested
 * @param patch    dotted key -> translated value
 */
export const mergeLocale = (english, locale, patch) => {
    const source = flatten(english);
    const target = flatten(locale);

    const unknown = Object.keys(patch).filter((key) => !(key in source));
    if (unknown.length)
        throw new Error(`patch names ${unknown.length} key(s) that en.json does not have: ${unknown.join(", ")}`);

    const merged = {};

    for (const key of Object.keys(source)) {
        const value = patch[key] ?? target[key];
        if (value !== undefined) merged[key] = value;
    }

    return nest(merged);
};
