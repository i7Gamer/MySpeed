import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyOf, readSource } from "../helpers/source.js";
import { runsOf, SINGLE_RUN } from "../../server/util/speedtest.js";
import { REGISTRY } from "../../server/util/providers/registry.js";

/**
 * A test made of more than one invocation of its CLI.
 *
 * Every provider but iperf3 measures both directions in one go and says
 * nothing about runs, which has to keep behaving exactly as it did - one
 * spawn, one parsed result, spread flat for the parser. iperf3 measures one
 * direction per invocation, so it declares two.
 */
describe("the runs a test is made of", () => {
    it("is one unnamed run for a provider that declares none", () => {
        assert.deepEqual(runsOf({}), SINGLE_RUN);
        assert.deepEqual(SINGLE_RUN, [{key: null, args: []}]);
    });

    it("is what the provider declares when it declares any", () => {
        const runs = [{key: "download", args: ["-R"]}, {key: "upload", args: []}];

        assert.deepEqual(runsOf({runs}), runs);
    });

    // The three that shipped before this existed must still take the flat
    // path, or their parsers are handed a shape they have never seen.
    it("leaves the providers that measure both directions at once alone", () => {
        for (const [id, provider] of Object.entries(REGISTRY))
            if (!provider.runs) assert.deepEqual(runsOf(provider), SINGLE_RUN, `${id} grew runs`);
    });
});

describe("how the runner performs them", () => {
    const run = bodyOf(readSource("server/util/speedtest.js"), "export default async (mode");

    /**
     * One at a time, which is load-bearing twice over: the shutdown reaches
     * the run in flight through a single tracked child, and two transfers
     * measured at once would contend for the very line being measured.
     */
    it("runs them one after another", () => {
        assert.match(run, /for \(const run of runs\) results\[run\.key\] = await runOnce\(/,
            "the runs are started together, so they contend for the line and the tracker holds one of two");
    });

    // Each invocation gets its own child, timers and accumulators; what it
    // must not get its own of is the temporary server file, which the test as
    // a whole owns.
    it("gives each invocation its own child and timers", () => {
        const once = bodyOf(run, "const runOnce = async");

        assert.match(once, /trackProcess\(spawn\(/);
        assert.match(once, /const timeout = setTimeout\(/);
        assert.doesNotMatch(once, /removeTemporaryServer\(/,
            "the first of several runs takes away the file the rest still need");
    });

    /**
     * The shape handed back. A provider with one unnamed run is answered as it
     * always was - the result spread flat - because every existing parser
     * reads it that way; several runs arrive keyed, for a parser that merges
     * them.
     */
    it("answers a single run flat and several of them keyed", () => {
        assert.match(run, /\{\.\.\.results\[null\], elapsed\}/,
            "a one-run provider's result changed shape, which every existing parser reads");
        // The latency and the address travel with the runs because neither is
        // in them: iperf3 measures no latency at all, and the address it
        // dialled belongs to the start event rather than the end one a parser
        // is handed.
        assert.match(run, /\{runs: results, latency, endpoint, elapsed\}/);
    });

    /**
     * The direction is passed down because the CLI's own records do not name
     * one: an iperf3 interval describes whichever direction this invocation was
     * started for, and only the caller knows which.
     *
     * The length of the run travels with it for the same reason - the records
     * state no fraction either, so the bar divides the interval clock by it, and
     * a target measuring for a minute against the ten-second default fills its
     * bar in the first sixth and then sits still.
     */
    it("tells the progress reader which direction is running, and for how long", () => {
        assert.match(run, /parseProgressLine\(mode, line\.trim\(\), phase, [A-Za-z][\w.]*\)/);
    });
});
