import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";

import {
    STAGE3_LAUNCHER_CLOSURE_PATHS,
    STAGE3_LAUNCHER_CONSTANTS,
    verifyClosureFiles,
    writeBoundedFailureEvidence,
    readBoundedRegularFile,
    inspectCompletedStage3Sequence,
    executeStage3Launcher
} from "../../scripts/qualification/linux-windows-cpu-floor-stage3-launcher.mjs";
import {
    createV161PostReleaseCpuFloorBinding,
    acquireV161PostReleaseCpuFloorBaselineSummary,
    buildV161PostReleaseCpuFloorStage2Request,
    buildV161PostReleaseCpuFloorStage3Template
} from "../../scripts/release/post-release-cpu-floor.mjs";
import {bindV161PostReleaseTarget} from "../../scripts/release/post-release-target.mjs";
import {
    targetInput,
    hostedContext,
    authenticBaselineSummaryBytes,
    BASELINE_ARTIFACT_ID,
    BASELINE_ARTIFACT_NAME,
    BASELINE_ARCHIVE_SIZE,
    BASELINE_ARCHIVE_DIGEST,
    QUALIFICATION_RUN_ID,
    QUALIFICATION_RUN_ATTEMPT,
    CANDIDATE_SHA,
    BASELINE_ARTIFACT_EXPIRES_AT,
    OBSERVED_AT
} from "../helpers/post-release-cpu-floor-fixture.mjs";
import {buildPostReleaseStage3Fixture} from "../helpers/post-release-cpu-floor-fixture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const RUNNER_TEMP_PREFIX = "/home/runner/work/_temp";

