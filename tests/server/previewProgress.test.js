import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyOf, readSource } from "../helpers/source.js";
import { previewProgressSteps, PREVIEW_RUN_MS } from "../../server/tasks/speedtest.js";
import { PHASE_ORDER } from "../../server/util/providers/progress.js";

/**
 * The demo's run used to be a flat five-second sleep.
 *
 * The preview branch skips run(), and run() was the only caller of
 * setRunning(true) - so for the whole simulated test the status endpoint
 * answered {running: true, phase: null, startedAt: null}, and the instance
 * whose entire job is showing the interface showed a run that reported
 * nothing. The branch now latches the run the way a real one does and walks
 * the real phases while it pretends, so the bar the demo exists to show is on
 * the demo.
 */
describe("the march the demo bar makes", () => {
    const steps = previewProgressSteps();

    it("walks the real phases, in the order a run takes them", () => {
        const phases = [...new Set(steps.map((step) => step.phase))];

        assert.deepEqual(phases, PHASE_ORDER, "the demo invents phases no real run reports");
    });

    it("finishes each phase it enters", () => {
        for (const phase of PHASE_ORDER) {
            const last = steps.filter((step) => step.phase === phase).at(-1);

            assert.equal(last.progress, 1, `the bar abandons ${phase} part-way`);
        }
    });

    it("only ever moves forward", () => {
        for (const [at, step] of steps.entries()) {
            assert.ok(step.progress > 0 && step.progress <= 1);

            const previous = steps[at - 1];
            if (previous && previous.phase === step.phase)
                assert.ok(step.progress > previous.progress, "the bar moves backwards");
        }
    });

    // No phase reports a throughput the fake run never measured; the latency
    // phase of a real run does the same.
    it("claims no speed for a measurement that never happened", () => {
        for (const step of steps) assert.equal(step.speed, null);
    });

    it("spreads the steps across the whole pretended run", () => {
        assert.ok(steps.length > 0);
        assert.ok(PREVIEW_RUN_MS / steps.length >= 100,
            "the steps are so dense the simulation is busywork");
    });
});

/**
 * And the branch actually uses it. Read as source, because firing execute()
 * needs a database and a five-second wait - previewMode.test.js draws the same
 * line for the same file.
 */
describe("the preview branch", () => {
    const execute = bodyOf(readSource("server/tasks/speedtest.js"), "const execute = async");
    const preview = execute.slice(execute.indexOf('PREVIEW_MODE === "true"'), execute.indexOf("} else {"));

    it("latches the run before it pretends, without notifying the integrations", () => {
        assert.match(preview, /setRunning\(true,\s*false\)/,
            "the demo's run never sets the running state, so the status endpoint reports nothing");
    });

    it("walks the bar while it waits", () => {
        assert.match(preview, /await simulatePreviewRun\(\)/,
            "the pretended run is a flat sleep again");
    });
});
