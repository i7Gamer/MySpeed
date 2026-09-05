import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { figureMeets, resolveLimits as serverLimits } from "../../server/util/targetLimits.js";
import { getIconBySpeed } from "../../client/src/common/utils/TestUtil.js";
import { resolveLimits as clientLimits } from "../../client/src/common/utils/TargetUtil.js";

/**
 * The server's target-met count and the client's colours are one verdict.
 *
 * The statistics count a test as having met its target when every figure it
 * measured earns the green grade the row paints it with - the same three
 * thresholds, the same floor to a whole percent, the same fallback from a
 * target's own optimal values to the instance-wide settings. Neither half
 * imports the other (the shared directory was reviewed and declined, see
 * TECH_DEBT.md), so this is what keeps the two from drifting: a test that
 * shows three green glyphs and is not counted, or is counted wearing an orange
 * one, fails here.
 */

// Every ratio around both boundaries, in whole and fractional percents, plus
// the far ends. The client floors the ratio, so a hair either side of the line
// is the case worth having.
const RATIOS = [0, 0.1, 0.29, 0.3, 0.5, 0.74, 0.7499, 0.75, 0.7501, 0.9, 1, 1.1, 1.29, 1.2999, 1.3, 1.3001, 1.5, 1.79, 1.8, 2, 5];
const OPTIMA = [1, 25, 100, 250.5, 1000];

const GREEN = "green";

describe("a speed the row paints green is a speed the count takes as met", () => {
    for (const optimum of OPTIMA) {
        it(`against an optimum of ${optimum}`, () => {
            for (const ratio of RATIOS) {
                const figure = optimum * ratio;

                assert.equal(figureMeets(figure, optimum, true), getIconBySpeed(figure, optimum, true) === GREEN,
                    `${figure} against ${optimum}`);
            }
        });
    }
});

describe("a latency the row paints green is a latency the count takes as met", () => {
    for (const optimum of OPTIMA) {
        it(`against an optimum of ${optimum}`, () => {
            for (const ratio of RATIOS) {
                const figure = optimum * ratio;

                assert.equal(figureMeets(figure, optimum, false), getIconBySpeed(figure, optimum, false) === GREEN,
                    `${figure} against ${optimum}`);
            }
        });
    }
});

/**
 * The fallback rule, over the shapes both halves are handed.
 *
 * The client keeps the strings the config carries and coerces at every
 * consumer; the server coerces once. So the comparison is numeric, through the
 * same refusal of an absent, empty or zero optimum the client's asTarget makes.
 */
const asTarget = (value) => {
    if (value === null || value === undefined || value === "") return null;

    const target = Number(value);
    return Number.isFinite(target) && target > 0 ? target : null;
};

const CONFIG = {ping: "25", download: "100", upload: "50"};

const TARGETS = [
    undefined,
    null,
    {optimalPing: 30, optimalDownload: 200, optimalUpload: 80},
    {optimalPing: null, optimalDownload: 200, optimalUpload: null},
    {optimalPing: "30", optimalDownload: "", optimalUpload: undefined},
    {optimalPing: 0, optimalDownload: -1, optimalUpload: "fast"}
];

describe("the two halves resolve the same limits", () => {
    for (const [index, target] of TARGETS.entries()) {
        it(`for target fixture ${index}`, () => {
            const client = clientLimits(target, CONFIG);
            const server = serverLimits(target, CONFIG);

            for (const metric of ["ping", "download", "upload"])
                assert.equal(server[metric], asTarget(client[metric]), `${metric} of fixture ${index}`);
        });
    }

    it("both fall back to nothing on an unloaded config", () => {
        for (const metric of ["ping", "download", "upload"]) {
            assert.equal(asTarget(clientLimits(undefined)[metric]), null);
            assert.equal(serverLimits(undefined)[metric], null);
        }
    });
});
