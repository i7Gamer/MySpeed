import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";

import {deriveActualHostedContext, runHostedStage2Controller} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2-controller.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_ROOT = path.join(HERE, "..", "fixtures", "linux-kvm-privileged-capability-evidence");
const readCanonical = p => Buffer.from(fs.readFileSync(p, "utf8").replace(/\r\n/gu, "\n"), "utf8");
const ordinaryBytes = readCanonical(path.join(EVIDENCE_ROOT, "result.json"));
const combinedBytes = readCanonical(path.join(EVIDENCE_ROOT, "privileged-result.json"));
const context = JSON.parse(ordinaryBytes).context;
const GENERIC_EVIDENCE_LIMIT_BYTES = 4_194_304;
const PROBE_ARCHIVE_LIMIT_BYTES = 268_435_456;
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function identity(pathValue, bytes) { return {path: pathValue, bytes: bytes.length, sha256: digest(bytes)}; }

function paths() {
    const root = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${context.nonce}`;
    return {root, packageRoot: `${root}/packages`,
        portableRoot: `/tmp/myspeed-windows-cpu-floor-tools-${context.nonce}`, probeRoot: `${root}/probes`,
        windowsIso: `${root}/windows.iso`, installWim: `${root}/install.wim`, seedIso: `${root}/seed.iso`,
        outputDisk: `${root}/output.img`, systemDisk: `${root}/system.qcow2`, ovmfVars: `${root}/OVMF_VARS.fd`,
        serialLog: `${root}/serial.log`, qemuPid: `${root}/qemu.pid`};
}

function observations() {
    return {taskRoot: {path: paths().root, exists: false, parentWritableByCurrentUser: true},
        filesystem: {taskPath: "/home/runner/work/_temp", mountPoint: "/", type: "ext4",
            mountOptions: "rw,relatime", remote: false, availableBlocks: "19816114",
            fragmentSizeBytes: "4096", availableBytes: "81166802944"},
        memory: {memAvailableBytes: "15474245632", selfCgroupPath:
            "/sys/fs/cgroup/system.slice/hosted-compute-agent.service", cgroupLevels: [
            {path: "/sys/fs/cgroup", mountPoint: "/sys/fs/cgroup", mountRoot: "/",
                limitBytes: null, currentBytes: null},
            {path: "/sys/fs/cgroup/system.slice", mountPoint: "/sys/fs/cgroup", mountRoot: "/",
                limitBytes: null, currentBytes: "3436752896"},
            {path: "/sys/fs/cgroup/system.slice/hosted-compute-agent.service",
                mountPoint: "/sys/fs/cgroup", mountRoot: "/", limitBytes: null, currentBytes: "882683904"}],
            cgroupHeadroomBytes: null, effectiveAvailableBytes: "15474245632"}};
}

function fixture() {
    const inputRoot = `/home/runner/work/_temp/myspeed-stage2-input-${context.nonce}`;
    const closureRoot = `/home/runner/work/_temp/myspeed-stage2-closure-${context.nonce}`;
    const closureNames = ["scripts/qualification/linux-windows-cpu-floor-admission.mjs",
        "scripts/qualification/linux-windows-cpu-floor-stage2-controller.mjs",
        "scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs",
        "scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs",
        "scripts/qualification/linux-windows-cpu-floor-stage2.mjs",
        "scripts/qualification/linux-kvm-capability.mjs",
        "scripts/qualification/linux-kvm-privileged-capability.mjs",
        "scripts/qualification/windows-msi-post-setup-activation.mjs"];
    const contents = new Map([[`${inputRoot}/ordinary.json`, ordinaryBytes],
        [`${inputRoot}/combined.json`, combinedBytes], [`${inputRoot}/artifact.zip`, Buffer.from("archive")],
        [`${inputRoot}/result.json`, Buffer.from("manifest")]]);
    for (const name of closureNames) contents.set(`${closureRoot}/${name}`, Buffer.from(`closure-${name}`));
    const roles = ["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good", "popcnt", "sse42"];
    const files = roles.map((role, index) => {
        const name = `${role.replaceAll("-", "_")}.exe`;
        const bytes = Buffer.from(`probe-${index}`);
        contents.set(`${inputRoot}/${name}`, bytes);
        return {role, name, bytes: String(bytes.length), sha256: digest(bytes)};
    });
    const request = {schemaVersion: 1, context,
        closure: {root: closureRoot, files: closureNames.map(name =>
            identity(`${closureRoot}/${name}`, contents.get(`${closureRoot}/${name}`)))},
        authorization: {confirmation: "RUN-CANDIDATE-NEUTRAL-STAGE2",
        scope: "candidate-neutral-cpu-calibration", media: true, qemu: true}, paths: paths(),
        kvm: {ordinary: identity(`${inputRoot}/ordinary.json`, ordinaryBytes),
            combined: identity(`${inputRoot}/combined.json`, combinedBytes)},
        probeArtifact: {schemaVersion: 1, repository: context.repository, sourceSha: context.sourceSha,
            runId: "34765142461", runAttempt: "1", artifactId: "10300000000",
            artifactName: "windows-cpu-readiness-evidence", archive: {bytes: String(contents.get(`${inputRoot}/artifact.zip`).length),
                sha256: digest(contents.get(`${inputRoot}/artifact.zip`))},
            innerManifest: {name: "result.json", bytes: String(contents.get(`${inputRoot}/result.json`).length),
                sha256: digest(contents.get(`${inputRoot}/result.json`))}, files},
        probeStage: {archive: identity(`${inputRoot}/artifact.zip`, contents.get(`${inputRoot}/artifact.zip`)),
            result: identity(`${inputRoot}/result.json`, contents.get(`${inputRoot}/result.json`)),
            files: files.map(file => identity(`${inputRoot}/${file.name}`, contents.get(`${inputRoot}/${file.name}`)))}};
    return {request, contents};
}

describe("hosted Stage 2 controller", () => {
    it("forwards only the exact optional installer confirmation authorization", async () => {
        const {request, contents} = fixture();
        request.authorization.bootConfirmation = "single-enter-before-setup-v1";
        let forwarded;
        await runHostedStage2Controller(request, {
            readVerified: target => ({bytes: contents.get(target), path: target, sha256: digest(contents.get(target))}),
            collectAdmission: async () => observations(), mkdirExclusive: () => undefined,
            copyExclusive: (source, target) => contents.set(target, contents.get(source)), operations: {},
            runStage2: async input => { forwarded = input; return {status: "observed"}; }
        });
        assert.equal(forwarded.bootConfirmation, request.authorization.bootConfirmation);
        for (const bad of [true, false, null, "enter", {}, undefined]) {
            const changed = fixture().request;
            changed.authorization.bootConfirmation = bad;
            await assert.rejects(runHostedStage2Controller(changed), /confirmation/iu);
        }
    });

    it("replays KVM evidence, admits resources, seals probe inputs, then invokes Stage 2", async () => {
        const {request, contents} = fixture();
        const events = [];
        const result = await runHostedStage2Controller(request, {
            readVerified: target => {
                const bytes = contents.get(target);
                if (!bytes) throw new Error(`missing ${target}`);
                return {bytes, path: target, sha256: digest(bytes)};
            }, collectAdmission: async () => observations(), mkdirExclusive: target => events.push(["mkdir", target]),
            copyExclusive: (source, target) => { events.push(["copy", source, target]); contents.set(target, contents.get(source)); },
            operations: {}, runStage2: async input => { events.push(["run", input.admission.admitted]);
                return {schemaVersion: 1, status: "observed", qualifying: false, releaseGateCleared: false}; }});
        assert.equal(result.status, "observed");
        assert.deepEqual(events.slice(0, 2), [["mkdir", paths().root], ["mkdir", paths().probeRoot]]);
        assert.equal(events.filter(([kind]) => kind === "copy").length, 10);
        assert.deepEqual(events.at(-1), ["run", true]);
    });

    it("uses the archive-specific bound for both source and copied probe archive bytes", async () => {
        const {request, contents} = fixture();
        const archive = Buffer.alloc(GENERIC_EVIDENCE_LIMIT_BYTES + 1, 0x61);
        contents.set(request.probeStage.archive.path, archive);
        request.probeStage.archive = identity(request.probeStage.archive.path, archive);
        request.probeArtifact.archive = {bytes: String(archive.length), sha256: digest(archive)};
        const limits = [];
        const result = await runHostedStage2Controller(request, {
            readVerified: (target, maximumBytes) => {
                limits.push([target, maximumBytes]);
                const bytes = contents.get(target);
                if (!bytes || bytes.length > maximumBytes) throw new Error("test evidence exceeds its bound");
                return {bytes, path: target, sha256: digest(bytes)};
            }, collectAdmission: async () => observations(), mkdirExclusive: () => undefined,
            copyExclusive: (source, target) => contents.set(target, contents.get(source)), operations: {},
            runStage2: async () => ({schemaVersion: 1, status: "observed", qualifying: false,
                releaseGateCleared: false})});
        assert.equal(result.status, "observed");
        const archiveReads = limits.filter(([target]) => target.endsWith("artifact.zip"));
        assert.deepEqual(archiveReads.map(([, maximumBytes]) => maximumBytes),
            [PROBE_ARCHIVE_LIMIT_BYTES, PROBE_ARCHIVE_LIMIT_BYTES]);
    });

    it("rejects insufficient capacity before task-root creation or media operations", async () => {
        const {request, contents} = fixture();
        const changed = observations();
        changed.filesystem.availableBlocks = "1"; changed.filesystem.availableBytes = "4096";
        let mutated = false;
        const result = await runHostedStage2Controller(request, {readVerified: target => {
            const bytes = contents.get(target); return {bytes, path: target, sha256: digest(bytes)}; },
        collectAdmission: async () => changed, mkdirExclusive: () => { mutated = true; },
        runStage2: async () => { throw new Error("must not run"); }});
        assert.equal(result.status, "rejected");
        assert.equal(mutated, false);
    });

    it("rejects missing authorization and changed input bytes before admission", async () => {
        const unauthorized = fixture(); unauthorized.request.authorization.qemu = false;
        await assert.rejects(runHostedStage2Controller(unauthorized.request), /authorized/u);
        const changed = fixture(); changed.request.kvm.ordinary.sha256 = "0".repeat(64);
        await assert.rejects(runHostedStage2Controller(changed.request, {readVerified: target => {
            const bytes = changed.contents.get(target); return {bytes, path: target, sha256: digest(bytes)}; }}),
        /differs/u);
        const duplicate = fixture(); duplicate.request.probeStage.files[1] =
            structuredClone(duplicate.request.probeStage.files[0]);
        await assert.rejects(runHostedStage2Controller(duplicate.request), /staging file identity/u);
    });

    it("derives the native context only from the actual hosted runtime", () => {
        const environment = {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
            RUNNER_ENVIRONMENT: "github-hosted", GITHUB_REPOSITORY: context.repository,
            MYSPEED_SOURCE_SHA: context.sourceSha, GITHUB_SHA: context.eventSha, GITHUB_RUN_ID: context.runId,
            GITHUB_RUN_ATTEMPT: context.runAttempt, ImageOS: context.environment.ImageOS,
            ImageVersion: context.environment.ImageVersion};
        assert.deepEqual(deriveActualHostedContext(context.nonce, environment,
            {platform: "linux", architecture: "x64"}), context);
        assert.throws(() => deriveActualHostedContext(context.nonce, environment,
            {platform: "win32", architecture: "x64"}), /actual hosted runtime/u);
    });
});
