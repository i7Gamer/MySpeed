import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";

import {buildV161PostReleaseMsiLifecycleToolchain, observeV161PostReleaseMsiHostSources,
    parseV161PostReleaseMsiControllerArguments,
    POST_RELEASE_MSI_LINUX_CONTROLLER_CONSTANTS, retainV161PostReleaseMsiControllerProgress,
    runV161PostReleaseMsiLifecycleHost, runV161PostReleaseMsiLinuxController,
    sealV161PostReleaseMsiInstalledBase, writeV161PostReleaseMsiHostRequest} from
    "../../scripts/release/post-release-msi-linux-controller.mjs";
import {createPostReleaseMsiControllerFixture, decodedExecution, lifecycleInput} from
    "../helpers/post-release-msi-controller-fixture.mjs";
import {WindowsMsiScenario0CalibrationRunError,
    SCENARIO0_CALIBRATION_MAX_JOB_MILLISECONDS,
    SCENARIO0_CALIBRATION_MAX_EXECUTION_MILLISECONDS} from
    "../../scripts/qualification/windows-msi-scenario0-calibration.mjs";

const NONCE = "9".repeat(32);
const HASH = "a".repeat(64);
const context = () => ({schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: "b".repeat(40),
    eventSha: "c".repeat(40), runId: "123", runAttempt: "1", nonce: NONCE,
    environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
        RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260914.1"}});
const owned = (target, suffix = "a") => ({path: target, bytes: "4096", sha256: suffix.repeat(64),
    ownership: {uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false}});
const stage2 = () => {
    const portableRoot = `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}`;
    const tool = (name, suffix) => ({...owned(`${portableRoot}/usr/bin/${name}`, suffix),
        invocationPath: `${portableRoot}/usr/bin/${name}`});
    const cpuid = {role: "cpuid", name: "cpuid.exe", path: `/tmp/probes/cpuid.exe`, bytes: "8192",
        sha256: "d".repeat(64)};
    return {status: "observed", stage: "complete", cpuCalibrationAccepted: true, context: context(), probes: {
        archive: {bytes: "1", sha256: HASH}, innerManifest: {bytes: "1", name: "result.json", sha256: HASH},
        files: [cpuid]}, probeArtifact: {files: [{role: "cpuid", name: "cpuid.exe", bytes: "8192",
        sha256: "d".repeat(64)}]}, toolchain: {qemu: {...tool("qemu-system-x86_64", "1"),
        version: "QEMU emulator version 8.2.2"}, qemuImg: tool("qemu-img", "2"),
    genisoimage: tool("genisoimage", "3"), mformat: tool("mformat", "4"), mcopy: tool("mcopy", "5"),
    ovmfCode: owned(`${portableRoot}/usr/share/OVMF/OVMF_CODE_4M.fd`, "6"),
    ovmfVarsTemplate: owned(`${portableRoot}/usr/share/OVMF/OVMF_VARS_4M.fd`, "7"),
    firmware: {searchPath: `${portableRoot}/usr/share/qemu`,
        kvmvapic: owned(`${portableRoot}/usr/share/qemu/kvmvapic.bin`, "8"),
        vga: owned(`${portableRoot}/usr/share/seabios/vgabios-stdvga.bin`, "9")},
    runtime: {loader: owned(`${portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`, "b"),
        libraryPath: [`${portableRoot}/usr/lib/x86_64-linux-gnu`, `${portableRoot}/usr/lib/7zip`]}}};
};

describe("post-release MSI Linux execution closure", () => {
    it("projects the exact Stage 2 QEMU toolchain and observes every transitive guest source", async () => {
        const value = stage2();
        const projected = buildV161PostReleaseMsiLifecycleToolchain(value);
        assert.equal(projected.portableRoot, `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}`);
        assert.equal(projected.qemu.invocationPath, undefined);
        assert.equal(projected.qemu.version, undefined);
        assert.equal(projected.firmware.vga.path, value.toolchain.firmware.vga.path);
        const closureRoot = `/home/runner/work/_temp/myspeed-msi-closure-${NONCE}`;
        const observedPreparation = {execution: {runtime: {path: "/appassets/node.exe", bytes: 85_268_464,
            sha256: "e".repeat(64)}}};
        const paths = [];
        const sources = await observeV161PostReleaseMsiHostSources({context: context(), closureRoot,
            observedPreparation, stage2Result: value}, {inspectFile: async request => { paths.push(request.path);
            return {path: request.path, bytes: 1000 + paths.length, sha256: HASH}; }});
        assert.deepEqual(Object.keys(sources), POST_RELEASE_MSI_LINUX_CONTROLLER_CONSTANTS.SOURCE_NAMES);
        assert.equal(sources.node.path, observedPreparation.execution.runtime.path);
        assert.equal(sources.cpuid.path, value.probes.files[0].path);
        assert.equal(paths.length, POST_RELEASE_MSI_LINUX_CONTROLLER_CONSTANTS.CLOSURE_FILES.length);
        assert.ok(paths.every(target => target.startsWith(`${closureRoot}/`)));
        assert.ok(paths.some(target => target.endsWith("/windows-msi-guest-matrix-operations.mjs")));
        assert.ok(paths.some(target => target.endsWith("/safety.mjs")));
        assert.ok(paths.some(target => target.endsWith("/fixture.mjs")));
        assert.ok(Object.isFrozen(sources));
    });

    it("rejects stale probe and missing closure identities", async () => {
        const value = stage2();
        value.probes.files[0].sha256 = "f".repeat(64);
        await assert.rejects(observeV161PostReleaseMsiHostSources({context: context(),
            closureRoot: `/home/runner/work/_temp/myspeed-msi-closure-${NONCE}`,
            observedPreparation: {execution: {runtime: {path: "/appassets/node.exe", bytes: 1, sha256: HASH}}},
            stage2Result: value}, {inspectFile: async request => ({path: request.path, bytes: 1, sha256: HASH})}),
        /CPUID/i);
        const clean = stage2(); let index = 0;
        await assert.rejects(observeV161PostReleaseMsiHostSources({context: context(),
            closureRoot: `/home/runner/work/_temp/myspeed-msi-closure-${NONCE}`,
            observedPreparation: {execution: {runtime: {path: "/appassets/node.exe", bytes: 1, sha256: HASH}}},
            stage2Result: clean}, {inspectFile: async request => ({path: request.path,
            bytes: ++index === 2 ? 0 : 1, sha256: HASH})}), /closure source/i);
    });

    it("keeps privileged sealing and native execution behind closed validated controller inputs", async () => {
        await assert.rejects(sealV161PostReleaseMsiInstalledBase({context: context()}), /input.*keys/i);
        await assert.rejects(runV161PostReleaseMsiLifecycleHost({provenance: {}, hostRequest: {},
            nativeExecutionStarted: true, releaseGatesCleared: []}), /binding state/i);
        await assert.rejects(runV161PostReleaseMsiLifecycleHost({provenance: {}, hostRequest: {},
            nativeExecutionStarted: false, releaseGatesCleared: ["release"]}), /binding state/i);
        await assert.rejects(runV161PostReleaseMsiLinuxController({context: context()}), /input.*keys/i);
    });

    /*
     * A run that stopped early has to retain what it observed, so the CLI takes a progress path of
     * its own. Dropping it would leave an unsuccessful run with nothing but an exit code.
     */
    it("requires a result, a progress and a host-request path on the controller command line", () => {
        const complete = ["run", "--request", "/t/request.json", "--result", "/t/result.json",
            "--progress", "/t/progress.json", "--host-request", "/t/host-request.json"];
        assert.deepEqual(parseV161PostReleaseMsiControllerArguments(complete),
            {requestPath: "/t/request.json", resultPath: "/t/result.json",
                progressPath: "/t/progress.json", hostRequestPath: "/t/host-request.json"});
        for (const argv of [
            complete.slice(0, 5),
            complete.slice(0, 7),
            complete.slice(0, 8),
            ["run", "--request", "/t/request.json", "--progress", "/t/progress.json", "--result",
                "/t/result.json", "--host-request", "/t/host-request.json"],
            ["run", "--request", "/t/request.json", "--result", "/t/result.json", "--host-request",
                "/t/host-request.json", "--progress", "/t/progress.json"],
            ["execute", ...complete.slice(1)],
            complete.join(" ")
        ]) assert.throws(() => parseV161PostReleaseMsiControllerArguments(argv), /arguments differ/u);
    });

    /*
     * Gemini's consumer requires `msi-host-request.json`, and it is right to: the outer
     * `msi-lifecycle-request.json` is the controller's input, taken before the base seal, the fixture
     * and the source observations exist. The document that
     * `validateCompletedWindowsMsiLifecycleHostResult` replays a result against is the final host
     * request, which only exists in memory for the moment before the matrix starts - so it is written
     * out, exclusively and bounded, before anything launches.
     */
    it("retains the exact final host request before the matrix launches", async () => {
        const retained = [];
        const binding = {provenance: {}, hostRequest: {schemaVersion: 1, nonce: NONCE},
            nativeExecutionStarted: false, releaseGatesCleared: []};
        const observed = await runV161PostReleaseMsiLifecycleHost(binding, {
            retainHostRequest: value => { retained.push(structuredClone(value)); return {bytes: "2",
                sha256: HASH}; },
            runHost: request => { retained.push("launched"); return {status: "completed", request}; }});
        assert.deepEqual(retained, [binding.hostRequest, "launched"]);
        assert.equal(observed.status, "completed");
        /* A run that could not retain the request never launches anything. */
        await assert.rejects(runV161PostReleaseMsiLifecycleHost(binding, {
            retainHostRequest: () => { throw new Error("host request retention failed"); },
            runHost: () => { retained.push("launched again"); return {status: "completed"}; }}),
        /host request retention failed/u);
        assert.equal(retained.includes("launched again"), false);
    });

    it("writes the retained host request exclusively, bounded and byte-exact", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-msi-host-request-"));
        try {
            const target = path.join(root, "msi-host-request.json");
            const value = {schemaVersion: 1, nonce: NONCE, rows: []};
            const identity = writeV161PostReleaseMsiHostRequest(target, value);
            const bytes = fs.readFileSync(target);
            assert.equal(bytes.toString("utf8"), `${JSON.stringify(value)}\n`);
            assert.deepEqual(identity, {name: "msi-host-request.json", bytes: String(bytes.length),
                sha256: createHash("sha256").update(bytes).digest("hex")});
            /* Exclusive creation: a second write to the same path is refused, never appended to. */
            assert.throws(() => writeV161PostReleaseMsiHostRequest(target, value), /EEXIST|exists/iu);
            /* The same bound the controller result is held to, at both ends. */
            assert.ok(POST_RELEASE_MSI_LINUX_CONTROLLER_CONSTANTS.MAX_CONTROLLER_DOCUMENT_BYTES > 0);
            assert.throws(() => writeV161PostReleaseMsiHostRequest(path.join(root, "tiny.json"), 0),
                /size differs/u);
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("rejects an unsupported controller mode", async () => {
        const arbitraryDeadlineMs = Date.now() + 60_000;
        await assert.rejects(runV161PostReleaseMsiLinuxController({
            mode: "invalid-mode",
            context: context(),
            taskRoot: "/t/task",
            artifactRoot: "/t/artifacts",
            artifact: {},
            closureRoot: "/t/closure",
            stage2Paths: {},
            stage2Result: {},
            installedBaseHelperSource: {},
            budget: {},
            wallDeadlineUnixMilliseconds: arbitraryDeadlineMs,
            hostRequestPath: "/t/host-request.json"
        }), /unsupported controller mode/u);
    });

    it("rejects scenario0 calibration mode when job or execution budget exceeds ceiling", async () => {
        const arbitraryDeadlineMs = Date.now() + 60_000;
        const excessBudgetMs = 1;
        const baseInput = {
            mode: "scenario0-calibration",
            context: context(),
            taskRoot: "/t/task",
            artifactRoot: "/t/artifacts",
            artifact: {},
            closureRoot: "/t/closure",
            stage2Paths: {},
            stage2Result: {},
            installedBaseHelperSource: {},
            budget: {
                jobBudgetMilliseconds: SCENARIO0_CALIBRATION_MAX_JOB_MILLISECONDS + excessBudgetMs,
                rowAllowanceMilliseconds: SCENARIO0_CALIBRATION_MAX_EXECUTION_MILLISECONDS
            },
            wallDeadlineUnixMilliseconds: arbitraryDeadlineMs,
            hostRequestPath: "/t/host-request.json"
        };
        await assert.rejects(runV161PostReleaseMsiLinuxController(baseInput),
            /scenario0 calibration job budget exceeds ceiling/u);

        const execOverInput = {
            ...baseInput,
            budget: {
                jobBudgetMilliseconds: SCENARIO0_CALIBRATION_MAX_JOB_MILLISECONDS,
                rowAllowanceMilliseconds: SCENARIO0_CALIBRATION_MAX_EXECUTION_MILLISECONDS + excessBudgetMs
            }
        };
        await assert.rejects(runV161PostReleaseMsiLinuxController(execOverInput),
            /scenario0 calibration execution allowance exceeds ceiling/u);
    });

    it("runs scenario0 calibration mode skipping containment preflight", async () => {
        const cleanupMarginMs = 5 * 60_000;
        const finalMarginMs = 10 * 60_000;
        const value = await createPostReleaseMsiControllerFixture();
        const input = lifecycleInput(value, decodedExecution(value.host.request.rows[0]));
        const calls = [];
        let retainedHostRequest = null;
        let calibrationRequest = null;

        const result = await runV161PostReleaseMsiLinuxController({
            mode: "scenario0-calibration",
            context: input.context,
            taskRoot: input.taskRoot,
            artifactRoot: `${input.taskRoot}/appassets`,
            artifact: {
                repository: "i7Gamer/MySpeed", id: "7001",
                name: "post-release-v1.6.1-msi-appassets", bytes: "400000000",
                digest: `sha256:${"e".repeat(64)}`, runId: input.context.runId,
                runAttempt: input.context.runAttempt, headSha: input.context.sourceSha
            },
            closureRoot: input.closureRoot,
            stage2Paths: {root: input.taskRoot},
            stage2Result: input.stage2Result,
            installedBaseHelperSource: {
                path: "scripts/qualification/windows-msi-installed-base.mjs",
                bytes: "4096", sha256: "b".repeat(64)
            },
            budget: {
                jobBudgetMilliseconds: SCENARIO0_CALIBRATION_MAX_JOB_MILLISECONDS,
                rowAllowanceMilliseconds: SCENARIO0_CALIBRATION_MAX_EXECUTION_MILLISECONDS,
                rowCleanupMarginMilliseconds: cleanupMarginMs,
                finalMarginMilliseconds: finalMarginMs
            },
            wallDeadlineUnixMilliseconds: input.wallDeadlineUnixMilliseconds,
            hostRequestPath: `${input.taskRoot}/msi-host-request.json`
        }, {
            observePreparation: async () => {
                calls.push("observe-preparation");
                return input.observedPreparation;
            },
            prepareLinuxFixture: async () => {
                calls.push("prepare-fixture");
                return input.linuxFixture;
            },
            sealInstalledBase: async () => {
                calls.push("seal-base");
                return input.installedBaseSeal;
            },
            observeSources: async () => {
                calls.push("observe-sources");
                return input.sources;
            },
            onPreflight: () => {
                calls.push("run-preflight");
            },
            retainHostRequest: request => {
                calls.push("retain-host-request");
                retainedHostRequest = request;
            },
            runCalibration: async request => {
                calls.push("run-calibration");
                calibrationRequest = request;
                return {status: "completed", mode: "scenario0-calibration", row: request.row.scenarioIndex};
            }
        });

        assert.deepEqual(calls, [
            "observe-preparation",
            "prepare-fixture",
            "seal-base",
            "observe-sources",
            "retain-host-request",
            "run-calibration"
        ]);
        assert.equal(calls.includes("run-preflight"), false);
        assert.equal(retainedHostRequest.row.scenarioIndex, 0);
        assert.equal(retainedHostRequest.row.scenarioId, "clean-default");
        /*
         * The deadline the job as a whole is held to reaches the retained request, which is what lets
         * the budget the operations run under be recomputed from the document rather than trusted.
         */
        assert.equal(retainedHostRequest.wallDeadlineUnixMilliseconds, input.wallDeadlineUnixMilliseconds);
        assert.equal(calibrationRequest, retainedHostRequest);
        assert.deepEqual(result, {status: "completed", mode: "scenario0-calibration", row: 0});
    });

    it("retains controller progress for WindowsMsiScenario0CalibrationRunError", () => {
        const progress = {schemaVersion: 1, nonce: NONCE, status: "timed-out"};
        const error = new WindowsMsiScenario0CalibrationRunError(progress);
        let written = null;
        const handled = retainV161PostReleaseMsiControllerProgress(error, val => { written = val; });
        assert.equal(handled, true);
        assert.deepEqual(written, progress);
    });
});
