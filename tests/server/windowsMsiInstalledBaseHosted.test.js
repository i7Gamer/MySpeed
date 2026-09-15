import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {inspectHostedInstalledBaseFile, prepareHostedInstalledBaseOperations} from
    "../../scripts/qualification/windows-msi-installed-base-hosted.mjs";

const NONCE = "0123456789abcdef0123456789abcdef";
const HASH = "a".repeat(64);
const HELPER_HASH = "b".repeat(64);
const NODE_HASH = "c".repeat(64);
const ROOT = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${NONCE}`;
const PORTABLE = `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}`;
const CLOSURE = `/home/runner/work/_temp/myspeed-msi-closure-${NONCE}`;
const STAGE2_CLOSURE = `/home/runner/work/_temp/myspeed-stage2-closure-${NONCE}`;
const HELPER_SOURCE = `${CLOSURE}/scripts/qualification/windows-msi-installed-base-seal-helper.mjs`;
const HELPER_STAGED = `${PORTABLE}/windows-msi-installed-base-seal-helper.mjs`;
const NODE = "/opt/hostedtoolcache/node/22.19.0/x64/bin/node";
const NODE_STAGED = `${PORTABLE}/node-v22.19.0`;
const QEMU_IMG = `${PORTABLE}/usr/bin/qemu-img`;
const LOADER = `${PORTABLE}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`;

function context() {
    return {schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: "b".repeat(40), eventSha: "c".repeat(40),
        runId: "34849306292", runAttempt: "1", nonce: NONCE, environment: {GITHUB_ACTIONS: "true", CI: "true",
            RUNNER_OS: "Linux", RUNNER_ARCH: "X64", RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24",
            ImageVersion: "20260907.300.1"}};
}

function paths() {
    return {root: ROOT, packageRoot: `${ROOT}/packages`, portableRoot: PORTABLE, probeRoot: `${ROOT}/probes`,
        windowsIso: `${ROOT}/windows.iso`, installWim: `${ROOT}/install.wim`, seedIso: `${ROOT}/seed.iso`,
        outputDisk: `${ROOT}/output.img`, systemDisk: `${ROOT}/system.qcow2`, ovmfVars: `${ROOT}/OVMF_VARS.fd`,
        serialLog: `${ROOT}/serial.log`, qemuPid: `${ROOT}/qemu.pid`};
}

const ownership = (root = true, mode = "555") => ({uid: root ? "0" : "1001", gid: root ? "0" : "1001", mode,
    ordinaryUserWritable: !root});
const identity = (target, sha256 = HASH, root = true, mode = "555") => ({path: target, kind: "file", dev: "8",
    ino: "1234", bytes: "4096", sha256, ownership: ownership(root, mode)});
const successful = stdout => ({process: {exitCode: 0, signal: null, timedOut: false, stdoutOverflow: false,
    stderrOverflow: false, cleanupProven: true, errorObserved: false}, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0)});

function environment() {
    return {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
        RUNNER_ENVIRONMENT: "github-hosted", GITHUB_REPOSITORY: context().repository, GITHUB_SHA: context().eventSha,
        MYSPEED_SOURCE_SHA: context().sourceSha,
        GITHUB_RUN_ID: context().runId, GITHUB_RUN_ATTEMPT: context().runAttempt, ImageOS: "ubuntu24",
        ImageVersion: context().environment.ImageVersion};
}

function stage2Result() {
    const tool = (target, sha256, invocation = false) => ({path: target, bytes: "4096", sha256,
        ownership: ownership(), ...(invocation ? {invocationPath: target} : {})});
    return {toolchain: {qemuImg: tool(QEMU_IMG, "e".repeat(64), true),
        runtime: {loader: tool(LOADER, "f".repeat(64)), libraryPath: [`${PORTABLE}/usr/lib/x86_64-linux-gnu`,
            `${PORTABLE}/usr/lib/7zip`]}}};
}

describe("hosted installed-base sealing operations", () => {
    it("rejects an opened descriptor that resolves to a different path before reading it", () => {
        let read = false;
        const facts = {isFile: () => true, nlink: 1n, size: 4n, dev: 1n, ino: 2n, mtimeNs: 3n,
            mode: 0o100444n, uid: 0n, gid: 0n};
        assert.throws(() => inspectHostedInstalledBaseFile({path: ROOT, maximumBytes: 8}, {
            realpathSync: target => target === ROOT ? ROOT : `${ROOT}.replacement`,
            openSync: () => 7,
            fstatSync: () => facts,
            readSync: () => { read = true; return 4; },
            closeSync: () => undefined,
            constants: {O_RDONLY: 0, O_NOFOLLOW: 0}
        }), /opened file path/u);
        assert.equal(read, false);
    });

    it("binds and stages the fixed helper before exposing bounded same-job operations", async () => {
        const calls = [];
        let staged = false;
        const inspectFile = input => {
            const target = typeof input === "string" ? input : input.path;
            calls.push(["inspect", target]);
            if (target === HELPER_SOURCE) return identity(target, HELPER_HASH, false, "644");
            if (target === HELPER_STAGED) {
                if (!staged) throw Object.assign(new Error("absent"), {code: "ENOENT"});
                return identity(target, HELPER_HASH, true, "444");
            }
            if (target === NODE) return identity(target, NODE_HASH);
            if (target === NODE_STAGED) {
                if (!staged) throw Object.assign(new Error("absent"), {code: "ENOENT"});
                return identity(target, NODE_HASH, true, "555");
            }
            if (target === QEMU_IMG) return identity(target, "e".repeat(64));
            if (target === LOADER) return identity(target, "f".repeat(64));
            if (["/usr/bin/sudo", "/usr/bin/timeout", "/usr/bin/install", "/usr/bin/env"].includes(target))
                return identity(target);
            return identity(target, "d".repeat(64), false, "600");
        };
        const operations = await prepareHostedInstalledBaseOperations({context: context(), paths: paths(),
            stage2Result: stage2Result(),
            helperSource: {path: HELPER_SOURCE, bytes: 4096, sha256: HELPER_HASH}}, {
            environment: environment(), runtime: {platform: "linux", architecture: "x64", nodeVersion: "22.19.0",
                nodePath: NODE}, inspectFile,
            inspectDirectory: target => ({path: target, uid: "0", gid: "0", mode: target === "/tmp" ? "1777" : "755",
                ordinaryUserWritable: target === "/tmp", sticky: target === "/tmp"}),
            pathExists: target => target === HELPER_STAGED && staged,
            runOwned: async (command, argv, options) => { calls.push(["run", command, argv, options]);
                if (argv.includes("/usr/bin/install")) staged = true;
                if (argv.includes("--output=json")) return successful(JSON.stringify({format: "qcow2",
                    "virtual-size": 51_539_607_552, "backing-filename": null}));
                return successful(""); },
            isProcessGroupAlive: () => false
        });
        assert.equal(calls.filter(call => call[0] === "run" && call[2].includes("/usr/bin/install")).length, 2);
        assert.equal(calls.some(call => call[0] === "run" && call[2].includes(HELPER_STAGED)), true);
        assert.equal(calls.some(call => call[0] === "run" && call[2].includes(NODE_STAGED)), true);
        assert.deepEqual(await operations.observeQemuGroup({processGroupId: 2300, qemuPid: 2345,
            qemuStartTicks: "77"}), {processGroupId: 2300, activeProcesses: 0});
        assert.deepEqual(await operations.inspectQcow2({path: paths().systemDisk,
            qemuImgPath: QEMU_IMG}),
        {format: "qcow2", virtualBytes: "51539607552", backingFilename: null});
        await operations.sealExact({path: paths().systemDisk, kind: "file", dev: "8", ino: "1234",
            uid: "0", gid: "0", mode: "444"});
        const sealRun = calls.filter(call => call[0] === "run").at(-1);
        assert.equal(sealRun[2].includes(HELPER_STAGED), true);
        assert.equal(sealRun[2].includes(NODE_STAGED), true);
        assert.equal(sealRun[2].includes("-e"), false);
    });

    it("rejects foreign runtime and helper closure identity before staging", async () => {
        let called = false;
        const base = {context: context(), paths: paths(), stage2Result: stage2Result(),
            helperSource: {path: HELPER_SOURCE, bytes: 4096,
            sha256: HELPER_HASH}};
        for (const runtime of [{platform: "win32", architecture: "x64", nodeVersion: "22.19.0", nodePath: NODE},
            {platform: "linux", architecture: "x64", nodeVersion: "22.18.0", nodePath: NODE}]) {
            await assert.rejects(() => prepareHostedInstalledBaseOperations(base, {environment: environment(), runtime,
                inspectFile() { called = true; }}));
            assert.equal(called, false);
        }
        await assert.rejects(() => prepareHostedInstalledBaseOperations({...base,
            helperSource: {...base.helperSource, path: `${CLOSURE}/other.mjs`}}, {environment: environment(),
            runtime: {platform: "linux", architecture: "x64", nodeVersion: "22.19.0", nodePath: NODE},
            inspectFile() { called = true; }}));
        assert.equal(called, false);
        await assert.rejects(() => prepareHostedInstalledBaseOperations({...base,
            helperSource: {...base.helperSource, path: `${STAGE2_CLOSURE}/scripts/qualification/windows-msi-installed-base-seal-helper.mjs`}},
        {environment: environment(), runtime: {platform: "linux", architecture: "x64", nodeVersion: "22.19.0",
            nodePath: NODE}, inspectFile() { called = true; }}), /installed-base helper closure identity/u);
        assert.equal(called, false);
        const unsafeToolchain = stage2Result();
        unsafeToolchain.toolchain.runtime.libraryPath[0] = "/usr/lib";
        await assert.rejects(() => prepareHostedInstalledBaseOperations({...base, stage2Result: unsafeToolchain},
            {environment: environment(), runtime: {platform: "linux", architecture: "x64", nodeVersion: "22.19.0",
                nodePath: NODE}, inspectFile() { called = true; }}));
        assert.equal(called, false);
    });

    it("rejects unsafe qemu metadata and changed staged launch identities", async () => {
        let staged = false;
        let changedHelper = false;
        let backing = true;
        let runCount = 0;
        const inspectFile = input => {
            const target = typeof input === "string" ? input : input.path;
            if (target === HELPER_SOURCE) return identity(target, HELPER_HASH, false, "644");
            if (target === HELPER_STAGED) return identity(target, changedHelper ? HASH : HELPER_HASH, true, "444");
            if (target === NODE) return identity(target, NODE_HASH, false, "755");
            if (target === NODE_STAGED) return identity(target, NODE_HASH, true, "555");
            if (target === QEMU_IMG) return identity(target, "e".repeat(64));
            if (target === LOADER) return identity(target, "f".repeat(64));
            return identity(target);
        };
        const operations = await prepareHostedInstalledBaseOperations({context: context(), paths: paths(),
            stage2Result: stage2Result(), helperSource: {path: HELPER_SOURCE, bytes: 4096, sha256: HELPER_HASH}}, {
            environment: environment(), runtime: {platform: "linux", architecture: "x64", nodeVersion: "22.19.0",
                nodePath: NODE}, inspectFile,
            inspectDirectory: target => ({path: target, uid: "0", gid: "0", mode: target === "/tmp" ? "1777" : "755",
                ordinaryUserWritable: target === "/tmp", sticky: target === "/tmp"}),
            pathExists: () => false,
            runOwned: async (command, argv) => { runCount += 1;
                if (argv.includes("/usr/bin/install")) staged = true;
                return successful(argv.includes("--output=json") ? JSON.stringify({format: "qcow2",
                    "virtual-size": 51_539_607_552, ...(backing ? {"backing-filename": "/tmp/base.qcow2"} : {})}) : ""); },
            isProcessGroupAlive: () => true
        });
        assert.equal(staged, true);
        assert.deepEqual(await operations.observeQemuGroup({processGroupId: 2300}),
            {processGroupId: 2300, activeProcesses: 1});
        await assert.rejects(() => operations.inspectQcow2({path: paths().systemDisk, qemuImgPath: QEMU_IMG}),
            /qemu-img/u);
        backing = false;
        changedHelper = true;
        const beforeSeal = runCount;
        await assert.rejects(() => operations.sealExact({path: paths().systemDisk, kind: "file", dev: "8",
            ino: "1234", uid: "0", gid: "0", mode: "444"}), /identity/u);
        assert.equal(runCount, beforeSeal);
    });
});
