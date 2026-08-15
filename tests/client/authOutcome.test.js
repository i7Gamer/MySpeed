import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
    PASSWORD_REQUIRED, PROMPT_BUSY, PROMPT_PASSWORD, PROMPT_SETUP_TOKEN, PROMPT_THROTTLED,
    SERVER_BUSY, SETUP_TOKEN_REQUIRED, TOO_MANY_ATTEMPTS, lockedNoticeKeys, promptFor, refusalDescriptionKey
} from "../../client/src/common/utils/AuthOutcome.js";

/**
 * A 401 is not one situation.
 *
 * An instance with no password refuses network callers until they present the
 * setup token from its log; an instance with one refuses a wrong password; and
 * either will refuse everything for a minute once too many have been rejected.
 * All three arrived as a bare 401 the client threw away, so it asked the same
 * question every time - "your password" - of an operator who did not have one
 * and could not have guessed that a token existed.
 *
 * The server names the case now, and this is where the name is turned into a
 * question.
 */
describe("promptFor", () => {
    it("asks for the setup token on an instance that has no password", () => {
        assert.equal(promptFor(SETUP_TOKEN_REQUIRED), PROMPT_SETUP_TOKEN);
    });

    it("asks for the password when there is one", () => {
        assert.equal(promptFor(PASSWORD_REQUIRED), PROMPT_PASSWORD);
    });

    it("does not ask at all while the caller is locked out", () => {
        assert.equal(promptFor(TOO_MANY_ATTEMPTS), PROMPT_THROTTLED);
    });

    /**
     * Falling back to the password prompt matters more than it looks. A node
     * running an older MySpeed answers 401 with no type at all, and the parent
     * proxies that answer through unchanged - so an absent type has to mean
     * "ask the way we always did" rather than break the dialog.
     */
    it("asks for the password when the server says nothing", () => {
        assert.equal(promptFor(undefined), PROMPT_PASSWORD);
        assert.equal(promptFor(null), PROMPT_PASSWORD);
    });

    it("asks for the password when the server says something unknown", () => {
        assert.equal(promptFor("SOMETHING_ADDED_LATER"), PROMPT_PASSWORD);
    });

    // The three questions have to stay distinguishable: mapping two of them to
    // the same prompt would silently reinstate the bug this exists to fix.
    it("gives each case its own question", () => {
        const prompts = [SETUP_TOKEN_REQUIRED, PASSWORD_REQUIRED, TOO_MANY_ATTEMPTS].map(promptFor);

        assert.equal(new Set(prompts).size, 3);
    });
});

/**
 * The admin login re-asks in place rather than switching dialogs, so what it
 * can vary is the line it shows about the refusal. "The password you entered
 * is incorrect" was that line for every refusal - including a lockout, where
 * it invited retyping into a throttle that answers nothing, and an instance
 * whose password was removed mid-session, where no password would ever work.
 */
describe("refusalDescriptionKey", () => {
    it("says the password was wrong when it was", () => {
        assert.equal(refusalDescriptionKey(PASSWORD_REQUIRED), "dialog.password.wrong");
    });

    it("says to wait when the caller is locked out", () => {
        assert.equal(refusalDescriptionKey(TOO_MANY_ATTEMPTS), "dialog.throttled.description");
    });

    // The full situation, not "that is not the token": the operator typed a
    // password, and what changed is that the instance no longer has one.
    it("explains the setup token when the instance wants one", () => {
        assert.equal(refusalDescriptionKey(SETUP_TOKEN_REQUIRED), "dialog.setup_token.description");
    });

    it("falls back to the wrong-password line for anything unrecognised", () => {
        assert.equal(refusalDescriptionKey(undefined), "dialog.password.wrong");
        assert.equal(refusalDescriptionKey("SOMETHING_ADDED_LATER"), "dialog.password.wrong");
    });
});

/**
 * A busy server is not a wrong password.
 *
 * The throttle keeps two counters: one for wrong guesses, which locks the
 * caller out for a window, and one for comparisons already running, which
 * clears the moment a slot frees. The second refuses with a 503 - and without
 * a type of its own the client fell through to its default and told the
 * operator "the password you entered is incorrect", which is precisely the
 * misreport the two counters were separated to end.
 */
describe("a refusal because the server is busy", () => {
    it("is its own question, not the password one", () => {
        assert.equal(promptFor(SERVER_BUSY), PROMPT_BUSY);
        assert.notEqual(promptFor(SERVER_BUSY), PROMPT_PASSWORD);
    });

    it("never says the password was wrong", () => {
        assert.equal(refusalDescriptionKey(SERVER_BUSY), "dialog.busy.description");
    });

    // Distinct from the lockout: both ask for patience, but only one of them
    // is about attempts that were rejected.
    it("is told apart from being locked out", () => {
        assert.notEqual(refusalDescriptionKey(SERVER_BUSY), refusalDescriptionKey(TOO_MANY_ATTEMPTS));
        assert.notEqual(lockedNoticeKeys(SERVER_BUSY).title, lockedNoticeKeys(TOO_MANY_ATTEMPTS).title);
    });

    it("offers a retry rather than a box to type into", () => {
        assert.equal(lockedNoticeKeys(SERVER_BUSY).action, "dialog.retry");
    });
});

/**
 * And the primary prompt honours it, not just the header's.
 *
 * The refusal dispatcher naming a case is only half of it: ConfigContext's
 * credential loop compared the prompt kind against PROMPT_THROTTLED alone and
 * fell through to the password box, whose description is a hardcoded "the
 * password you entered is incorrect". So the one place an operator meets this
 * first still blamed their credentials.
 */
describe("the credential prompt's own branches", () => {
    const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
    const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

    it("has a dialog for a busy server", () => {
        assert.match(read("client/src/common/contexts/Config/dialog.jsx"), /export const busyDialog/,
            "there is no busy dialog for the prompt to open");
    });

    it("opens it rather than the password box", () => {
        // Bounded to the one statement: `/s` across the whole file would still
        // pass if these two fragments drifted into unrelated branches.
        assert.match(read("client/src/common/contexts/Config/ConfigContext.jsx"),
            /kind === PROMPT_BUSY\) return openAlertDialog\(busyDialog\(\)\)/,
            "a busy refusal still falls through to the wrong-password prompt");
    });

    /**
     * A busy refusal is a refusal - but only when the body says it is ours.
     * A reverse proxy fronting a stopped container answers 503 too, and
     * treating that as a credential problem puts a password box in front of a
     * server that is down, then calls the password wrong when the retry fails
     * the same way. Server-side node.js makes exactly this check.
     */
    it("treats our own busy refusal as a refusal", () => {
        const source = read("client/src/common/contexts/Config/ConfigContext.jsx");

        assert.match(source, /res\.status === 503/, "a 503 is never treated as a refusal");
        assert.match(source, /body\?\.type === SERVER_BUSY/,
            "any 503 is taken as a credential refusal, including a gateway's");
    });
});
