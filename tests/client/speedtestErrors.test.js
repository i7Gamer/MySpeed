import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import i18n from "i18next";
import { describeError } from "@/pages/Home/components/Speedtest/utils/errors.js";

before(async () => {
    await i18n.init({
        lng: "en",
        resources: {en: {translation: {errors: {
            network_unreachable: "The network could not be reached",
            cannot_open_socket: "Could not open a connection to the test server",
            timed_out: "The test timed out"
        }}}}
    });
});

/**
 * A failed test showed nothing but a blank row until it was expanded. The reason
 * is stored and was already translated for the detail panel, so the row can say
 * it - but only the friendly form: the raw output is a wall of JSON on the
 * failure this was written for.
 */
describe("describeError", () => {
    it("translates a reason it recognises", () => {
        assert.equal(describeError("Network unreachable"), "The network could not be reached");
    });

    // The stored error is whatever the CLI printed, which for the Ookla failure
    // this was written for is several JSON log records rather than a bare phrase.
    it("finds the reason inside a larger blob of output", () => {
        const raw = '{"type":"log","timestamp":"2026-08-08T18:00:10Z","message":"Error: [0] Cannot open socket","level":"error"}';

        assert.equal(describeError(raw), "Could not open a connection to the test server");
    });

    it("matches a reason wherever it appears in the output", () => {
        assert.equal(describeError("something happened: timed out after 30s"), "The test timed out");
    });

    it("says nothing it cannot explain", () => {
        assert.equal(describeError("kernel panic in the flux capacitor"), null);
    });

    it("has nothing to say about a test that did not fail", () => {
        for (const absent of [null, undefined, ""])
            assert.equal(describeError(absent), null, `failed for ${JSON.stringify(absent)}`);
    });
});
