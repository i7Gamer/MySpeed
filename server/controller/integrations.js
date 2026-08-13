import IntegrationData from '../models/IntegrationData.js';
import integrationModules from '../integrations/index.js';
import { ALERT_METRICS, ALERT_ONLY, breachesThreshold, wantsOnlyBreaches } from '../util/alertThreshold.js';
import { FAILED_VARIABLES, FINISHED_VARIABLES } from '../util/notificationPayload.js';

const integrations = {};

const events = {};

const lastPings = {};

const registerEvent = (module) => (name, callback) => {
    if (!events[name]) events[name] = [];
    events[name].push({module, callback});
}

const shouldThrottlePing = (eventName, integration) => {
    if (eventName !== "minutePassed") return false;

    const intervalRaw = integration.data?.interval;
    const interval = Number.isInteger(intervalRaw) && intervalRaw > 0 ? intervalRaw : 1;
    if (interval <= 1) return false;

    const now = Date.now();
    const last = lastPings[integration.id];
    if (last !== undefined && now - last < interval * 60 * 1000 - 30 * 1000) return true;

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

const triggerActivity = async (id, error = false) => {
    await IntegrationData.update({lastActivity: new Date().toISOString(), activityFailed: error}, {where: {id: id}});
}

export const triggerEvent = async (name, data) => {
    if (!events[name]) return;

    for (const module of events[name]) {
        const active = await getActiveByName(module.module);
        for (const integration of active) {
            if (shouldThrottlePing(name, integration)) continue;

            // Stamped even though nothing was sent. The activity columns are
            // the only thing the dialog reads to decide between "last run …"
            // and "Never executed", so an integration doing exactly what it was
            // asked - staying quiet through a run of healthy tests - would
            // otherwise present itself as one that has never worked.
            if (suppressesEvent(name, module.module, integration, data)) {
                await triggerActivity(integration.id, false).catch(() => undefined);
                continue;
            }

            // Contained per integration. One throwing callback used to end the
            // whole fan-out, so every integration registered after it missed
            // the event with nothing said - and the throw could come from a
            // stored value the validator should never have accepted.
            try {
                await module.callback(integration, data, (error = false) => triggerActivity(integration.id, error));
            } catch (e) {
                console.error(`Integration "${module.module}" failed to handle ${name}: ${e?.message ?? e}`);
                await triggerActivity(integration.id, true).catch(() => undefined);
            }
        }
    }
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

/** Whether a module asked to be offered the threshold settings. */
const isNotifier = (definition) => definition?.notifier === true;

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
 */
const TEMPLATE_VARIABLES = {
    finished_message: FINISHED_VARIABLES,
    error_message: FAILED_VARIABLES
};

const withVariables = (field) => Object.hasOwn(TEMPLATE_VARIABLES, field.name)
    ? {...field, variables: TEMPLATE_VARIABLES[field.name]}
    : field;

export const initialize = async () => {
    for (const { name, setup } of integrationModules) {
        const definition = setup(registerEvent(name));

        // A new object with a new array, never a push into the module's own
        // fields: initialize() runs from the server's boot and again from the
        // integration test harness, and the definition is handed out by
        // reference, so appending in place stacks another copy on every pass.
        const fields = (isNotifier(definition)
            ? [...definition.fields, ...ALERT_FIELDS]
            : definition.fields).map(withVariables);

        integrations[name] = {...definition, fields};

        console.log(`Integration "${name}" loaded successfully`);
    }
};

/**
 * Whether this integration asked not to be told about this particular result.
 *
 * Exported for its tests: it is the decision that governs whether a person
 * hears from MySpeed at all, and triggerEvent below cannot be exercised without
 * a database behind it.
 *
 * Only the finished-test event is ever withheld. A failure is the notification
 * people most want, the keep-alive ping is how an integration says it is still
 * there, and nothing else carries a measurement to judge. Only modules that
 * call themselves notifiers are gated at all - influxdb is a time series whose
 * gaps read as an outage, and healthChecks' finished ping is what closes the
 * run its started ping opened.
 */
export const suppressesEvent = (eventName, moduleName, integration, payload) => {
    if (eventName !== "testFinished") return false;
    if (!isNotifier(getIntegration(moduleName))) return false;
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
    if (secrets !== null && secrets.length === 0) return row;

    const data = typeof row.data === "string" ? JSON.parse(row.data) : {...row.data};

    // An unrecognised integration gets everything blanked. Guessing which of its
    // fields are harmless is exactly the mistake this function exists to stop.
    const fields = secrets ?? Object.keys(data);
    for (const field of fields) if (data[field] !== undefined) data[field] = null;

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
            if (field.regex && !new RegExp(field.regex).test(data[field.name])) return false;

            // Checked before the lengths, which read `.length`: `undefined >
            // 250` is false, so a number, an object or an array sailed past
            // them and was whitelisted into the stored data column. At send
            // time replaceVariables calls message.replaceAll() on it and
            // throws - the influxdb module already guarded against exactly
            // this locally and named the hazard in a comment.
            if ((field.type === "text" || field.type === "textarea")
                && typeof data[field.name] !== "string") return false;

            if (field.type === "text" && data[field.name].length > 250) return false;
            if (field.type === "textarea" && data[field.name].length > 2000) return false;
            if (field.type === "boolean" && typeof data[field.name] !== "boolean") return false;
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

    const result = {};
    for (const field of integration.fields) result[field.name] = data[field.name];
    result["integration_name"] = data["integration_name"];

    return result;
}