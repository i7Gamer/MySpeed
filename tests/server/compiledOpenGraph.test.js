import {after, before, describe, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {generateThirdPartyNotices} from "../../scripts/generate-third-party-notices.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BUN_BINARY = process.env.MYSPEED_BUN_BINARY;
const COMPILED_RENDER_TIMEOUT_MS = 120_000;
const WINDOWS_TEST_VERSION = "1.6.0.1";
const BUILD_INPUTS = ["package.json", "bun.lock", "server", "scripts", "node_modules", "build"];
const PROBE_SOURCE = path.join(ROOT, "tests", "fixtures", "compiledOpenGraphProbe.mjs");

describe("the compiled production OpenGraph renderer", {skip: !BUN_BINARY}, () => {
    let taskDirectory;
    let snapshot;
    let unavailableSnapshot;
    let runtime;

    before(() => {
        taskDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-compiled-opengraph-"));
        snapshot = path.join(taskDirectory, "snapshot");
        unavailableSnapshot = path.join(taskDirectory, "snapshot.unavailable");
        runtime = path.join(taskDirectory, "runtime");
        fs.mkdirSync(path.join(snapshot, "tests", "fixtures"), {recursive: true});
        fs.mkdirSync(path.join(runtime, "data"), {recursive: true});

        for (const input of BUILD_INPUTS)
            fs.cpSync(path.join(ROOT, input), path.join(snapshot, input), {recursive: true});
        fs.copyFileSync(PROBE_SOURCE, path.join(snapshot, "tests", "fixtures", "compiledOpenGraphProbe.mjs"));
        generateThirdPartyNotices({
            root: snapshot,
            output: path.join(snapshot, "build", "third-party-notices.txt"),
        });
    });

    after(() => {
        if (fs.existsSync(unavailableSnapshot) && !fs.existsSync(snapshot))
            fs.renameSync(unavailableSnapshot, snapshot);
        fs.rmSync(taskDirectory, {recursive: true, force: true});
    });

    it("renders a real 1200x600 PNG after its complete build tree is unavailable", () => {
        const executable = path.join(runtime, process.platform === "win32" ? "renderer.exe" : "renderer");
        const target = process.platform === "win32"
            ? `bun-windows-${process.arch === "arm64" ? "arm64" : "x64"}`
            : `bun-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
        const environment = {
            DB_TYPE: "sqlite",
            NODE_ENV: "production",
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
            TZ: "UTC",
            WINDIR: process.env.WINDIR,
        };
        const embedded = spawnSync(process.execPath, ["scripts/generate-client-embed.js"], {
            cwd: snapshot,
            encoding: "utf8",
            env: environment,
            timeout: COMPILED_RENDER_TIMEOUT_MS,
        });
        assert.equal(embedded.status, 0, `${embedded.stdout}\n${embedded.stderr}`);

        const buildArguments = [
            "scripts/build-binary.mjs",
            "--target", target,
            "--outfile", executable,
            "--entrypoint", "tests/fixtures/compiledOpenGraphProbe.mjs",
        ];
        if (process.platform === "win32")
            buildArguments.push("--windows-version", WINDOWS_TEST_VERSION);

        const built = spawnSync(BUN_BINARY, buildArguments, {
            cwd: snapshot,
            encoding: "utf8",
            env: environment,
            timeout: COMPILED_RENDER_TIMEOUT_MS,
        });

        assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
        fs.renameSync(snapshot, unavailableSnapshot);

        const rendered = spawnSync(executable, [], {
            cwd: runtime,
            encoding: "utf8",
            env: environment,
            timeout: COMPILED_RENDER_TIMEOUT_MS,
        });

        assert.equal(rendered.status, 0, `${rendered.stdout}\n${rendered.stderr}`);
        assert.match(rendered.stdout, /opengraph=ok bytes=\d+/);
        assert.doesNotMatch(`${rendered.stdout}\n${rendered.stderr}`, /hb\.wasm|WebAssembly\.RuntimeError/);
    });
});
