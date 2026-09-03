import IntegrationData from '../models/IntegrationData.js';
import Config from '../models/Config.js';
import integrationModules from '../integrations/index.js';
import { zoneFromName } from '../util/timezone.js';
import { ALERT_CROSSED, ALERT_METRICS, ALERT_ONLY, ALERT_SUMMARY, alertSummary, breachesThreshold,
    crossedLimits, wantsOnlyBreaches } from '../util/alertThreshold.js';
import { DIGEST_MONTHLY_FIELD, DIGEST_WEEKLY_FIELD } from '../util/digestOptIn.js';
import { LANGUAGE_FIELD, NOTIFICATION_LANGUAGES } from '../util/notificationLocale.js';
export { wantsDigest } from '../util/digestOptIn.js';
import { FAILED_VARIABLES, FINISHED_VARIABLES } from '../util/notificationPayload.js';
import { withoutUrlCredentials } from '../util/urlCredentials.js';

const integrations = {};

const events = {};

const lastPings = {};

const registerEvent = (module) => (name, callback) => {
    if (!events[name]) events[name] = [];
    events[name].push({module, callback});
}

const MS_PER_MINUTE = 60_000;

// How early a minute tick may land and still count as the next ping. The
// scheduler is not exact, and a window of exactly the interval would skip
// every tick that arrives a few seconds ahead of it.
const PING_THROTTLE_TOLERANCE_MS = 30_000;

const shouldThrottlePing = (eventName, integration) => {
    if (eventName !== "minutePassed") return false;

    const intervalRaw = integration.data?.interval;
    const interval = Number.isInteger(intervalRaw) && intervalRaw > 0 ? intervalRaw : 1;
    if (interval <= 1) return false;

    const now = Date.now();
    const last = lastPings[integration.id];
    if (last !== undefined && now - last < interval * MS_PER_MINUTE - PING_THROTTLE_TOLERANCE_MS) return true;

    lastPings[integration.id] = now;
    return false;
}

/**
 * The `data` column as an object, whichever dialect answered.
 *
 * sqlite hands the JSON column back as the string it stored; mysql2 parses
 * JSON columns on the wire and hands back an object. An unconditional
 * JSON.parse therefore threw on every MySQL read - taking the active list,
 * the patch route and every event notification with it.
 */
export const asDataObject = (value) => typeof value === "string" ? JSON.parse(value) : value;

// One reader for the stored rows: every caller wants `data` as an object, and
// the two copies of this mapping had already drifted once.
const activeRows = async (where) => {
    const data = await IntegrationData.findAll(where ? {where} : undefined);
    if (!data) return null;

    return data.map((item) => ({...item, data: asDataObject(item.data)}));
};

const getActiveByName = (name) => activeRows({name});

/**
 * Records that an integration dealt with an event, and how it went.
 *
 * `error` may be left out entirely, which stamps the time and leaves the
 * failure flag as it stands. Passing false instead would clear a failure the
 * previous send recorded - and for an integration that only speaks up about
 * breaches, the next healthy test would turn a broken webhook green and keep it
 * that way while it went on delivering nothing. That is the one combination in
 * which a dead integration is invisible: the card reads "last run just now"
 * with no error, and no message arrives to say otherwise.
 */
const triggerActivity = async (id, error) => {
    const update = {lastActivity: new Date().toISOString()};
    if (error !== undefined) update.activityFailed = error;

    await IntegrationData.update(update, {where: {id: id}});
}

