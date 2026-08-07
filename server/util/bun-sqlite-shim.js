/**
 * Compatibility shim that exposes an sqlite3-style callback API - the subset
 * sequelize uses - on top of whichever synchronous sqlite driver the current
 * runtime provides.
 *
 * Under bun that is bun:sqlite, which is embedded in the runtime and therefore
 * works in compiled binaries without native node_modules. Under node it is the
 * built-in node:sqlite, which keeps the server (and its integration tests)
 * runnable outside bun. Neither adds a dependency.
 */
const OPEN_READONLY = 0x00000001;
const OPEN_READWRITE = 0x00000002;
const OPEN_CREATE = 0x00000004;

const isBun = typeof globalThis.Bun !== "undefined";

// Resolved through a variable so bundlers and the node loader never attempt to
// statically resolve the module that does not exist on the current runtime.
const driverModule = isBun ? "bun:sqlite" : "node:sqlite";
const driver = await import(/* @vite-ignore */ driverModule);

const openDatabase = (filename, readonly) => {
    if (isBun) return new driver.Database(filename, {readonly, create: !readonly});
    return new driver.DatabaseSync(filename, {readOnly: readonly});
};

// bun:sqlite takes bound parameters as a single array or object; node:sqlite
// takes them spread, with an optional leading object for named parameters.
const bind = (statement, method, params) => {
    if (isBun) return statement[method](params);
    if (Array.isArray(params)) return statement[method](...params);
    return statement[method](params);
};

const parseArgs = (args) => {
    let params = [];
    let callback;
    for (const arg of args) {
        if (typeof arg === "function") callback = arg;
        else if (Array.isArray(arg)) params = arg;
        else if (arg !== null && typeof arg === "object") params = arg;
        else if (arg !== undefined) params.push(arg);
    }
    return [params, callback];
};

// node:sqlite reports rowids as BigInt once they exceed 2^31; sequelize expects
// a plain number for the generated primary key.
const toNumber = (value) => typeof value === "bigint" ? Number(value) : value;

class Database {
    constructor(filename, mode, callback) {
        try {
            const readonly = typeof mode === "number" && !(mode & OPEN_READWRITE);
            this.db = openDatabase(filename, readonly);
            this.filename = filename;
            this.db.exec("PRAGMA journal_mode = WAL");
            if (callback) process.nextTick(() => callback(null));
        } catch (err) {
            if (callback) process.nextTick(() => callback(err));
            else throw err;
        }
    }

    run(sql, ...args) {
        const [params, callback] = parseArgs(args);
        try {
            const result = bind(this.db.prepare(sql), "run", params);

            const context = {
                lastID: toNumber(result.lastInsertRowid),
                changes: toNumber(result.changes),
                sql
            };
            if (callback) process.nextTick(() => callback.call(context, null));
        } catch (err) {
            if (callback) process.nextTick(() => callback.call({}, err));
        }
        return this;
    }

    all(sql, ...args) {
        const [params, callback] = parseArgs(args);
        try {
            const rows = bind(this.db.prepare(sql), "all", params);
            if (callback) process.nextTick(() => callback(null, rows));
        } catch (err) {
            if (callback) process.nextTick(() => callback(err, []));
        }
        return this;
    }

    serialize(fn) {
        if (fn) fn();
        return this;
    }

    close(callback) {
        try {
            this.db.close();
            if (callback) process.nextTick(() => callback(null));
        } catch (err) {
            if (callback) process.nextTick(() => callback(err));
        }
        return this;
    }
}

const sqlite3 = {Database, OPEN_READONLY, OPEN_READWRITE, OPEN_CREATE};

export default sqlite3;
export {Database, OPEN_READONLY, OPEN_READWRITE, OPEN_CREATE};
