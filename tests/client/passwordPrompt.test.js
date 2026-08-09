import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promptUntilAccepted } from "../../client/src/common/utils/PasswordPrompt.js";

/**
 * The app asks for the password in two places, and they used to disagree about
 * what a rejected one means.
 *
 * The header re-opened the prompt and said the password was wrong. The dialog
 * the page opens when it loads unauthenticated did neither: it called login(),
 * ignored the false it answered with, and stopped - the prompt had already
 * closed, so a single typo left a blank dashboard with nothing said and no way
 * back except a manual reload. That is the prompt a locked-out operator meets
 * first.
 *
 * The loop lives here so both call sites share one answer, and so the branch
 * that was missing is covered by something other than clicking.
 */
describe("promptUntilAccepted", () => {
    // Records what the prompt was told about the previous attempt, which is
    // what decides whether the user is shown the "that was wrong" line.
    const promptReturning = (...values) => {
        const shown = [];
        let call = 0;

        const prompt = async (failed) => {
            shown.push(failed);
            return values[call++];
        };

        return {prompt, shown};
    };

    const accepts = async () => true;
    const rejects = async () => false;

    it("accepts a password that works the first time", async () => {
        const {prompt, shown} = promptReturning("hunter2");

        assert.equal(await promptUntilAccepted(prompt, accepts), true);
        assert.deepEqual(shown, [false], "nothing had failed yet, so nothing should have been reported");
    });

    // The regression: this used to end the story with the page still broken.
    it("asks again after a rejected password, saying it was wrong", async () => {
        const {prompt, shown} = promptReturning("wrong", "hunter2");
        const authenticate = async (value) => value === "hunter2";

        assert.equal(await promptUntilAccepted(prompt, authenticate), true);
        assert.deepEqual(shown, [false, true], "the second prompt has to know the first was rejected");
    });

    it("keeps asking for as long as the answers are wrong", async () => {
        const {prompt, shown} = promptReturning("a", "b", "c", "hunter2");
        const authenticate = async (value) => value === "hunter2";

        assert.equal(await promptUntilAccepted(prompt, authenticate), true);
        assert.deepEqual(shown, [false, true, true, true]);
    });

    // Dismissing is a decision, not a failure - it must not spin.
    it("gives up when the prompt is dismissed", async () => {
        const {prompt, shown} = promptReturning(undefined);

        assert.equal(await promptUntilAccepted(prompt, accepts), false);
        assert.deepEqual(shown, [false]);
    });

    it("gives up when the prompt is dismissed after a wrong password", async () => {
        const {prompt, shown} = promptReturning("wrong", null);

        assert.equal(await promptUntilAccepted(prompt, rejects), false);
        assert.deepEqual(shown, [false, true]);
    });

    // An empty box is a dismissal too: authenticating "" would spend a bcrypt
    // comparison and count against the throttle for nothing.
    it("treats an empty answer as a dismissal", async () => {
        let attempts = 0;
        const {prompt} = promptReturning("");

        await promptUntilAccepted(prompt, async () => {
            attempts++;
            return false;
        });

        assert.equal(attempts, 0, "an empty box must never reach the server");
    });

    it("never authenticates a value the prompt did not return", async () => {
        const {prompt} = promptReturning("wrong", "hunter2");
        const seen = [];

        await promptUntilAccepted(prompt, async (value) => {
            seen.push(value);
            return value === "hunter2";
        });

        assert.deepEqual(seen, ["wrong", "hunter2"]);
    });
});
