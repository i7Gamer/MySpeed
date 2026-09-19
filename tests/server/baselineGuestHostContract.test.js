/*
 * The seam that was missing.
 *
 * Stage 3's host validator and the guest that feeds it were each covered by their own tests, and
 * each of those tests built the other side's document by hand. Three mismatches survived that way
 * until the guest first ran to completion: the guest published the executor's own result instead of
 * the composite envelope the host parses, the seed narrowed the hosted context to five keys while
 * the host compared all eight, and the verifier summary carried the harness source SHA where the
 * host and the release manifest both require the candidate's.
 *
 * Every assertion below therefore flows one context through the real producers and hands the result
 * to the real validator. Nothing here may hand-build a document that production code also builds.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {describe, it} from "node:test";

import {validateBaselineGuestResult} from "../../scripts/qualification/linux-windows-cpu-floor-stage3.mjs";
import {WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS} from
    "../../scripts/qualification/windows-baseline-guest-runtime-bundle.mjs";
import {buildWindowsBaselineGuestSeedDocuments, WINDOWS_BASELINE_GUEST_SEED_DOCUMENT_CONSTANTS} from
    "../../scripts/qualification/windows-baseline-guest-seed-documents.mjs";
import {composeWindowsBaselineGuestResult} from "../../scripts/qualification/windows-baseline-guest-composer.mjs";
import {WINDOWS_BASELINE_GUEST_EXECUTOR_CONSTANTS} from
    "../../scripts/qualification/windows-baseline-guest-executor.mjs";
import {runWindowsBaselineGuest} from "../../scripts/qualification/windows-baseline-guest-runner.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const QUALIFICATION_ROOT = path.join(REPOSITORY_ROOT, "scripts", "qualification");
const SHA = character => character.repeat(64);
const HARNESS_SOURCE_SHA = "1".repeat(40);
const CANDIDATE_SOURCE_SHA = "4".repeat(40);
const EVENT_SHA = "3".repeat(40);
const NONCE = "2".repeat(32);
const ROOT = `/home/runner/work/_temp/myspeed-stage3-${NONCE}`;
const STAGE2_ROOT = `/home/runner/work/_temp/myspeed-stage2-transport-${NONCE}`;
const ARTIFACT_NAME = "MySpeed-windows-x64-baseline.exe";
const CANDIDATE_FILE_SHA = SHA("d");
const CANDIDATE_BYTES = "524288";
const IMAGE_VERSION = "20260901.1";
const WALL_DEADLINE_MILLISECONDS = Date.parse("2026-09-16T13:20:00Z");
const SCENARIOS = ["populated-first-boot", "populated-restart", "fresh-no-config-reset"];

/* The one context. Both sides below are derived from exactly this object. */
const hostedContext = () => ({schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: HARNESS_SOURCE_SHA,
    eventSha: EVENT_SHA, runId: "123", runAttempt: "1", nonce: NONCE, environment: {
        GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
        RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: IMAGE_VERSION}});

const hostRequest = () => ({schemaVersion: 1, context: hostedContext(), profile: "baseline-cpu",
    authorization: {scope: "windows-baseline-cpu-floor-full-runtime", qemu: true, candidate: true,
        confirmation: "RUN-WINDOWS-BASELINE-CPU-FLOOR"},
    budget: {label: "cpu-floor-stage3-baseline", wallDeadlineUnixMilliseconds: WALL_DEADLINE_MILLISECONDS},
    stage2: {result: {path: `${STAGE2_ROOT}/stage2-result.json`, bytes: "65536", sha256: SHA("b")},
        guestResult: {path: `${STAGE2_ROOT}/guest-result.json`, bytes: "4096", sha256: SHA("a")}},
    candidate: {artifactId: "563103679", artifactName: ARTIFACT_NAME, releaseAssetId: "563103679",
        releaseAssetDigest: `sha256:${CANDIDATE_FILE_SHA}`, archive: {bytes: "1048576", sha256: SHA("c")},
        sourceSha: CANDIDATE_SOURCE_SHA, runId: "34829932391", runAttempt: "1", tagName: "v1.6.1",
        file: {name: "MySpeed.exe", bytes: CANDIDATE_BYTES, sha256: CANDIDATE_FILE_SHA},
        qualificationSummary: {name: "qualification-summary.json", bytes: "8192", sha256: SHA("e")},
        manifest: {name: "qualification-manifest.json", bytes: "65536", sha256: SHA("f")}},
    paths: {root: ROOT, systemDisk: `${ROOT}/stage3.qcow2`, seedIso: `${ROOT}/baseline-seed.iso`,
        outputDisk: `${ROOT}/baseline-output.img`, ovmfVars: `${ROOT}/OVMF_VARS.fd`,
        qemuPid: `${ROOT}/baseline-qemu.pid`, serialLog: `${ROOT}/baseline-serial.log`}});

