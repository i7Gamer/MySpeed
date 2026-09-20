import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {PROVIDER_BINARIES, PROVIDER_CATALOGUES} from
    "../../scripts/qualification/fixture.mjs";
import {WINDOWS_BASELINE_GUEST_FIXTURE_BUNDLE_CONSTANTS} from
    "../../scripts/qualification/windows-baseline-guest-fixture-bundle.mjs";
import {WINDOWS_BASELINE_GUEST_MATERIALIZER_CONSTANTS} from
    "../../scripts/qualification/windows-baseline-guest-materializer.mjs";
import {POST_RELEASE_BASELINE_INPUT_CONSTANTS} from
    "../../scripts/release/post-release-msi-baseline-input-preparation.mjs";

/*
 * Three consumers hard-code the Windows form of the fixture inventory: the guest bundle builder,
 * the guest materializer, and the MSI baseline input preparation. Nothing held them to what the
 * producer actually emits, so when ost-cli shipped with the OpenSpeedTest provider all three went
 * stale and stayed stale for a year - invisible because the only caller ran an older producer, so
 * the two halves never came from the same commit.
 *
 * Deriving the expectation from the producer's own exported sets is what makes the next addition
 * fail here, in a unit test, rather than inside a virtual machine forty minutes into a run.
 */
const EXPECTED = Object.freeze([
    ...PROVIDER_BINARIES.map(name => `bin/${name}.exe`),
    ...PROVIDER_CATALOGUES.map(name => `data/servers/${name}`)
].sort());

describe("fixture inventory parity", () => {
    it("every consumer expects exactly what the producer emits", () => {
        for (const [label, actual] of [
            ["guest fixture bundle", WINDOWS_BASELINE_GUEST_FIXTURE_BUNDLE_CONSTANTS.COMMON_FILES],
            /* The materializer exposes the common set as its reset inventory. */
            ["guest materializer", WINDOWS_BASELINE_GUEST_MATERIALIZER_CONSTANTS.RESET_FILES],
            ["MSI baseline inputs", POST_RELEASE_BASELINE_INPUT_CONSTANTS.FIXTURE_COMMON]
        ]) {
            assert.deepEqual([...actual].sort(), EXPECTED, label);
        }
    });

    /*
     * The producer suffixes binaries only on Windows, and the guest is always Windows. A catalogue
     * gaining a .exe, or a binary losing one, would leave the lists equal to each other and wrong
     * against the guest.
     */
    it("names every provider binary with the Windows suffix and no catalogue", () => {
        for (const name of EXPECTED.filter(value => value.startsWith("bin/"))) {
            assert.match(name, /^bin\/[a-z0-9-]+\.exe$/u, name);
        }
        for (const name of EXPECTED.filter(value => value.startsWith("data/"))) {
            assert.doesNotMatch(name, /\.exe$/u, name);
        }
        assert.equal(EXPECTED.filter(value => value.startsWith("bin/")).length,
            PROVIDER_BINARIES.length);
    });
});
