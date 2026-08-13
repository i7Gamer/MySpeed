import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
    PASSWORD_REQUIRED, SETUP_TOKEN_REQUIRED, TOO_MANY_ATTEMPTS, lockedNoticeKeys
} from "../../client/src/common/utils/AuthOutcome.js";

const read = (relative) =>
    fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const english = JSON.parse(read("../../client/public/assets/locales/en.json"));
const lookup = (key) => key.split(".").reduce((node, part) => node?.[part], english);

/**
 * The way out of the credential prompt.
 *
 * The prompt refused to close - no X, no Escape, no backdrop - because
 * dismissing it left the page gutted: the config stayed {} and the dashboard
 * behind it rendered nothing. That reasoning held right up until the operator
 * could not answer the question. An instance with no password asks for a token
 * printed in a server log, and someone who cannot reach that log had a modal
 * they could neither answer nor leave.
 *
 * So dismissing now lands somewhere rather than nowhere, and this is the copy
 * that somewhere shows.
 */
describe("lockedNoticeKeys", () => {
    it("explains the setup token when the instance has no password", () => {
        const keys = lockedNoticeKeys(SETUP_TOKEN_REQUIRED);

        assert.equal(keys.title, "dialog.setup_token.title");
        assert.equal(keys.description, "dialog.setup_token.description");
    });

    // The token is not a fixed secret to look up once: it is reprinted whenever
    // a request is refused, which is the difference between "hunt through the
    // log" and "reload this page and read the last lines".
    it("says how to get the token back when it has scrolled out of view", () => {
        assert.ok(lockedNoticeKeys(SETUP_TOKEN_REQUIRED).hint, "the notice has to say where the token comes from");
    });

    it("asks for the password when there is one", () => {
        const keys = lockedNoticeKeys(PASSWORD_REQUIRED);

        assert.equal(keys.title, "dialog.password.title");
        assert.equal(keys.action, "dialog.login");
    });

    // Nothing to enter and nothing to explain beyond the wait, so the button
    // retries rather than reopening a prompt that would be refused anyway.
    it("says to wait while the caller is locked out", () => {
        const keys = lockedNoticeKeys(TOO_MANY_ATTEMPTS);

        assert.equal(keys.title, "dialog.throttled.title");
        assert.equal(keys.action, "dialog.retry");
    });

    // Same fallback as promptFor: an older node answers 401 with no type at
    // all and the parent proxies that through unchanged.
    it("falls back to the password notice for anything unrecognised", () => {
        assert.deepEqual(lockedNoticeKeys(undefined), lockedNoticeKeys(PASSWORD_REQUIRED));
        assert.deepEqual(lockedNoticeKeys("SOMETHING_ADDED_LATER"), lockedNoticeKeys(PASSWORD_REQUIRED));
    });

    // Built from a lookup rather than written literally in the component, so
    // the scanner in i18nKeys.test.js cannot see them - they are checked here
    // instead, or the escape hatch renders raw key names.
    it("names only keys that exist", () => {
        for (const type of [SETUP_TOKEN_REQUIRED, PASSWORD_REQUIRED, TOO_MANY_ATTEMPTS, undefined])
            for (const [role, key] of Object.entries(lockedNoticeKeys(type)))
                assert.equal(typeof lookup(key), "string", `${role} key "${key}" is missing from en.json`);
    });

    it("gives every notice something to press", () => {
        for (const type of [SETUP_TOKEN_REQUIRED, PASSWORD_REQUIRED, TOO_MANY_ATTEMPTS])
            assert.ok(lockedNoticeKeys(type).action, "a notice with no button is the deadlock again");
    });
});

/**
 * The prompts themselves. Both are opened by askForCredential, and both used to
 * carry disableCloseButton - the property that removed the X, ignored Escape
 * and swallowed backdrop clicks.
 */
describe("the credential prompts can be left", () => {
    const source = read("../../client/src/common/contexts/Config/dialog.jsx");
    const declaration = (name) => {
        const start = source.indexOf(`export const ${name}`);
        const rest = source.slice(start).slice(1);
        const end = rest.indexOf("export const");
        return end === -1 ? rest : rest.slice(0, end);
    };

    for (const name of ["passwordRequiredDialog", "setupTokenDialog"]) {
        it(`${name} does not hold the page hostage`, () => {
            assert.doesNotMatch(declaration(name), /disableCloseButton:\s*true/,
                "an operator who cannot answer the question must still be able to close it");
        });
    }

    // The empty box is the other way out, and it must stay shut: submitting
    // nothing reads as a dismissal, which would close the prompt for a keypress
    // nobody meant as one.
    it("still refuses an empty answer", () => {
        const context = read("../../client/src/common/contexts/Config/ConfigContext.jsx");
        const openInput = context.slice(context.indexOf("alert.openInput"));

        assert.match(openInput.slice(0, openInput.indexOf("});")), /required: true/);
    });
});

/**
 * Dismissing has to land on the notice. Leaving the prompt without one is the
 * gutted page the disableClose was there to prevent, so the two changes only
 * make sense together.
 */
describe("the page a dismissed prompt falls back to", () => {
    const context = read("../../client/src/common/contexts/Config/ConfigContext.jsx");

    it("remembers the refusal instead of returning to nothing", () => {
        assert.match(context, /if\s*\(!accepted\)\s*return setLocked/);
    });

    it("renders the notice", () => {
        assert.match(context, /<LockedNotice/);
    });

    it("lets the notice reopen the prompt", () => {
        assert.match(context, /onRetry=\{\(\) => askForCredential\(/);
    });

    // Reopening while the notice is still up would stack the two.
    it("takes the notice down while the prompt is open", () => {
        assert.match(context, /setLocked\(null\)/);
    });
});

/**
 * The button that caused this.
 *
 * Removing the password was labelled "Unlock" - the same word the login prompt
 * uses for its submit button - and it fired on the first click. An operator
 * reading it as "unlock the settings" instead deleted the instance's password,
 * was signed out by the deletion, and met the setup-token prompt with no way
 * back.
 */
describe("removing the password", () => {
    const dialog = read("../../client/src/common/components/PasswordDialog/PasswordDialog.jsx");

    it("is not called Unlock any more", () => {
        assert.doesNotMatch(dialog, /t\("dialog\.password\.unlock"\)/,
            "that key is the login prompt's submit button, not a delete");
        assert.match(dialog, /t\("update\.remove_password"\)/);
    });

    it("asks before it deletes", () => {
        assert.match(dialog, /openConfirm\(/);
        assert.match(dialog, /update\.remove_password_title/);
        assert.match(dialog, /update\.remove_password_desc/);
    });

    it("marks the confirmation as destructive", () => {
        assert.match(dialog, /danger: true/);
    });

    // Nothing in the interface said what removal costs, which is the whole
    // reason the click looked harmless.
    it("says what is lost", () => {
        const description = lookup("update.remove_password_desc");

        assert.match(description, /setup token/i, "the lockout that follows has to be named before the click");
        assert.match(description, /signed out/i);
    });

    // Only offered when there is something to remove - an instance with no
    // password must not advertise removing one.
    it("is only offered when a password is set", () => {
        assert.match(dialog, /isPasswordSet && \(/);
    });
});
