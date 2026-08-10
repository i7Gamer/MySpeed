import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootServer } from "./helpers/boot.js";

let server;
let speedTest;

before(async () => {
    server = await bootServer();
    // Imported after boot so the module resolves against the test database. No
    // interface probe runs in tests, so the detected map is empty and the
    // stored interface - "none" on a fresh install - has no address.
    speedTest = (await import("../../server/util/speedtest.js")).default;
});

after(async () => {
    await server?.close();
});

/**
 * Regression: with no detected interfaces the run went ahead and handed
 * `undefined` to the CLI - cloudflare threw a bare TypeError on
 * `interfaceIp.includes(':')` - so the failure stored for the operator said
 * nothing about the interface that caused it.
 */
describe("a run without a usable interface", () => {
    for (const mode of ["cloudflare", "libre"]) {
        it(`refuses ${mode} with the interface named instead of crashing into the CLI`, async () => {
            await assert.rejects(() => speedTest(mode, undefined, undefined, undefined), (error) => {
                assert.match(error.message, /interface/i);
                assert.doesNotMatch(error.message, /undefined/);
                return true;
            });
        });
    }
});
