import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { missingInterfaceMessage } from "../../server/util/speedtest.js";

/**
 * Regression: when the configured interface was not among the detected ones -
 * detection needs the network, and a fresh install may have none - the run
 * carried `undefined` into the CLI arguments. Cloudflare threw a TypeError on
 * `interfaceIp.includes(':')`, Ookla on Windows and librespeed were handed the
 * literal `--ip=undefined`, and the stored failure named none of it.
 */
describe("missingInterfaceMessage", () => {
    it("says nothing while the interface has an address", () => {
        for (const mode of ["ookla", "libre", "cloudflare"])
            assert.equal(missingInterfaceMessage(mode, "linux", "eth0", "192.168.1.2"), null);
    });

    it("names the configured interface when it has no address", () => {
        for (const mode of ["libre", "cloudflare"]) {
            const message = missingInterfaceMessage(mode, "linux", "eth7", undefined);

            assert.equal(typeof message, "string", `${mode} ran with an unusable interface`);
            assert.match(message, /eth7/);
            assert.match(message, /interface/i);
        }
    });

    it("guards ookla on windows, which binds by address", () => {
        assert.match(missingInterfaceMessage("ookla", "win32", "Ethernet", undefined), /Ethernet/);
    });

    // Everywhere but Windows the Ookla CLI binds by interface *name*, which can
    // be perfectly usable even when the address probe came up empty - so that
    // one combination keeps running.
    it("lets ookla elsewhere bind by name", () => {
        assert.equal(missingInterfaceMessage("ookla", "linux", "eth0", undefined), null);
    });
});
