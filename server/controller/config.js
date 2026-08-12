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
 * The floor a chosen password has to clear before it is hashed and stored.
 *
 * This guards the admin credential of an instance that may face the open
 * internet, where the failed-attempt throttle only slows a dictionary down.
 * One rule per entry, so the refusal can say which rule was broken instead of
 * reciting the whole policy at someone who missed one character class.
 *
 * Only a *newly chosen* password passes through here: a restored backup
 * carries the bcrypt hash verbatim, so existing installs keep working.
 */
const PASSWORD_MIN_LENGTH = 8;

const PASSWORD_RULES = [
    {
        broken: (value) => value.length < PASSWORD_MIN_LENGTH,
        message: `The password must be at least ${PASSWORD_MIN_LENGTH} characters long`
    },
    {
        broken: (value) => !/[a-z]/.test(value) || !/[A-Z]/.test(value),
        message: "The password must contain both lower and upper case letters"
    },
    {
        broken: (value) => !/[0-9]/.test(value) && !/[^A-Za-z0-9]/.test(value),
        message: "The password must contain a number or a special character"
    }
];

/** The first rule a candidate breaks, or null when it passes. Exported for tests. */
export const passwordPolicyProblem = (value) =>
    PASSWORD_RULES.find((rule) => rule.broken(value))?.message ?? null;

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

/**
 * How much disk one sqlite database actually occupies.
 *
 * The driver runs in WAL mode, so everything written since the last checkpoint
 * lives in the `-wal` sidecar rather than in the database file - an instance
 * with 336 tests stat'd as 4 KB while holding 264 KB, which made the figure
 * wrong essentially always. `-shm` is the index into that log and is counted
 * for the same reason.
 *
 * A file that is not there yet contributes nothing: a fresh install has no
 * database until the first write, and the dialog asking how much space is used
 * must not be the thing that fails on it.
 */
const SQLITE_SIDECARS = ["-wal", "-shm"];

const fileBytes = (file) => {
    try {
        return fs.statSync(file).size;
    } catch {
        return 0;
    }
};

export const sqliteBytes = (databasePath) =>
    [databasePath, ...SQLITE_SIDECARS.map((suffix) => databasePath + suffix)]
        .reduce((total, file) => total + fileBytes(file), 0);

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

        size = sqliteBytes(STORAGE_PATH);
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

        const problem = passwordPolicyProblem(value.toString());
        if (problem) return problem;

        value = await bcrypt.hash(value, PASSWORD_HASH_ROUNDS);
    }

    if (key === "cron" && !cron.isValidCron(value.toString()))
        return "Not a valid cron expression";

    // Compared as a string: this is stored in a STRING column and the client
    // sends "true"/"false", but a boolean true is the obvious thing for anyone
    // driving the API to send and it was rejected with "provide either true or
    // false" - which is exactly what they had sent.
    if (key === "scheduleOffset" && !["true", "false"].includes(value?.toString()))
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

    // Object.hasOwn, not a lookup: configDefaults["toString"] answers with
    // Object.prototype's, so a prototype name walked past this check and died
    // as a 500 in the update instead of the 400 an unknown key earns.
    if (!Object.hasOwn(configDefaults, key))
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
        // hasOwn for the same reason as validateInput: a hand-edited backup
        // carrying "toString" or "__proto__" must be skipped, not written.
        if (!Object.hasOwn(configDefaults, key)) continue;

        // Restored verbatim. The exported value is already a bcrypt hash, and
        // validateInput would hash it a second time - the restored instance
        // would accept no password at all. A redacted export carries no
        // password key, so this simply leaves the current one alone.
        if (key === "password") {
            if (!isStoredPassword(obj.config[key])) return false;
            updates.push({key, value: obj.config[key]});
            continue;
        }

        // What is skipped for a default is the *validation*, not the write.
        // Several defaults are sentinels validateInput deliberately refuses as
        // user input - `provider: "none"` means "not chosen yet" - so a
        // round-tripped export could not carry them back through it.
        //
        // Skipping the write as well made a restore a no-op for exactly the
        // settings an operator most needs put back, while still answering 200:
        // restoring a year of retention onto an instance pruning weekly left it
        // pruning weekly, and restoring open access onto one locked to
        // read-only left it locked.
        if (obj.config[key] === configDefaults[key]) {
            updates.push({key, value: configDefaults[key]});
            continue;
        }

        const validated = await validateInput(key, obj.config[key]);
        if (typeof validated === "string") return false;

        updates.push({key, value: validated.value});
    }

    // Read before the write, so the scheduler is only rebuilt when the restore
    // actually moves the schedule. Now that a default is written rather than
    // skipped, every full backup carries a cron - and restarting on all of them
    // tears down a working timer and starts a fresh one for no reason.
    const storedCron = await getValue("cron");

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

    // Restoring a backup is usually the remediation, so a session issued
    // against the password it replaced must not outlive it. password.js honours
    // a valid session before it ever reads the stored hash, so the old holder
    // would otherwise keep full access for the rest of its seven days - past
    // the point where the old password itself correctly stops working.
    if (updates.some((update) => update.key === "password")) destroyAllSessions();

    // Restarting the scheduler is not something a transaction can roll back, so
    // it only happens once the import has actually committed.
    const cron = updates.find((update) => update.key === "cron");
    if (cron && cron.value.toString() !== storedCron) {
        timer.stopTimer();
        timer.startTimer(cron.value.toString());
    }

    return true;
}

export const factoryReset = async () => {
    // Cleared and re-seeded rather than updated key by key. The loop read
    // configDefaults[key] for every key the table happened to hold, so a key
    // left behind by an older version - or one written by hand - resolved to
    // undefined and was written into a NOT NULL column. That threw from the
    // middle of the reset, leaving the configuration half-default and skipping
    // everything below, including the session revocation. It also never
    // restored a default whose row was missing altogether.
    await config.destroy({where: {}});
    await insertDefaults();

    // The reset put the password back to the unprotected sentinel without going
    // through updateValue, which is the only place that revoked sessions.
    destroyAllSessions();

    await node.destroy({where: {}});
    await recommendations.destroy({where: {}});
    await integration.destroy({where: {}});

    timer.stopTimer();
    timer.startTimer(configDefaults.cron);

    interfaces.requestInterfaces();

    return true;
}