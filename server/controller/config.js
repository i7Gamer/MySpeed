import config from '../models/Config.js';
import node from '../models/Node.js';
import test from '../models/Speedtests.js';
import recommendations from '../models/Recommendations.js';
import integration from '../models/IntegrationData.js';
import { triggerEvent, withoutSecrets } from './integrations.js';
import bcrypt from 'bcryptjs';
import * as timer from '../tasks/timer.js';
import cron from 'cron-validator';
import db, { SQLITE_STORAGE_PATH } from '../config/database.js';
import { toErrorMessage } from '../util/helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import * as interfaces from '../util/loadInterfaces.js';
import { destroyAllSessions } from '../util/session.js';
import { isValidTimeOfDay } from '../util/quietHours.js';

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
    retentionDays: "365",
    // The daily window in which no scheduled test runs. Both ends have to be
    // set before it means anything, so both default to the off sentinel.
    quietHoursStart: "none",
    quietHoursEnd: "none"
}

const MAX_RETENTION_DAYS = 10000;

/**
 * A speed or latency threshold: anything that reads as a number, and nothing
 * that does not.
 *
 * Anchored, for the reason retentionDays states where it does the same thing. A
 * bare negated class - `/[^0-9.]/` - only asks whether every character is a
 * digit or a dot, so "1.2.3", ".." and "." were all numbers to it.
 *
 * What that cost was quiet rather than loud. No server code reads these three
 * keys, so the value was stored behind a 200 and handed to the client, where
 * `Number("1.2.3")` is NaN and getIconBySpeed answers `blue` for a threshold it
 * cannot read - the colour this interface uses for a figure nobody measured, so
 * every speed on the page reads as ungraded and nothing on screen names the
 * value that did it. "." was worse: the ping branch below splits on the dot, so
 * what reached the column was the empty string.
 *
 * Wide on purpose either side of the dot. ".5" and "1." are 0.5 and 1, the old
 * check took both, and an instance can be holding one now - and importConfig
 * runs every stored key back through here and abandons the whole restore on the
 * first refusal, naming no key. Refusing a value that was legal when it was
 * saved would take the nodes and the integrations down with a threshold.
 */
const THRESHOLD_NUMBER = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)$/;

/**
 * The three keys that rule is for, named once because importConfig treats them
 * apart from every other value it restores - see the fallback there.
 */
const THRESHOLD_KEYS = ["ping", "download", "upload"];

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

// `transaction` is optional so factoryReset can clear the table and re-seed it
// as one unit. Without it, a failure between the two left the instance with no
// configuration at all, which every reader treats as neither the stored value
// nor the default.
export const insertDefaults = async (transaction = undefined) => {
    let insert = [];
    for (let key in configDefaults) {
        if (key !== "interface" && !(await config.findOne({where: {key: key}, transaction})))
            insert.push({key: key, value: configDefaults[key]});

        if (key === "interface") {
            const ips = Object.keys(interfaces.interfaces);
            let ip = ips.length > 0 ? ips[0] : "none";

            if (!(await config.findOne({where: {key: key}, transaction})))
                insert.push({key: key, value: ip});
        }
    }

    await config.bulkCreate(insert, {validate: true, transaction});
}

export const listAll = async () => {
    return await config.findAll();
}

export const getValue = async (key) => {
    return (await config.findByPk(key))?.value;
}

export const updateValue = async (key, newValue) => {
    if ((await getValue(key)) === undefined) return undefined;

    /*
     * The write first, then the two things that describe it.
     *
     * Both used to run ahead of it. A write the database refuses - a locked
     * sqlite file, a MySQL connection dropped between the read above and the
     * write below - had already told every subscribed webhook that the value
     * changed, and for a password change had already logged the operator out of
     * an instance whose password was never altered. The caller then gets a 500
     * for an operation whose side effects have all happened.
     *
     * This is the ordering d499ad30 fixed in controller/recommendations.js,
     * which explains it at the call site there too.
     */
    const result = await config.update({value: newValue}, {where: {key: key}});

    // Changing or clearing the password takes access back, and a session left
    // alive would quietly undo that: the browser holding it would keep working
    // against a password that no longer exists.
    if (key === "password") destroyAllSessions();

    // Not awaited - an integration is allowed to be slow, and a caller waiting
    // on a config save should not wait on a webhook - but its rejection is
    // caught rather than dropped. triggerEvent already contains a failing
    // module; this covers a failure of the dispatch itself, which floated free
    // to the process-level unhandledRejection hook.
    triggerEvent("configUpdated", {key: key, value: key === "password" ? "protected" : newValue})
        .catch((error) => console.error(`Could not announce the change to '${key}': ${toErrorMessage(error)}`));

    return result;
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
        // The path the database is actually opened with, rather than a second
        // derivation of it. Resolved against the working directory because the
        // exported value is relative, exactly as sequelize receives it.
        size = sqliteBytes(path.resolve(process.cwd(), SQLITE_STORAGE_PATH));
    }

    return {size, testCount: await test.count()};
}

