import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const CLIENT_SRC = path.join(ROOT, "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

/**
 * What a demo offers has to match what a demo will do.
 *
 * `previewReadOnly` refuses every mutating route on a preview instance, which
 * is right - but the client was never told. It went on offering the settings
 * dialogs, the pause control and the delete button, so a visitor filled in a
 * form, saved, and got a red "changes unsaved" toast; the delete button asked
 * them to confirm something irreversible and then reported that it had failed.
 *
 * The trap underneath is that `!config.viewMode` reads as "the operator is
 * allowed to change things" and does not mean that on a demo: the password
 * middleware returns before it ever sets `req.viewMode`, so the flag arrives
 * undefined and every gate written on it is open. Preview has to be named.
 *
 * Nothing in the suite set previewMode before this file, which is why the
 * divergence went unnoticed on both sides at once.
 */
describe("controls a demo instance cannot honour", () => {
    const dropdown = read("common/components/Dropdown/DropdownComponent.jsx");

    /**
     * Every entry whose action reaches a route previewReadOnly now refuses.
     * Storage is deliberately absent: its exports are GETs and still work, and
     * its import and clear buttons report their own refusal.
     */
    const REFUSED = ["optimal_values", "change_provider", "cron", "pause_tests"];

    for (const entry of REFUSED) {
        it(`marks ${entry} as unavailable on a demo`, () => {
            // The entry's own line in the options list, which is where the flag
            // has to sit for the renderer to see it.
            const line = dropdown.split("\n").find((candidate) =>
                candidate.includes(`dropdown.${entry}`) || candidate.includes(`"${entry}"`));

            assert.ok(line, `${entry} is no longer an entry in the dropdown`);
            assert.match(line, /previewDisabled: true/,
                `${entry} is offered on a demo, where saving it is refused`);
        });
    }

    it("explains the refusal rather than letting the save fail", () => {
        assert.match(dropdown, /explainPreview/,
            "a blocked entry opens its dialog anyway");
        assert.match(dropdown, /blocked \? explainPreview : entry\.run/,
            "the explanation is not what a blocked entry actually runs");
    });

    // Seeing which settings exist is half of what a demo is for, so these are
    // dimmed and explained rather than removed - the shape the node page and
    // the integration dialog already use.
    it("keeps them visible", () => {
        const refusedFlags = (dropdown.match(/previewDisabled: true/g) ?? []).length;
        const hidden = (dropdown.match(/previewHidden: true/g) ?? []).length;

        assert.equal(refusedFlags, REFUSED.length);
        assert.equal(hidden, 1, "a refused setting was hidden instead of explained");
    });

    // The exports still work on a demo, so hiding the whole dialog would take
    // away something that functions.
    it("leaves storage alone", () => {
        const line = dropdown.split("\n").find((candidate) => candidate.includes("dropdown.storage"));

        assert.ok(line);
        assert.doesNotMatch(line, /previewDisabled|previewHidden/,
            "the storage dialog was disabled, but its exports still work on a demo");
    });

    /**
     * And the resume control checks its answer. This was the one postRequest in
     * the file with no assertOk, so a refusal - the 403 a demo now returns, an
     * expired session's 401, any 500 - was discarded and the menu re-rendered
     * still saying "Resume tests" with nothing to show for the press.
     */
    it("reports a refused resume rather than swallowing it", () => {
        const body = dropdown.slice(dropdown.indexOf("const togglePause"),
            dropdown.indexOf("const showProviderDetails"));

        assert.match(body, /assertOk\(await postRequest\("\/speedtests\/continue"\)/,
            "the resume response is still discarded");
        assert.match(body, /updateToast\(/, "a failed resume says nothing");
    });
});

/**
 * The delete button, which the confirmation made worse on a demo: two steps to
 * reach a refusal.
 */
describe("deleting a test on a demo", () => {
    const row = read("pages/Home/components/Speedtest/SpeedtestComponent.jsx");

    it("is not offered at all", () => {
        assert.match(row, /!config\.viewMode && !config\.previewMode/,
            "the delete button is gated on viewMode alone, which is undefined in preview mode");
    });

    // The gate has to be on the button, not inside the handler - the point is
    // that the reader is never asked to confirm something that cannot happen.
    it("is gated before the confirmation, not after it", () => {
        const at = row.indexOf("!config.viewMode && !config.previewMode");
        const confirm = row.indexOf("openConfirm(");

        assert.notEqual(at, -1);
        assert.ok(confirm < at,
            "the preview check sits inside the handler rather than on the control");
    });
});
