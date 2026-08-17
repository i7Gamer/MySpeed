import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bootServer } from "./helpers/boot.js";

/**
 * The harness itself, which is once per process and did not say so.
 *
 * `booted` guards the second call and was never cleared by close(), so a file
 * that closed and then booted again was handed the instance it had just shut
 * down: a closed database handle, a listener that is no longer listening, and a
 * data directory that close() had deleted. Every assertion after that fails
 * somewhere deep in sequelize, describing none of it.
 *
 * Clearing the guard would not have helped. The imports inside bootServer are
 * ESM and cached, so a second boot gets the same database instance back - the
 * closed one - and the same app, while process.chdir has already moved out of
 * the directory the storage path resolves against. Booting twice is not a thing
 * this harness can do; the node runner isolates each test file in its own
 * process precisely so it never has to. So it refuses, and says which rule was
 * broken instead of failing as a mystery three assertions later.
 */
describe("the integration harness", () => {
    it("hands back the same instance while it is up", async () => {
        assert.equal(await bootServer(), await bootServer());
    });

    it("refuses to boot again once it has been closed", async () => {
        const server = await bootServer();

        await server.close();

        await assert.rejects(bootServer(), /once per process/,
            "a second boot was handed the instance that had just been shut down");
    });
});