/**
 * The clock the instance keeps, for the messages that name an hour.
 *
 * Off the model rather than through controller/config.js's getValue, which is
 * the same one-line read: that module imports this one for triggerEvent and
 * withoutSecrets, so an import back would be the first cycle between two
 * controllers here - and it would drag the scheduler, the migrations and the
 * session store into every suite that loads a notifier. IntegrationData is read
 * straight off the model three lines up for the same reason it is here.
 *
 * zoneFromName answers the host's own clock for "none" - the sentinel every
 * optional setting uses - for a missing row, and for any name the platform's
 * zone database does not know, so neither an instance that set no timezone nor
 * one carrying a hand-written value renders anything but what it always did.
 * A stored name is refused by the door in any case (validateInput does), so a
 * bad one is historical or hand-written.
 *
 * The read itself is left to fail like the row read below it, which runs a
 * moment later against the same connection: a database this cannot reach is
 * one the fan-out cannot read its integrations from either, and catching here
 * would only change which of the two rejections the caller sees.
 */
const TIMEZONE_SETTING = "timezone";

const instanceZone = async () => zoneFromName((await Config.findByPk(TIMEZONE_SETTING))?.value);

export const triggerEvent = async (name, data) => {
    if (!events[name]) return;

    /*
     * Resolved once for the whole fan-out, and ahead of it.
     *
     * The six clock names a message template may use - %year% through %second%
     * - were rendered from the process clock, while the schedule, the digests,
     * the quiet hours and the /status countdown all read this setting; the
     * Docker image pins `ENV TZ=Etc/UTC`, so a Berlin instance sent "09:14" for
     * a test that ran at 11:14. Here rather than inside replaceVariables
     * because a reader that has to await the setting cannot stay synchronous,
     * and every notifier composes its message inside an expression -
     * `balancedForTelegram(replaceVariables(...))` would be handed a promise.
     *
     * Once rather than per integration: every recipient of one event is told
     * the same time in any case, and this path already runs a query per
     * registered module every minute.
     */
    const zone = await instanceZone();

    const tasks = [];

    for (const module of events[name]) {
        const active = await getActiveByName(module.module);
        for (const integration of active) {
            if (shouldThrottlePing(name, integration)) continue;

            // Stamped even though nothing was sent. The activity columns are
            // the only thing the dialog reads to decide between "last run …"
            // and "Never executed", so an integration doing exactly what it was
            // asked - staying quiet through a run of healthy tests - would
            // otherwise present itself as one that has never worked.
            //
            // The time only: nothing was attempted, so this says nothing about
            // whether the integration still delivers, and must not overwrite
            // what the last actual send found out.
            //
            // "What it was asked" means by its own settings. A member that
            // opted out of alerting is the *target's* decision: nothing about
            // this integration was exercised, and stamping it painted "last
            // run just now" on a notifier that has never delivered a single
            // message - on an instance whose only member has alerts off,
            // permanently.
            if (suppressesEvent(name, module.module, integration, data)) {
                if (data?.alerts !== false)
                    tasks.push(triggerActivity(integration.id).catch(() => undefined));
                continue;
            }

            // Contained per integration. One throwing callback used to end the
            // whole fan-out, so every integration registered after it missed
            // the event with nothing said - and the throw could come from a
            // stored value the validator should never have accepted.
            //
            // Promise.resolve().then(...) rather than calling the callback
            // here, so a callback that throws before its first await is caught
            // by the same handler as one that rejects.
            /*
             * What this integration's own limits made of the result, added
             * here because here is the only place both are in hand.
             *
             * Per recipient, which is the whole reason it is not on the payload
             * the way the baseline's pair is: two integrations watching one
             * test can hold different limits, so "what crossed" has a different
             * answer for each of them and one shared object cannot carry it.
             *
             * Filled in whether or not this integration filters on those limits.
             * suppressesEvent only asks when alert_only is on, but a template
             * naming the variable means the same thing either way, and an
             * operator who set limits and kept every message would otherwise
             * read "nothing crossed" on the very tests that crossed something.
             *
             * Finished tests only. A failure carries no readings at all, so
             * every armed metric would be described as unmeasured - true, and
             * useless beside the %error% the failure template already has.
             */
            const settings = composingSettings(module.module, integration.data);
            const described = name === "testFinished"
                ? {...data, [ALERT_CROSSED]: crossedLimits(data, settings),
                    [ALERT_SUMMARY]: alertSummary(data, settings)}
                : data;

            tasks.push(Promise.resolve()
                .then(() => module.callback(integration, described,
                    (error = false) => triggerActivity(integration.id, error), zone))
                .catch((e) => {
                    console.error(`Integration "${module.module}" failed to handle ${name}: ${e?.message ?? e}`);
                    return triggerActivity(integration.id, true).catch(() => undefined);
                }));
        }
    }

    /*
     * Dispatched together rather than awaited one after another. Every send is
     * bounded by OUTBOUND_TIMEOUT, but with several integrations configured
     * one dead endpoint still held every later notification for its full ten
     * seconds - and the message most likely to be queued behind a slow send is
     * the failure alert, the one least able to afford arriving late.
     *
     * The database reads above stay sequential, and their failure still
     * belongs to the caller. allSettled is belt over braces: every task in the
     * list already handles its own rejection.
     */
    await Promise.allSettled(tasks);
}

