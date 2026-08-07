import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getSetupToken, matchesSetupToken, resetSetupToken } from "../../server/util/setupToken.js";

beforeEach(() => resetSetupToken());

describe("setup token", () => {
    describe("generation", () => {
        it("returns the same token for the lifetime of the process", () => {
            assert.equal(getSetupToken(), getSetupToken());
        });

        it("issues a different token after a reset", () => {
            const first = getSetupToken();
            resetSetupToken();
            assert.notEqual(first, getSetupToken());
        });

        it("is long enough to be worth printing rather than guessing", () => {
            // 24 random bytes, hex encoded.
            assert.equal(getSetupToken().length, 48);
            assert.match(getSetupToken(), /^[0-9a-f]+$/);
        });
    });

    describe("matching", () => {
        it("accepts the active token", () => {
            assert.equal(matchesSetupToken(getSetupToken()), true);
        });

        it("rejects a different token of the same length", () => {
            const wrong = "f".repeat(getSetupToken().length);
            assert.equal(matchesSetupToken(wrong), getSetupToken() === wrong);
        });

        it("rejects a token that is merely a prefix", () => {
            assert.equal(matchesSetupToken(getSetupToken().slice(0, -1)), false);
        });

        it("rejects a token with anything appended", () => {
            assert.equal(matchesSetupToken(getSetupToken() + "0"), false);
        });

        // timingSafeEqual throws outright on a length mismatch, and Buffer.from
        // throws on a non-string, so every one of these has to be filtered out
        // before it reaches the comparison.
        it("rejects empty and non-string candidates without throwing", () => {
            for (const candidate of ["", null, undefined, 0, {}, [], true])
                assert.equal(matchesSetupToken(candidate), false, `${String(candidate)} must not match`);
        });

        it("rejects a stale token after a reset", () => {
            const first = getSetupToken();
            resetSetupToken();
            assert.equal(matchesSetupToken(first), false);
        });
    });
});
