import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { passwordConfirmationProblem, PASSWORD_MISMATCH }
    from "../../client/src/common/utils/PasswordConfirmation.js";

/**
 * A password was chosen in one box, hashed, and stored - so a typo in it became
 * the password. Nothing on the way in could catch that: the server only ever
 * sees the one value, and the only way back from a password nobody knows is
 * editing the database by hand. The second box is the only check there can be.
 */
describe("passwordConfirmationProblem", () => {
    it("passes when both boxes are empty, which changes no password at all", () => {
        assert.equal(passwordConfirmationProblem("", ""), null);
    });

    it("passes when the two boxes agree", () => {
        assert.equal(passwordConfirmationProblem("Hunter2!", "Hunter2!"), null);
    });

    it("catches two different passwords", () => {
        assert.equal(passwordConfirmationProblem("Hunter2!", "Hunter3!"), PASSWORD_MISMATCH);
    });

    it("catches a confirmation left empty", () => {
        assert.equal(passwordConfirmationProblem("Hunter2!", ""), PASSWORD_MISMATCH);
    });

    // The password box alone is what save() reads, so this typed nothing into
    // it and would silently have changed no password behind a success toast.
    it("catches a password left empty while the confirmation is filled", () => {
        assert.equal(passwordConfirmationProblem("", "Hunter2!"), PASSWORD_MISMATCH);
    });

    // Trimming here would defeat the point: a stray trailing space is stored as
    // part of the password, and is exactly the typo nobody can see.
    it("counts a trailing space as a difference", () => {
        assert.equal(passwordConfirmationProblem("Hunter2!", "Hunter2! "), PASSWORD_MISMATCH);
    });

    it("counts a leading space as a difference", () => {
        assert.equal(passwordConfirmationProblem(" Hunter2!", "Hunter2!"), PASSWORD_MISMATCH);
    });

    // Caps lock is the other invisible typo.
    it("compares case sensitively", () => {
        assert.equal(passwordConfirmationProblem("Hunter2!", "hunter2!"), PASSWORD_MISMATCH);
    });

    it("names a key the interface can translate", () => {
        assert.match(PASSWORD_MISMATCH, /^[a-z_]+\.[a-z_]+$/);
    });
});

const DIALOG = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..",
    "client", "src", "common", "components", "PasswordDialog", "PasswordDialog.jsx");

const source = fs.readFileSync(DIALOG, "utf8");

/**
 * The check is only worth anything if the dialog actually consults it, and the
 * order matters: refusing after the PATCH would have stored the typo already.
 */
describe("the password dialog asks before it saves", () => {
    it("offers a second box", () => {
        assert.match(source, /passwordConfirmationProblem/,
            "the dialog never consults the confirmation check");
    });

    it("refuses before the password is sent, not after", () => {
        const checked = source.indexOf("passwordConfirmationProblem(password");
        const sent = source.indexOf('patchRequest("/config/password"');

        assert.notEqual(checked, -1, "the check is never run against the typed password");
        assert.ok(checked < sent, "the password is sent before the confirmation is checked");
    });

    it("clears the second box when the dialog opens, as it does the first", () => {
        const sync = source.slice(source.indexOf("useSyncOnOpen"), source.indexOf("const save"));

        assert.match(sync, /setConfirmation\(""\)/,
            "a confirmation typed into a previous open survives into the next one");
    });
});
