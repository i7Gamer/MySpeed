import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

const welcomeSource = readSource("client/src/common/components/WelcomeDialog/WelcomeDialog.jsx");

/**
 * What the wizard reads back out of the stored configuration.
 *
 * The initialiser parsed the three thresholds with parseInt, and finish()
 * writes all three back unconditionally - so the wizard silently rewrote any
 * fractional threshold it was merely clicked past: "25.9" went back as 25,
 * and "0.4" - the recommended ping on a fibre line, storable since the
 * config controller stopped cutting pings at the dot - went back as 0, a
 * threshold no latency is ever under. The wizard opens by itself while the
 * provider is unset, which is exactly when someone is setting thresholds for
 * the first time.
 *
 * Extracted and run the way welcomeFinish.test.js runs finish(): what was
 * wrong is what this callback does with one config, and that is only
 * observable by handing it one.
 */
const blockEnd = (source, from) => {
    let depth = 0;

    for (let index = from; index < source.length; index++) {
        if (source[index] === "{") depth++;
        else if (source[index] === "}" && --depth === 0) return index;
    }

    assert.fail("a block is never closed");
};

const seededWith = (config) => {
    const start = welcomeSource.indexOf("useSyncOnOpen(open, () => {");
    assert.notEqual(start, -1, "the wizard no longer seeds its fields when it opens");

    const body = welcomeSource.slice(welcomeSource.indexOf("{", welcomeSource.indexOf("=>", start)));
    const callback = body.slice(0, blockEnd(body, 0) + 1);

    const seeded = {};
    new Function("config", "setPing", "setDownload", "setUpload", `(() => ${callback})();`)(
        config,
        (value) => { seeded.ping = value; },
        (value) => { seeded.download = value; },
        (value) => { seeded.upload = value; });

    return seeded;
};

describe("the wizard reading the stored thresholds", () => {
    it("keeps a fraction instead of flooring it", () => {
        assert.deepEqual(seededWith({ping: "25.9", download: "123.45", upload: "50.5"}),
            {ping: 25.9, download: 123.45, upload: 50.5},
            "a threshold the wizard is clicked past is written back mangled");
    });

    // The recommended ping on a fast line - the value the config controller
    // now stores whole, and the one an integer parse reads as nothing at all.
    it("keeps a sub-millisecond ping", () => {
        assert.equal(seededWith({ping: "0.4"}).ping, 0.4,
            "the wizard writes back the threshold no latency is ever under");
    });

    it("reads the bare-dot spelling the threshold rule accepts", () => {
        assert.equal(seededWith({ping: ".5"}).ping, 0.5);
    });

    // The original contract: a config that has not been fetched yet seeds
    // zeroes rather than NaN, and a stored zero stays a zero.
    it("still zeroes what is absent", () => {
        assert.deepEqual(seededWith({}), {ping: 0, download: 0, upload: 0});
        assert.equal(seededWith({ping: "0"}).ping, 0);
    });
});