export const clearPingState = (id) => {
    delete lastPings[id];
}

/**
 * The settings that let an integration stay quiet while the line is fine.
 *
 * Declared once here and handed to every module that calls itself a notifier,
 * rather than copied into each of them: the same six field definitions in six
 * files is six places for the next change to be made in five.
 *
 * They are appended in initialize(), which is the definition validateInput
 * reads. Adding them to the serialisation getIntegrations() builds instead
 * would render them in the dialog, accept a value, and have the whitelist at
 * the end of validateInput drop it on save with nothing said.
 *
 * A threshold is a number the measurement is compared against, so it is not
 * required and carries no maximum - a gigabit line's download limit is a
 * different order of magnitude from a DSL one's. `decimals` because the figures
 * it is compared against are stored as doubles, and an upload limit of 12.5
 * Mbit is an ordinary thing to want.
 */
const ALERT_FIELDS = [
    {name: ALERT_ONLY, type: "boolean", required: false},
    ...ALERT_METRICS.map(({field}) => ({name: field, type: "number", required: false, min: 0, decimals: true}))
];

/**
 * The digest opt-ins, one boolean per cadence, declared once for the same
 * reason ALERT_FIELDS is: identical fields on every notifier is one place for
 * the next change, not seven. Booleans rather than an off/weekly/monthly
 * choice because the form knows four field types and a digest is sensibly
 * both. A row from before the fields existed has no key, which reads falsy -
 * nobody is opted in by an upgrade.
 *
 * The read itself lives in util/digestOptIn.js, not here: this controller
 * imports the generated index that imports every module, so a module cannot
 * import it back - the leaf module is the home all readers can reach, and
 * the re-export keeps this side's callers on one name.
 */
const DIGEST_FIELDS = [
    {name: DIGEST_WEEKLY_FIELD, type: "boolean", required: false},
    {name: DIGEST_MONTHLY_FIELD, type: "boolean", required: false}
];

/**
 * The language a notifier writes its per-test messages in - the finished and
 * failed templates and the alert summary - offered for the reason the two
 * lists above are declared once. The digest is composed once per instance
 * before any recipient is known (tasks/digestReport.js) and does not read it
 * yet. A choice from the locales the interface ships -
 * the list is read off the locale directory, so it cannot name a language
 * nothing can answer - and not required: a notifier that chose none writes
 * English, which is what every row from before the field existed did.
 */
const LANGUAGE_FIELDS = [
    {name: LANGUAGE_FIELD, type: "select", required: false, options: NOTIFICATION_LANGUAGES}
];

/**
 * Whether a module asked to be offered the threshold settings.
 *
 * `notifier: true` is a module's own opt-in: it exists to tell a person
 * something, so it can sensibly be asked to stay quiet while the line is fine.
 * influxdb and healthChecks do not set it, for the reasons suppressesEvent
 * gives below.
 *
 * That last sentence is why this note lives here rather than above the flag in
 * each module, where it had been copied out six times: which integrations
 * abstain is a fact about the whole set, and no single module owns it or can
 * notice when it changes.
 */
