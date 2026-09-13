import {it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import bcrypt from "bcryptjs";
import {inspectPopulatedDatabase} from "../../scripts/qualification/sqlite-check.mjs";

const SYNTHETIC_PASSWORD = "qualification-fingerprint-only";
const BCRYPT_ROUNDS = 12;
const RESULT_ID = "synthetic-fingerprint-row";
const PING = "123.456";
const fingerprint = bytes => createHash("sha256").update(bytes).digest("hex");

it("qualification fingerprints the existing bcrypt record without storing or authenticating with SHA-256", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-credential-fingerprint-"));
    const file = path.join(root, "synthetic.db");
    const {Database: BunDatabase, DatabaseSync: NodeDatabase} = process.versions.bun
        ? await import("bun:sqlite") : await import("node:sqlite");
    const Database = process.versions.bun ? BunDatabase : NodeDatabase;
    const storedHash = await bcrypt.hash(SYNTHETIC_PASSWORD, BCRYPT_ROUNDS);
    try {
        const seed = new Database(file);
        try {
            seed.exec("CREATE TABLE config (key TEXT, value TEXT); CREATE TABLE speedtests (resultId TEXT)");
            seed.prepare("INSERT INTO config VALUES (?, ?)").run("password", storedHash);
            seed.prepare("INSERT INTO config VALUES (?, ?)").run("ping", PING);
            seed.prepare("INSERT INTO speedtests VALUES (?)").run(RESULT_ID);
        } finally {
            if (process.versions.bun) seed.close(true);
            else seed.close();
        }
        const before = fingerprint(fs.readFileSync(file));
        const result = await inspectPopulatedDatabase(file, RESULT_ID);
        assert.deepEqual(result, {ping: PING, resultId: RESULT_ID,
            passwordValueSha256: fingerprint(storedHash)});
        assert.notEqual(result.passwordValueSha256, fingerprint(SYNTHETIC_PASSWORD));
        assert.equal(fingerprint(fs.readFileSync(file)), before, "inspection changed the database");

        const verification = new Database(file);
        try {
            const persisted = verification.prepare("SELECT value FROM config WHERE key = ?").get("password").value;
            assert.equal(persisted, storedHash);
            assert.equal(bcrypt.getRounds(persisted), BCRYPT_ROUNDS);
            assert.equal(await bcrypt.compare(SYNTHETIC_PASSWORD, persisted), true);
        } finally {
            if (process.versions.bun) verification.close(true);
            else verification.close();
        }
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});
