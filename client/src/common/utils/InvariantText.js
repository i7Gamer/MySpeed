/**
 * The strings that read the same in every language MySpeed ships.
 *
 * Brand names, the formats an export is offered in, the example URLs and
 * numbers shown greyed out in a field the reader is about to overwrite. They
 * were locale keys once, which meant fifteen copies of "Discord" and a standing
 * invitation to translate a word that has no translation.
 *
 * Several were duly translated. German named the ntfy integration "nackt" and
 * Dutch "kant-en-klare"; French turned Pushover into "Effet de poussée" and
 * HealthChecks into "Tests de santé"; Portuguese made Discord "Discórdia" and
 * Telegram "Telegrama". Ukrainian dropped the "<uuid>" out of the healthchecks
 * URL, leaving a placeholder that no longer showed the field's shape.
 *
 * None of that is catchable from the locale files. A parity check can see a
 * value that is still the English text - that is what the untranslated ones
 * look like - but it cannot see one that has been confidently rendered into the
 * wrong thing, because that is exactly what a translation looks like. The only
 * fix that holds is to stop asking the question.
 *
 * What deliberately did NOT move here, though it looks like it belongs:
 *
 *  - the units. "ms" is "мс" in Russian and "毫秒" in Chinese, "Mbps" is
 *    "Mbit/s" across much of Europe and "Мбіт/с" in Ukrainian, "MB/s" is "Mo/s"
 *    in French. Those are translations, not oversights.
 *  - the notification templates. The %variables% are read by the sender rather
 *    than by a person, but the units between them are not.
 *  - the example hostnames - nodes.placeholder.url and the webhook's. Every
 *    locale localises them on purpose: "dein-server.de", "su-servidor.es".
 *  - integrations.email.title. "Email" is a word, not a name, and every
 *    language has one.
 */

/** The application's own name, shown when a node has none of its own. */
export const PRODUCT_NAME = "MySpeed";

/** The label on the link to the project, which is the site's name. */
export const GITHUB_LABEL = "GitHub";

/** The file formats an export is offered in, by their extensions. */
export const EXPORT_FORMATS = {csv: "CSV", json: "JSON"};

/** A year, shown greyed out in the retention field as the default it holds. */
export const RETENTION_DAYS_PLACEHOLDER = "365";

/** The host a full Ookla result opens on, used as the link's text. */
export const OOKLA_RESULT_HOST = "speedtest.net";

/** The shape a self-hosted backend URL takes, shown in the field. */
export const CUSTOM_BACKEND_PLACEHOLDER = "https://speed.test/backend/";

/**
 * What each integration is called, where that is a product rather than a word.
 *
 * Keyed by the name the server registers the module under, which is also what
 * every stored IntegrationData row carries - see PINNED_INTEGRATION_NAMES in
 * tests/server/generatorIdentifiers.test.js. Renaming a key here is a data
 * migration, not a rename.
 */
export const INTEGRATION_BRANDS = {
    discord: "Discord",
    gotify: "Gotify",
    healthChecks: "HealthChecks",
    influxdb: "InfluxDB",
    mqtt: "MQTT",
    ntfy: "ntfy",
    pushover: "Pushover",
    telegram: "Telegram",
    webhook: "Webhook"
};

/**
 * Field placeholders that are an address or a number rather than a phrase,
 * keyed "<integration>.<field>".
 *
 * Only the invariant ones. A placeholder that reads as a sentence - "tk_...
 * (optional, for protected servers)", "speedtests (default)" - stays in the
 * locales, because the parenthetical is a phrase somebody has to translate.
 */
export const INTEGRATION_PLACEHOLDERS = {
    "discord.url": "https://discord.com/api/webhooks/...",
    "healthChecks.url": "https://hc-ping.com/<uuid>",
    "healthChecks.interval": "1",
    "influxdb.url": "http://localhost:8086",
    "ntfy.url": "https://ntfy.sh",
    "ntfy.priority": "3",
    "ntfy.error_priority": "5",
    "webhook.interval": "1"
};

/**
 * The locale keys these constants replaced.
 *
 * Kept so a test can assert they are gone rather than merely unused: a key left
 * behind in fifteen files is a value nothing reads, that a translator will
 * still be shown and can still get wrong.
 */
export const RETIRED_KEYS = [
    "header.title",
    "about.github",
    "storage.csv",
    "storage.json",
    "storage.retention_days_placeholder",
    "test.details.open_result",
    "dialog.provider.custom_url_placeholder",
    ...Object.keys(INTEGRATION_BRANDS).map((name) => `integrations.${name}.title`),
    ...Object.keys(INTEGRATION_PLACEHOLDERS)
        .map((key) => `integrations.${key.replace(".", ".fields.")}_placeholder`)
];

/**
 * What to call an integration.
 *
 * A brand keeps its name; anything else asks the locale, which is why the
 * translator is passed in rather than imported - this has to stay loadable from
 * a test, and importing i18next pulls in the whole initialised instance.
 */
export const integrationTitle = (name, translate) =>
    INTEGRATION_BRANDS[name] ?? translate(`integrations.${name}.title`);

/** The invariant placeholder for a field, or nothing if the locale owns it. */
export const integrationPlaceholder = (name, field) => INTEGRATION_PLACEHOLDERS[`${name}.${field}`];
