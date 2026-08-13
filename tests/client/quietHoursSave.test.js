import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const source = fs.readFileSync(
    path.join(CLIENT_SRC, "common", "components", "PauseDialog", "PauseDialog.jsx"), "utf8");

/**
 * The quiet window is two configuration keys written one PATCH at a time, and a
 * refusal on the second used to be both destructive and invisible: the server
 * was left holding a new start against the old end - a window nobody configured,
 * which the scheduler then honours - while the dialog went on showing the pair
 * that had been asked for, and reloadConfig() sat on the success path where the
 * failure never reached it. Reopening the dialog re-seeded from the same stale
 * context, so nothing on screen ever named the mixed pair.
 *
 * Source-scanned because the dialog is a component with no render harness here;
 * what it delegates to is exercised in quietHoursWindow.test.js.
 */
describe("the quiet hours save", () => {
    it("goes through the helper that undoes a half-written window", () => {
        assert.match(source, /writeQuietHours\(/, "the save does not use writeQuietHours");
        assert.doesNotMatch(source, /for \(const \{key, value\} of quietHoursUpdates\(/,
            "the save still PATCHes the pair in a bare loop with no undo");
    });

    it("still checks every write it issues", () => {
        assert.match(source, /assertOk\(await patchRequest\(`\/config\/\$\{key\}`/,
            "a refused quiet hours write is not surfaced");
    });

    it("reads back what the server actually holds when a write is refused", () => {
        const save = source.slice(source.indexOf("const saveQuietHours"));
        const body = save.slice(0, save.indexOf("\n    };"));

        assert.match(body, /catch[\s\S]*checkConfig\(\)/,
            "the failure path never re-reads the configuration");
        assert.match(body, /catch[\s\S]*showStoredWindow\(/,
            "the fields go on showing the window that was asked for, not the stored one");
    });

    // checkConfig hands back the parsed body whatever the status was, so an
    // expired session arrives looking like a config with no keys in it.
    it("does not read a window out of a refusal", () => {
        assert.match(source, /carriesWindow\(/,
            "a refused re-read blanks the fields, calling the window off when it may not be");
    });

    // The rest of the app reads the same two keys - the frequency dialog's
    // preview among them - so a partial save has to reach every consumer of the
    // config, not only the fields that caused it.
    it("resyncs the config whatever happened", () => {
        assert.match(source, /finally[\s\S]{0,300}reloadConfig\(\)/,
            "a partial save does not resync the config");
    });
});
