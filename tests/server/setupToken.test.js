import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    ANNOUNCE_COOLDOWN_MS, announceSetupToken, getSetupToken, matchesSetupToken, resetSetupToken
} from "../../server/util/setupToken.js";

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

    /**
     * The banner used to print at most once per process, which made a lost log
     * line unrecoverable: the only way to see the token again was a restart -
     * which mints a different one. It reprints on a cooldown now. The cooldown
     * is what keeps that safe: announceSetupToken is reachable by any
     * unauthenticated caller a 401 turns away, so an unbounded reprint would be
     * a way to fill the log from outside.
     */
    describe("announcement", () => {
        const banners = (act) => {
            const lines = [];
            const original = console.log;
            console.log = (...parts) => lines.push(parts.join(" "));

            try {
                act();
            } finally {
                console.log = original;
            }

            return lines.filter((line) => line.includes("Setup token:"));
        };

        const NOW = 1_700_000_000_000;

        it("prints the token when asked", () => {
            const printed = banners(() => announceSetupToken(NOW));

            assert.equal(printed.length, 1);
            assert.ok(printed[0].includes(getSetupToken()));
        });

        it("stays quiet inside the cooldown", () => {
            const printed = banners(() => {
                announceSetupToken(NOW);
                announceSetupToken(NOW + ANNOUNCE_COOLDOWN_MS - 1);
            });

            assert.equal(printed.length, 1);
        });

        it("prints again once the cooldown has passed", () => {
            const printed = banners(() => {
                announceSetupToken(NOW);
                announceSetupToken(NOW + ANNOUNCE_COOLDOWN_MS);
            });

            assert.equal(printed.length, 2);
        });

        // A reprint is a reminder, not a rotation: the operator reading the log
        // a minute late must find the token that is still being asked for.
        it("announces the same token again rather than a new one", () => {
            const printed = banners(() => {
                announceSetupToken(NOW);
                announceSetupToken(NOW + ANNOUNCE_COOLDOWN_MS);
            });

            assert.equal(printed[0], printed[1]);
        });

        it("speaks again after a reset, whatever the clock says", () => {
            const printed = banners(() => {
                announceSetupToken(NOW);
                resetSetupToken();
                announceSetupToken(NOW + 1);
            });

            assert.equal(printed.length, 2);
        });

        /**
         * The token is reusable for the whole process lifetime -
         * matchesSetupToken consumes nothing - and the banner used to call it
         * "one-time", which told a retyping operator their token was already
         * spent. The banner has to say what is true: it holds until a restart.
         */
        it("does not call the token one-time", () => {
            const lines = [];
            const original = console.log;
            console.log = (...parts) => lines.push(parts.join(" "));

            try {
                announceSetupToken(NOW);
            } finally {
                console.log = original;
            }

            const banner = lines.join("\n");
            assert.doesNotMatch(banner, /one-time/i);
            assert.match(banner, /until the next restart/i);
        });
    });
});
