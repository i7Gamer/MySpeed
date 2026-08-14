import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, setConfig } from "./helpers/boot.js";

let server;
let resetPassword;
let outcomes;
let resetFailedAttempts;
let model;

const PASSWORD = "Hunter2!";
const GUARDED = "/speedtests?limit=1";

before(async () => {
    server = await bootServer();
    // Imported after the boot: the database module resolves its file from the
    // working directory at import time, and boot is what moves it.
    ({resetPassword, ...outcomes} = await import("../../server/util/resetPassword.js"));
    ({resetFailedAttempts} = await import("../../server/middlewares/password.js"));
    // The same model object resetPassword holds, so a query replaced on it here
    // is the query the command runs.
    ({default: model} = await import("../../server/models/Config.js"));
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

/**
 * The three ways the query can come back without a password to clear, driven
 * through the real table rather than described to it.
 *
 * These branches decide between two opposite instructions - "your data is
 * somewhere else, change the path" and "your data is here and in trouble" - and
 * until now every one of them was reached only by handing isMissingConfigTable
 * an error built in the test. That leaves the interesting half untested: whether
 * the driver, on a table that genuinely is not there, actually says the thing
 * the matcher is looking for. It also let the distinction be deleted outright -
 * swallowing every failure as "no configuration here" kept the whole suite
 * green, while turning a locked database into an instruction to go and check a
 * working directory that was never wrong.
 *
 * Last in the file, and each case puts the table back, because the ones above
 * expect a seeded configuration to be there.
 */
describe("resetPassword when there is nothing to read", () => {
    const restore = async () => {
        await model.sync();
        await server.config.insertDefaults();
    };

    // Pointed at the wrong directory: sqlite makes the file rather than
    // refusing, so the first query is what discovers there was never a
    // configuration here.
    it("reports an empty database when the table is not there at all", async () => {
        await model.drop();

        try {
            assert.equal(await resetPassword(), outcomes.RESET_NO_CONFIG);
        } finally {
            await restore();
        }
    });

    // A table that exists and was never seeded - a first start that did not
    // finish, or a database this was pointed at by mistake. Seeding it here
    // would answer a lockout by inventing the configuration it was recovering.
    it("reports an empty database when the table holds no password", async () => {
        await model.destroy({where: {key: "password"}});

        try {
            assert.equal(await resetPassword(), outcomes.RESET_NO_CONFIG);
        } finally {
            await restore();
        }
    });

    /**
     * And a database that is there and unwell has to keep travelling, so that
     * index.js can spend the failure code on it.
     *
     * Answered as "no configuration here" it would exit 113 - nothing was wrong,
     * nothing was done - and send an operator whose database is locked or
     * read-only off to check a path, while the password they cannot use is
     * still exactly where it was.
     */
    it("lets a failure that is not a missing table reach the caller", async () => {
        const findOne = model.findOne;

        model.findOne = async () => {
            throw Object.assign(new Error("SQLITE_BUSY: database is locked"),
                {name: "SequelizeDatabaseError"});
        };

        try {
            await assert.rejects(resetPassword(), /database is locked/,
                "a locked database is reported as one that holds no configuration");
        } finally {
            model.findOne = findOne;
        }
    });
});