const isNotifier = (definition) => definition?.notifier === true;

/**
 * Whether a module asked to be offered the language setting.
 *
 * A second opt-in rather than a reading of the first, because "can be asked to
 * stay quiet" and "writes prose somebody reads" are not the same property, and
 * the webhook is the integration that separates them. It calls itself a
 * notifier - it carries the thresholds, and staying quiet while the line is
 * fine is exactly what an operator wants of it - but what it delivers is a
 * JSON document a program reads. The only thing the language reached there was
 * the `alertCrossed` and `alertSummary` strings inside that document, so a
 * German setting rewrote the fields a script was matching on, in a place no
 * human was reading the wording anyway.
 *
 * The six that do set it are the ones with message templates: their whole
 * output is the sentence the setting is about.
 */
const isLocalised = (definition) => definition?.localised === true;

/**
 * The settings a message is composed from, with the language dropped for a
 * module that was never offered one.
 *
 * The stored column is whatever was last written to it, and rows saved while
 * the webhook was offered the field still carry a language. Read here rather
 * than migrated away, so a row that is later reconfigured onto a notifier
 * keeps the choice its operator made.
 */
const composingSettings = (moduleName, data) => isLocalised(getIntegration(moduleName))
    ? data
    : {...data, [LANGUAGE_FIELD]: undefined};

/**
 * The variables each message template accepts.
 *
 * The templates have always understood %ping% and the rest, and nothing said
 * so: the only hint was the example in the placeholder, which disappears the
 * moment anything is typed. The list belongs here because this is the side that
 * substitutes them - a copy in the interface would drift the first time a field
 * was added to the payload.
 *
 * Keyed per field, because a template for a finished test and one for a failure
 * do not accept the same names, and offering a variable that will not
 * substitute leaves a literal "%download%" in the message that arrives.
 *
 * The subject lines are here for the mirror-image reason. That last sentence
 * guards against offering a variable that does not substitute; email's two
 * subjects are the opposite case - server/integrations/email.js puts them
 * through replaceVariables exactly as it does the bodies, so they always
 * accepted these names and were the only templated fields never offered them.
 * The dialog drew a row of chips under "Finished message" and nothing under the
 * "Finished subject" directly above it, which reads as a statement that the
 * subject does not take variables.
 */
const TEMPLATE_VARIABLES = {
    finished_message: FINISHED_VARIABLES,
    finished_subject: FINISHED_VARIABLES,
    error_message: FAILED_VARIABLES,
    error_subject: FAILED_VARIABLES
};

const withVariables = (field) => Object.hasOwn(TEMPLATE_VARIABLES, field.name)
    ? {...field, variables: TEMPLATE_VARIABLES[field.name]}
    : field;

export const initialize = async () => {
    // Emptied first, for the same reason the fields array below is rebuilt
    // rather than appended to: this runs from the server's boot and again from
    // the integration test harness, and every pass registers each module's
    // callbacks afresh. Left to accumulate, the Nth load sends N copies of
    // every notification and writes N activity rows per event - the half of
    // this hazard that the comment below already described but did not cover.
    for (const name of Object.keys(events)) delete events[name];

    for (const { name, setup } of integrationModules) {
        const definition = setup(registerEvent(name));

        // A new object with a new array, never a push into the module's own
        // fields: initialize() runs from the server's boot and again from the
        // integration test harness, and the definition is handed out by
        // reference, so appending in place stacks another copy on every pass.
        const fields = [
            ...definition.fields,
            ...(isNotifier(definition) ? [...ALERT_FIELDS, ...DIGEST_FIELDS] : []),
            ...(isLocalised(definition) ? LANGUAGE_FIELDS : [])
        ].map(withVariables);

        integrations[name] = {...definition, fields};

        console.log(`Integration "${name}" loaded successfully`);
    }
};

