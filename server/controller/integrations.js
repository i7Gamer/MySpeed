import IntegrationData from '../models/IntegrationData.js';
import integrationModules from '../integrations/index.js';

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

const getActiveByName = async (name) => {
    const data = await IntegrationData.findAll({where: {name: name}});
    if (!data) return null;

    return data.map((item) => ({...item, data: asDataObject(item.data)}));
}

const triggerActivity = async (id, error = false) => {
    await IntegrationData.update({lastActivity: new Date().toISOString(), activityFailed: error}, {where: {id: id}});
}

export const triggerEvent = async (name, data) => {
    if (!events[name]) return;

    for (const module of events[name]) {
        const active = await getActiveByName(module.module);
        for (const integration of active) {
            if (shouldThrottlePing(name, integration)) continue;
            await module.callback(integration, data, (error = false) => triggerActivity(integration.id, error));
        }
    }
}

export const clearPingState = (id) => {
    delete lastPings[id];
}

export const initialize = async () => {
    for (const { name, setup } of integrationModules) {
        integrations[name] = setup(registerEvent(name));
        console.log(`Integration "${name}" loaded successfully`);
    }
};

export const getActive = async () => {
    const data = await IntegrationData.findAll();
    if (!data) return null;

    return data.map((item) => ({...item, data: asDataObject(item.data)}));
}

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
    const definition = integrations[name];
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
    const integration = integrations[name];
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

export const getIntegration = (name) => integrations[name];

export const validateInput = (module, data) => {
    const integration = integrations[module];
    if (!integration) return false;

    for (const field of integration.fields) {
        if (field.required && (data[field.name] === undefined || data[field.name] === null || data[field.name] === "")) return false;

        if (data[field.name] !== undefined && data[field.name] !== null && data[field.name] !== "") {
            if (field.regex && !new RegExp(field.regex).test(data[field.name])) return false;
            if (field.type === "text" && data[field.name].length > 250) return false;
            if (field.type === "textarea" && data[field.name].length > 2000) return false;
            if (field.type === "boolean" && typeof data[field.name] !== "boolean") return false;
            if (field.type === "number") {
                const num = Number(data[field.name]);
                if (!Number.isInteger(num)) return false;
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