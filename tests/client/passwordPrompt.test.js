import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { promptUntilAccepted } from "../../client/src/common/utils/PasswordPrompt.js";

/**
 * The app asks for a credential in two places, and they used to disagree about
 * what a rejected one means.
 *
 * The header re-opened the prompt and said the password was wrong. The dialog
 * the page opens when it loads unauthenticated did neither: it called login(),
 * ignored the false it answered with, and stopped - the prompt had already
 * closed, so a single typo left a blank dashboard with nothing said and no way
 * back except a manual reload. That is the prompt a locked-out operator meets
 * first.
 *
 * The refusal is handed back to the prompt rather than a bare "it failed":
 * being told the wrong password and being told to wait out a lockout are
 * different sentences, and asking for a setup token is a different question
 * altogether.
 */
describe("promptUntilAccepted", () => {
    // Records what each prompt was told about the attempt before it, which is
    // what decides the question it asks.
    const promptReturning = (...values) => {
        const shown = [];
        let call = 0;

        const prompt = async (previous) => {
            shown.push(previous);
            return values[call++];
        };

        return {prompt, shown};
    };

    const accepts = async () => ({ok: true});
    const rejects = async () => ({ok: false, type: "PASSWORD_REQUIRED"});

    it("accepts a credential that works the first time", async () => {
        const {prompt, shown} = promptReturning("hunter2");

        assert.equal(await promptUntilAccepted(prompt, accepts), true);
        assert.deepEqual(shown, [null], "nothing had been refused yet, so nothing should have been reported");
    });

    // The regression: this used to end the story with the page still broken.
    it("asks again after a refusal, passing on why", async () => {
        const {prompt, shown} = promptReturning("wrong", "hunter2");
        const authenticate = async (value) =>
            value === "hunter2" ? {ok: true} : {ok: false, type: "PASSWORD_REQUIRED"};

        assert.equal(await promptUntilAccepted(prompt, authenticate), true);
        assert.deepEqual(shown, [null, {ok: false, type: "PASSWORD_REQUIRED"}]);
    });

    // The reason can change between attempts - a wrong password often enough
    // becomes a lockout - and the prompt has to follow it.
    it("passes on the newest reason, not the first", async () => {
        // Two answers, so the third prompt is dismissed and ends the loop -
        // leaving exactly one prompt per refusal to inspect.
        const {prompt, shown} = promptReturning("a", "b");
        const reasons = ["PASSWORD_REQUIRED", "TOO_MANY_ATTEMPTS"];
        let call = 0;

        await promptUntilAccepted(prompt, async () => ({ok: false, type: reasons[call++]}));

        assert.deepEqual(shown.map((previous) => previous?.type), [undefined, "PASSWORD_REQUIRED", "TOO_MANY_ATTEMPTS"]);
    });

    it("keeps asking for as long as the answers are refused", async () => {
        const {prompt, shown} = promptReturning("a", "b", "c", "hunter2");
        const authenticate = async (value) =>
            value === "hunter2" ? {ok: true} : {ok: false, type: "PASSWORD_REQUIRED"};

        assert.equal(await promptUntilAccepted(prompt, authenticate), true);
        assert.equal(shown.length, 4);
    });

    // Dismissing is a decision, not a failure - it must not spin.
    it("gives up when the prompt is dismissed", async () => {
        const {prompt, shown} = promptReturning(undefined);

        assert.equal(await promptUntilAccepted(prompt, accepts), false);
        assert.deepEqual(shown, [null]);
    });

    it("gives up when the prompt is dismissed after a refusal", async () => {
        const {prompt, shown} = promptReturning("wrong", null);

        assert.equal(await promptUntilAccepted(prompt, rejects), false);
        assert.equal(shown.length, 2);
    });

    // An empty box is a dismissal too: authenticating "" would spend a bcrypt
    // comparison and count against the throttle for nothing.
    it("treats an empty answer as a dismissal", async () => {
        let attempts = 0;
        const {prompt} = promptReturning("");

        await promptUntilAccepted(prompt, async () => {
            attempts++;
            return {ok: false};
        });

        assert.equal(attempts, 0, "an empty box must never reach the server");
    });

    it("never authenticates a value the prompt did not return", async () => {
        const {prompt} = promptReturning("wrong", "hunter2");
        const seen = [];

        await promptUntilAccepted(prompt, async (value) => {
            seen.push(value);
            return {ok: value === "hunter2"};
        });

        assert.deepEqual(seen, ["wrong", "hunter2"]);
    });
});

/**
 * The other half of the same regression, one layer up.
 *
 * promptUntilAccepted reads an empty value as a dismissal, and that is
 * deliberate - it is pinned above. But the credential prompt is opened with
 * disableClose precisely because there is nothing behind it to go back to, and
 * AlertRenderer only refuses an empty box when the call site asked it to. It
 * did not, so pressing Enter on the autofocused empty input resolved with "",
 * the loop read a dismissal, askForCredential returned without reloading, and
 * the config stayed {} - a gutted page with the prompt gone and no way back
 * short of F5.
 */
describe("the credential prompt cannot be emptied out of existence", () => {
    const source = fs.readFileSync(fileURLToPath(
        new URL("../../client/src/common/contexts/Config/ConfigContext.jsx", import.meta.url)), "utf8");

    const openInput = source.slice(source.indexOf("alert.openInput"));
    const options = openInput.slice(0, openInput.indexOf("});"));

    it("asks for a value it will not accept as empty", () => {
        assert.match(options, /required: true/,
            "an empty submit still closes the unclosable prompt for good");
    });

    it("still refuses to be closed any other way", () => {
        assert.match(options, /disableClose/);
    });
});

describe("the alert renderer honours that request", () => {
    const renderer = fs.readFileSync(fileURLToPath(
        new URL("../../client/src/common/contexts/Alert/AlertContext.jsx", import.meta.url)), "utf8");

    it("refuses to submit a required input that is empty", () => {
        assert.match(renderer, /alert\.required && !inputValue/);
    });
});