/**
 * Whether this integration should not be told about this particular result.
 *
 * Exported for its tests: it is the decision that governs whether a person
 * hears from MySpeed at all, and triggerEvent below cannot be exercised without
 * a database behind it.
 *
 * Only the two per-test events are ever withheld, and only from modules that
 * call themselves notifiers - influxdb is a time series whose gaps read as an
 * outage, MQTT feeds a Home Assistant history that wants every point, and
 * healthChecks follows the round's own completion rather than the member
 * events, which closes the run its started ping opened whatever is decided
 * here. The keep-alive ping is how an integration says it is still there, and
 * nothing else carries a measurement to judge.
 *
 * Two gates, in order of who asked for the quiet. A member that opted out of
 * alerting is quiet to every notifier, failures included: `alerts` is the
 * target's own switch, the diagnostic box that fails because the machine is
 * asleep, and its events still leave the round so the sinks can mirror the
 * stored history - which is why the flag travels on the payload and is judged
 * here rather than gating the send at its source, where it silenced the sinks
 * too. Absent is not opted out: an older node's payload carries no flag. Then
 * the integration's own thresholds, which withhold only the finished event - a
 * failure of a watched line is the notification people most want.
 */
export const suppressesEvent = (eventName, moduleName, integration, payload) => {
    if (eventName !== "testFinished" && eventName !== "testFailed") return false;
    if (!isNotifier(getIntegration(moduleName))) return false;

    if (payload?.alerts === false) return true;

    if (eventName !== "testFinished") return false;
    if (!wantsOnlyBreaches(integration?.data)) return false;

    return !breachesThreshold(payload, integration.data);
};

export const getActive = () => activeRows();

export const getIntegrationById = (id) => IntegrationData.findOne({where: {id: id}});

/**
 * The field names an integration declared as credentials.
 *
 * Returns null - not an empty list - when the integration is unknown, so the
 * caller can tell "this one has no secrets" apart from "there is no definition
 * to ask". The two must not be treated alike: a stale row for an integration
 * that has since been removed would otherwise export in full.
 */
export const secretFieldNames = (name) => {
    const definition = getIntegration(name);
    if (!definition) return null;

    return definition.fields.filter((field) => field.secret).map((field) => field.name);
};

/**
 * Blanks every credential in a set of integration rows, keeping the keys so the
 * shape of the payload is unchanged.
 *
 * The config export is a file people download and attach to bug reports. It
 * carried Telegram bot tokens, Discord webhook URLs, Pushover keys and InfluxDB
 * tokens in clear, so one shared config.json compromised every downstream
 * service.
 */
export const withoutSecrets = (rows) => rows.map((row) => {
    const secrets = secretFieldNames(row.name);
    const data = typeof row.data === "string" ? JSON.parse(row.data) : {...row.data};

    // An unrecognised integration gets everything blanked. Guessing which of its
    // fields are harmless is exactly the mistake this function exists to stop.
    const fields = secrets ?? Object.keys(data);
    for (const field of fields) if (data[field] !== undefined) data[field] = null;

    /*
     * And a credential does not stop being one for living inside a URL.
     *
     * No integration flags its endpoint as a secret, and none should - it is
     * not one. But gotify's and influxdb's both accept `https?://\S+`, which
     * permits userinfo, so an operator fronting either with basic auth had
     * `http://myspeed:hunter2@influx.lan:8086` written into the file that
     * blanks the token beside it and stamps secretsRedacted true.
     *
     * Every string rather than a list of URL fields, so the next integration
     * with an endpoint does not have to be remembered here. For anything that
     * is not a URL carrying userinfo, this hands the value straight back - and
     * a row whose integration flags nothing as secret now reaches it too, which
     * an early return used to skip.
     */
    for (const [field, value] of Object.entries(data))
        if (typeof value === "string") data[field] = withoutUrlCredentials(value);

    return {...row, data};
});

