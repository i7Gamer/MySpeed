import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import { LIBRE_DURATION_SECONDS } from "../../server/util/providers/registry.js";

/**
 * How long a LibreSpeed run measures for.
 *
 * The CLI was spawned with --duration=5 for a while, and upstream #694's
 * doubled upload readings are what a window that short looks like: TCP spends
 * the first seconds filling buffers at line-plus rate, and on a five-second
 * sample that spike is most of the average. librespeed-cli's own default is
 * fifteen, which is the tool author's accuracy/traffic trade-off - so the
 * value is pinned to that default, and pinned by name so shortening it again
 * is a decision someone has to write down, not a literal that drifts.
 */
describe("the librespeed measurement window", () => {
    const source = readSource("server/util/providers/registry.js");

    it("matches the CLI's own default", () => {
        assert.equal(LIBRE_DURATION_SECONDS, 15);
    });

    it("reaches the spawn through the named constant", () => {
        assert.match(source, /--duration=' \+ LIBRE_DURATION_SECONDS/);
    });

    it("keeps no hard-coded duration beside it", () => {
        assert.doesNotMatch(source, /--duration=\d/);
        assert.doesNotMatch(readSource("server/util/speedtest.js"), /--duration=/);
    });
});
