import config from '../models/Config.js';
import node from '../models/Node.js';
import test from '../models/Speedtests.js';
import recommendations from '../models/Recommendations.js';
import integration from '../models/IntegrationData.js';
import { triggerEvent, withoutSecrets } from './integrations.js';
import bcrypt from 'bcryptjs';
import * as timer from '../tasks/timer.js';
import cron from 'cron-validator';
import db from '../config/database.js';
import fs from 'node:fs';
import path from 'node:path';
import * as interfaces from '../util/loadInterfaces.js';
import { destroyAllSessions } from '../util/session.js';

const configDefaults = {
    ping: "25",
    download: "100",
    upload: "50",
    cron: "0 * * * *",
    scheduleOffset: "true",
    provider: "none",
    ooklaId: "none",
    libreId: "none",
    libreUrl: "none",
    password: "none",
    passwordLevel: "none",
    interface: "none",
    retentionDays: "365"
}

const MAX_RETENTION_DAYS = 10000;

// The value stored when no password is configured. It is a sentinel, not a
// password: password.js waves every request through when it sees this.
export const NO_PASSWORD = "none";

const PASSWORD_HASH_ROUNDS = 10;

/**
 * A stored password is either the no-password sentinel or a bcrypt hash.
 *
 * An import writes the value straight into the column password.js compares
 * against, and bcrypt never matches a malformed hash - so a hand-edited backup
 * carrying a plaintext password would lock the owner out of their own instance
 * with no way back short of editing the database.
 */
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

const isStoredPassword = (value) => value === NO_PASSWORD || BCRYPT_HASH.test(String(value ?? ""));

// Tables importConfig replaces wholesale, mapped to the payload key carrying them.
const IMPORTED_TABLES = [
    {key: "nodes", model: node},
    {key: "integrations", model: integration},
    {key: "recommendations", model: recommendations}
];

export const insertDefaults = async () => {
    let insert = [];
    for (let key in configDefaults) {
        if (key !== "interface" && !(await config.findOne({where: {key: key}})))
            insert.push({key: key, value: configDefaults[key]});

        if (key === "interface") {
            const ips = Object.keys(interfaces.interfaces);
            let ip = ips.length > 0 ? ips[0] : "none";

            if (!(await config.findOne({where: {key: key}})))
                insert.push({key: key, value: ip});
        }
    }

    await config.bulkCreate(insert, {validate: true});
}

export const listAll = async () => {
    return await config.findAll();
}

export const getValue = async (key) => {
    return (await config.findByPk(key))?.value;
}

export const updateValue = async (key, newValue) => {
    if ((await getValue(key)) === undefined) return undefined;

    // Changing or clearing the password takes access back, and a session left
    // alive would quietly undo that: the browser holding it would keep working
    // against a password that no longer exists.
    if (key === "password") destroyAllSessions();

    triggerEvent("configUpdated", {key: key, value: key === "password" ? "protected" : newValue})
        .then(undefined);

    return await config.update({value: newValue}, {where: {key: key}});
}

export const getUsedStorage = async () => {
    let size = 0;

    if (process.env.DB_TYPE === "mysql") {
        const sizes = await db.query("SELECT table_name AS `Table`, ROUND((data_length + index_length), 2) AS `size` FROM information_schema.TABLES WHERE table_schema = ?;", {
            replacements: [process.env.DB_NAME],
            type: db.QueryTypes.SELECT
        });
        for (let i = 0; i < sizes.length; i++) {
            size += parseFloat(sizes[i].size);
        }
    } else {
        const STORAGE_PATH = path.join(process.cwd(), 'data', `storage${process.env.PREVIEW_MODE === "true" ? "_preview" : ""}.db`);

        size = fs.statSync(STORAGE_PATH).size;
    }

    return {size, testCount: await test.count()};
}

export const validateInput = async (key, value) => {
    if (!value?.toString()) return "You need to provide the new value";

    if ((key === "ping" || key === "download" || key === "upload") && /[^0-9.]/.test(value))
        return "You need to provide a number in order to change this";

    if ((key === "ooklaId" || key === "libreId") && (/[^0-9]/.test(value) && value !== "none"))
        return "You need to provide a number in order to change this";

    if (key === "libreUrl" && value !== "none") {
        try {
            new URL(value);
        } catch (e) {
            return "You need to provide a valid URL";
        }
    }

    if (key === "passwordLevel" && !["none", "read"].includes(value))
        return "You need to provide either none or read-access";

    if (key === "provider" && !["ookla", "libre", "cloudflare"].includes(value))
        return "You need to provide a valid provider";

    if (key === "ping")
        value = value.toString().split(".")[0];

    // "none" is the stored sentinel for "no password configured". Letting it
    // through as a chosen password stored the literal string, which
    // password.js reads as "unprotected" - the instance was left open while
    // the API answered "successfully updated".
    if (key === "password") {
        if (value === NO_PASSWORD)
            return "This password cannot be used. Use the remove button to clear the password instead";

        value = await bcrypt.hash(value, PASSWORD_HASH_ROUNDS);
    }

    if (key === "cron" && !cron.isValidCron(value.toString()))
        return "Not a valid cron expression";

    if (key === "scheduleOffset" && !["true", "false"].includes(value))
        return "You need to provide either true or false";

    if (key === "interface" && !Object.keys(interfaces.interfaces).includes(value))
        return "The provided interface does not exist";

    if (key === "retentionDays") {
        // Anchored: a bare [^0-9-] character check also passed "5-3", which
        // parseInt then quietly read as 5.
        if (!/^-?[0-9]+$/.test(value.toString()))
            return "You need to provide a number in order to change this";

        const num = parseInt(value);

        if (num <= 0) {
            value = "0";
        } else if (num > MAX_RETENTION_DAYS) {
            return `Retention must be ${MAX_RETENTION_DAYS} days or less (use 0 for unlimited)`;
        } else {
            value = num.toString();
        }
    }

    if (configDefaults[key] === undefined)
        return "The provided key does not exist";

    if (process.env.PREVIEW_MODE === "true" && (key === "password" || key === "passwordLevel"))
        return "You can't change the password in preview mode";

    return {value: value};
}

