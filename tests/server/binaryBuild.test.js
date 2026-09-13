import {describe, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
    assertCompatibleHarfBuzz,
    assertQualifiedBunRuntime,
    buildBinary,
    checkInstalledHarfBuzz,
    createBuildOptions,
    createHarfBuzzPlugin,
    parseBuildArguments,
    QUALIFIED_BUN_VERSION,
} from "../../scripts/build-binary.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENTRYPOINT = path.join(ROOT, "server", "index.js");
const ADAPTER = path.join(ROOT, "scripts", "binary", "embedded-harfbuzz.mjs");
const EXTERNALS = ["pg", "pg-hstore"];

const compatibleProject = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-binary-options-"));
    const writePackage = (directory, contents) => {
        fs.mkdirSync(directory, {recursive: true});
        fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(contents));
    };

    writePackage(root, {dependencies: {harfbuzzjs: "0.10.0"}});
    writePackage(path.join(root, "node_modules", "satori"), {dependencies: {harfbuzzjs: "0.10.0"}});
    writePackage(path.join(root, "node_modules", "harfbuzzjs"), {version: "0.10.0"});
    return root;
};

describe("standalone binary build arguments", () => {
    it("requires an output path", () => {
        assert.throws(() => parseBuildArguments([]), /--outfile/);
    });

    it("accepts the target, output and Windows version used by release builds", () => {
        assert.deepEqual(parseBuildArguments([
            "--target", "bun-windows-x64",
            "--outfile", "artifacts/MySpeed.exe",
            "--windows-version", "1.7.0.42",
        ]), {
            target: "bun-windows-x64",
            outfile: "artifacts/MySpeed.exe",
            windowsVersion: "1.7.0.42",
            entrypoint: "server/index.js",
        });
    });

    it("rejects unsupported arguments and incomplete pairs", () => {
        assert.throws(() => parseBuildArguments(["--outfile"]), /value/);
        assert.throws(() => parseBuildArguments(["--outfile", "MySpeed", "--surprise", "yes"]),
            /Unsupported/);
    });

    it("rejects Windows metadata for a non-Windows target", () => {
        assert.throws(() => parseBuildArguments([
            "--target", "bun-linux-x64",
            "--outfile", "MySpeed",
            "--windows-version", "1.7.0.42",
        ]), /Windows version/);
    });
});

describe("standalone binary compiler runtime", () => {
    it("accepts only the exact Bun runtime qualified for release artifacts", () => {
        assert.doesNotThrow(() => assertQualifiedBunRuntime(QUALIFIED_BUN_VERSION));
        assert.throws(() => assertQualifiedBunRuntime("1.4.1"), /requires Bun 1\.4\.2.*received 1\.4\.1/);
        assert.throws(() => assertQualifiedBunRuntime("1.4.3"), /requires Bun 1\.4\.2.*received 1\.4\.3/);
        assert.throws(() => assertQualifiedBunRuntime(undefined), /requires Bun 1\.4\.2.*non-Bun runtime/);
    });
});

describe("standalone binary build options", () => {
    it("preserves the production entrypoint, package metadata and external drivers", () => {
        const options = createBuildOptions({
            root: ROOT,
            entrypoint: ENTRYPOINT,
            outfile: "artifacts/MySpeed",
            target: "bun-linux-x64",
            adapterPath: ADAPTER,
        });

        assert.deepEqual(options.entrypoints, [ENTRYPOINT]);
        assert.deepEqual(options.external, EXTERNALS);
        assert.deepEqual(options.compile, {
            autoloadPackageJson: true,
            target: "bun-linux-x64",
            outfile: path.resolve(ROOT, "artifacts/MySpeed"),
        });
        assert.equal(options.plugins.length, 1);
    });

    it("passes Windows resource metadata without adding it to other targets", () => {
        const options = createBuildOptions({
            root: ROOT,
            entrypoint: ENTRYPOINT,
            outfile: "MySpeed.exe",
            target: "bun-windows-x64",
            windowsVersion: "1.7.0.42",
            adapterPath: ADAPTER,
        });

        assert.deepEqual(options.compile.windows, {version: "1.7.0.42"});
    });
});

describe("the build-only HarfBuzz replacement", () => {
    it("resolves only the package root to the adapter", () => {
        let registration;
        createHarfBuzzPlugin(ADAPTER).setup({
            onResolve(options, callback) {
                registration = {options, callback};
            },
        });

        assert.equal(registration.options.filter.test("harfbuzzjs"), true);
        assert.equal(registration.options.filter.test("harfbuzzjs/hb.js"), false);
        assert.deepEqual(registration.callback(), {path: ADAPTER});
    });

    it("accepts only the HarfBuzz version Satori declares", () => {
        assert.doesNotThrow(() => assertCompatibleHarfBuzz({
            installedVersion: "0.10.0",
            satoriDependency: "0.10.0",
            directDependency: "0.10.0",
        }));
        assert.throws(() => assertCompatibleHarfBuzz({
            installedVersion: "0.10.1",
            satoriDependency: "0.10.0",
            directDependency: "0.10.1",
        }), /Satori/);
        assert.throws(() => assertCompatibleHarfBuzz({
            installedVersion: "0.10.0",
            satoriDependency: "0.10.0",
            directDependency: undefined,
        }), /direct dependency/);
    });

    it("checks the installed graph before handing semantic options to Bun", async () => {
        const root = compatibleProject();
        let received;
        try {
            assert.doesNotThrow(() => checkInstalledHarfBuzz(root));
            const result = await buildBinary({root, entrypoint: "entry.js", outfile: "binary"},
                async (options) => {
                    received = options;
                    return {success: true, logs: []};
                }, QUALIFIED_BUN_VERSION);

            assert.equal(result.success, true);
            assert.deepEqual(received.entrypoints, [path.join(root, "entry.js")]);
        } finally {
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    it("fails the command when Bun reports a compile error", async () => {
        const root = compatibleProject();
        try {
            await assert.rejects(() => buildBinary({root, entrypoint: "entry.js", outfile: "binary"},
                async () => ({success: false, logs: []}), QUALIFIED_BUN_VERSION), /compilation failed/);
        } finally {
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    it("rejects an unqualified runtime before invoking the compiler", async () => {
        let invoked = false;
        await assert.rejects(() => buildBinary({root: ROOT, outfile: "binary"}, async () => {
            invoked = true;
            return {success: true, logs: []};
        }, "1.4.1"), /requires Bun 1\.4\.2/);
        assert.equal(invoked, false);
    });
});
