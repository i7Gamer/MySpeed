import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(
    fileURLToPath(new URL("../../server/tasks/speedtest.js", import.meta.url)), "utf8");

/**
 * "Choose automatically" has to survive a test run.
 *
 * The run used to persist whichever server the CLI happened to pick -
 * `if (serverId === undefined) await config.updateValue("ooklaId", ...)` - so
 * the provider dialog's "choose automatically" lasted exactly one test, and
 * re-selecting it was undone by the very next run. Nothing said so anywhere in
 * the UI. When the pinned server later degrades the line simply looks slower
 * with no explanation, and when it dies the run burns a full attempt against it
 * - up to the CLI's three-minute timeout - before falling back, and the stale
 * pin is never cleared.
 *
 * Source-scanned because the surrounding function shells out to a real CLI.
 * The resolved id still travels on the stored row; it is only the write back
 * into the configuration that had no business being there.
 */
describe("an automatically chosen server", () => {
    it("is not written back into the configuration", () => {
        assert.doesNotMatch(source, /updateValue\(\s*["']ooklaId["']/,
            "the run still pins the Ookla server it happened to get");
        assert.doesNotMatch(source, /updateValue\(\s*["']libreId["']/,
            "the run still pins the librespeed server it happened to get");
    });

    it("is still recorded on the test row", () => {
        assert.match(source, /serverId = speedtest\.server\?\.id/,
            "the row no longer says which server answered");
        assert.match(source, /return \{\.\.\.speedtest, serverId\}/);
    });
});

/**
 * What the parser worked out has to actually reach the row.
 *
 * Source-scanned for the same reason as above: the success branch of execute()
 * shells out to a real CLI, so no test in the suite ever runs it - every run
 * here lands in the catch block for want of a binary. That leaves the one line
 * joining a covered parser to a covered controller uncovered, and it is exactly
 * the kind of line a column gets forgotten in: the server name and host spent a
 * release parsed, stored and never exported for want of one like it.
 */
describe("everything the parser measured reaches the row", () => {
    // Taken off parseData's own return so this cannot drift: a key the parser
    // produces and the task drops would otherwise be invisible here too.
    const PARSED = ["ping", "jitter", "download", "upload", "time", "resultId", "serverName", "serverHost",
        "packetLoss", "downloadLatency", "uploadLatency", "isp", "externalIp", "provider",
        "bytesDownloaded", "bytesUploaded"];

    const created = source.match(/tests\.create\(\{[\s\S]*?\}\);/);

    it("finds the call that records a successful test", () => {
        assert.notEqual(created, null, "no tests.create call to check");
    });

    for (const column of PARSED) {
        it(`hands ${column} to tests.create`, () => {
            assert.match(created[0], new RegExp(`\\b${column}\\b`),
                `${column} is parsed but never reaches the stored row`);
        });
    }
});
