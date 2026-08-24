import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readSource } from "../helpers/source.js";
import {
    checkIntegrity, damageFrom, isDamaged, recoveryAdvice
} from "../../server/util/databaseIntegrity.js";

/**
 * Whether the database is readable, asked once at boot instead of discovered by
 * whatever query happens to touch the broken page first.
 *
 * Upstream #1549 is a boot that failed, restarted, and did that 138 times, and
 * the reporter's way out was to delete the database - losing the history the
 * instance exists to keep - because nothing told them there was another one.
 * describeError already made the message say *what* failed; this is about saying
 * what to do next, and saying it before a migration has started half-applying
 * itself to a file that cannot be read.
 *
 * What this is deliberately *not*: a promise that the file is healthy. sqlite
 * keeps no page checksums, so damage to a page nothing reaches is damage nothing
 * can see - an experiment while writing this scribbled over a free page and
 * quick_check answered "ok". "Nothing found" is the strongest claim available
 * and is the one the code makes.
 */
describe("reading a quick_check answer", () => {
    it("takes ok for ok", () => {
        assert.equal(isDamaged([{quick_check: "ok"}]), false);
    });

    it("takes anything else for damage, and keeps what it said", () => {
        const rows = [{quick_check: "row 3 missing from index idx_v"}];

        assert.equal(isDamaged(rows), true);
    });

    it("reads every row a long answer carries", () => {
        const rows = [
            {quick_check: "row 3 missing from index idx_v"},
            {quick_check: "wrong # of entries in index idx_v"}
        ];

        assert.equal(isDamaged(rows), true);
    });

    /**
     * An answer with no rows at all is not evidence of damage. Crying wolf here
     * would send an operator to a recovery procedure their database does not
     * need, which is worse than the silence it replaces.
     */
    it("does not read an empty or unreadable answer as damage", () => {
        for (const rows of [[], null, undefined, "nonsense", [{}]])
            assert.equal(isDamaged(rows), false, `${JSON.stringify(rows)} was read as damage`);
    });

    // The column is named after whichever pragma was run, so the value is taken
    // from the row rather than from a key written out here.
    it("does not depend on the column being called quick_check", () => {
        assert.equal(isDamaged([{integrity_check: "ok"}]), false);
        assert.equal(isDamaged([{integrity_check: "page 42 is never used"}]), true);
    });
});

/**
 * The other half, and the one an experiment turned up: on a file damaged badly
 * enough, the pragma does not answer with rows describing the problem - it
 * throws SQLITE_CORRUPT, exactly as an ordinary SELECT would. A check that only
 * read rows would let that escape as an unexplained startup failure, which is
 * the thing being fixed.
 */
describe("recognising damage in a thrown error", () => {
    const thrown = (message, code) => Object.assign(new Error(message), code ? {code} : {});

    it("knows the driver's code for it", () => {
        assert.equal(damageFrom(thrown("something", "SQLITE_CORRUPT")), true);
        assert.equal(damageFrom(thrown("something", "SQLITE_NOTADB")), true);
    });

    it("knows the wording when there is no code to read", () => {
        assert.equal(damageFrom(thrown("SQLITE_CORRUPT: database disk image is malformed")), true);
        assert.equal(damageFrom(thrown("file is not a database")), true);
    });

    // Sequelize wraps a driver error, so the code can be a level down.
    it("looks through a wrapper at the driver error underneath", () => {
        assert.equal(damageFrom({parent: thrown("x", "SQLITE_CORRUPT")}), true);
        assert.equal(damageFrom({original: thrown("x", "SQLITE_NOTADB")}), true);
    });

    it("does not read an ordinary failure as damage", () => {
        assert.equal(damageFrom(thrown("SQLITE_BUSY: database is locked", "SQLITE_BUSY")), false);
        assert.equal(damageFrom(thrown("no such table: speedtests")), false);
        assert.equal(damageFrom(null), false);
        assert.equal(damageFrom(undefined), false);
    });
});

/**
 * Against real files, because the two behaviours above were both discovered by
 * trying it rather than by reading about it.
 */
