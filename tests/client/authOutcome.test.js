import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    PASSWORD_REQUIRED, PROMPT_PASSWORD, PROMPT_SETUP_TOKEN, PROMPT_THROTTLED,
    SETUP_TOKEN_REQUIRED, TOO_MANY_ATTEMPTS, promptFor
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