/* The real seed builder, fed the real hosted context - not a narrowed copy of it. */
const seedDocuments = () => buildWindowsBaselineGuestSeedDocuments({
    context: hostedContext(),
    candidate: {artifactName: ARTIFACT_NAME, sourceSha: CANDIDATE_SOURCE_SHA, bytes: CANDIDATE_BYTES,
        sha256: CANDIDATE_FILE_SHA},
    fixtureBundle: {bytes: "8192", sha256: SHA("5")},
    candidateController: {bytes: "4096", sha256: SHA("7")},
    cleanStopController: {bytes: "4096", sha256: SHA("8")},
    cpuidProbe: {bytes: "16384", sha256: SHA("9")},
    imageVersion: IMAGE_VERSION, manifestSha256: SHA("e")});

/*
 * The CPUID the guest's probe prints. Westmere-v2 under QEMU: SSE4.2 and POPCNT set, AVX and
 * OSXSAVE clear, so leaf 1 ECX carries bits 20 and 23 only and XCR0 is unreadable.
 */
const rawCpuid = () => ({schemaVersion: 1, kind: "cpuid", maxBasicLeaf: 7,
    leaf1: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00900000", edx: "0x00000000"},
    leaf7Subleaf0: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00000000", edx: "0x00000000"},
    xcr0: null, features: {sse42: true, popcnt: true, osxsave: false, avx: false, avx2: false}});
const cpuidBytes = () => Buffer.from(`${JSON.stringify(rawCpuid())}\n`, "utf8");

/* Stub operations only - the sequencing they drive is the runner's own test's subject, not this one's. */
function guestOperations() {
    const populated = {ping: "123.456", resultId: "qualification-seed-row", passwordValueSha256: SHA("6")};
    return {
        async prepareFixture() { return {initialDatabase: populated, expected: populated}; },
        async observeNetwork() { return {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}; },
        async openScenario(input) { return {scenario: input.scenario}; },
        async awaitReady() { return {candidatePid: 100, candidateCreationTime: "7".repeat(16)}; },
        async awaitOwnedListener(input) { return {listenerOwned: true, candidatePid: input.ready.candidatePid,
            candidateCreationTime: input.ready.candidateCreationTime, port: input.port}; },
        async checkPopulated() { return {elapsedMs: 10}; },
        async closeScenario(input) { return {scenario: input.session.scenario, controllerLifecyclePassed: true,
            candidateExited: true, candidateExitCode: input.session.scenario === "fresh-no-config-reset" ? 113 : 0,
            forced: false, jobActiveProcesses: 0, handlesClosed: true}; },
        async checkPopulatedDatabase() { return populated; },
        async checkResetDatabase() { return {integrity: "ok", configTable: false}; },
        async cleanupFixture() { return {cleanupProven: true}; }
    };
}

/* Drive the real producers end to end and return exactly what the guest would publish. */
async function publishedGuestResult() {
    const documents = seedDocuments();
    const inner = await runWindowsBaselineGuest(documents.request, guestOperations());
    assert.equal(inner.status, "observed", inner.failure);
    return composeWindowsBaselineGuestResult({request: documents.request, execution: documents.execution,
        result: inner, cpuidBytes: cpuidBytes()});
}

