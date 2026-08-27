import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyOf, readSource } from "../helpers/source.js";
import { welcomeSeed } from "@/common/components/WelcomeDialog/welcomeStep.js";

const welcomeSource = readSource("client/src/common/components/WelcomeDialog/WelcomeDialog.jsx");

/**
 * What the wizard shows the moment it opens.
 *
 * Two histories meet here. The thresholds half: the initialiser parsed the
 * three thresholds with parseInt, and finish() writes all three back
 * unconditionally - so the wizard silently rewrote any fractional threshold it
 * was merely clicked past. The rest: only the thresholds were ever re-seeded
 * on open, and the component never unmounts - TargetsContext renders it
 * unconditionally and DialogContext unmounts only a dialog's children - so the
 * step, the provider and the endpoint survived every close, and the next
 * instance that needed setting up got the previous one's answers with the
 * provider step already skipped.
 *
 * Executed rather than scanned, because the two mutations that matter here -
 * a swapped pair of setters, and a callback whose seed comes from somewhere
 * other than welcomeSeed - are invisible to a set<Name> text scan. welcomeSeed
 * arrives through the parameter list because node cannot import a .jsx file,
 * so the callback's own import is out of reach.
 */
const openedWith = (config) => {
    const callback = bodyOf(welcomeSource, "useSyncOnOpen(open, () => {");
    const shown = {};
    const record = (key) => (value) => { shown[key] = value; };

    new Function("config", "welcomeSeed", "setStep", "setProvider", "setEndpoint", "setPing",
        "setDownload", "setUpload", "setAnimating", `(() => ${callback})();`)(
        config, welcomeSeed,
        record("step"), record("provider"), record("endpoint"),
        record("ping"), record("download"), record("upload"), record("animating"));

    return shown;
};

// Narrow on purpose, so a parseFloat regression reports itself as the number
// it mangled rather than as a six-key shape mismatch.
const thresholdsOf = (config) => {
    const {ping, download, upload} = openedWith(config);
    return {ping, download, upload};
};

// The six answers a reopened wizard shows; animating is a transition flag, not
// an answer, and is asserted on its own.
const answersShown = (config) => {
    const {animating, ...answers} = openedWith(config);
    return answers;
};

describe("the wizard reading the stored thresholds", () => {
    it("keeps a fraction instead of flooring it", () => {
        assert.deepEqual(thresholdsOf({ping: "25.9", download: "123.45", upload: "50.5"}),
            {ping: 25.9, download: 123.45, upload: 50.5},
            "a threshold the wizard is clicked past is written back mangled");
    });

    // The recommended ping on a fast line - the value the config controller
    // now stores whole, and the one an integer parse reads as nothing at all.
    it("keeps a sub-millisecond ping", () => {
        assert.equal(thresholdsOf({ping: "0.4"}).ping, 0.4,
            "the wizard writes back the threshold no latency is ever under");
    });

    it("reads the bare-dot spelling the threshold rule accepts", () => {
        assert.equal(thresholdsOf({ping: ".5"}).ping, 0.5);
    });

    // The original contract: a config that has not been fetched yet seeds
    // zeroes rather than NaN, and a stored zero stays a zero.
    it("still zeroes what is absent", () => {
        assert.deepEqual(thresholdsOf({}), {ping: 0, download: 0, upload: 0});
        assert.equal(thresholdsOf({ping: "0"}).ping, 0);
    });
});

describe("the wizard opening on a second node", () => {
    // Every value distinct, so no two setters can be exchanged unseen.
    it("starts over rather than resuming the previous instance's setup", () => {
        assert.deepEqual(answersShown({ping: "25", download: "100", upload: "50"}),
            {step: 1, provider: "ookla", endpoint: "", ping: 25, download: 100, upload: 50},
            "the next node is set up holding the previous node's answers");
    });

    it("shows exactly what the seed states", () => {
        const config = {ping: "12.5", download: "940.5", upload: "50.25"};

        assert.deepEqual(answersShown(config), welcomeSeed(config));
    });

    // A wizard closed mid-slide must not reopen mid-slide.
    it("opens still, not animating", () => {
        assert.equal(openedWith({}).animating, false);
    });

    /**
     * The guarantee execution cannot give: a hook added later that the
     * callback was never told about. Every useState's setter has to appear in
     * the reopened wizard's seed - except setSaving, the double-submit lock,
     * which continueStep's own finally clears and which seeding on open would
     * only race.
     */
    it("seeds every answer the component holds", () => {
        const callback = bodyOf(welcomeSource, "useSyncOnOpen(open, () => {");
        const setters = [...welcomeSource.matchAll(/const \[\w+, (set\w+)] = useState\(/g)]
            .map((match) => match[1])
            .filter((name) => name !== "setSaving");

        assert.ok(setters.length >= 6, `only ${setters.length} hooks were found - the sweep went blind`);
        for (const setter of setters)
            assert.match(callback, new RegExp(`\\b${setter}\\(`),
                `${setter} still carries the previous attempt into the reopened wizard`);
    });

    // The reset is keyed on open because the component never unmounts. If it
    // ever does unmount between opens, the seed becomes dead code and this
    // whole file is asserting the wrong mechanism.
    it("is mounted for the life of the provider, which is why the seed exists", () => {
        const context = readSource("client/src/common/contexts/Targets/TargetsContext.jsx");

        assert.match(context, /<WelcomeDialog\s+open=/,
            "the wizard is no longer rendered unconditionally");
        assert.doesNotMatch(context, /\{\s*welcomeShown\s*&&\s*<WelcomeDialog/,
            "the wizard unmounts on close now, so the reset below is dead code");
    });
});

describe("the seed itself", () => {
    it("states the whole first-open answer", () => {
        assert.deepEqual(welcomeSeed({}),
            {step: 1, provider: "ookla", endpoint: "", ping: 0, download: 0, upload: 0});
    });
});
