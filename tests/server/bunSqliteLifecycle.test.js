import {it} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import {fileURLToPath} from "node:url";

// Two bounded child phases plus teardown must fit before the outer deadline.
const FIXTURE_TIMEOUT_MS = 75000;
const fixture = fileURLToPath(new URL("../fixtures/bun-sqlite-lifecycle/run.mjs", import.meta.url));

it("measures only the SQLite wait after the writer acknowledges its release timer", () => {
    const source = fs.readFileSync(fixture, "utf8");
    assert.match(source, /await released\.startRelease\(\);\s*const started = performance\.now\(\);\s*await run\(db,/,
        "release-command pipe latency must not count as SQLite busy-wait time");
});

for (const delayedReader of [false, true]) it(`the SQLite lifecycle survives delayed lock readiness (${delayedReader})`, () => {
    const result = spawnSync(process.execPath, [fixture], {
        encoding: "utf8", timeout: FIXTURE_TIMEOUT_MS, windowsHide: true,
        env: {...process.env, MYSPEED_SQLITE_DELAY_READER: String(delayedReader)}
    });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    const summary = JSON.parse(result.stdout.trim().split("\n").at(-1));
    const migrations = fs.readdirSync(new URL("../../server/migrations/", import.meta.url))
        .filter(name => /^\d{4}-.+\.js$/.test(name));
    assert.equal(summary.migrations, migrations.length);
    assert.deepEqual(summary.checks, ["migrations", "idempotence", "rollback", "commit",
        "reopen", "integrity", "wait-for-writer", "busy-timeout", "retry-after-release"]);
    assert.equal(summary.cleaned, true, "database files must be removable after owned children exit");
});