describe("baseline guest to Stage 3 host contract", () => {
    it("publishes a result the host validator accepts", async () => {
        const published = await publishedGuestResult();
        const accepted = validateBaselineGuestResult(published, hostRequest());
        assert.deepEqual(accepted, published);
    });

    it("carries the hosted context through the seed unnarrowed", async () => {
        const published = await publishedGuestResult();
        assert.deepEqual(published.context, hostedContext());
    });

    /*
     * The two SHAs are the trap. The summary is the candidate release's evidence, so it is stamped
     * with the candidate's SHA; the harness SHA belongs to the context alone. Stage 3's
     * validateFullSummary is what rejects it, at the very end of a run that has already spent an
     * hour, which is why the two are pinned apart here instead.
     */
    it("stamps the verifier summary with the candidate SHA, not the harness SHA", async () => {
        const published = await publishedGuestResult();
        assert.equal(published.verifier.summary.sourceSha, CANDIDATE_SOURCE_SHA);
        assert.notEqual(published.verifier.summary.sourceSha, published.context.sourceSha);
    });

    it("binds the verifier summary bytes to the summary the host reads", async () => {
        const published = await publishedGuestResult();
        const bytes = Buffer.from(published.verifier.summaryBytesBase64, "base64");
        assert.deepEqual(JSON.parse(bytes.toString("utf8")), published.verifier.summary);
        assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), published.verifier.summarySha256);
    });

    it("binds the CPUID evidence bytes to the probe output verbatim", async () => {
        const published = await publishedGuestResult();
        const bytes = Buffer.from(published.cpu.cpuidBytesBase64, "base64");
        assert.deepEqual(bytes, cpuidBytes());
        assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), published.cpu.cpuidSha256);
        assert.deepEqual({sse42: published.cpu.sse42, popcnt: published.cpu.popcnt, avx: published.cpu.avx,
            avx2: published.cpu.avx2, osxsave: published.cpu.osxsave}, rawCpuid().features);
    });

    it("keeps the cleanup proof the bootstrap gate reads", async () => {
        const published = await publishedGuestResult();
        assert.equal(published.cleanupProven, true);
    });

    /*
     * The guest runs from a frozen bundle, so a module the executor imports but the bundle does not
     * carry fails only inside the VM, an hour into a qualification run, as an unresolved import.
     * Every relative import reachable from the executor must therefore be in the shipped inventory.
     */
    /*
     * The seed stamps the CPU model and the host compares it, from two constants that cannot see
     * each other. Drift between them would surface only as a rejected envelope at the end of a
     * qualification run, so it is pinned here where both sides are already in scope.
     */
    it("stamps the CPU model the host requires", async () => {
        const published = await publishedGuestResult();
        assert.equal(published.cpu.model, WINDOWS_BASELINE_GUEST_SEED_DOCUMENT_CONSTANTS.CPU_MODEL);
        assert.doesNotThrow(() => validateBaselineGuestResult(published, hostRequest()));
    });

    /*
     * The seed bounds the probe it declares and the executor bounds the probe it reads. They are the
     * same file, so a raise on one side alone turns into a physical-identity refusal inside the guest
     * rather than a rejected document; the two constants cannot see each other, so pin them here.
     */
    it("bounds the CPU floor probe identically on both sides", () => {
        assert.equal(WINDOWS_BASELINE_GUEST_SEED_DOCUMENT_CONSTANTS.MAX_PROBE_BYTES,
            WINDOWS_BASELINE_GUEST_EXECUTOR_CONSTANTS.MAX_PROBE_BYTES);
    });

    it("ships every module the guest executor imports", () => {
        const shipped = new Set(WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS);
        const root = path.join(QUALIFICATION_ROOT, "windows-baseline-guest-executor.mjs");
        const seen = new Set(); const pending = [root];
        while (pending.length > 0) {
            const current = pending.pop();
            if (seen.has(current)) continue;
            seen.add(current);
            const relative = path.relative(REPOSITORY_ROOT, current).replaceAll("\\", "/");
            assert.ok(shipped.has(relative), `${relative} is imported by the guest but is not in the bundle`);
            for (const match of fs.readFileSync(current, "utf8").matchAll(/^import\s[^"']*["'](\.[^"']+)["']/gmu))
                pending.push(path.resolve(path.dirname(current), match[1]));
        }
        assert.ok(seen.size > 1, "the import walk found no modules");
    });
});
