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

    /**
     * Read inside save(), between its opening and the PATCH, rather than as two
     * indexOf positions in the file.
     *
     * The file-wide version of this could not fail. The live hint below calls
     * passwordConfirmationProblem too, on a line that sits above save() and
     * therefore above the PATCH no matter what save() does - so the first match
     * in the file was always the hint, and the comparison always held. Moving
     * the real guard to after the awaited PATCH left the whole suite green,
     * which is the one regression this test exists to catch.
     */
    it("refuses before the password is sent, not after", () => {
        const opens = source.indexOf("const save = async");
        const sends = source.indexOf('patchRequest("/config/password"');

        assert.notEqual(opens, -1, "the dialog no longer has a save function to read");
        assert.ok(opens < sends, "the password is sent from outside save()");

        const beforeSending = source.slice(opens, sends);

        assert.match(beforeSending, /passwordConfirmationProblem\(password, confirmation\)/,
            "the password is sent before the two boxes are compared");
        assert.match(beforeSending, /if \(problem\) return/,
            "a mismatch is noticed and then carries on into the save anyway");
    });

    it("clears the second box when the dialog opens, as it does the first", () => {
        const sync = source.slice(source.indexOf("useSyncOnOpen"), source.indexOf("const save"));

        assert.match(sync, /setConfirmation\(""\)/,
            "a confirmation typed into a previous open survives into the next one");
    });
});

/**
 * And says so while it is still being typed, not only once Save is pressed.
 *
 * The refusal at save time is what makes the typo impossible to store; this
 * hint is what makes it cheap to fix. Caught at save, the operator has two
 * boxes of hidden text and no idea which one is wrong; caught under the box as
 * the second is typed, the character that diverged is the one just entered.
 *
 * Node cannot parse JSX and this renders either way, so the wiring is read off
 * the source - the rule itself is exercised against the helper above, which is
 * what keeps the two from drifting apart.
 */
describe("the password dialog shows a mismatch as it is typed", () => {
    const hint = source.match(/const mismatch = [^\n]*/)?.[0] ?? "";

    it("computes a live hint at all", () => {
        assert.notEqual(hint, "", "the dialog holds no mismatch state, so nothing can be shown while typing");
    });

    // The same check the save runs, not a second copy of the rule: two
    // spellings of "do these agree" is how a dialog ends up refusing a save it
    // showed no complaint about.
    it("derives the hint from the check the save uses", () => {
        assert.match(hint, /passwordConfirmationProblem\(password, confirmation\)/,
            "the live hint applies its own copy of the comparison");
    });

    /**
     * Gated on the confirmation box having been typed into.
     *
     * Ungated it would be red from the first character of the *first* box:
     * passwordConfirmationProblem reports a filled password against an empty
     * confirmation as a mismatch, which is right at save time and wrong here -
     * that box has simply not been reached yet. A dialog that opens complaining
     * teaches the operator to ignore the complaint.
     */
    it("stays silent until a confirmation has actually been typed", () => {
        assert.match(hint, /^const mismatch = confirmation \?/,
            "the hint is computed for an untouched confirmation box, so it complains before it can be right");

        // The gate is only correct because this is what it suppresses.
        assert.equal(passwordConfirmationProblem("Hunter2!", ""), PASSWORD_MISMATCH);
    });

    it("renders the hint, and only when there is one", () => {
        assert.match(source, /\{mismatch && <span[^>]*className="[^"]*password-mismatch/,
            "the mismatch is computed and never shown");
    });

    // Through i18next like every other string here - the helper hands back a
    // key precisely so this line is not an English sentence in the markup.
    it("translates the hint rather than printing the key", () => {
        assert.match(source, /\{mismatch && <span[^>]*>\{t\(mismatch\)}<\/span>}/,
            "the hint prints the raw translation key");
    });

    /**
     * Directly under the confirmation box, which its spacing depends on: the
     * rule carries a negative margin-top to pull itself out of the gap the
     * content column puts between sections, so that it reads as belonging to
     * the box above rather than sitting between the two. Moved elsewhere in the
     * markup it keeps the negative margin and lands on whatever now precedes
     * it.
     */
    it("sits between the confirmation box and the access section", () => {
        const confirmation = source.indexOf("update.confirm_password_placeholder");
        const shown = source.indexOf("{mismatch &&");
        const access = source.indexOf('className="access-section"');

        assert.ok(confirmation !== -1 && shown !== -1 && access !== -1, "the dialog no longer has these three parts");
        assert.ok(confirmation < shown, "the hint is rendered above the box it describes");
        assert.ok(shown < access, "the hint has drifted past the access section below it");
    });
});
