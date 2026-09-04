import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FULL_DETAIL_POINTS } from "@/common/contexts/Preferences/constants";
import { MAX_CHART_POINTS } from "../../server/util/statistics.js";

/**
 * The client asks the statistics route for FULL_DETAIL_POINTS and renders that
 * number into a sentence; the route caps at MAX_CHART_POINTS. They were born
 * equal in one commit and have not moved since - and nothing said so, which is
 * how the retention ceiling drifted before it was pinned. Held to each other
 * the way the other server/client pairs are.
 */
describe("the full-resolution point count", () => {
    it("is the same number on both sides", () => {
        assert.equal(FULL_DETAIL_POINTS, MAX_CHART_POINTS,
            "the detail description promises a resolution the route does not deliver");
    });
});
