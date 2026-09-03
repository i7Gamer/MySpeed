import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { statusScope } from "../../server/routes/speedtests.js";

/**
 * Whose rows GET /speedtests/status speaks for.
 *
 * alertingScope answers the alerting question and its two empty answers mean
 * different things there. This is the reading of that scope the status body
 * needs, and the only place the two questions part company: the keep-alive
 * asks whether anybody should be paged, the dashboard asks what the instance
 * last measured.
 */
describe("statusScope", () => {
    it("keeps a scope that names targets", () => {
        assert.deepEqual(statusScope([1, 3]), [1, 3]);
    });

    it("stays instance-wide when no target exists", () => {
        assert.equal(statusScope(null), null);
    });

    /**
     * The regression: an operator with targets who switched alerts off on all
     * of them kept a dashboard that read as an instance which had never
     * tested, while the rounds kept running and the history kept filling.
     */
    it("falls back to the instance when targets exist and none alert", () => {
        assert.equal(statusScope([]), null,
            "an instance whose targets all opted out lost its last test");
    });
});
