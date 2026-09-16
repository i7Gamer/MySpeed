import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
    WINPE_DIAGNOSTIC_CLASSIFICATION,
    WINPE_DIAGNOSTIC_MEMBERS,
    WINPE_DIAGNOSTIC_SEED_MARKER_NAME,
    runWindowsCpuFloorStage2,
    validateWinpeDiagnosticEvidence
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";
import {
    WINPE_DIAGNOSTIC_CLEANUP_MILLISECONDS,
    WINPE_DIAGNOSTIC_COLLECTION_RESERVE_MILLISECONDS,
    WINPE_DIAGNOSTIC_GUEST_ALLOWANCE_MILLISECONDS,
    WINPE_DIAGNOSTIC_JOB_CEILING_MILLISECONDS,
    WINPE_DIAGNOSTIC_KILL_GRACE_MILLISECONDS,
    WINPE_DIAGNOSTIC_RESERVATION_LABEL,
    WINPE_DIAGNOSTIC_RETENTION_RESERVE_MILLISECONDS,
    admitWinpeDiagnosticReservation,
    anchorWinpeDiagnosticJobBudget,
    createWinpeDiagnosticCollectionBudget
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";
import {WINPE_DIAGNOSTIC_CONFIRMATION, winpeDiagnosticScriptName} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs";
import {runHostedStage2Controller} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2-controller.mjs";

const NONCE = "0123456789abcdef0123456789abcdef";
const AUTHORIZATION = {confirmation: WINPE_DIAGNOSTIC_CONFIRMATION, nonce: NONCE};
const ROOT = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${NONCE}`;
const CONTEXT = Object.freeze({schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: "a".repeat(40),
    eventSha: "b".repeat(40), runId: "42", runAttempt: "1", nonce: NONCE,
    environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
        RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260901.1"}});
const PATHS = Object.freeze({root: ROOT, packageRoot: `${ROOT}/packages`,
    portableRoot: `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}`, probeRoot: `${ROOT}/probes`,
    windowsIso: `${ROOT}/windows.iso`, installWim: `${ROOT}/install.wim`, seedIso: `${ROOT}/seed.iso`,
    outputDisk: `${ROOT}/output.img`, systemDisk: `${ROOT}/system.qcow2`, ovmfVars: `${ROOT}/OVMF_VARS.fd`,
    serialLog: `${ROOT}/serial.log`, qemuPid: `${ROOT}/qemu.pid`});

function collection(overrides = {}) {
    return {schemaVersion: 1, kind: "winpe-answer-file-diagnostic-collection", status: "capture-complete",
        outputDiskVerified: true, failure: null, members: WINPE_DIAGNOSTIC_MEMBERS.slice(0, 2).map(member => ({
            name: member.name, role: member.role, status: "absent", acceptedBytes: 0,
            readCapReached: false, exitCode: 1})), ...overrides};
}

function evidence(overrides = {}) {
    return {schemaVersion: 1, kind: "winpe-answer-file-diagnostic", nonce: NONCE,
        confirmation: WINPE_DIAGNOSTIC_CONFIRMATION, input: null, collection: collection(), ...overrides};
}

/* A Stage 2 run whose only real operation is the launch; every earlier stage is refused on purpose. */
async function runDiagnosticStage2(launchObservation, {admission = {}} = {}) {
    const operations = Object.fromEntries(["acquirePackages", "acquireProbeClosure", "acquireWindowsIso",
        "extractInstallWim", "extractPortableTools", "inspectInstallWim", "launchOwnedQemu",
        "prepareOfflineMedia", "resolveSignedPackageClosure"]
        .map(name => [name, async () => { throw new Error(`${name} is not stubbed`); }]));
    operations.launchOwnedQemu = async () => launchObservation;
    return await runWindowsCpuFloorStage2({context: CONTEXT, admission, paths: PATHS,
        probeArtifact: {}, winpeDiagnostic: AUTHORIZATION,
        admitWinpeDiagnostic: () => ({reservation: {label: WINPE_DIAGNOSTIC_RESERVATION_LABEL,
            executionMilliseconds: 360_000, cleanupMilliseconds: 300_000},
        collectionDeadlineMilliseconds: 720_000})}, operations);
}

describe("WinPE diagnostic evidence validation", () => {
    it("accepts a bound payload and refuses one bound to anything else", () => {
        assert.equal(validateWinpeDiagnosticEvidence(evidence(), CONTEXT, AUTHORIZATION).nonce, NONCE);
        assert.throws(() => validateWinpeDiagnosticEvidence(evidence(), CONTEXT, undefined),
            /is not authorized/u);
        assert.throws(() => validateWinpeDiagnosticEvidence(evidence({nonce: "f".repeat(32)}), CONTEXT,
            AUTHORIZATION), /binding is invalid/u);
        assert.throws(() => validateWinpeDiagnosticEvidence(evidence({confirmation: "other"}), CONTEXT,
            AUTHORIZATION), /binding is invalid/u);
        assert.throws(() => validateWinpeDiagnosticEvidence({...evidence(), extra: 1}, CONTEXT,
            AUTHORIZATION), /keys are invalid/u);
    });

    it("refuses an unknown status, an unknown member and a duplicated member", () => {
        assert.throws(() => validateWinpeDiagnosticEvidence(
            evidence({collection: collection({status: "ok"})}), CONTEXT, AUTHORIZATION),
        /collection is invalid/u);
        assert.throws(() => validateWinpeDiagnosticEvidence(evidence({collection: collection(
            {members: [{name: "SECRETS.TXT", role: "start-marker", status: "captured"}]})}), CONTEXT,
        AUTHORIZATION), /member is invalid/u);
        const duplicated = {name: "MSDIAG.STA", role: "start-marker", status: "absent"};
        assert.throws(() => validateWinpeDiagnosticEvidence(
            evidence({collection: collection({members: [duplicated, duplicated]})}), CONTEXT, AUTHORIZATION),
        /member is invalid/u);
    });

    it("refuses a captured member whose published bytes do not match their own digest", () => {
        const body = Buffer.from("collected line\r\n", "utf8");
        const captured = {name: "MSACT.LOG", role: "setup-action-log", status: "captured",
            acceptedBytes: body.length, readCapReached: false, encoding: "utf-8", bom: false,
            trailingOddByte: false, decodeReplacements: 0, redactionHits: 0, partialRedactionHits: 0,
            publishedBytes: body.length, publicationTruncated: false,
            sha256: "0".repeat(64), textBase64: body.toString("base64")};
        assert.throws(() => validateWinpeDiagnosticEvidence(
            evidence({collection: collection({members: [captured]})}), CONTEXT, AUTHORIZATION),
        /identity differs/u);
    });
});

describe("WinPE diagnostic result is never a calibration on an authorized failure exit", () => {
    it("carries the diagnostic classification at the admission refusal, before anything is launched", async () => {
        const failed = await runDiagnosticStage2(null);
        assert.equal(failed.status, "failed");
        assert.equal(failed.stage, "admission");
        assert.equal(failed.classification, WINPE_DIAGNOSTIC_CLASSIFICATION);
        assert.equal(failed.qualifying, false);
        assert.equal(failed.releaseGateCleared, false);
        assert.equal(failed.cpuCalibrationAccepted, false);
        assert.deepEqual(failed.context, CONTEXT);
    });

    it("leaves an unauthorized run on exactly the calibration classification it had", async () => {
        const operations = Object.fromEntries(["acquirePackages", "acquireProbeClosure", "acquireWindowsIso",
            "extractInstallWim", "extractPortableTools", "inspectInstallWim", "launchOwnedQemu",
            "prepareOfflineMedia", "resolveSignedPackageClosure"]
            .map(name => [name, async () => { throw new Error("not stubbed"); }]));
        const failed = await runWindowsCpuFloorStage2({context: CONTEXT, admission: {}, paths: PATHS,
            probeArtifact: {}}, operations);
        assert.equal(failed.classification,
            "github-hosted-windows-cpu-floor-stage2-calibration-nonqualifying");
        assert.equal(Object.hasOwn(failed, "winpeDiagnostic"), false);
    });

    it("refuses an authorization bound to another run before anything is launched", async () => {
        await assert.rejects(runWindowsCpuFloorStage2({context: CONTEXT, admission: {}, paths: PATHS,
            probeArtifact: {}, winpeDiagnostic: {confirmation: WINPE_DIAGNOSTIC_CONFIRMATION,
                nonce: "f".repeat(32)}, admitWinpeDiagnostic: () => ({})}, {}),
        /not bound to this run/u);
        /* And a diagnostic with no way to take its budget is a programming error, not a run. */
        await assert.rejects(runWindowsCpuFloorStage2({context: CONTEXT, admission: {}, paths: PATHS,
            probeArtifact: {}, winpeDiagnostic: AUTHORIZATION}, {}), /not bound to this run/u);
    });
});

describe("WinPE diagnostic whole-job budget", () => {
    const jobs = (overrides = {}) => [{name: "Collect WinPE answer-file diagnostics", run_id: 42,
        run_attempt: 1, runner_name: "runner-1", status: "in_progress",
        started_at: "2026-09-16T10:00:00Z", ...overrides}];
    const anchorRequest = (jobList = jobs()) => ({jobs: jobList, totalCount: jobList.length,
        jobName: "Collect WinPE answer-file diagnostics", runId: "42", runAttempt: "1",
        runnerName: "runner-1"});
    const startedAt = Date.parse("2026-09-16T10:00:00Z");

    it("anchors to authenticated job metadata and reserves retention and kill grace inside the ceiling", () => {
        const anchor = anchorWinpeDiagnosticJobBudget(anchorRequest(), () => startedAt + 30_000);
        assert.equal(anchor.startedAtUnixMilliseconds, startedAt);
        assert.equal(anchor.hardStopUnixMilliseconds,
            startedAt + WINPE_DIAGNOSTIC_JOB_CEILING_MILLISECONDS - WINPE_DIAGNOSTIC_RETENTION_RESERVE_MILLISECONDS);
        assert.equal(anchor.wallDeadlineUnixMilliseconds,
            anchor.hardStopUnixMilliseconds - WINPE_DIAGNOSTIC_KILL_GRACE_MILLISECONDS);
        assert.ok(anchor.wallDeadlineUnixMilliseconds <
            startedAt + WINPE_DIAGNOSTIC_JOB_CEILING_MILLISECONDS);
    });

    it("refuses an ambiguous, absent, queued or impossible anchor rather than using a fresh clock", () => {
        assert.throws(() => anchorWinpeDiagnosticJobBudget(anchorRequest([]), () => startedAt),
            /ambiguous or absent/u);
        assert.throws(() => anchorWinpeDiagnosticJobBudget(
            anchorRequest([...jobs(), ...jobs()]), () => startedAt), /ambiguous or absent/u);
        assert.throws(() => anchorWinpeDiagnosticJobBudget(
            anchorRequest(jobs({status: "queued"})), () => startedAt), /ambiguous or absent/u);
        assert.throws(() => anchorWinpeDiagnosticJobBudget(
            anchorRequest(jobs({started_at: "not a date"})), () => startedAt), /job start is invalid/u);
        /* A job that claims to have started after now, or longer ago than the ceiling. */
        assert.throws(() => anchorWinpeDiagnosticJobBudget(anchorRequest(), () => startedAt - 1),
            /job start is invalid/u);
        assert.throws(() => anchorWinpeDiagnosticJobBudget(anchorRequest(),
            () => startedAt + WINPE_DIAGNOSTIC_JOB_CEILING_MILLISECONDS + 1), /job start is invalid/u);
    });

    it("converts the wall deadline into a launch reservation only while the guest allowance fits", () => {
        const wallDeadline = startedAt + WINPE_DIAGNOSTIC_JOB_CEILING_MILLISECONDS -
            WINPE_DIAGNOSTIC_RETENTION_RESERVE_MILLISECONDS - WINPE_DIAGNOSTIC_KILL_GRACE_MILLISECONDS;
        const budget = {label: WINPE_DIAGNOSTIC_RESERVATION_LABEL, wallDeadlineUnixMilliseconds: wallDeadline};
        const admitted = admitWinpeDiagnosticReservation(budget, () => startedAt + 1_000, () => 5_000);
        assert.deepEqual({...admitted.reservation}, {label: WINPE_DIAGNOSTIC_RESERVATION_LABEL,
            executionMilliseconds: WINPE_DIAGNOSTIC_GUEST_ALLOWANCE_MILLISECONDS,
            cleanupMilliseconds: WINPE_DIAGNOSTIC_CLEANUP_MILLISECONDS});
        assert.equal(admitted.collectionDeadlineMilliseconds, 5_000 +
            WINPE_DIAGNOSTIC_GUEST_ALLOWANCE_MILLISECONDS + WINPE_DIAGNOSTIC_CLEANUP_MILLISECONDS +
            WINPE_DIAGNOSTIC_COLLECTION_RESERVE_MILLISECONDS);

        /* One millisecond too late and the run is refused rather than launched on a short budget. */
        const tooLate = wallDeadline - WINPE_DIAGNOSTIC_CLEANUP_MILLISECONDS -
            WINPE_DIAGNOSTIC_COLLECTION_RESERVE_MILLISECONDS - WINPE_DIAGNOSTIC_GUEST_ALLOWANCE_MILLISECONDS + 1;
        assert.throws(() => admitWinpeDiagnosticReservation(budget, () => tooLate, () => 5_000),
            /does not fit/u);
        assert.throws(() => admitWinpeDiagnosticReservation({...budget, label: "other"},
            () => startedAt, () => 0), /budget is invalid/u);
    });

    it("refuses a backwards clock and an exhausted collection budget before each phase", () => {
        let now = 1_000;
        const budget = createWinpeDiagnosticCollectionBudget(4_000, () => now);
        assert.equal(budget.admit(10_000), 3_000);
        now = 3_500;
        assert.equal(budget.admit(10_000), 500);
        now = 3_400;
        assert.throws(() => budget.admit(10), /not monotonic/u);
        now = 5_000;
        assert.throws(() => budget.admit(10), /exhausted/u);
    });
});

describe("WinPE diagnostic controller authorization", () => {
    it("refuses a diagnostic authorization without its budget, and a budget without the authorization", async () => {
        const request = {schemaVersion: 1, context: CONTEXT, paths: PATHS,
            authorization: {confirmation: "RUN-CANDIDATE-NEUTRAL-STAGE2", media: true, qemu: true,
                scope: "candidate-neutral-cpu-calibration", winpeDiagnostic: AUTHORIZATION},
            closure: {root: "", files: []}, kvm: {}, probeArtifact: {}, probeStage: {}};
        await assert.rejects(runHostedStage2Controller(request), /keys are invalid/u);
        const withBudgetOnly = {...request,
            authorization: {confirmation: "RUN-CANDIDATE-NEUTRAL-STAGE2", media: true, qemu: true,
                scope: "candidate-neutral-cpu-calibration"},
            winpeDiagnosticBudget: {label: WINPE_DIAGNOSTIC_RESERVATION_LABEL,
                wallDeadlineUnixMilliseconds: 1}};
        await assert.rejects(runHostedStage2Controller(withBudgetOnly), /keys are invalid/u);
    });

    it("refuses a job whose remaining budget cannot hold a guest, before any expensive setup", async () => {
        const collected = [];
        const request = {schemaVersion: 1, context: CONTEXT, paths: PATHS,
            authorization: {confirmation: "RUN-CANDIDATE-NEUTRAL-STAGE2", media: true, qemu: true,
                scope: "candidate-neutral-cpu-calibration", winpeDiagnostic: AUTHORIZATION},
            winpeDiagnosticBudget: {label: WINPE_DIAGNOSTIC_RESERVATION_LABEL,
                wallDeadlineUnixMilliseconds: Date.now() + 1_000},
            closure: {root: `/home/runner/work/_temp/myspeed-stage2-closure-${NONCE}`, files: []},
            kvm: {}, probeArtifact: {}, probeStage: {}};
        await assert.rejects(runHostedStage2Controller(request, {
            readVerified: () => { collected.push("read"); return {bytes: Buffer.alloc(1), sha256: "0".repeat(64)}; },
            collectAdmission: async () => { collected.push("admission"); return {}; }}),
        /keys are invalid|does not fit/u);
    });

    it("refuses a diagnostic authorization bound to a different nonce", async () => {
        const request = {schemaVersion: 1, context: CONTEXT, paths: PATHS,
            authorization: {confirmation: "RUN-CANDIDATE-NEUTRAL-STAGE2", media: true, qemu: true,
                scope: "candidate-neutral-cpu-calibration",
                winpeDiagnostic: {confirmation: WINPE_DIAGNOSTIC_CONFIRMATION, nonce: "f".repeat(32)}},
            winpeDiagnosticBudget: {label: WINPE_DIAGNOSTIC_RESERVATION_LABEL,
                wallDeadlineUnixMilliseconds: 1},
            closure: {root: "", files: []}, kvm: {}, probeArtifact: {}, probeStage: {}};
        await assert.rejects(runHostedStage2Controller(request), /WinPE diagnostic is not authorized/u);
    });
});

describe("WinPE diagnostic seed media", () => {
    it("names a script and a marker that only an authorized run can put on the seed", () => {
        assert.match(winpeDiagnosticScriptName(NONCE), /^[a-f0-9]{8}\.cmd$/u);
        assert.equal(WINPE_DIAGNOSTIC_SEED_MARKER_NAME, "seed.tag");
        assert.equal(WINPE_DIAGNOSTIC_MEMBERS.length, 7);
    });
});
