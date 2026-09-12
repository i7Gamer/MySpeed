// Shared source/compiled release probe. Each database lives beneath an owned
// temporary directory; child exit releases native statements before cleanup.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {Sequelize, QueryTypes} from "sequelize";
import shim, {Database} from "../../../server/util/bun-sqlite-shim.js";

const CHILD_TIMEOUT_MS = 30000;
const WRITER_RELEASE_MS = 600;
const TIMING_TOLERANCE_MS = 200;
const RELEASE_STARTED = "release-started";
const DELAY_READER = process.env.MYSPEED_SQLITE_DELAY_READER === "true";
const CHECKS = ["migrations", "idempotence", "rollback", "commit", "reopen", "integrity",
    "wait-for-writer", "busy-timeout", "retry-after-release"];
const compiled = Boolean(process.versions.bun)
    && !/^bun(?:-debug)?(?:\.exe)?$/i.test(path.basename(process.execPath));
const argsFor = (...args) => [...(compiled ? [] : [fileURLToPath(import.meta.url)]), ...args];
const run = (db, sql) => new Promise((resolve, reject) =>
    db.run(sql, error => error ? reject(error) : resolve()));
const all = (db, sql) => new Promise((resolve, reject) =>
    db.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
const close = db => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
const select = (db, sql) => db.query(sql, {type: QueryTypes.SELECT});

async function holdWriter(root, automaticRelease) {
    const child = spawn(process.execPath, argsFor("lock", root, String(automaticRelease)), {
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
    });
    let output = "", errors = "";
    let acknowledgeRelease;
    const releaseStarted = new Promise(resolve => { acknowledgeRelease = resolve; });
    child.stderr.on("data", chunk => { errors += chunk; });
    const exited = new Promise(resolve => child.once("close", resolve));
    child.stdout.on("data", chunk => {
        output += chunk;
        if (output.includes(`${RELEASE_STARTED}\n`)) acknowledgeRelease();
    });
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("writer fixture failed to acquire its lock")), CHILD_TIMEOUT_MS);
            const finish = error => { clearTimeout(timeout); error ? reject(error) : resolve(); };
            child.once("error", finish);
            child.once("close", () => finish(new Error(`writer exited before ready: ${errors}`)));
            child.stdout.on("data", () => { if (output.includes("locked\n")) finish(); });
        });
    } catch (error) {
        child.kill();
        await exited;
        throw error;
    }
    if (DELAY_READER) await new Promise(resolve =>
        setTimeout(resolve, WRITER_RELEASE_MS + TIMING_TOLERANCE_MS));
    return {
        pid: child.pid,
        startRelease: async () => {
            child.stdin.end("release\n");
            let timeout;
            try {
                await Promise.race([
                    releaseStarted,
                    exited.then(() => { throw new Error(`writer exited before release started: ${errors}`); }),
                    new Promise((_, reject) => {
                        timeout = setTimeout(() => reject(new Error("writer fixture did not start its release timer")),
                            CHILD_TIMEOUT_MS);
                    })
                ]);
            } finally { clearTimeout(timeout); }
        },
        release: async () => {
            if (!automaticRelease) child.stdin.end("release\n");
            assert.equal(await exited, 0, errors);
        },
        stop: async () => {
            if (child.exitCode === null && child.signalCode === null) child.kill();
            await exited;
        }
    };
}

async function contention(root) {
    const db = new Database(path.join(root, "contention.db"));
    const children = [];
    try {
        await run(db, "CREATE TABLE writes (value INTEGER)");
        const [{timeout}] = await all(db, "PRAGMA busy_timeout");
        assert.ok(timeout > WRITER_RELEASE_MS, "the writer must release inside the configured wait");
        const released = await holdWriter(root, true);
        children.push(released);
        await released.startRelease();
        const started = performance.now();
        await run(db, "INSERT INTO writes VALUES (1)");
        const waited = performance.now() - started;
        assert.ok(waited >= WRITER_RELEASE_MS - TIMING_TOLERANCE_MS, `write bypassed the held lock: ${waited}ms`);
        await released.release();
        const held = await holdWriter(root, false);
        children.push(held);
        const timeoutStarted = performance.now();
        await assert.rejects(run(db, "INSERT INTO writes VALUES (2)"), /locked|busy/i);
        const timeoutWaited = performance.now() - timeoutStarted;
        assert.ok(timeoutWaited >= timeout - TIMING_TOLERANCE_MS, `busy failure ignored its timeout: ${timeoutWaited}ms`);
        await held.release();
        await run(db, "INSERT INTO writes VALUES (2)");
        const values = (await all(db, "SELECT value FROM writes ORDER BY value")).map(row => row.value);
        assert.deepEqual(values, [1, 2]);
        return {writerPids: children.map(child => child.pid), waited, timeoutWaited};
    } finally {
        for (const child of children) await child.stop();
        await close(db);
    }
}