export const deleteIntegration = async (id) => {
    const data = await IntegrationData.findOne({where: {id}});
    if (!data) return null;

    await IntegrationData.destroy({where: {id}});
    clearPingState(id);
    return true;
}

export const create = async (name, data) => {
    const integration = getIntegration(name);
    if (!integration) return null;

    const displayName = data.integration_name;
    delete data.integration_name;

    const created = await IntegrationData.create({name: name, data: data, displayName});

    return created.id;
}

export const patch = async (id, data) => {
    const item = await IntegrationData.findOne({where: {id: id}});
    if (!item) return null;

    const displayName = data.integration_name;
    delete data.integration_name;

    // validateInput returns an entry for every declared field, so a field the
    // caller left out arrives as undefined. Spreading those straight over the
    // stored object dropped them on serialisation, which turned "change one
    // setting" into "clear everything else".
    const changes = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));

    const update = {data: {...asDataObject(item.data), ...changes}};
    if (displayName !== undefined) update.displayName = displayName;

    // Awaited: the route answered "Integration updated" before the write had
    // landed, so a failing write was reported as a success.
    await IntegrationData.update(update, {where: {id: id}});
    clearPingState(id);
    return true;
}

export const getIntegrations = () => {
    const result = {};

    for (const [name, integration] of Object.entries(integrations)) {
        const updatedIntegration = {...integration};

        updatedIntegration.fields = updatedIntegration.fields.map((field) => ({
            ...field, regex: field.regex ? field.regex.source : undefined
        }));

        result[name] = {name, ...updatedIntegration};
    }

    return result;
};

/**
 * The definition registered under a name, or undefined.
 *
 * Object.hasOwn, not a bare lookup: `integrations["toString"]` answers
 * Object.prototype's, which is truthy - so a prototype name walked past the
 * route's 404 and died as a 500 inside validateInput instead. The config
 * controller had already been fixed for the identical trap.
 */
export const getIntegration = (name) =>
    Object.hasOwn(integrations, name) ? integrations[name] : undefined;

/**
 * The caps a declared text field wears.
 *
 * Named rather than written at the comparison, because the display name in
 * validateInput is held to the same one and is not a declared field of any
 * module - so the two have to move together or they disagree about the same
 * column type.
 */
const MAX_TEXT_LENGTH = 250;
const MAX_TEXTAREA_LENGTH = 2000;

/**
 * @param isPatch  whether this body is changing some settings rather than
 *                 supplying all of them.
 *
 * A PATCH that omits a required field used to be rejected outright, so
 * "change the message template" meant re-sending the token, the url and
 * everything else or getting a flat 400. patch() below is built for the
 * opposite - it filters undefined keys out and merges what is left over the
 * stored object, with a comment saying a field the caller left out arrives as
 * undefined, which can only happen if this let it through. The two halves
 * disagreed about their own contract.
 *
 * An explicit null or "" is still a rejection either way: that is not "leave it
 * alone", it is "clear a field that is required".
 */
