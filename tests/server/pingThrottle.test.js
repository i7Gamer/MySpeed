import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyIn, readSource } from "../helpers/source.js";

/**
 * The ping throttle's window is the integration's interval less a tolerance,
 * so a minute tick that lands a few seconds early is not skipped as a
 * duplicate. Both figures were inline arithmetic - `interval * 60 * 1000 -
 * 30 * 1000` - which reads as a puzzle rather than a policy.
 */
describe("the ping throttle's window", () => {
    const source = readSource("server/controller/integrations.js");
    const throttle = bodyIn("server/controller/integrations.js", "const shouldThrottlePing =");

    it("measures the interval in named minutes", () => {
        assert.match(source, /^const MS_PER_MINUTE = 60_000;/m);
        assert.match(throttle, /interval \* MS_PER_MINUTE/);
    });

    it("names the tolerance an early tick is allowed", () => {
        assert.match(source, /^const PING_THROTTLE_TOLERANCE_MS = 30_000;/m);
        assert.match(throttle, /- PING_THROTTLE_TOLERANCE_MS/);
    });

    it("keeps no inline millisecond arithmetic", () => {
        assert.doesNotMatch(throttle, /60 \* 1000|30 \* 1000/);
    });
});
