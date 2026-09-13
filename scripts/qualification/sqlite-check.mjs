import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const openDatabase = async (file) => process.versions.bun
    ? import("bun:sqlite").then(({Database}) => {
        const database = new Database(file, {readonly: true, create: false, strict: true});
        return {
            all: (sql, ...values) => database.query(sql).all(...values),
            close: () => database.close()
        };
    })
    : import("node:sqlite").then(({DatabaseSync}) => {
        const database = new DatabaseSync(file, {readOnly: true});
        return {
            all: (sql, ...values) => database.prepare(sql).all(...values),
            close: () => database.close()
        };
    });

// Integrity fingerprint of an already-stored synthetic bcrypt record, not a
// password-storage or authentication hash. This read-only checker never writes
// the fingerprint to config or uses it to accept credentials.
const sha256Text = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

const assertIntegrity = (rows) => {
    if (!rows.some((row) => Object.values(row).includes("ok")))
        throw new Error(`SQLite integrity check failed: ${JSON.stringify(rows)}`);
};

export const inspectPopulatedDatabase = async (file, expectedResultId) => {
    const database = await openDatabase(file);
    try {
        assertIntegrity(database.all("PRAGMA quick_check"));
        const ping = database.all("SELECT value FROM config WHERE key = ?", "ping")[0]?.value;
        const password = database.all("SELECT value FROM config WHERE key = ?", "password")[0]?.value;
        const resultId = database.all("SELECT resultId FROM speedtests WHERE resultId = ?",
            expectedResultId)[0]?.resultId;
        if (typeof password !== "string" || password.length === 0)
            throw new Error("Synthetic password configuration is absent");
        return {ping, resultId, passwordValueSha256: sha256Text(password)};
    } finally {
        database.close();
    }
};

export const checkPopulatedDatabase = async (file, expected) => {
    const actual = await inspectPopulatedDatabase(file, expected.resultId);
    for (const key of ["ping", "resultId", "passwordValueSha256"])
        if (actual[key] !== expected[key])
            throw new Error(`Preseeded SQLite ${key} does not match its handoff manifest`);
    return actual;
};

export const checkResetDatabase = async (file) => {
    const database = await openDatabase(file);
    try {
        assertIntegrity(database.all("PRAGMA quick_check"));
        const configTable = database.all(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'config'");
        if (configTable.length > 0)
            throw new Error("Fresh reset database unexpectedly contains MySpeed configuration");
        return {integrity: "ok", configTable: false};
    } finally {
        database.close();
    }
};

const parseArguments = (values) => {
    const [command, ...rest] = values;
    const options = {};
    for (let index = 0; index < rest.length; index += 2) {
        const name = rest[index];
        const value = rest[index + 1];
        if (!name?.startsWith("--") || value === undefined)
            throw new Error(`Invalid SQLite check argument "${name ?? ""}"`);
        options[name.slice(2)] = value;
    }
    if (command !== "inspect-populated") throw new Error("SQLite check command must be inspect-populated");
    if (!options.file || !options["result-id"]) throw new Error("SQLite inspect requires --file and --result-id");
    return {command, ...options};
};

const main = async () => {
    const options = parseArguments(process.argv.slice(2));
    const result = await inspectPopulatedDatabase(path.resolve(options.file), options["result-id"]);
    process.stdout.write(JSON.stringify(result) + "\n");
};

const invokedDirectly = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
});