export const validateInput = (module, data, isPatch = false) => {
    const integration = getIntegration(module);
    if (!integration) return false;

    for (const field of integration.fields) {
        const omitted = data[field.name] === undefined;

        if (field.required && !(isPatch && omitted)
            && (omitted || data[field.name] === null || data[field.name] === "")) return false;

        if (data[field.name] !== undefined && data[field.name] !== null && data[field.name] !== "") {
            // Checked before the lengths, which read `.length`: `undefined >
            // 250` is false, so a number, an object or an array sailed past
            // them and was whitelisted into the stored data column. At send
            // time replaceVariables calls message.replaceAll() on it and
            // throws - the influxdb module already guarded against exactly
            // this locally and named the hazard in a comment.
            if ((field.type === "text" || field.type === "textarea")
                && typeof data[field.name] !== "string") return false;

            if (field.type === "text" && data[field.name].length > MAX_TEXT_LENGTH) return false;
            if (field.type === "textarea" && data[field.name].length > MAX_TEXTAREA_LENGTH) return false;

            /*
             * And the pattern last of the three, because it is the one whose
             * cost depends on how long the value is.
             *
             * This ran first, against the raw request value, whose only bound is
             * app.js's 100kb body parser - so every pattern a module declares
             * was handed up to 100,000 characters. All eleven shipped patterns
             * are linear and were timed to 80,000 characters, so nothing was
             * wrong; what this changes is that the next module to declare one
             * cannot be handed more than its column takes. The threshold check
             * in the config controller is what happens when that is left to
             * whoever writes the pattern.
             *
             * Every branch here answers `false`, so moving it changes no
             * answer - only which check gets there first.
             *
             * Still ahead of the number branch below, which ends by writing the
             * coerced value back: past that, this would be testing a number
             * rather than what arrived.
             */
            if (field.regex && !new RegExp(field.regex).test(data[field.name])) return false;

            if (field.type === "boolean" && typeof data[field.name] !== "boolean") return false;
            // Held to the list the field declares. `includes` is a strict
            // comparison, so a number, an array or an object holding a valid
            // code is refused with the rest.
            //
            // A select that declares no list refuses everything rather than
            // throwing on the read: the only such list today is built from the
            // locale directory, which answers an empty array where no source
            // could be found - and a field with nothing to offer has no value
            // it can accept. A TypeError here would come out of the route as a
            // 500 on an ordinary save.
            if (field.type === "select"
                && (!Array.isArray(field.options) || !field.options.includes(data[field.name]))) return false;
            if (field.type === "number") {
                // Checked before coercing, for the same reason the text branch
                // above checks its own type: Number([]) is 0 and Number(true) is
                // 1, so an array or a boolean passed every numeric test and was
                // whitelisted into the stored data column as a plausible number.
                const raw = data[field.name];
                if (typeof raw !== "number" && typeof raw !== "string") return false;

                const num = Number(raw);
                // A field that declares `decimals` is compared against a stored
                // measurement rather than counted, so a fraction is a legitimate
                // value for it. Everything else stays whole, as it was.
                if (field.decimals ? !Number.isFinite(num) : !Number.isInteger(num)) return false;
                if (field.min !== undefined && num < field.min) return false;
                if (field.max !== undefined && num > field.max) return false;
                data[field.name] = num;
            }
        }
    }

    /**
     * The display name, which is the one value here no module declares - so
     * the loop above, where every type and length cap lives, never saw it. It
     * was copied onto the result unread and assigned straight to `displayName`,
     * a bare Sequelize.STRING: VARCHAR(255) on MySQL, where an over-long name
     * was ER_DATA_TOO_LONG and a 500 with a stack in the operator's log, while
     * sqlite stored it whole behind the 200 the create route answers with. The
     * two supported backends answered the same request differently.
     *
     * A non-string did not simply fail. Sequelize's STRING validator lets a
     * number through - `42` was stored as the text "42" on both backends, with
     * nothing said - and threw only for a boolean, an object or an array, which
     * is where the 500 came from. So the type half of this check is not
     * belt-and-braces beside the length: it is the only thing standing between
     * a numeric display name and a silently coerced one.
     *
     * Held to the text cap rather than to 255, so it wears the limit a declared
     * text field wears and stays inside the column either way.
     *
     * undefined stays allowed, and has to: the column names its own default for
     * create(), and patch() reads undefined as "leave the name alone".
     */
    const displayName = data["integration_name"];
    if (displayName !== undefined
        && (typeof displayName !== "string" || displayName.length > MAX_TEXT_LENGTH)) return false;

    const result = {};
    for (const field of integration.fields) result[field.name] = data[field.name];
    result["integration_name"] = displayName;

    return result;
}