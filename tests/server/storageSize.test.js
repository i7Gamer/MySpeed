import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sqliteBytes } from "../../server/controller/config.js";
import { SQLITE_STORAGE_PATH } from "../../server/config/database.js";

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

/**
 * And it stats the database the app is actually using.
 *
 * The path was written out twice - once in config/database.js, which is the
 * value handed to sequelize, and once in getUsedStorage, which rebuilt it from
 * process.cwd(). The two agreed only by coincidence, and the failure is silent:
 * fileBytes swallows ENOENT and returns 0, so a divergence reports a database
 * of no size rather than an error. Anyone moving the file - a data-directory
 * environment variable, a different layout for the Windows installer - edits
 * the first, because that is the one sequelize reads.
 */
describe("where the database is", () => {
    const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
    const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

    it("is stated by the module that opens it", () => {
        assert.equal(typeof SQLITE_STORAGE_PATH, "string");
        assert.match(SQLITE_STORAGE_PATH, /storage(_preview)?\.db$/);
    });

    it("is the path sequelize is given", () => {
        assert.match(read("server/config/database.js"), /storage:\s*SQLITE_STORAGE_PATH/,
            "the exported path is not the one the database is actually opened with");
    });

    it("is not rebuilt anywhere else", () => {
        assert.doesNotMatch(read("server/controller/config.js"), /storage\$\{|['"]storage['"]|storage\.db/,
            "the storage path is spelled out a second time, and a divergence reports a size of zero");
    });

    // The preview instance keeps its own database, and the size dialog on a
    // preview instance has to report that one rather than the real one.
    it("follows preview mode, wherever it is read", () => {
        const expected = process.env.PREVIEW_MODE === "true" ? "storage_preview.db" : "storage.db";

        assert.ok(SQLITE_STORAGE_PATH.endsWith(expected),
            `expected the path to end in ${expected}, got ${SQLITE_STORAGE_PATH}`);
    });
});
