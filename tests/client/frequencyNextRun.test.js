import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (...parts) => fs.readFileSync(path.join(CLIENT_SRC, ...parts), "utf8");

const source = read("common", "components", "FrequencyDialog", "FrequencyDialog.jsx");
const dropdown = read("common", "components", "Dropdown", "DropdownComponent.jsx");

/**
 * The dialog's "Next test:" line used to be a bare CronExpressionParser.next()
 * with no quiet-hours knowledge, which commit 7f684733 had already declared a
 * bug for the other announcer: the server steps over occurrences inside the
 * window because runTask refuses them. So with quiet hours of 23:00-08:00, at
 * 23:30, typing "0 * * * *" made the dialog promise 00:00 while the status bar
 * on the same screen counted down to 08:00.
 *
 * The window logic itself lives in quietHoursWindow.js and is exercised there;
 * this pins the wiring, which a render harness would otherwise be needed for.
 */
describe("the frequency dialog's next-test preview", () => {
    it("steps over the occurrences the scheduler would refuse", () => {
        assert.match(source, /firstRunOutsideWindow\(/,
            "the preview is not quiet-aware");
        assert.match(source, /quietHoursWindow/,
            "the preview does not reuse the client's window logic");
    });

    it("reads the window from the config it already holds", () => {
        assert.match(source, /config\.quietHoursStart/);
        assert.match(source, /config\.quietHoursEnd/);
    });

    /**
     * Both quiet hours keys are withheld from a read-only visitor, along with
     * the cron itself - so the preview only knows what it needs while the dialog
     * stays behind an operator-only entry. Opening it to view mode would leave
     * it announcing the very time the scheduler skips, to the one audience that
     * cannot correct it.
     */
    it("is only offered to an operator, which is why the window is there to read", () => {
        const entry = dropdown.match(/\{run: \(\) => setShowFrequencyDialog\(true\)[^}]*\}/);
        assert.ok(entry, "the frequency dialog is no longer opened from the dropdown");

        assert.doesNotMatch(entry[0], /allowView/,
            "view mode opens the dialog, and the config it is given carries no quiet hours");
    });

    /**
     * Validity has to stay a question about the expression alone. A window that
     * happens to swallow every occurrence of a perfectly good cron would
     * otherwise make it unsaveable - and the operator's way out of that is the
     * quiet hours dialog, not this one.
     */
    it("does not let the window decide whether an expression can be saved", () => {
        assert.match(source, /isCronValid\(/, "validity is not separated from the preview");

        const guard = source.match(/if \(!cronValue \|\| ([^)]*\)?)\) return;/);
        assert.ok(guard, "the save guard is gone");
        assert.doesNotMatch(guard[1], /getNextRun\b/,
            "the save is blocked by the quiet-aware preview");

        const validity = source.match(/const isCustomValid = [^;]*;/);
        assert.ok(validity, "the custom-cron validity check is gone");
        assert.doesNotMatch(validity[0], /getNextRun\b/,
            "a swallowed schedule marks a valid expression invalid");
    });
});
