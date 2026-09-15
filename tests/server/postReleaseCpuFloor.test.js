import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, it} from "node:test";

import {bindV161PostReleaseTarget} from "../../scripts/release/post-release-target.mjs";
import {
    POST_RELEASE_CPU_FLOOR_CONSTANTS,
    acquireV161PostReleaseCpuFloorBaselineSummary,
    buildV161PostReleaseCpuFloorStage2Request,
    buildV161PostReleaseCpuFloorStage3Template,
    buildV161PostReleaseCpuFloorStage3Request,
    createV161PostReleaseCpuFloorBinding,
    inspectV161PostReleaseCpuFloorEvidence
} from "../../scripts/release/post-release-cpu-floor.mjs";
import {WINDOWS_MSI_STAGE2_CLOSURE} from "../../scripts/qualification/windows-msi-stage2-request.mjs";
import {runHostedStage2Controller}
    from "../../scripts/qualification/linux-windows-cpu-floor-stage2-controller.mjs";
import {
    BASELINE_ARCHIVE_DIGEST,
    BASELINE_ARTIFACT_NAME,
    BASELINE_SUMMARY_SHA256,
    CANDIDATE_SHA,
    DEFAULT_VARIANT_SUMMARY_SHA256,
    HARNESS_SHA,
    HOSTED_NONCE,
    HOSTED_RUN_ATTEMPT,
    HOSTED_RUN_ID,
    TAG_NAME,
    acquisitionInput,
    authenticBaselineSummaryBytes,
    buildOtherExecutionStage3Fixture,
    buildPostReleaseStage3Fixture,
    buildUnrelatedStage3Fixture,
    hostedContext,
    manifestBytes,
    placeholderStage2Receipts,
    targetInput
} from "../helpers/post-release-cpu-floor-fixture.mjs";

const AUTHENTIC_SUMMARY_BYTES = 1649;
const STAGE2_INPUT_ROOT = `/home/runner/work/_temp/myspeed-stage2-input-${HOSTED_NONCE}`;
const PROBE_ROLES = ["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good", "popcnt", "sse42"];
const PROBE_MEMBER_BYTES = "4096";

const target = () => bindV161PostReleaseTarget(targetInput());
const binding = () => createV161PostReleaseCpuFloorBinding({
    target: target(), manifestBytes: manifestBytes(), hostedContext: hostedContext()
});
const acquired = () => acquireV161PostReleaseCpuFloorBaselineSummary(binding(), acquisitionInput());

const identityOf = targetPath => ({
    path: targetPath, bytes: Number(PROBE_MEMBER_BYTES),
    sha256: createHash("sha256").update(targetPath).digest("hex")
});

const probeArtifact = () => ({
    sourceSha: HARNESS_SHA, runId: HOSTED_RUN_ID, runAttempt: HOSTED_RUN_ATTEMPT,
    artifactId: "123456", archiveBytes: PROBE_MEMBER_BYTES,
    archiveSha256: identityOf(`${STAGE2_INPUT_ROOT}/artifact.zip`).sha256,
    files: PROBE_ROLES.map(role => {
        const name = `${role.replaceAll("-", "_")}.exe`;
        return {role, name, bytes: PROBE_MEMBER_BYTES, sha256: identityOf(`${STAGE2_INPUT_ROOT}/${name}`).sha256};
    })
});

/** The full authentic path: binding, acquisition, Stage 3 request, real producer, consumer. */
async function producedEvidence() {
    const acquiredBinding = acquired();
    const projection = buildV161PostReleaseCpuFloorStage3Request(acquiredBinding, placeholderStage2Receipts());
    const fixture = await buildPostReleaseStage3Fixture(projection.candidate);
    const request = buildV161PostReleaseCpuFloorStage3Request(acquiredBinding, fixture.request.stage2);
    return {acquiredBinding, fixture, request};
}

