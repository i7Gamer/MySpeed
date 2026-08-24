import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseData, CLOUDFLARE } from "../../server/util/providers/parseData.js";
import { FAILED_TEST, isFailedTest } from "../../server/util/testOutcome.js";

/**
 * A cloudflare run that reported its blocks and nothing in them.
 *
 * The neighbouring case is already handled and its comment sits directly under
 * the branch this fixes: a run with no measurement blocks at all is a failure,
 * because answering zeros "counted toward the success total and pulled every
 * download, upload and ping average toward zero: a malfunction published as a
 * line delivering nothing".
 *
 * That fix tested for the blocks being *present*, not for them holding
 * anything. `latency_measurement: {}` and `speed_measurements: []` are both
 * truthy, so a run that measured nothing took the success path anyway and
 * directionSpeed answered a fabricated 0 for each direction - the same row of
 * zeros, recorded as a success, by the other door.
 *
 * The distinction that has to survive is between a direction that ran and moved
 * nothing, and a direction that never ran. The first is a real reading and the
 * one an outage looks like; only the second is a fabrication. `successes` is
 * what tells them apart, and directionSpeed already reads it.
 */
const withMeasurements = (speed_measurements, latency = {avg_latency_ms: 12}) =>
    ({latency_measurement: latency, speed_measurements, elapsed: 30000, metadata: {colo: "ZRH"}});

const ran = (test_type, median, payload_size = 1e7) =>
    ({test_type, payload_size, successes: 5, skipped: 0, median});

const skipped = (test_type, payload_size = 1e7) =>
    ({test_type, payload_size, successes: 0, skipped: 10, median: 0, max: 0});

describe("a run whose measurement blocks are empty", () => {
    it("is a failure rather than a line delivering nothing", () => {
        const parsed = parseData(CLOUDFLARE, withMeasurements([], {}));

        assert.equal(isFailedTest(parsed), true,
            "empty blocks still record a successful test of zero in both directions");
    });

    it("is a failure when only the speeds are empty", () => {
        const parsed = parseData(CLOUDFLARE, withMeasurements([]));

        assert.equal(isFailedTest(parsed), true);
    });

    /**
     * Entries that exist and were all skipped are the same thing said in more
     * words - which is the shape the CLI actually prints when it collected
     * nothing at a payload size.
     */
    it("is a failure when every entry was skipped", () => {
        const parsed = parseData(CLOUDFLARE,
            withMeasurements([skipped("Download"), skipped("Upload")]));

        assert.equal(isFailedTest(parsed), true);
    });

    // The identity is still worth keeping, exactly as the no-blocks case keeps
    // it: the edge that answered is true of the attempt even when nothing else is.
    it("keeps what the run did establish", () => {
        const parsed = parseData(CLOUDFLARE, withMeasurements([], {}));

        assert.equal(parsed.serverName, "ZRH");
    });
});

describe("a run that measured only one direction", () => {
    /**
     * A speedtest that measured one direction is not a speedtest with one
     * direction missing - both columns are NOT NULL and there is no sentinel for
     * an unmeasured throughput, because 0 is a real reading and cannot be
     * borrowed for it the way the latency column borrows it.
     */
    it("is a failure rather than half a result", () => {
        const parsed = parseData(CLOUDFLARE, withMeasurements([ran("Download", 100)]));

        assert.equal(isFailedTest(parsed), true, "an upload nobody measured was recorded as 0 Mbps");
    });

    it("is a failure the other way round too", () => {
        const parsed = parseData(CLOUDFLARE, withMeasurements([ran("Upload", 50)]));

        assert.equal(isFailedTest(parsed), true);
    });
});

/**
 * The property this must not break, and the reason a bare `=== 0` test would
 * have been the wrong fix.
 */
describe("a direction that ran and moved nothing", () => {
    it("keeps its measured zero", () => {
        const parsed = parseData(CLOUDFLARE,
            withMeasurements([ran("Download", 0), ran("Upload", 0)]));

        assert.equal(isFailedTest(parsed), false,
            "a line that genuinely delivered nothing was thrown away as a malfunction");
        assert.equal(parsed.download, 0);
        assert.equal(parsed.upload, 0);
    });

    it("is told apart from one that never ran", () => {
        const measured = parseData(CLOUDFLARE, withMeasurements([ran("Download", 0), ran("Upload", 0)]));
        const fabricated = parseData(CLOUDFLARE, withMeasurements([skipped("Download"), skipped("Upload")]));

        assert.equal(measured.download, 0);
        assert.equal(fabricated.download, FAILED_TEST);
    });
});

describe("an ordinary run", () => {
    it("is untouched", () => {
        const parsed = parseData(CLOUDFLARE,
            withMeasurements([ran("Download", 943.2), ran("Upload", 512.8)]));

        assert.equal(isFailedTest(parsed), false);
        assert.equal(parsed.download, 943.2);
        assert.equal(parsed.upload, 512.8);
        assert.equal(parsed.ping, 12);
    });

    /**
     * The latency sentinel stays as it was. Zero already means "nobody measured
     * this" for the ping column - testOutcome.js owns that convention and
     * isMeasuredLatency is its reader - so a run with real throughput and no
     * latency block is still a result, not a failure.
     */
    it("survives a latency block with nothing in it", () => {
        const parsed = parseData(CLOUDFLARE,
            withMeasurements([ran("Download", 100), ran("Upload", 50)], {}));

        assert.equal(isFailedTest(parsed), false, "a run that measured throughput was thrown away over its ping");
        assert.equal(parsed.ping, 0);
    });
});
