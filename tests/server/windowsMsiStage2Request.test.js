import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, it} from "node:test";

import {runHostedStage2Controller} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2-controller.mjs";
import {buildWindowsMsiStage2Request, WINDOWS_MSI_STAGE2_CLOSURE, WINDOWS_MSI_STAGE2_PROBE_ROLES,
    WINDOWS_MSI_STAGE2_ROOTS, INSTALLER_BOOT_CONFIRMATION} from "../../scripts/qualification/windows-msi-stage2-request.mjs";
import {sealSameJobInstalledBase} from "../../scripts/qualification/windows-msi-installed-base.mjs";
import {buildWindowsMsiSetupCompleteActivation, getCompletedWindowsMsiActivationEvidence} from
    "../../scripts/qualification/windows-msi-post-setup-activation.mjs";

const NONCE = "5".repeat(32);
const RUNNER_TEMP = "/home/runner/work/_temp";
const CLOSURE_ROOT = `${RUNNER_TEMP}/myspeed-stage2-closure-${NONCE}`;
const INPUT_ROOT = `${RUNNER_TEMP}/myspeed-stage2-input-${NONCE}`;

const digest = text => createHash("sha256").update(text).digest("hex");

const context = () => ({schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: "1".repeat(40),
    eventSha: "2".repeat(40), runId: "34900000001", runAttempt: "1", nonce: NONCE,
    environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
        RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260914.1"}});

/*
 * One synthetic byte string per path, so every identity in the request is distinct and a test that
 * moves a file to another root produces a genuinely different record rather than a coincidence.
 */
const contents = target => `bytes-of:${target}`;
const identity = target => {
    const text = contents(target);
    return {path: target, bytes: text.length, sha256: digest(text)};
};

/*
 * Stage 2 requires the staged archive to be the very artifact the pin names, so the fixture pins
 * what it staged - which is exactly what the acquisition step establishes before staging.
 */
const probe = () => ({artifactId: "10222222222", runId: "34800000001", runAttempt: "1",
    sourceSha: "3".repeat(40),
    archiveBytes: String(identity(`${INPUT_ROOT}/artifact.zip`).bytes),
    archiveSha256: identity(`${INPUT_ROOT}/artifact.zip`).sha256,
    files: WINDOWS_MSI_STAGE2_PROBE_ROLES.map(role => {
        const name = `${role.replaceAll("-", "_")}.exe`;
        const observed = identity(`${INPUT_ROOT}/${name}`);
        return {role, name, bytes: String(observed.bytes), sha256: observed.sha256};
    })});

const build = (overrides = {}) => buildWindowsMsiStage2Request({context: context(), identity,
    probe: probe(), ...overrides});

/*
 * The request the workflow hands Stage 2 is fed to the real Stage 2 validator, not to a regex. The
 * controller validates before it touches anything, so injected dependencies let the whole validation
 * path run with no disk, no QEMU and no admission.
 */
const validateThroughStage2 = async request => {
    const reads = [];
    let admitted = null;
    const readVerified = target => {
        reads.push(target);
        const text = contents(target);
        return {bytes: Buffer.from(text), path: target, sha256: digest(text)};
    };
    await runHostedStage2Controller(request, {readVerified,
        collectAdmission: value => { admitted = value; throw new Error("stopped after validation"); }})
        .catch(error => { if (error.message !== "stopped after validation") throw error; });
    return {reads, admitted};
};

describe("Windows MSI Stage 2 request", () => {
    it("names the exact ordered Stage 2 closure rather than the MSI closure", () => {
        assert.deepEqual([...WINDOWS_MSI_STAGE2_CLOSURE], [
            "scripts/qualification/linux-windows-cpu-floor-admission.mjs",
            "scripts/qualification/linux-windows-cpu-floor-stage2-controller.mjs",
            "scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs",
            "scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs",
            "scripts/qualification/linux-windows-cpu-floor-stage2.mjs",
            "scripts/qualification/linux-kvm-capability.mjs",
            "scripts/qualification/linux-kvm-privileged-capability.mjs",
            "scripts/qualification/windows-msi-post-setup-activation.mjs"]);
        assert.equal(WINDOWS_MSI_STAGE2_ROOTS.closurePrefix, `${RUNNER_TEMP}/myspeed-stage2-closure-`);
        assert.equal(WINDOWS_MSI_STAGE2_ROOTS.inputPrefix, `${RUNNER_TEMP}/myspeed-stage2-input-`);
        assert.deepEqual([...WINDOWS_MSI_STAGE2_PROBE_ROLES],
            ["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good", "popcnt", "sse42"]);
    });

    /*
     * The defect this replaces: the workflow built the request around
     * `myspeed-msi-closure-<nonce>` with every MSI controller member in it, and staged the KVM and
     * probe inputs under the MSI input root. The validator names different roots and an exact
     * eight-file list, so the run would have failed at its first Stage 2 call.
     */
    it("passes the real Stage 2 validator with its own closure and input roots", async () => {
        const request = build();
        assert.equal(request.closure.root, CLOSURE_ROOT);
        assert.equal(request.closure.files.length, WINDOWS_MSI_STAGE2_CLOSURE.length);
        assert.deepEqual(request.closure.files.map(file => file.path),
            WINDOWS_MSI_STAGE2_CLOSURE.map(name => `${CLOSURE_ROOT}/${name}`));
        assert.equal(request.kvm.ordinary.path, `${INPUT_ROOT}/ordinary.json`);
        assert.equal(request.kvm.combined.path, `${INPUT_ROOT}/combined.json`);
        assert.equal(request.probeStage.archive.path, `${INPUT_ROOT}/artifact.zip`);
        assert.equal(request.probeStage.result.path, `${INPUT_ROOT}/result.json`);
        const {reads, admitted} = await validateThroughStage2(request);
        assert.notEqual(admitted, null, "validation did not reach admission");
        assert.deepEqual(admitted.context, request.context);
        /* Every closure member and both KVM inputs were verified before admission was collected. */
        for (const name of WINDOWS_MSI_STAGE2_CLOSURE)
            assert.ok(reads.includes(`${CLOSURE_ROOT}/${name}`), name);
        assert.ok(reads.includes(`${INPUT_ROOT}/ordinary.json`));
        assert.ok(reads.includes(`${INPUT_ROOT}/combined.json`));
    });

    it("keeps the MSI closure out of the Stage 2 request", async () => {
        const request = build();
        const text = JSON.stringify(request);
        assert.equal(text.includes("myspeed-msi-closure-"), false);
        assert.equal(text.includes("myspeed-msi-input-"), false);
        assert.equal(text.includes("post-release-msi-linux-controller.mjs"), false);
        assert.equal(text.includes("windows-msi-guest-matrix-executor.mjs"), false);
    });

    /*
     * A request that drifts back towards the MSI roots, loses a closure member or reorders the list
     * has to be refused by Stage 2 itself, which is the check a regex over the workflow text could
     * never make.
     */
    it("is refused by Stage 2 when a root, a member or the order drifts", async () => {
        const cases = {
            "closure root moved to the MSI closure": request => ({...request,
                closure: {...request.closure,
                    root: `${RUNNER_TEMP}/myspeed-msi-closure-${NONCE}`}}),
            "closure member dropped": request => ({...request,
                closure: {...request.closure, files: request.closure.files.slice(1)}}),
            "closure order reversed": request => ({...request,
                closure: {...request.closure, files: [...request.closure.files].reverse()}}),
            "extra MSI member appended": request => ({...request, closure: {...request.closure,
                files: [...request.closure.files,
                    identity(`${CLOSURE_ROOT}/scripts/release/post-release-msi-linux-controller.mjs`)]}}),
            "KVM input staged under the MSI input root": request => ({...request,
                kvm: {...request.kvm,
                    ordinary: identity(`${RUNNER_TEMP}/myspeed-msi-input-${NONCE}/ordinary.json`)}}),
            "probe archive staged under the MSI input root": request => ({...request,
                probeStage: {...request.probeStage,
                    archive: identity(`${RUNNER_TEMP}/myspeed-msi-input-${NONCE}/artifact.zip`)}})
        };
        for (const [name, mutate] of Object.entries(cases)) {
            const {admitted} = await validateThroughStage2(mutate(build()))
                .then(value => value, () => ({admitted: null}));
            assert.equal(admitted, null, name);
        }
    });

    it("binds the probe artifact identity the acquisition step pinned", () => {
        const request = build();
        assert.equal(request.probeArtifact.artifactName, "windows-cpu-readiness-evidence");
        assert.equal(request.probeArtifact.repository, "i7Gamer/MySpeed");
        assert.equal(request.probeArtifact.archive.sha256,
            identity(`${INPUT_ROOT}/artifact.zip`).sha256);
        assert.equal(request.probeArtifact.files.length, 8);
        assert.deepEqual(request.probeStage.files.map(file => file.path),
            WINDOWS_MSI_STAGE2_PROBE_ROLES.map(role =>
                `${INPUT_ROOT}/${role.replaceAll("-", "_")}.exe`));
        assert.throws(() => build({probe: {...probe(), files: probe().files.slice(1)}}),
            /probe/iu);
        assert.throws(() => build({context: {...context(), nonce: "not-a-nonce"}}), /context|nonce/iu);
    });

    it("binds INSTALLER_BOOT_CONFIRMATION at the MSI caller and validates through real controller, result and seal", async () => {
        // 1. Generic builder without bootConfirmation remains default-denied
        const generic = build();
        assert.equal(generic.authorization.bootConfirmation, undefined);
        assert.equal(Object.hasOwn(generic.authorization, "bootConfirmation"), false);

        // 2. Explicit binding sets the canonical token
        const authorizedRequest = build({bootConfirmation: INSTALLER_BOOT_CONFIRMATION});
        assert.equal(authorizedRequest.authorization.bootConfirmation, INSTALLER_BOOT_CONFIRMATION);

        // 3. Unauthorized token is rejected by the real controller
        const unauthorizedRequest = build({bootConfirmation: "unauthorized-token"});
        await assert.rejects(() => validateThroughStage2(unauthorizedRequest), /Stage 2 boot confirmation is not authorized/u);

        // 4. Authorized request passes the real Stage 2 controller validation
        const {admitted} = await validateThroughStage2(authorizedRequest);
        assert.notEqual(admitted, null);

        // 5. Exercise complete pipeline: workflow-generated request -> Stage 2 result -> installed-base seal
        const {buildQemuArguments} = await import("../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs");
        const stage2Result = {
            schemaVersion: 1,
            stage: "complete",
            status: "observed",
            classification: "github-hosted-windows-cpu-floor-stage2-calibration-nonqualifying",
            qualifying: false,
            releaseGateCleared: false,
            cpuCalibrationAccepted: true,
            cleanupProven: true,
            privilegeMode: "ordinary-kvm",
            context: authorizedRequest.context,
            bootConfirmation: authorizedRequest.authorization.bootConfirmation,
            toolchain: {
                runtime: {loader: {path: `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`,
                    bytes: "4096", sha256: "4".repeat(64), ownership: {uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false}}},
                qemuImg: {path: `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}/usr/bin/qemu-img`,
                    invocationPath: `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}/usr/bin/qemu-img`,
                    bytes: "4096", sha256: "b".repeat(64), ownership: {uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false}},
                ovmfCode: {path: `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}/usr/share/OVMF/OVMF_CODE_4M.fd`,
                    bytes: "4096", sha256: "1".repeat(64), ownership: {uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false}},
                firmware: {searchPath: `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}/usr/share/qemu`,
                    kvmvapic: {path: `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}/usr/share/qemu/kvmvapic.bin`, bytes: "4096",
                        sha256: "3".repeat(64), ownership: {uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false}},
                    vga: {path: `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}/usr/share/seabios/vgabios-stdvga.bin`, bytes: "4096",
                        sha256: "5".repeat(64), ownership: {uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false}}}
            },
            argv: [],
            media: {
                outputDisk: {path: `${RUNNER_TEMP}/myspeed-windows-cpu-floor-${NONCE}/output.img`, bytes: "67108864", sha256: "e".repeat(64)},
                ovmfVars: {path: `${RUNNER_TEMP}/myspeed-windows-cpu-floor-${NONCE}/OVMF_VARS.fd`, bytes: "4096", sha256: "2".repeat(64)},
                seedIso: {path: `${RUNNER_TEMP}/myspeed-windows-cpu-floor-${NONCE}/seed.iso`, bytes: "1048576", sha256: "8".repeat(64)},
                systemDisk: {path: `${RUNNER_TEMP}/myspeed-windows-cpu-floor-${NONCE}/system.qcow2`, bytes: "196616",
                    sha256: "d".repeat(64), virtualBytes: "51539607552", format: "qcow2"}
            },
            qemuProcess: {
                cleanupProven: true, exitCode: 0, signal: null, timedOut: false, treeGone: true,
                qemuPid: 2345, qemuStartTicks: "77",
                launcherExecutablePath: `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`,
                processGroupId: 2300, qemuPidAbsentAfter: true, terminationReason: null
            },
            earlyBoot: {
                schemaVersion: 1, kind: "qemu-early-boot-observation",
                inputSent: {
                    kind: "installer-boot-confirmation",
                    qcode: "ret",
                    holdMilliseconds: 100,
                    requestedOffsetMilliseconds: 2000,
                    sentOffsetMilliseconds: 2050,
                    acknowledged: true
                },
                version: {major: 8, minor: 2, micro: 2},
                status: "running", running: true,
                screenshots: [1, 2].map(index => {
                    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(`screen-${index}`)]);
                    return {
                        path: `${RUNNER_TEMP}/myspeed-windows-cpu-floor-${NONCE}/early-boot-${index}.png`,
                        bytes: String(png.length),
                        sha256: digest(png),
                        bytesBase64: png.toString("base64")
                    };
                })
            },
            guest: {
                schemaVersion: 1, status: "observed",
                cpu: {sse42: true, popcnt: true, osxsave: false, avx: false, avx2: false, xcr0: null},
                instructions: {sse42: "completed", popcnt: "completed", avx: "illegal-instruction", avx2: "illegal-instruction"},
                network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0},
                activation: (() => {
                    const hosted = authorizedRequest.context;
                    const activation = buildWindowsMsiSetupCompleteActivation({
                        repository: hosted.repository, sourceSha: hosted.sourceSha,
                        eventSha: hosted.eventSha, runId: hosted.runId,
                        runAttempt: hosted.runAttempt, nonce: hosted.nonce
                    });
                    return getCompletedWindowsMsiActivationEvidence(activation);
                })(),
                systemTools: [
                    {role: "msiexec", path: "C:\\Windows\\System32\\msiexec.exe", bytes: "1024", sha256: "8".repeat(64)},
                    {role: "sc", path: "C:\\Windows\\System32\\sc.exe", bytes: "2048", sha256: "9".repeat(64)},
                    {role: "powershell", path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
                        bytes: "4096", sha256: "b".repeat(64)}
                ],
                output: {path: `${RUNNER_TEMP}/myspeed-windows-cpu-floor-${NONCE}/output.img`, bytes: "67108864", sha256: "e".repeat(64)}
            },
            installWim: {path: `${RUNNER_TEMP}/myspeed-windows-cpu-floor-${NONCE}/install.wim`, bytes: "5000000000", sha256: "5".repeat(64)},
            installWimRemoval: {path: `${RUNNER_TEMP}/myspeed-windows-cpu-floor-${NONCE}/install.wim`, sha256: "5".repeat(64), removed: true},
            iso: {path: `${RUNNER_TEMP}/myspeed-windows-cpu-floor-${NONCE}/windows.iso`, bytes: "8152356864", sha256: "3".repeat(64)},
            packageClosure: {schemaVersion: 1, snapshot: {id: "20260913T000000Z"}, packages: []},
            probeArtifact: authorizedRequest.probeArtifact,
            probes: [],
            selectedImage: {index: 2, name: "Windows Server 2025 SERVERSTANDARD"}
        };
        stage2Result.argv = buildQemuArguments({paths: authorizedRequest.paths, toolchain: stage2Result.toolchain});

        const io = {
            calls: [],
            async observeQemuGroup(input) { io.calls.push(["group", input]); return {processGroupId: input.processGroupId, activeProcesses: 0}; },
            async inspectFile(input) { io.calls.push(["file", input]);
                const isSecond = io.calls.filter(([k]) => k === "file").length > 1;
                return {path: input.path, kind: "file", dev: "8", ino: "1234", bytes: "4294967296",
                    sha256: "a".repeat(64), ownership: {uid: "0", gid: "0", mode: isSecond ? "444" : "644", ordinaryUserWritable: !isSecond}};
            },
            async inspectQcow2(input) { io.calls.push(["qcow2", input]); return {format: "qcow2", virtualBytes: "51539607552", backingFilename: null}; },
            async sealExact(input) { io.calls.push(["seal", input]); }
        };

        const sealed = await sealSameJobInstalledBase({
            expectedContext: authorizedRequest.context,
            paths: authorizedRequest.paths,
            stage2Result
        }, io);
        assert.equal(sealed.status, "sealed");
        assert.deepEqual(io.calls.map(([k]) => k), ["group", "file", "qcow2", "seal", "file"]);
    });
});
