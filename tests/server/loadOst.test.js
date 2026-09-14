import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadFile, fileExists, selectBinary } from "../../server/util/providers/loadOst.js";

describe("the OpenSpeedTest loader", () => {
    const temporaryDirectories = [];

    afterEach(() => {
        for (const directory of temporaryDirectories.splice(0))
            fs.rmSync(directory, {recursive: true, force: true});
    });

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

    it("recognises only the platform's exact installed binary name", async () => {
        const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-ost-loader-"));
        temporaryDirectories.push(outputDir);

        assert.equal(await fileExists({platform: "linux", outputDir}), false);
        fs.writeFileSync(path.join(outputDir, "ost-cli.exe"), "synthetic fixture");
        assert.equal(await fileExists({platform: "linux", outputDir}), false);
        assert.equal(await fileExists({platform: "win32", outputDir}), true);
    });
});
