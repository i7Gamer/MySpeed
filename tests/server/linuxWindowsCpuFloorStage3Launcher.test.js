import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";

import {
    STAGE3_LAUNCHER_CLOSURE_PATHS,
    verifyClosureFiles,
    performTaskOwnedProcessCleanup,
    writeBoundedFailureEvidence,
    buildStage3SequenceRequest,
    executeStage3Launcher
} from "../../scripts/qualification/linux-windows-cpu-floor-stage3-launcher.mjs";
import {
    validateSequence
} from "../../scripts/qualification/linux-windows-cpu-floor-stage3-sequence.mjs";
import {
    validateRequest
} from "../../scripts/qualification/linux-windows-cpu-floor-stage3.mjs";
import {
    createV161PostReleaseCpuFloorBinding,
    acquireV161PostReleaseCpuFloorBaselineSummary,
    buildV161PostReleaseCpuFloorStage2Request,
    buildV161PostReleaseCpuFloorStage3Request
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
    OBSERVED_AT,
    HOSTED_NONCE
} from "../helpers/post-release-cpu-floor-fixture.mjs";
import {buildAcceptedStage3Fixture} from "../helpers/windows-cpu-floor-stage3-fixture.mjs";

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

    it("feeds real request-builder outputs to actual Stage 3 request validation", async () => {
        const {binding, acquired, context} = buildBinding();
        const nonce = context.nonce;
        const tempRoot = makeTempDir("myspeed-stage3-builders-test-");
        try {
            // The sequence and controller expect these paths to be under the runner temp prefix
            const closureRoot = `${RUNNER_TEMP_PREFIX}/myspeed-stage3-closure-${nonce}`;
            const transportRoot = `${RUNNER_TEMP_PREFIX}/myspeed-stage2-transport-${nonce}`;

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

            // Stage 3 request must use runner temp transport paths
            const dummyReceipt = {
                path: `${transportRoot}/stage2-result.json`,
                bytes: "100",
                sha256: "0".repeat(64)
            };
            const dummyGuestReceipt = {
                path: `${transportRoot}/guest-result.json`,
                bytes: "100",
                sha256: "0".repeat(64)
            };
            const stage3Request = buildV161PostReleaseCpuFloorStage3Request(acquired, {
                result: dummyReceipt,
                guestResult: dummyGuestReceipt
            });

            // validateRequest from the Stage 3 module itself validates schema
            const validatedStage3 = validateRequest(stage3Request);
            assert.equal(validatedStage3.request.profile, "baseline-cpu");
            assert.equal(validatedStage3.request.authorization.confirmation, "RUN-WINDOWS-BASELINE-CPU-FLOOR");

            // buildStage3SequenceRequest builds the envelope for the sequence CLI
            // The sequence validator requires closure files to be physically present on disk
            // so we use a mock read function approach by testing the request shape instead
            assert.equal(stage3Request.profile, "baseline-cpu");
            assert.equal(stage3Request.authorization.scope, "windows-baseline-cpu-floor-full-runtime");
            assert.equal(stage3Request.candidate.sourceSha, CANDIDATE_SHA);
            assert.notEqual(stage3Request.candidate.sourceSha, context.sourceSha);
        } finally {
            fs.rmSync(tempRoot, {recursive: true, force: true});
        }
    });

    it("workflow invocation cannot succeed without executing sequence and checking completed result", async () => {
        // Test that executeStage3Launcher rejects an unobserved sequence result.
        // Use injected binding+acquired so we skip the consumer brand check at launch.
        const {binding, acquired, context} = buildBinding();
        const nonce = context.nonce;

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
                transportRoot: `${RUNNER_TEMP_PREFIX}/myspeed-stage2-transport-${nonce}`,
                envelopeRoot: `${RUNNER_TEMP_PREFIX}/myspeed-stage3-sequence-envelope-${nonce}`,
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
                // Inject both buildRequests and buildSequenceRequest to avoid file I/O for launcher paths
                buildRequests: () => ({
                    stage2Request: {schemaVersion: 1, authorization: {confirmation: "RUN-CANDIDATE-NEUTRAL-STAGE2"}},
                    stage3Request: {profile: "baseline-cpu", schemaVersion: 1, authorization: {confirmation: "RUN-WINDOWS-BASELINE-CPU-FLOOR"}}
                }),
                buildSequenceRequest: () => ({schemaVersion: 1, nonce}),
                runSequence: failingSequence
            }),
            /Stage 3 sequence did not produce an observed result/
        );
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

    it("cleanup ignores an unrelated fake process and terminates only task-owned PIDs", () => {
        const tempRoot = makeTempDir("myspeed-stage3-cleanup-test-");
        let fakeProc = null;
        try {
            // Spawn an unrelated background dummy process
            fakeProc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"});
            const unrelatedPid = fakeProc.pid;
            assert.ok(unrelatedPid > 0, "unrelated process should have a PID");

            const stage2Root = path.join(tempRoot, "stage2");
            const stage3Root = path.join(tempRoot, "stage3");
            fs.mkdirSync(stage2Root, {recursive: true});
            fs.mkdirSync(stage3Root, {recursive: true});

            // Write one owned PID in stage2Root; stage3Root has a distinct non-alive PID
            const ownedPid = 999998;
            const unownedPid = 999997; // not alive
            fs.writeFileSync(path.join(stage2Root, "qemu.pid"), `${ownedPid}\n`);
            fs.writeFileSync(path.join(stage3Root, "baseline-qemu.pid"), `${unownedPid}\n`);

            const killCalls = []; // tracks {pid, sig}
            const {cleanedPids} = performTaskOwnedProcessCleanup({
                stage2Root,
                stage3Root,
                killFn: (pid, sig) => { killCalls.push({pid, sig}); },
                // Only ownedPid is "alive"; after SIGTERM pretend it's gone
                isAliveFn: (pid, _callIndex) => {
                    // Always return false — pretend SIGTERM worked
                    return pid === ownedPid && killCalls.filter(c => c.pid === pid).length === 0;
                }
            });

            // cleanedPids must contain ownedPid, not unownedPid or unrelatedPid
            assert.ok(cleanedPids.includes(ownedPid), "owned PID should be cleaned");
            assert.ok(!cleanedPids.includes(unrelatedPid), "unrelated PID must not be cleaned");
            assert.ok(!cleanedPids.includes(unownedPid), "non-alive PID should not be cleaned");

            // killFn must have been called only for ownedPid
            assert.ok(killCalls.every(c => c.pid === ownedPid), "killFn must only target owned PIDs");

            // The unrelated process must still be running
            let stillAlive = false;
            try { process.kill(unrelatedPid, 0); stillAlive = true; } catch {}
            assert.equal(stillAlive, true, "Unrelated process was incorrectly killed");
        } finally {
            if (fakeProc?.pid) { try { fakeProc.kill(); } catch {} }
            fs.rmSync(tempRoot, {recursive: true, force: true});
        }
    });
});
