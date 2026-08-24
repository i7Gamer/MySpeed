import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../../server/util/bun-sqlite-shim.js";

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
});