function hash(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function populateCopiedClosure(targetDir) {
    const records = [];
    for (const rel of STAGE3_LAUNCHER_CLOSURE_PATHS) {
        const srcPath = path.join(REPO_ROOT, rel);
        const destPath = path.join(targetDir, rel);
        fs.mkdirSync(path.dirname(destPath), {recursive: true});
        const bytes = fs.readFileSync(srcPath);
        fs.writeFileSync(destPath, bytes, {mode: 0o600});
        records.push({name: rel, bytes: String(bytes.length), sha256: hash(bytes)});
    }
    return records;
}

function buildBinding() {
    const context = hostedContext();
    const target = bindV161PostReleaseTarget(targetInput());
    const binding = createV161PostReleaseCpuFloorBinding({
        target,
        manifestBytes: targetInput().manifestBytes,
        hostedContext: context
    });
    const acquired = acquireV161PostReleaseCpuFloorBaselineSummary(binding, {
        artifact: {
            id: BASELINE_ARTIFACT_ID,
            name: BASELINE_ARTIFACT_NAME,
            runId: QUALIFICATION_RUN_ID,
            runAttempt: QUALIFICATION_RUN_ATTEMPT,
            headSha: CANDIDATE_SHA,
            archiveSize: BASELINE_ARCHIVE_SIZE,
            archiveDigest: BASELINE_ARCHIVE_DIGEST,
            expired: false,
            expiresAt: BASELINE_ARTIFACT_EXPIRES_AT
        },
        summaryBytes: authenticBaselineSummaryBytes(),
        observedAt: OBSERVED_AT
    });
    return {binding, acquired, context};
}

describe("Windows CPU-floor Stage 3 trusted launcher", () => {
    it("verifies closure files externally and detects any tampering before execution", () => {
        const closureRoot = makeTempDir("myspeed-stage3-closure-test-");
        try {
            const records = populateCopiedClosure(closureRoot);

            // Positive: all files correct
            const verified = verifyClosureFiles(closureRoot, records);
            assert.equal(verified.valid, true);
            assert.equal(verified.files.length, STAGE3_LAUNCHER_CLOSURE_PATHS.length);

            fs.writeFileSync(path.join(closureRoot, "execution-closure.json"), "{}\n");
            assert.equal(verifyClosureFiles(closureRoot, records).valid, true,
                "the externally authenticated execution manifest is metadata, not an extra member");

            // Tampered file with a harmless top-level marker appended
            const tamperedRel = "scripts/qualification/safety.mjs";
            const tamperedPath = path.join(closureRoot, tamperedRel);
            const originalBytes = fs.readFileSync(tamperedPath);
            // Append extra bytes — changes length AND sha256 but marker is never executed
            fs.appendFileSync(tamperedPath, "\n// TOP_LEVEL_MARKER_WOULD_EXECUTE\n");

            // Must throw a verification error mentioning size or sha256 — NOT marker execution
            assert.throws(
                () => verifyClosureFiles(closureRoot, records),
                (err) => {
                    // The error must be about the file content, not an execution
                    assert.doesNotMatch(err.message, /TOP_LEVEL_MARKER_WOULD_EXECUTE/);
                    assert.match(err.message, /differs/);
                    return true;
                }
            );
            // Restore
            fs.writeFileSync(tamperedPath, originalBytes);

            // Extra/untracked file must also be refused
            const extraPath = path.join(closureRoot, "scripts", "qualification", "extra-untracked.mjs");
            fs.writeFileSync(extraPath, "console.log('extra');");
            assert.throws(
                () => verifyClosureFiles(closureRoot, records),
                /untracked or unexpected closure file/
            );
            fs.unlinkSync(extraPath);
        } finally {
            fs.rmSync(closureRoot, {recursive: true, force: true});
        }
    });

    it("feeds real branded builder outputs into the Stage 3 sequence template", async () => {
        const {binding, acquired, context} = buildBinding();
        const tempRoot = makeTempDir("myspeed-stage3-builders-test-");
        try {
            // The sequence and controller expect these paths to be under the runner temp prefix
            const fileIdentity = (targetPath) => ({
                path: targetPath,
                bytes: "100",
                sha256: "0".repeat(64)
            });

            const probeFiles = ["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good", "popcnt", "sse42"]
                .map(role => ({
                    role,
                    name: `${role.replaceAll("-", "_")}.exe`,
                    bytes: "100",
                    sha256: "0".repeat(64)
                }));

            const probeArtifact = {
                sourceSha: CANDIDATE_SHA,
                runId: "12345",
                runAttempt: "1",
                artifactId: "99999",
                archiveBytes: "1000",
                archiveSha256: "0".repeat(64),
                files: probeFiles
            };

            const stage2Request = buildV161PostReleaseCpuFloorStage2Request(binding, probeArtifact, fileIdentity);
            assert.equal(stage2Request.schemaVersion, 1);
            assert.equal(stage2Request.authorization.confirmation, "RUN-CANDIDATE-NEUTRAL-STAGE2");

            const stage3Template = buildV161PostReleaseCpuFloorStage3Template(acquired);
            assert.equal(Object.hasOwn(stage3Template, "stage2"), false);
            assert.equal(stage3Template.profile, "baseline-cpu");
            assert.equal(stage3Template.authorization.scope, "windows-baseline-cpu-floor-full-runtime");
            assert.equal(stage3Template.candidate.sourceSha, CANDIDATE_SHA);
            assert.notEqual(stage3Template.candidate.sourceSha, context.sourceSha);
        } finally {
            fs.rmSync(tempRoot, {recursive: true, force: true});
        }
    });

    it("workflow invocation cannot succeed without executing sequence and checking completed result", async () => {
        // Test that executeStage3Launcher rejects an unobserved sequence result.
        // Use injected binding+acquired so we skip the consumer brand check at launch.
        const {binding, acquired, context} = buildBinding();
        const nonce = context.nonce;
        const tempRoot = makeTempDir("myspeed-stage3-launcher-failure-");
        const envelopeRoot = path.join(tempRoot, "envelope");
        const transportRoot = path.join(tempRoot, "transport");
        fs.mkdirSync(envelopeRoot);
        fs.mkdirSync(transportRoot);
        let cleanupAttempted = false;

        // Sequence returns a failed (non-observed) result
        const failingSequence = async () => ({
            status: "failed",
            error: "QEMU launch failed"
        });

        // executeStage3Launcher must throw when sequence status is not "observed"
        await assert.rejects(
            () => executeStage3Launcher({
                nonce,
                closureRoot: `${RUNNER_TEMP_PREFIX}/myspeed-stage3-closure-${nonce}`,
                closureRecords: [],
                transportRoot,
                envelopeRoot,
                stage2Root: `${RUNNER_TEMP_PREFIX}/myspeed-windows-cpu-floor-${nonce}`,
                stage3Root: `${RUNNER_TEMP_PREFIX}/myspeed-stage3-${nonce}`,
                binding,
                acquired,
                probeArtifact: {
                    sourceSha: CANDIDATE_SHA,
                    runId: "12345",
                    runAttempt: "1",
                    artifactId: "99999",
                    archiveBytes: "1000",
                    archiveSha256: "0".repeat(64),
                    files: ["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good", "popcnt", "sse42"]
                        .map(role => ({role, name: `${role.replaceAll("-", "_")}.exe`, bytes: "100", sha256: "0".repeat(64)}))
                },
                guestFiles: []
            }, {
                buildStage2Request: () => ({schemaVersion: 1,
                    authorization: {confirmation: "RUN-CANDIDATE-NEUTRAL-STAGE2"}}),
                buildStage3Template: () => ({profile: "baseline-cpu", schemaVersion: 1,
                    authorization: {confirmation: "RUN-WINDOWS-BASELINE-CPU-FLOOR"}}),
                buildSequenceRequest: () => ({schemaVersion: 1, nonce}),
                verifyClosure: () => ({valid: true, files: []}),
                runSequence: failingSequence,
                cleanupProcesses: async () => { cleanupAttempted = true; }
            }),
            /Stage 3 sequence did not produce an observed result/
        );
        assert.equal(cleanupAttempted, true);
        const failure = JSON.parse(fs.readFileSync(path.join(transportRoot, "evidence-manifest.json"), "utf8"));
        assert.equal(failure.accepted, false);
        fs.rmSync(tempRoot, {recursive: true, force: true});
    });

    it("passes actual producer output across the sequence boundary into the real consumer", async () => {
        const {binding, acquired} = buildBinding();
        const template = buildV161PostReleaseCpuFloorStage3Template(acquired);
        const fixture = await buildPostReleaseStage3Fixture(template.candidate);
        const inspection = inspectCompletedStage3Sequence({binding, acquired,
            sequenceResult: fixture.completedResult, sameExecutionStage2: fixture.request.stage2,
            stage2ResultBytes: fixture.retainedStage2Bytes});
        assert.equal(inspection.accepted, true);
        assert.equal(inspection.candidate.sourceSha, CANDIDATE_SHA);
        assert.equal(inspection.stage2.status, "observed");
    });

    it("reads retained evidence through a bounded stable regular-file descriptor", () => {
        const tempRoot = makeTempDir("myspeed-stage3-retained-read-");
        const evidencePath = path.join(tempRoot, "stage2-result.json");
        const evidence = Buffer.from("{\"status\":\"observed\"}\n", "utf8");
        try {
            fs.writeFileSync(evidencePath, evidence);
            assert.deepEqual(readBoundedRegularFile(evidencePath, evidence.length), evidence);

            assert.throws(() => readBoundedRegularFile(evidencePath, evidence.length - 1),
                /identity differs/);

            const linkedPath = path.join(tempRoot, "linked-result.json");
            fs.linkSync(evidencePath, linkedPath);
            assert.throws(() => readBoundedRegularFile(evidencePath, evidence.length), /identity differs/);
            fs.unlinkSync(linkedPath);

            const symlinkPath = path.join(tempRoot, "symlink-result.json");
            try {
                fs.symlinkSync(evidencePath, symlinkPath, "file");
                assert.throws(() => readBoundedRegularFile(symlinkPath, evidence.length), /identity differs/);
            } catch (error) {
                if (error?.code !== "EPERM") throw error;
            }
        } finally {
            fs.rmSync(tempRoot, {recursive: true, force: true});
        }
    });

    it("retains the raw sequence result before inspection and the accepted inspection only after acceptance", async () => {
        const tempRoot = makeTempDir("myspeed-stage3-retention-");
        const envelopeRoot = path.join(tempRoot, "envelope");
        const transportRoot = path.join(tempRoot, "transport");
        fs.mkdirSync(envelopeRoot);
        fs.mkdirSync(transportRoot);
        fs.writeFileSync(path.join(transportRoot, "stage2-result.json"), "stage2\n");
        fs.writeFileSync(path.join(transportRoot, "guest-result.json"), "guest\n");
        const sequenceResult = {status: "observed", evidence: "bounded"};
        const acceptedInspection = {accepted: true, status: "accepted"};
        const options = {closureRoot: tempRoot, closureRecords: [], transportRoot, envelopeRoot,
            binding: {hostedContext: {}}, acquired: {}, probeArtifact: {}};
        const dependencies = {
            verifyClosure: () => ({valid: true}),
            buildStage2Request: () => ({}),
            buildStage3Template: () => ({}),
            buildStage3Request: () => ({}),
            buildSequenceRequest: () => ({}),
            runSequence: async () => sequenceResult,
            inspectEvidence: () => acceptedInspection
        };
        try {
            assert.deepEqual(await executeStage3Launcher(options, dependencies), acceptedInspection);
            assert.deepEqual(JSON.parse(fs.readFileSync(path.join(transportRoot,
                STAGE3_LAUNCHER_CONSTANTS.STAGE3_RESULT_FILE), "utf8")), sequenceResult);
            assert.deepEqual(JSON.parse(fs.readFileSync(path.join(transportRoot,
                STAGE3_LAUNCHER_CONSTANTS.ACCEPTED_INSPECTION_FILE), "utf8")), acceptedInspection);
            assert.equal(fs.readFileSync(path.join(transportRoot, "stage2-result.json"), "utf8"), "stage2\n");
            assert.equal(fs.readFileSync(path.join(transportRoot, "guest-result.json"), "utf8"), "guest\n");
        } finally {
            fs.rmSync(tempRoot, {recursive: true, force: true});
        }
    });

    it("retains no accepted inspection when consumer inspection fails", async () => {
        const tempRoot = makeTempDir("myspeed-stage3-refused-retention-");
        const envelopeRoot = path.join(tempRoot, "envelope");
        const transportRoot = path.join(tempRoot, "transport");
        fs.mkdirSync(envelopeRoot);
        fs.mkdirSync(transportRoot);
        fs.writeFileSync(path.join(transportRoot, "stage2-result.json"), "stage2\n");
        fs.writeFileSync(path.join(transportRoot, "guest-result.json"), "guest\n");
        try {
            await assert.rejects(() => executeStage3Launcher({closureRoot: tempRoot, closureRecords: [],
                transportRoot, envelopeRoot, binding: {hostedContext: {}}, acquired: {}, probeArtifact: {}}, {
                verifyClosure: () => ({valid: true}), buildStage2Request: () => ({}),
                buildStage3Template: () => ({}), buildStage3Request: () => ({}),
                buildSequenceRequest: () => ({}), runSequence: async () => ({status: "observed"}),
                inspectEvidence: () => { throw new Error("consumer refusal"); }
            }), /consumer refusal/);
            assert.equal(fs.existsSync(path.join(transportRoot,
                STAGE3_LAUNCHER_CONSTANTS.STAGE3_RESULT_FILE)), true);
            assert.equal(fs.existsSync(path.join(transportRoot,
                STAGE3_LAUNCHER_CONSTANTS.ACCEPTED_INSPECTION_FILE)), false);
        } finally {
            fs.rmSync(tempRoot, {recursive: true, force: true});
        }
    });

    it("timeout and partial-result paths write bounded failure evidence without claiming acceptance", () => {
        const tempRoot = makeTempDir("myspeed-stage3-failure-bounds-");
        try {
            const evidenceRoot = path.join(tempRoot, "evidence");
            const largeStderr = "E".repeat(2 * 1024 * 1024); // 2 MB
            const largeStdout = "O".repeat(2 * 1024 * 1024); // 2 MB

            const summary = writeBoundedFailureEvidence({
                evidenceRoot,
                error: new Error("Simulation of sequence timeout after 90m"),
                streams: {stdout: largeStdout, stderr: largeStderr}
            });

            assert.equal(summary.accepted, false);
            assert.equal(summary.qualifying, false);
            assert.equal(summary.releaseGateCleared, false);
            assert.equal(summary.status, "failed");

            // Files must be capped at 1 MB
            const stdoutStat = fs.statSync(path.join(evidenceRoot, "controller.stdout"));
            const stderrStat = fs.statSync(path.join(evidenceRoot, "controller.stderr"));
            assert.ok(stdoutStat.size <= 1024 * 1024, `stdout ${stdoutStat.size} > 1 MB`);
            assert.ok(stderrStat.size <= 1024 * 1024, `stderr ${stderrStat.size} > 1 MB`);

            // Evidence manifest must be written and non-accepting
            const manifest = JSON.parse(fs.readFileSync(path.join(evidenceRoot, "evidence-manifest.json"), "utf8"));
            assert.equal(manifest.accepted, false);
            assert.equal(manifest.qualifying, false);
            assert.equal(manifest.releaseGatesCleared.length, 0);
            assert.equal(manifest.status, "failed");
        } finally {
            fs.rmSync(tempRoot, {recursive: true, force: true});
        }
    });

    it("refuses acceptance and writes failure evidence when transport root path does not match canonical hosted transport contract", async () => {
        const {binding, acquired} = buildBinding();
        const template = buildV161PostReleaseCpuFloorStage3Template(acquired);
        const fixture = await buildPostReleaseStage3Fixture(template.candidate);
        const tempRoot = makeTempDir("myspeed-stage3-launcher-transport-mismatch-");
        const closureRoot = path.join(tempRoot, "closure");
        const envelopeRoot = path.join(tempRoot, "envelope");
        const transportRoot = path.join(tempRoot, "transport");
        fs.mkdirSync(envelopeRoot);
        fs.mkdirSync(transportRoot);
        try {
            const records = populateCopiedClosure(closureRoot);
            const probeFiles = ["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good", "popcnt", "sse42"]
                .map(role => ({role, name: `${role.replaceAll("-", "_")}.exe`, bytes: "100", sha256: "0".repeat(64)}));
            const probeArtifact = {
                sourceSha: CANDIDATE_SHA,
                runId: "12345",
                runAttempt: "1",
                artifactId: "99999",
                archiveBytes: "1000",
                archiveSha256: "0".repeat(64),
                files: probeFiles
            };

            let sequenceObserved = false;
            const runSequence = async (sequenceRequest) => {
                sequenceObserved = true;
                assert.equal(sequenceRequest.schemaVersion, 1);
                assert.equal(sequenceRequest.kind, "myspeed-windows-cpu-floor-stage3-sequence");
                assert.equal(sequenceRequest.transportRoot, transportRoot);
                assert.equal(fs.existsSync(path.join(envelopeRoot, "request.json")), true);
                fs.writeFileSync(path.join(transportRoot, "stage2-result.json"), fixture.retainedStage2Bytes);
                fs.writeFileSync(path.join(transportRoot, "guest-result.json"), fixture.retainedStage2GuestBytes);
                return fixture.completedResult;
            };

            // When executeStage3Launcher runs with default inspectEvidence, sameExecutionStage2 derives
            // from the actual read path (in local tempRoot). Because tempRoot does not match the canonical
            // hosted contract (/home/runner/work/_temp/myspeed-stage2-transport-<nonce>), the consumer
            // validator strictly rejects the mismatched declared/actual transport root.
            await assert.rejects(
                () => executeStage3Launcher({
                    closureRoot,
                    closureRecords: records,
                    transportRoot,
                    envelopeRoot,
                    binding,
                    acquired,
                    probeArtifact,
                    guestFiles: []
                }, {
                    fileIdentity: targetPath => ({path: targetPath, bytes: "100", sha256: "0".repeat(64)}),
                    runSequence
                }),
                /Stage 2 result path is invalid|Stage 2 retained evidence paths differ/
            );

            assert.equal(sequenceObserved, true);

            // Accepted inspection must NOT be written
            assert.equal(fs.existsSync(path.join(transportRoot,
                STAGE3_LAUNCHER_CONSTANTS.ACCEPTED_INSPECTION_FILE)), false);

            // Bounded failure evidence must be retained
            const manifest = JSON.parse(fs.readFileSync(
                path.join(transportRoot, "evidence-manifest.json"), "utf8"));
            assert.equal(manifest.accepted, false);
            assert.equal(manifest.status, "failed");
        } finally {
            fs.rmSync(tempRoot, {recursive: true, force: true});
        }
    });

    it("refuses acceptance in real consumer when retained Stage 2 evidence bytes are corrupted", async () => {
        const {binding, acquired} = buildBinding();
        const template = buildV161PostReleaseCpuFloorStage3Template(acquired);
        const fixture = await buildPostReleaseStage3Fixture(template.candidate);
        assert.throws(
            () => inspectCompletedStage3Sequence({
                binding,
                acquired,
                sequenceResult: fixture.completedResult,
                sameExecutionStage2: fixture.request.stage2,
                stage2ResultBytes: Buffer.from("{\"corrupted\":\"evidence\"}\n")
            }),
            /Stage 2 observation keys are invalid|retained Stage 2 result bytes differ/
        );
    });

    it("refuses acceptance in real consumer when candidate source SHA in sequence result does not match binding", async () => {
        const {binding, acquired} = buildBinding();
        const template = buildV161PostReleaseCpuFloorStage3Template(acquired);
        const fixture = await buildPostReleaseStage3Fixture(template.candidate);
        const tamperedResult = {
            ...fixture.completedResult,
            candidate: {
                ...fixture.completedResult.candidate,
                candidate: {
                    ...fixture.completedResult.candidate.candidate,
                    sourceSha: "0".repeat(40)
                }
            }
        };
        assert.throws(
            () => inspectCompletedStage3Sequence({
                binding,
                acquired,
                sequenceResult: tamperedResult,
                sameExecutionStage2: fixture.request.stage2,
                stage2ResultBytes: fixture.retainedStage2Bytes
            }),
            /acquired candidate provenance differs/
        );
    });

});