describe("checking a real database", () => {
    let directory;

    const build = (name, rows = 3000) => {
        const file = path.join(directory, name);
        const db = new DatabaseSync(file);

        db.exec("PRAGMA journal_mode = WAL");
        db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");

        const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
        for (let index = 0; index < rows; index++) insert.run(`payload-${index}-${"y".repeat(60)}`);

        db.exec("CREATE INDEX idx_v ON t(v)");
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.close();

        return file;
    };

    /** A query function of the shape checkIntegrity wants, over a real handle. */
    const queryOver = (file) => {
        const db = new DatabaseSync(file);

        return {
            query: async (sql) => db.prepare(sql).all(),
            close: () => db.close()
        };
    };

    before(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-integrity-"));
    });

    after(() => {
        fs.rmSync(directory, {recursive: true, force: true});
    });

    it("finds nothing wrong with a healthy file", async () => {
        const handle = queryOver(build("healthy.db"));

        try {
            assert.deepEqual(await checkIntegrity(handle.query), {ok: true, problems: []});
        } finally {
            handle.close();
        }
    });

    /**
     * Whole interior pages overwritten, which is what a torn write looks like
     * from sqlite's side. This is the case that throws rather than answering.
     */
    it("finds damage in a file whose pages were overwritten", async () => {
        const file = build("damaged.db");
        const raw = fs.readFileSync(file);
        const PAGE = 4096;

        for (const page of [40, 41, 42, 80, 81]) raw.fill(0xa5, page * PAGE, (page + 1) * PAGE);
        fs.writeFileSync(file, raw);

        const handle = queryOver(file);

        try {
            const outcome = await checkIntegrity(handle.query);

            assert.equal(outcome.ok, false, "a file sqlite itself calls malformed was passed as healthy");
            assert.ok(outcome.problems.length > 0, "the check says it failed but not what it saw");
        } finally {
            handle.close();
        }
    });

    /**
     * A check that cannot run is not a check that failed. A locked database or a
     * pragma the runtime will not answer must not send an operator to a recovery
     * procedure, so anything that is not recognisable damage passes.
     */
    it("passes when the check itself could not be run", async () => {
        const outcome = await checkIntegrity(async () => { throw new Error("SQLITE_BUSY: database is locked"); });

        assert.equal(outcome.ok, true);
    });
});

describe("what the operator is told", () => {
    const advice = recoveryAdvice("data/storage.db", ["database disk image is malformed"]).join("\n");

    it("names the file", () => {
        assert.match(advice, /data\/storage\.db/);
    });

    it("repeats what sqlite actually said", () => {
        assert.match(advice, /malformed/);
    });

    /**
     * The three ways out, in the order somebody should try them. The last one is
     * what #1549's reporter found unaided, and it is the one that loses the
     * history - so it is named as a last resort rather than left to be
     * rediscovered.
     */
    it("offers the ways out, with the destructive one named as the last", () => {
        assert.match(advice, /backup/i, "restoring a backup is not offered");
        assert.match(advice, /\.recover|sqlite3/i, "sqlite's own recovery is not offered");

        const deleting = advice.search(/delet|remov/i);
        assert.notEqual(deleting, -1, "starting fresh is not mentioned at all");
        assert.ok(deleting > advice.search(/backup/i), "deleting the database is offered before restoring one");
        assert.match(advice.slice(deleting), /histor/i, "nothing says what deleting it costs");
    });
});

describe("the boot", () => {
    const source = readSource("server/index.js");

    /**
     * The call, not the import. Searching for the bare name finds the import
     * line, which is above everything and so is "before the migrations" whatever
     * the code does - and the window measured from it swallows most of the file,
     * including a process.exit that has nothing to do with this.
     */
    const callSite = () => {
        const at = source.lastIndexOf("checkIntegrity(");

        assert.notEqual(at, -1, "a damaged database is still found by whatever query touches it first");

        return at;
    };

    it("checks before it migrates", () => {
        assert.ok(callSite() < source.indexOf("runMigrations()"),
            "a migration starts applying itself to a file that cannot be read before anything says so");
    });

    /**
     * Reported, not fatal. Exiting is what produced #1549's 138 restarts: the
     * service comes back, fails the same way, and the operator reads the same
     * unexplained line over and over. Coming up lets them reach the interface
     * and export whatever is still readable.
     */
    it("does not exit over it", () => {
        const around = source.slice(callSite(), source.indexOf("runMigrations()"));

        assert.ok(!/process\.exit/.test(around),
            "a damaged database takes the server down, which is the restart loop again");
    });
});