async function exercise(root) {
    fs.mkdirSync(path.join(root, "data"));
    process.chdir(root);
    process.env.DB_TYPE = "sqlite";
    delete process.env.PREVIEW_MODE;
    const {default: db} = await import("../../../server/config/database.js");
    const {runMigrations} = await import("../../../server/util/migrationRunner.js");
    const {default: migrations} = await import("../../../server/migrations/index.js");
    try {
        await db.authenticate();
        await runMigrations();
        const executed = await select(db, "SELECT name FROM SequelizeMeta ORDER BY name");
        assert.equal(executed.length, migrations.length);
        await runMigrations();
        assert.deepEqual(await select(db, "SELECT name FROM SequelizeMeta ORDER BY name"), executed);
        await db.query("CREATE TABLE lifecycle (value TEXT)");
        const rolledBack = await db.transaction();
        await db.query("INSERT INTO lifecycle VALUES ('rolled back')", {transaction: rolledBack});
        await rolledBack.rollback();
        assert.deepEqual(await select(db, "SELECT * FROM lifecycle"), []);
        const committed = await db.transaction();
        await db.query("INSERT INTO lifecycle VALUES ('synthetic persisted')", {transaction: committed});
        await committed.commit();
        const writers = await contention(root);
        console.log(JSON.stringify({migrations: migrations.length, writers}));
    } finally { await db.close(); }
}

async function reopen(root) {
    const db = new Sequelize({dialect: "sqlite", dialectModule: shim,
        storage: path.join(root, "data/storage.db"), logging: false, query: {raw: true}});
    try {
        assert.deepEqual(await select(db, "SELECT value FROM lifecycle"), [{value: "synthetic persisted"}]);
        assert.equal((await select(db, "PRAGMA integrity_check"))[0].integrity_check, "ok");
    } finally { await db.close(); }
}

const [phase, directory, automaticRelease] = process.argv.slice(2);
if (phase === "lock") {
    const db = new Database(path.join(directory, "contention.db"));
    try {
        await run(db, "BEGIN IMMEDIATE");
        console.log("locked");
        await new Promise(resolve => {
            process.stdin.once("data", resolve);
            process.stdin.once("end", resolve);
            process.stdin.resume();
        });
        console.log(RELEASE_STARTED);
        if (automaticRelease === "true") await new Promise(resolve => setTimeout(resolve, WRITER_RELEASE_MS));
        await run(db, "COMMIT");
    } finally { await close(db); }
} else if (phase === "exercise") await exercise(directory);
else if (phase === "reopen") await reopen(directory);
else {
    assert.equal(phase, undefined, "unknown fixture phase");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-sqlite-lifecycle-"));
    let resultSummary;
    const pids = [];
    try {
        for (const step of ["exercise", "reopen"]) {
            const result = spawnSync(process.execPath, argsFor(step, root), {
                encoding: "utf8", timeout: CHILD_TIMEOUT_MS, windowsHide: true
            });
            pids.push(result.pid);
            assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
            if (step === "exercise") resultSummary = JSON.parse(result.stdout.trim().split("\n").at(-1));
        }
    } finally { fs.rmSync(root, {recursive: true, force: true}); }
    console.log(JSON.stringify({runtime: process.versions.bun ?? process.version, pids,
        data: root, ...resultSummary, checks: CHECKS, cleaned: true}));
}
