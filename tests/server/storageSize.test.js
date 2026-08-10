import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sqliteBytes } from "../../server/controller/config.js";

/**
 * What the storage dialog reports as "used".
 *
 * Regression: it stat'd only `storage.db`. The driver runs the database in WAL
 * mode, so everything written since the last checkpoint lives in the
 * `-wal` sidecar instead - a real instance with 336 tests reported 4 KB while
 * the data on disk was 264 KB. The figure was wrong essentially always, and
 * badly enough that "is my history actually being kept?" could not be answered
 * from it.
 */
let directory;

const write = (name, bytes) => fs.writeFileSync(path.join(directory, name), Buffer.alloc(bytes));

before(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-size-"));
});

after(() => {
    fs.rmSync(directory, {recursive: true, force: true});
});

describe("sqliteBytes", () => {
    it("counts the database file", () => {
        write("a.db", 4096);
        assert.equal(sqliteBytes(path.join(directory, "a.db")), 4096);
    });

    it("counts the write-ahead log beside it", () => {
        write("b.db", 4096);
        write("b.db-wal", 259592);

        assert.equal(sqliteBytes(path.join(directory, "b.db")), 4096 + 259592);
    });

    it("counts the shared-memory index too", () => {
        write("c.db", 4096);
        write("c.db-wal", 1000);
        write("c.db-shm", 32768);

        assert.equal(sqliteBytes(path.join(directory, "c.db")), 4096 + 1000 + 32768);
    });

    /**
     * A database that has not been created yet is zero bytes used, not a 500.
     * The dialog asking how much space is used must not be the thing that
     * fails on a fresh install.
     */
    it("answers zero for a database that does not exist", () => {
        assert.equal(sqliteBytes(path.join(directory, "absent.db")), 0);
    });

    it("ignores a sidecar that is not there", () => {
        write("d.db", 512);
        assert.equal(sqliteBytes(path.join(directory, "d.db")), 512);
    });
});