export const validateInput = async (key, value) => {
    if (!value?.toString()) return "You need to provide the new value";

    if (THRESHOLD_KEYS.includes(key) && !THRESHOLD_NUMBER.test(value.toString()))
        return "You need to provide a number in order to change this";

    if ((key === "ooklaId" || key === "libreId") && (/[^0-9]/.test(value) && value !== "none"))
        return "You need to provide a number in order to change this";

    if (key === "libreUrl" && value !== "none") {
        try {
            new URL(value);
        } catch {
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
        // Checked before the policy, not stringified into it. The policy ran
        // against value.toString() while the hash was taken of the raw value,
        // so anything whose string form happened to satisfy the rules reached
        // bcrypt - and bcryptjs refuses a non-string outright. `{"value": {}}`
        // stringifies to "[object Object]": fifteen characters, both cases, a
        // special character, every rule cleared. The throw left the controller
        // instead of earning the 400 every other malformed key gets.
        if (typeof value !== "string")
            return "The password has to be text";

        if (value === NO_PASSWORD)
            return "This password cannot be used. Use the remove button to clear the password instead";

        const problem = passwordPolicyProblem(value);
        if (problem) return problem;

        value = await bcrypt.hash(value, PASSWORD_HASH_ROUNDS);
    }

    if (key === "cron" && !cron.isValidCron(value.toString()))
        return "Not a valid cron expression";

    if ((key === "quietHoursStart" || key === "quietHoursEnd") && !isValidTimeOfDay(value.toString()))
        return "You need to provide a time of day as HH:MM, or none to switch the quiet hours off";

    // Compared as a string, and then *stored* as one. A boolean true is the
    // obvious thing for anyone driving the API to send, and it used to be
    // rejected with "provide either true or false" - which is what they had
    // sent. Accepting it without this normalisation was worse than the
    // rejection though: the raw boolean reached a STRING column and came back
    // as sqlite's rendering of a bound boolean, the text "1.0", which no reader
    // compares equal to "true". The offset silently stayed off behind a 200,
    // and every later config export carried a value that fails validation on
    // the way back in, so the whole restore was refused.
    if (key === "scheduleOffset") {
        if (!["true", "false"].includes(value?.toString()))
            return "You need to provide either true or false";

        value = value.toString();
    }

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
/**
 * What a refused import answers with when no single value is to blame - a
 * payload that is not a backup, or a write the database turned down.
 *
 * An object rather than a boolean, because the useful half of a refusal is
 * *which* key it was: the import abandons everything on the first value it
 * cannot read, so an operator was left holding a file that would not go back
 * and sixteen stored values to bisect by hand.
 */
const REFUSED = {ok: false};

export const importConfig = async (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return REFUSED;

    const rows = {};
    for (const {key} of IMPORTED_TABLES) {
        const value = asRows(obj[key]);
        if (value === null) return REFUSED;
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
        return REFUSED;
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
            if (!isStoredPassword(obj.config[key])) return {ok: false, key};
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

        if (typeof validated === "string") {
            /*
             * A threshold that can no longer be read takes the default rather
             * than the whole restore.
             *
             * These three were guarded by a negated character class until this
             * check was anchored - "is every character a digit or a dot" - so
             * "1.2.3", ".." and a lone "." were all stored behind a 200 by an
             * older version. Every backup carrying one would otherwise be
             * refused here in full, and the refusal names no key: the nodes,
             * the integrations and the recorded history are all left behind by
             * a display preference no server code even reads.
             *
             * The same trade this rule already makes for ".5" and "1." - a
             * value that was legal when it was saved must not take a restore
             * down with it - except that these cannot be kept as they are,
             * because Number() cannot read them and a threshold it cannot read
             * greys every speed on the dashboard. So the restore completes and
             * the unreadable preference is the one thing that does not survive
             * it, which is the direction with something left to fix afterwards.
             *
             * Only these three. Anything else refused here is a value the
             * server acts on, and guessing at one of those would restore an
             * instance that is not the one that was backed up.
             */
            if (!THRESHOLD_KEYS.includes(key)) return {ok: false, key};

            updates.push({key, value: configDefaults[key]});
            continue;
        }

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
    } catch {
        return REFUSED;
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

    return {ok: true};
}

export const factoryReset = async () => {
    // Cleared and re-seeded rather than updated key by key. The loop read
    // configDefaults[key] for every key the table happened to hold, so a key
    // left behind by an older version - or one written by hand - resolved to
    // undefined and was written into a NOT NULL column. That threw from the
    // middle of the reset, leaving the configuration half-default and skipping
    // everything below, including the session revocation. It also never
    // restored a default whose row was missing altogether.
    //
    // Both halves in one transaction: an unwrapped destroy commits on its own,
    // so a failure in the re-seed would leave the table empty - which is worse
    // than the half-default state this replaced, because "no row" is not a
    // value any reader has a fallback for.
    await db.transaction(async (transaction) => {
        await config.destroy({where: {}, transaction});
        await insertDefaults(transaction);
    });

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