describe("v1.6.1 post-release CPU-floor consumer", () => {
    describe("identity binding", () => {
        it("derives the required baseline summary digest from the authenticated manifest", () => {
            const value = binding();
            assert.equal(value.kind, POST_RELEASE_CPU_FLOOR_CONSTANTS.KIND);
            assert.equal(value.qualifying, false);
            assert.equal(value.releaseGateCleared, false);
            assert.deepEqual(value.releaseGatesCleared, []);
            assert.equal(value.requiredBaselineSummary.sha256, BASELINE_SUMMARY_SHA256);
            assert.equal(value.requiredBaselineSummary.name, "qualification-summary.json");
            assert.notEqual(value.requiredBaselineSummary.sha256, DEFAULT_VARIANT_SUMMARY_SHA256);
            assert.equal(value.candidate.sourceSha, CANDIDATE_SHA);
            assert.equal(value.harness.sourceSha, HARNESS_SHA);
            assert.equal(value.hostedContext.sourceSha, HARNESS_SHA);
            assert.equal(value.hostedContext.eventSha, HARNESS_SHA);
            assert.ok(Object.isFrozen(value));
            assert.ok(Object.isFrozen(value.hostedContext));
            assert.equal(value.summary, undefined);
        });

        it("refuses a target that did not come from the sealed binder", () => {
            assert.throws(() => createV161PostReleaseCpuFloorBinding({
                target: structuredClone(target()), manifestBytes: manifestBytes(), hostedContext: hostedContext()
            }), /immutable target|binder/i);
        });

        it("refuses manifest bytes that are not the sealed manifest", () => {
            const tampered = Buffer.from(manifestBytes());
            tampered[tampered.length - 2] = tampered[tampered.length - 2] === 0x20 ? 0x09 : 0x20;
            assert.throws(() => createV161PostReleaseCpuFloorBinding({
                target: target(), manifestBytes: tampered, hostedContext: hostedContext()
            }), /manifest/i);
            assert.throws(() => createV161PostReleaseCpuFloorBinding({
                target: target(), manifestBytes: Buffer.from("{}"), hostedContext: hostedContext()
            }), /manifest/i);
        });

        it("refuses source-role swaps between harness and candidate context", () => {
            for (const mutate of [
                context => { context.sourceSha = CANDIDATE_SHA; },
                context => { context.eventSha = CANDIDATE_SHA; },
                context => { context.sourceSha = "b".repeat(40); }
            ]) {
                const context = hostedContext();
                mutate(context);
                assert.throws(() => createV161PostReleaseCpuFloorBinding({
                    target: target(), manifestBytes: manifestBytes(), hostedContext: context
                }), /harness|candidate|source/i);
            }
        });

        it("refuses an incomplete hosted context instead of inventing defaults", () => {
            for (const mutate of [
                context => { delete context.sourceSha; },
                context => { delete context.environment; },
                context => { delete context.environment.ImageVersion; },
                context => { context.environment.RUNNER_ENVIRONMENT = "self-hosted"; }
            ]) {
                const context = hostedContext();
                mutate(context);
                assert.throws(() => createV161PostReleaseCpuFloorBinding({
                    target: target(), manifestBytes: manifestBytes(), hostedContext: context
                }));
            }
        });
    });

    describe("baseline summary acquisition", () => {
        it("accepts the authentic historical summary bytes", () => {
            const value = acquired();
            assert.equal(value.summary.name, "qualification-summary.json");
            assert.equal(value.summary.sha256, BASELINE_SUMMARY_SHA256);
            assert.equal(value.summary.bytes, String(AUTHENTIC_SUMMARY_BYTES));
            assert.equal(createHash("sha256").update(authenticBaselineSummaryBytes()).digest("hex"),
                BASELINE_SUMMARY_SHA256);
            assert.ok(Object.isFrozen(value));
        });

        it("reproduces the arbitrary-summary bypass as a refusal", () => {
            const bytes = Buffer.from("not the historical summary");
            const input = acquisitionInput();
            input.summaryBytes = bytes;
            assert.throws(() => acquireV161PostReleaseCpuFloorBaselineSummary(binding(), input), /summary/i);

            // The original defect: bytes accompanied by their own digest were accepted.
            const withOwnDigest = acquisitionInput();
            withOwnDigest.summaryBytes = bytes;
            withOwnDigest.artifact.summarySha256 = createHash("sha256").update(bytes).digest("hex");
            assert.throws(() => acquireV161PostReleaseCpuFloorBaselineSummary(binding(), withOwnDigest));
        });

        it("refuses the default-variant summary in place of the baseline summary", () => {
            const input = acquisitionInput();
            input.summaryBytes = Buffer.from(JSON.stringify({substituted: DEFAULT_VARIANT_SUMMARY_SHA256}));
            assert.throws(() => acquireV161PostReleaseCpuFloorBaselineSummary(binding(), input), /summary/i);
        });

        it("refuses a single altered byte in the authentic summary", () => {
            const input = acquisitionInput();
            const bytes = Buffer.from(authenticBaselineSummaryBytes());
            bytes[0] = bytes[0] ^ 0x01;
            input.summaryBytes = bytes;
            assert.throws(() => acquireV161PostReleaseCpuFloorBaselineSummary(binding(), input), /summary/i);
        });

        it("refuses expired, missing or mismatched artifact provenance", () => {
            const mutations = [
                artifact => { artifact.expired = true; },
                artifact => { delete artifact.headSha; },
                artifact => { artifact.headSha = HARNESS_SHA; },
                artifact => { artifact.id = 99999999999; },
                artifact => { artifact.name = "MySpeed-windows-x64.exe"; },
                artifact => { artifact.runId = 11111; },
                artifact => { artifact.runAttempt = 2; },
                artifact => { artifact.archiveSize = 1; },
                artifact => { artifact.archiveDigest = `sha256:${"0".repeat(64)}`; },
                artifact => { artifact.expiresAt = "2026-09-14T00:00:00Z"; }
            ];
            for (const mutate of mutations) {
                const input = acquisitionInput();
                mutate(input.artifact);
                assert.throws(() => acquireV161PostReleaseCpuFloorBaselineSummary(binding(), input));
            }
        });

        it("refuses a fabricated kind-only binding", () => {
            assert.throws(() => acquireV161PostReleaseCpuFloorBaselineSummary(
                {kind: POST_RELEASE_CPU_FLOOR_CONSTANTS.KIND,
                    requiredBaselineSummary: {name: "qualification-summary.json",
                        sha256: BASELINE_SUMMARY_SHA256}},
                acquisitionInput()), /binding/i);
        });
    });

    describe("request builders", () => {
        it("builds a Stage 2 request the real controller admits", async () => {
            const request = buildV161PostReleaseCpuFloorStage2Request(binding(), probeArtifact(), identityOf);
            assert.equal(request.context.sourceSha, HARNESS_SHA);
            assert.equal(request.context.eventSha, HARNESS_SHA);
            assert.notEqual(request.context.sourceSha, CANDIDATE_SHA);
            assert.equal(request.closure.files.length, WINDOWS_MSI_STAGE2_CLOSURE.length);

            let admitted = null;
            await runHostedStage2Controller(request, {
                readVerified: targetPath => {
                    const member = request.closure.files.find(file => file.path === targetPath)
                        ?? {bytes: PROBE_MEMBER_BYTES, sha256: identityOf(targetPath).sha256};
                    return {bytes: Buffer.alloc(Number(member.bytes)), sha256: member.sha256};
                },
                collectAdmission: value => { admitted = value.context; throw new Error("stop after validation"); }
            }).catch(error => { if (error.message !== "stop after validation") throw error; });
            assert.equal(admitted.eventSha, HARNESS_SHA);
            assert.equal(admitted.sourceSha, HARNESS_SHA);
        });

        it("refuses fabricated or unacquired bindings in both request builders", () => {
            const fabricated = {kind: POST_RELEASE_CPU_FLOOR_CONSTANTS.KIND, hostedContext: hostedContext(),
                candidate: {sourceSha: CANDIDATE_SHA}};
            assert.throws(() => buildV161PostReleaseCpuFloorStage2Request(fabricated, probeArtifact(), identityOf),
                /binding/i);
            assert.throws(() => buildV161PostReleaseCpuFloorStage3Request(fabricated, placeholderStage2Receipts()),
                /binding/i);
            // An identity binding has no verified summary, so it cannot build a Stage 3 request.
            assert.throws(() => buildV161PostReleaseCpuFloorStage3Request(binding(), placeholderStage2Receipts()),
                /acquir/i);
            // A structural clone loses the brand and must not be trusted at a subsequent call.
            assert.throws(() => buildV161PostReleaseCpuFloorStage3Request(
                structuredClone(acquired()), placeholderStage2Receipts()), /binding/i);
        });

        it("separates candidate identity from harness context in the Stage 3 request", () => {
            const request = buildV161PostReleaseCpuFloorStage3Request(acquired(), placeholderStage2Receipts());
            assert.equal(request.context.sourceSha, HARNESS_SHA);
            assert.notEqual(request.candidate.sourceSha, request.context.sourceSha);
            assert.equal(request.candidate.sourceSha, CANDIDATE_SHA);
            assert.equal(request.candidate.tagName, TAG_NAME);
            assert.equal(request.candidate.artifactName, BASELINE_ARTIFACT_NAME);
            assert.equal(request.candidate.archive.sha256,
                BASELINE_ARCHIVE_DIGEST.slice("sha256:".length));
            assert.equal(request.candidate.qualificationSummary.sha256, BASELINE_SUMMARY_SHA256);
            assert.equal(request.candidate.qualificationSummary.bytes, String(AUTHENTIC_SUMMARY_BYTES));
            assert.equal(request.paths.root, `/home/runner/work/_temp/myspeed-stage3-${HOSTED_NONCE}`);
        });

        it("builds a branded acquired Stage 3 template without invented Stage 2 identities", () => {
            const template = buildV161PostReleaseCpuFloorStage3Template(acquired());
            const request = buildV161PostReleaseCpuFloorStage3Request(acquired(), placeholderStage2Receipts());
            assert.deepEqual(template, Object.fromEntries(Object.entries(request)
                .filter(([key]) => key !== "stage2")));
            assert.equal(Object.hasOwn(template, "stage2"), false);
            assert.throws(() => buildV161PostReleaseCpuFloorStage3Template(binding()), /acquir/i);
            assert.throws(() => buildV161PostReleaseCpuFloorStage3Template(structuredClone(acquired())), /binding/i);
        });

        it("refuses malformed same-execution Stage 2 receipts", () => {
            for (const mutate of [
                receipts => { delete receipts.guestResult; },
                receipts => { receipts.extra = {}; },
                receipts => { delete receipts.result.sha256; }
            ]) {
                const receipts = placeholderStage2Receipts();
                mutate(receipts);
                assert.throws(() => buildV161PostReleaseCpuFloorStage3Request(acquired(), receipts));
            }
        });
    });

    describe("evidence inspection", () => {
        it("accepts the actual producer result and stays non-qualifying", async () => {
            const {acquiredBinding, fixture, request} = await producedEvidence();
            assert.deepEqual(request, fixture.request);

            const inspection = inspectV161PostReleaseCpuFloorEvidence({
                binding: acquiredBinding, request, result: fixture.completedResult,
                retainedStage2Bytes: fixture.retainedStage2Bytes
            });
            assert.equal(inspection.accepted, true);
            assert.equal(inspection.qualifying, false);
            assert.equal(inspection.releaseGateCleared, false);
            assert.deepEqual(inspection.releaseGatesCleared, []);
            assert.equal(inspection.classification,
                "windows-baseline-cpu-floor-full-runtime-stage3-nonqualifying");
            assert.equal(inspection.candidate.sourceSha, CANDIDATE_SHA);
            assert.equal(inspection.context.sourceSha, HARNESS_SHA);
            assert.ok(Object.isFrozen(inspection));
            // The strict Stage 3 result schema has no outer releaseGatesCleared field.
            assert.equal(Object.hasOwn(fixture.completedResult, "releaseGatesCleared"), false);
        });

        it("accepts the identity binding as well as the acquired binding", async () => {
            const {fixture, request} = await producedEvidence();
            const inspection = inspectV161PostReleaseCpuFloorEvidence({
                binding: binding(), request, result: fixture.completedResult,
                retainedStage2Bytes: fixture.retainedStage2Bytes
            });
            assert.equal(inspection.accepted, true);
        });

        it("refuses tampered or missing raw retained receipts", async () => {
            const {acquiredBinding, fixture, request} = await producedEvidence();
            const tampered = Buffer.from(fixture.retainedStage2Bytes);
            tampered[tampered.length - 2] = tampered[tampered.length - 2] ^ 0x01;
            for (const bytes of [tampered, Buffer.alloc(0), undefined]) {
                assert.throws(() => inspectV161PostReleaseCpuFloorEvidence({
                    binding: acquiredBinding, request, result: fixture.completedResult,
                    retainedStage2Bytes: bytes
                }));
            }
        });

        it("refuses stripped raw runtime evidence rather than trusting the projections", async () => {
            const {acquiredBinding, fixture, request} = await producedEvidence();
            const mutations = [
                result => { delete result.guestEvidence.bytesBase64; },
                result => { result.guest.cpu.cpuidBytesBase64 = Buffer.from("[]").toString("base64"); },
                result => { delete result.guest.verifier.summaryBytesBase64; },
                result => { result.guest.verifier.summary.shutdownProofs = []; },
                result => { result.guest.cpu.avx = true; },
                result => { result.guest.network.hardwareNics = 1; },
                result => { result.qemuProcess.treeGone = false; },
                result => { result.cleanupProven = false; },
                result => { result.qualifying = true; },
                result => { result.releaseGateCleared = true; },
                result => { result.releaseGatesCleared = ["windows-cpu-floor"]; },
                result => { delete result.argv; }
            ];
            for (const mutate of mutations) {
                const broken = structuredClone(fixture.completedResult);
                mutate(broken);
                assert.throws(() => inspectV161PostReleaseCpuFloorEvidence({
                    binding: acquiredBinding, request, result: broken,
                    retainedStage2Bytes: fixture.retainedStage2Bytes
                }), `mutation should have been refused: ${mutate}`);
            }
        });

        it("refuses a result whose request drifts from the binding", async () => {
            const {acquiredBinding, fixture} = await producedEvidence();
            const mutations = [
                request => { request.candidate.sourceSha = HARNESS_SHA; },
                request => { request.context.sourceSha = CANDIDATE_SHA; },
                request => { request.candidate.qualificationSummary.sha256 = DEFAULT_VARIANT_SUMMARY_SHA256; },
                request => { request.candidate.tagName = "v1.6.0"; },
                request => { request.candidate.archive.sha256 = "0".repeat(64); }
            ];
            for (const mutate of mutations) {
                const drifted = structuredClone(fixture.request);
                mutate(drifted);
                assert.throws(() => inspectV161PostReleaseCpuFloorEvidence({
                    binding: acquiredBinding, request: drifted, result: fixture.completedResult,
                    retainedStage2Bytes: fixture.retainedStage2Bytes
                }));
            }
        });

        it("refuses a self-consistent execution that was not the one this binding sealed", async () => {
            // Both cases are internally valid Stage 3 executions, so the core validator accepts
            // them. Only the request-to-binding check can tell that they are not this binding's.
            const unrelated = await buildUnrelatedStage3Fixture();
            assert.throws(() => inspectV161PostReleaseCpuFloorEvidence({
                binding: binding(), request: unrelated.request, result: unrelated.completedResult,
                retainedStage2Bytes: unrelated.retainedStage2Bytes
            }), /hosted context|candidate/i);

            const acquiredBinding = acquired();
            const projection = buildV161PostReleaseCpuFloorStage3Request(
                acquiredBinding, placeholderStage2Receipts());
            const otherExecution = await buildOtherExecutionStage3Fixture(projection.candidate);
            assert.throws(() => inspectV161PostReleaseCpuFloorEvidence({
                binding: acquiredBinding, request: otherExecution.request,
                result: otherExecution.completedResult,
                retainedStage2Bytes: otherExecution.retainedStage2Bytes
            }), /hosted context/i);
        });

        it("refuses a fabricated kind-only binding at inspection", async () => {
            const {fixture, request} = await producedEvidence();
            assert.throws(() => inspectV161PostReleaseCpuFloorEvidence({
                binding: {kind: POST_RELEASE_CPU_FLOOR_CONSTANTS.KIND, hostedContext: hostedContext()},
                request, result: fixture.completedResult,
                retainedStage2Bytes: fixture.retainedStage2Bytes
            }), /binding/i);
        });
    });
});
