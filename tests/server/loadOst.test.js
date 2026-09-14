import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { forgetDownloadHolds, heldDownload } from "../../server/util/providers/downloadHold.js";
import { downloadFile, load, selectBinary } from "../../server/util/providers/loadOst.js";

describe("the OpenSpeedTest loader", () => {
    beforeEach(() => forgetDownloadHolds());

    it("selects each published platform and refuses an unsupported one", () => {
        assert.equal(selectBinary({platform: "linux", arch: "x64"}).suffix,
            "ost-cli_linux_amd64.tar.gz");
        assert.throws(() => selectBinary({platform: "linux", arch: "ia32"}), /linux-ia32.*not supported/i);
    });

    it("forwards the exact release URL, digest and output identity", async () => {
        let call;
        const download = async (...args) => { call = args; };

        await downloadFile({platform: "win32", arch: "arm64", outputDir: "C:\\safe-bin", download});

        assert.equal(call[0],
            "https://github.com/ajthom90/ost-cli/releases/download/v0.1.1/ost-cli_windows_arm64.zip");
        assert.deepEqual(call[1], {
            suffix: "ost-cli_windows_arm64.zip", outputDir: "C:\\safe-bin",
            binaryRegex: /(^|[\\/])ost-cli(?:\.exe)?$/,
            outputName: "ost-cli.exe",
            sha256: "47c1636e862bb13598ffeb58bcf26d36f2cce5187c164f933ca6f9c396022d30"
        });
    });

    it("does not consult the hold or downloader when a manual binary exists", async () => {
        let held = 0;
        let downloaded = 0;

        await load({exists: async () => true, download: async () => { downloaded++; },
            hold: async () => { held++; }});

        assert.equal(held, 0);
        assert.equal(downloaded, 0);
    });

    it("replays a held failure without downloading again", async () => {
        let downloads = 0;
        const options = {exists: async () => false, download: async () => {
            downloads++;
            throw new Error("synthetic digest mismatch");
        }, hold: heldDownload};

        await assert.rejects(() => load(options), /digest mismatch/);
        await assert.rejects(() => load(options), /digest mismatch/);
        assert.equal(downloads, 1);
    });
});