/** Clears the password. The only way back to the unprotected sentinel. */
export const clearPassword = async () => await updateValue("password", NO_PASSWORD);

/**
 * The whole configuration as a downloadable backup.
 *
 * Credentials are left out unless the caller explicitly asks for them. The
 * export used to hand back node passwords and every integration token in clear,
 * which turned a config.json - a file people attach to bug reports and sync to
 * cloud backups - into a dump of every downstream service's secrets. A restore
 * from a redacted export brings back the nodes and integrations themselves; only
 * their credentials have to be re-entered.
 */
export const exportConfig = async ({includeSecrets = false} = {}) => {
    let obj = {};
    obj.config = {};

    let configValues = await config.findAll();
    for (let i = 0; i < configValues.length; i++) {
        // `interface` is this host's own network adapter. It does not transfer
        // to another machine, and validateInput would reject the unknown name
        // and fail the whole import.
        if (configValues[i].key === "interface") continue;

        // The admin password hash is a credential like any other: left out of a
        // redacted export, carried by a full one. Without it a restore brought
        // the instance back unprotected, which is the one difference from the
        // original state nobody would think to check.
        if (configValues[i].key === "password" && !includeSecrets) continue;

        obj.config[configValues[i].key] = configValues[i].value;
    }

    const nodeRows = await node.findAll();
    obj.nodes = includeSecrets ? nodeRows : nodeRows.map((row) => ({...row, password: null}));

    obj.recommendations = await recommendations.findAll();

    const integrationRows = await integration.findAll();
    obj.integrations = includeSecrets ? integrationRows : withoutSecrets(integrationRows);

    // Stated in the file itself, so nobody restores a redacted backup and is
    // left guessing why their notifications stopped.
    obj.secretsRedacted = !includeSecrets;

    return obj;
}

/**
 * Every export carries all three tables, so an absent key means a truncated or
 * hand-edited file rather than "this table is empty" - and reading it as the
 * latter would delete the very rows the import was meant to restore.
 */
const asRows = (value) => Array.isArray(value) ? value : null;

/**
 * Replaces the stored configuration with an exported one.
 *
 * The whole payload is checked before a single row is touched, and the
 * replacement runs in one transaction. Previously the three tables were
 * emptied first and validated afterwards, so a payload missing so much as the
 * `nodes` key destroyed every node, integration and recommendation with no way
 * back - there is no soft delete and nothing else holds a copy.
 */
export const importConfig = async (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;

    const rows = {};
    for (const {key} of IMPORTED_TABLES) {
        const value = asRows(obj[key]);
        if (value === null) return false;
        rows[key] = value;
    }

    try {
        rows.integrations = rows.integrations.map((entry) => ({
            ...entry,
            // A current export carries `data` as an object already; only older
            // exports store it as a JSON string.
            data: typeof entry?.data === "string" ? JSON.parse(entry.data) : entry?.data
        }));
    } catch {
        return false;
    }

    const updates = [];
    for (const key in obj.config ?? {}) {
        if (configDefaults[key] === undefined) continue;

        // Restored verbatim. The exported value is already a bcrypt hash, and
        // validateInput would hash it a second time - the restored instance
        // would accept no password at all. A redacted export carries no
        // password key, so this simply leaves the current one alone.
        if (key === "password") {
            if (!isStoredPassword(obj.config[key])) return false;
            updates.push({key, value: obj.config[key]});
            continue;
        }

        // A value already at its default needs no write, which also keeps a
        // round-tripped export importable: several defaults are sentinels that
        // validateInput deliberately refuses as user input.
        if (obj.config[key] === configDefaults[key]) continue;

        const validated = await validateInput(key, obj.config[key]);
        if (typeof validated === "string") return false;

        updates.push({key, value: validated.value});
    }

    try {
        await db.transaction(async (transaction) => {
            for (const {key, value} of updates)
                await config.update({value}, {where: {key}, transaction});

            for (const {model} of IMPORTED_TABLES)
                await model.destroy({where: {}, transaction});

            for (const {key, model} of IMPORTED_TABLES)
                await model.bulkCreate(rows[key], {transaction});
        });
    } catch (e) {
        return false;
    }

    // Restarting the scheduler is not something a transaction can roll back, so
    // it only happens once the import has actually committed.
    const cron = updates.find((update) => update.key === "cron");
    if (cron) {
        timer.stopTimer();
        timer.startTimer(cron.value.toString());
    }

    return true;
}

export const factoryReset = async () => {
    let configValues = await config.findAll();
    for (let i = 0; i < configValues.length; i++) {
        await config.update({value: configDefaults[configValues[i].key]}, {where: {key: configValues[i].key}});
    }

    await node.destroy({where: {}});
    await recommendations.destroy({where: {}});
    await integration.destroy({where: {}});

    timer.stopTimer();
    timer.startTimer(configDefaults.cron);

    interfaces.requestInterfaces();

    return true;
}