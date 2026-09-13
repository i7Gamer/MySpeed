import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {bodyIn} from "../helpers/source.js";
import {
    SHUTDOWN_SUCCESS_EXIT_CODE,
    SHUTDOWN_INCOMPLETE_EXIT_CODE
} from "../../server/util/shutdown.js";

// Exercise the actual verifier function with synthetic process/listener seams.
// Do not launch an application or use an existing listener on any platform.
const verifierBody = bodyIn("scripts/qualification/check-artifact.mjs", "const stopCleanly = async");
const createStop = new Function("stopOwnedProcess", "ensureListenerGone", "SUCCESS_EXIT",
    `return async (child, host, port) => ${verifierBody}`);
const SYNTHETIC_HOST = "127.0.0.1";
const SYNTHETIC_PORT = 12345;

describe("qualification shutdown exit evidence", () => {
    it("checks listener disappearance only after owned successful process shutdown", async () => {
        const calls = [];
        const child = {exitCode: SHUTDOWN_SUCCESS_EXIT_CODE, signalCode: null};
        const stop = createStop(
            async observed => { assert.equal(observed, child); calls.push("stop"); },
            (observed, host, port) => {
                assert.equal(observed, child);
                assert.equal(host, SYNTHETIC_HOST);
                assert.equal(port, SYNTHETIC_PORT);
                calls.push("listener");
            }, SHUTDOWN_SUCCESS_EXIT_CODE);
        await stop(child, SYNTHETIC_HOST, SYNTHETIC_PORT);
        assert.deepEqual(calls, ["stop", "listener"]);
    });

    for (const [name, exitCode, signalCode] of [
        ["incomplete cleanup", SHUTDOWN_INCOMPLETE_EXIT_CODE, null],
        ["signal-only termination", null, "SIGKILL"],
        ["missing exit evidence", undefined, null]
    ]) {
        it(`does not accept ${name} as a clean shutdown`, async () => {
            let checkedListener = false;
            const stop = createStop(async () => undefined, () => { checkedListener = true; },
                SHUTDOWN_SUCCESS_EXIT_CODE);
            await assert.rejects(stop({exitCode, signalCode}, SYNTHETIC_HOST, SYNTHETIC_PORT),
                /Artifact shutdown exited/);
            assert.equal(checkedListener, false);
        });
    }
});
