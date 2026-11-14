import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../../server/util/bun-sqlite-shim.js";
import { readSource, withoutComments } from "../helpers/source.js";

/**
 * The pragmas the shim opens every database with.
 *
 * These are asserted as pragma values rather than provoked, because provoking
 * them is the problem: demonstrating busy_timeout for real takes a second
 * connection holding a write lock while this one blocks the event loop for the
 * whole timeout - a five-second test that ends in the same error it started
 * with. The pragma readback is what sqlite itself consults, so it is the
 * behaviour, not a proxy for it.
 */
const all = (db, sql) => new Promise((resolve, reject) =>
    db.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));

describe("the sqlite shim's connection settings", () => {
    let root;
    let db;

    before(() => {
        // A file, not :memory: - WAL is a property of a database file, and
        // journal_mode on a memory database answers "memory" whatever was asked.
        root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-shim-"));
        db = new Database(path.join(root, "storage.db"));
    });

    after(async () => {
        await new Promise((resolve) => db.close(resolve));
        fs.rmSync(root, {recursive: true, force: true});
    });

    it("opens in WAL mode", async () => {
        const [{journal_mode}] = await all(db, "PRAGMA journal_mode");
        assert.equal(journal_mode, "wal");
    });

    /**
     * A second connection writing while this one holds the file must wait, not
     * fail on the spot. sqlite's default is 0 - SQLITE_BUSY immediately - and
     * the one place that bites is exactly the place nobody tests: a transaction
     * from factoryReset or insertDefaults overlapping an ordinary write, or a
     * second process touching the same file. Five seconds outlasts any
     * transaction this server runs.
     */
    it("waits for a locked database instead of failing immediately", async () => {
        const [{timeout}] = await all(db, "PRAGMA busy_timeout");
        assert.equal(timeout, 5000, "busy_timeout is unset, so concurrent writes fail with SQLITE_BUSY");
    });

    /*
     * Order, read from the source for the reason the header gives. Switching
     * to WAL needs a lock - and on the first open after an unclean stop it
     * also recovers the old WAL - so set first, with the timeout still 0, it
     * failed SQLITE_BUSY at once whenever another process held the file for a
     * moment (an old instance still shutting down on the same data
     * directory), and the server exited with "Could not open the database".
     */
    it("arms the busy timeout before the first statement that needs a lock", () => {
        // Comments stripped, so one that names either pragma cannot stand in
        // for the statement.
        const source = withoutComments(readSource("server/util/bun-sqlite-shim.js"));
        const timeout = source.indexOf("PRAGMA busy_timeout");
        const journal = source.indexOf("PRAGMA journal_mode");

        assert.ok(timeout !== -1 && journal !== -1, "the shim no longer sets both pragmas");
        assert.ok(timeout < journal, "journal_mode = WAL runs before busy_timeout is set");
    });
});

/**
 * Sequelize runs two statements through the shim without a callback: the
 * FOREIGN_KEYS pragma on every acquire, and close() on every transaction
 * release. Real sqlite3 emits those failures on the Database; the shim, with
 * nothing to hand them to, dropped them on the floor. Logged now, not thrown:
 * a throw from close() escapes into the pool's release path.
 */
describe("a statement the shim is given no callback for", () => {
    const captured = () => {
        const lines = [];
        const original = console.error;
        console.error = (...args) => lines.push(args.map(String).join(" "));
        return {lines, restore: () => { console.error = original; }};
    };

    it("logs a failed run and still hands the database back", () => {
        const db = new Database(":memory:");
        const log = captured();
        try {
            assert.equal(db.run("NOT SQL AT ALL"), db);
        } finally {
            log.restore();
            db.close();
        }
        assert.equal(log.lines.length, 1, "the failure was dropped without a trace");
        assert.match(log.lines[0], /NOT SQL AT ALL|syntax/i);
    });

    it("logs a failed all the same way", () => {
        const db = new Database(":memory:");
        const log = captured();
        try {
            assert.equal(db.all("SELECT * FROM no_such_table"), db);
        } finally {
            log.restore();
            db.close();
        }
        assert.equal(log.lines.length, 1);
    });

    it("stays quiet when the statement succeeds", () => {
        const db = new Database(":memory:");
        const log = captured();
        try {
            db.run("CREATE TABLE t (id INTEGER)");
            db.all("SELECT * FROM t");
        } finally {
            log.restore();
            db.close();
        }
        assert.deepEqual(log.lines, []);
    });
});

/**
 * bun:sqlite statements hold native memory the garbage collector does not
 * count as pressure, so an idle server that prepares a statement per query
 * grew by hundreds of MiB before anything reclaimed it. Every statement the
 * shim prepares is finalized once used - on success and on failure alike.
 * node:sqlite statements have no finalize; the shim must not require one.
 */
describe("the statements the shim prepares", () => {
    const tracked = (db) => {
        const finalized = [];
        const prepare = db.db.prepare.bind(db.db);
        db.db.prepare = (sql) => {
            const statement = prepare(sql);
            const entry = {sql, done: false};
            finalized.push(entry);
            return new Proxy(statement, {
                get(target, key) {
                    if (key === "finalize") return () => { entry.done = true; };
                    const value = target[key];
                    return typeof value === "function" ? value.bind(target) : value;
                }
            });
        };
        return finalized;
    };
    const quietly = (fn) => {
        const original = console.error;
        console.error = () => {};
        try { fn(); } finally { console.error = original; }
    };

    it("finalizes a statement after run and after all", () => {
        const db = new Database(":memory:");
        const statements = tracked(db);
        try {
            db.run("CREATE TABLE t (id INTEGER)");
            db.run("INSERT INTO t VALUES (?)", [1]);
            db.all("SELECT * FROM t");
        } finally {
            db.close();
        }
        assert.equal(statements.length, 3);
        assert.ok(statements.every(s => s.done), JSON.stringify(statements));
    });

    it("finalizes a statement whose execution throws", () => {
        const db = new Database(":memory:");
        db.run("CREATE TABLE t (id INTEGER PRIMARY KEY)");
        db.run("INSERT INTO t VALUES (1)");
        const statements = tracked(db);
        try {
            quietly(() => {
                db.run("INSERT INTO t VALUES (1)");
                db.all("SELECT * FROM t WHERE id = ?", [{bad: Symbol("x")}]);
            });
        } finally {
            db.close();
        }
        assert.ok(statements.length >= 1);
        assert.ok(statements.every(s => s.done), JSON.stringify(statements));
    });

    it("works with a driver whose statements have no finalize", () => {
        const db = new Database(":memory:");
        const prepare = db.db.prepare.bind(db.db);
        db.db.prepare = (sql) => {
            const statement = prepare(sql);
            return new Proxy(statement, {
                get(target, key) {
                    if (key === "finalize") return undefined;
                    const value = target[key];
                    return typeof value === "function" ? value.bind(target) : value;
                }
            });
        };
        let rows;
        try {
            db.run("CREATE TABLE t (id INTEGER)");
            db.all("SELECT 1 AS one", (error, result) => { rows = result; });
        } finally {
            db.close();
        }
        return new Promise((resolve) => process.nextTick(() => {
            assert.deepEqual(rows.map(r => ({...r})), [{one: 1}]);
            resolve();
        }));
    });
});
