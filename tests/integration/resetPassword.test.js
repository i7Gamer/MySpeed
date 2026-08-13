import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, setConfig } from "./helpers/boot.js";

let server;
let resetPassword;
let outcomes;
let resetFailedAttempts;

const PASSWORD = "Hunter2!";
const GUARDED = "/speedtests?limit=1";

before(async () => {
    server = await bootServer();
    // Imported after the boot: the database module resolves its file from the
    // working directory at import time, and boot is what moves it.
    ({resetPassword, ...outcomes} = await import("../../server/util/resetPassword.js"));
    ({resetFailedAttempts} = await import("../../server/middlewares/password.js"));
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    resetFailedAttempts();
    await setConfig(server.config, "password", PASSWORD);
});

/**
 * The recovery command, exercised against the real configuration table.
 *
 * It clears the password rather than setting a new one: a password passed on
 * the command line is left behind in the shell history and visible in the
 * process list of a machine that may not be the operator's alone, and clearing
 * it hands the instance back to the setup-token flow that already exists for
 * exactly this - refused from the network, open on loopback, printing a token
 * to the log for everyone else.
 */
describe("resetPassword", () => {
    it("puts the stored password back to the unconfigured sentinel", async () => {
        const outcome = await resetPassword();

        assert.equal(outcome, outcomes.RESET_CLEARED);
        assert.equal(await server.config.getValue("password"), server.config.NO_PASSWORD);
    });

    // The point of the whole exercise: the credential that was refusing the
    // operator has to stop refusing them.
    it("stops the old password being accepted", async () => {
        await resetPassword();

        const response = await api(server.baseUrl, "/session", {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({password: PASSWORD})
        });

        assert.equal(response.status, 401);
        assert.equal(response.body.type, "SETUP_TOKEN_REQUIRED",
            "the instance still believes it has a password to check against");
    });

    // Loopback is where the reset is run from, and where the operator then is.
    it("lets the machine it runs on back in unchallenged", async () => {
        await resetPassword();

        assert.equal((await api(server.baseUrl, GUARDED)).status, 200);
    });

    /**
     * Run twice, or run on an instance that never had one. Saying so is the
     * whole of it - reporting "cleared" for a password that was already clear
     * would tell an operator who is still locked out that the fix has been
     * applied, and send them looking somewhere else.
     */
    it("says when there was nothing to clear", async () => {
        await resetPassword();

        assert.equal(await resetPassword(), outcomes.RESET_ALREADY_CLEAR);
    });

    // Every other setting is someone's configuration, and a recovery command
    // that resets more than the credential is one nobody dares run.
    it("touches nothing but the password", async () => {
        await setConfig(server.config, "passwordLevel", "read");
        await setConfig(server.config, "retentionDays", "42");

        await resetPassword();

        assert.equal(await server.config.getValue("passwordLevel"), "read");
        assert.equal(await server.config.getValue("retentionDays"), "42");
    });
});
