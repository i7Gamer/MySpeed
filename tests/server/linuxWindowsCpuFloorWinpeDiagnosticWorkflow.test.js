import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";

import {parse} from "yaml";

import {
    WINPE_DIAGNOSTIC_JOB_CEILING_MILLISECONDS,
    WINPE_DIAGNOSTIC_RESERVATION_LABEL,
    WINPE_DIAGNOSTIC_KILL_GRACE_MILLISECONDS,
    WINPE_DIAGNOSTIC_RETENTION_RESERVE_MILLISECONDS,
    WINPE_DIAGNOSTIC_CLEANUP_MILLISECONDS,
    WINPE_DIAGNOSTIC_COLLECTION_RESERVE_MILLISECONDS,
    WINPE_DIAGNOSTIC_GUEST_ALLOWANCE_MILLISECONDS,
    WINPE_DIAGNOSTIC_MINIMUM_SEQUENCE_MILLISECONDS,
    WINPE_DIAGNOSTIC_MINIMUM_SEQUENCE_SECONDS,
    anchorWinpeDiagnosticJobBudget,
    admitWinpeDiagnosticReservation,
    createHostedCpuFloorCleanupOperations
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";
import {
    readCpuFloorCleanupAuthorityReceipt,
    cleanupTaskOwnedCpuProcesses,
    CPU_FLOOR_CLEANUP_CONSTANTS
} from "../../scripts/qualification/linux-windows-cpu-floor-stage3-cleanup.mjs";
import {verifyWinpeDiagnosticCleanup} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2-controller.mjs";
import {INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs";
import {WINPE_DIAGNOSTIC_CLASSIFICATION} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS = path.join(HERE, "..", "..", ".github", "workflows");
const DIAGNOSTIC = path.join(WORKFLOWS, "winpe-answer-file-diagnostic.yml");
const STAGE2 = path.join(WORKFLOWS, "linux-windows-cpu-floor-stage2.yml");
const text = fs.readFileSync(DIAGNOSTIC, "utf8");
const workflow = parse(text);
const step = name => workflow.jobs.execute.steps.find(value => value.name === name);

describe("WinPE answer-file diagnostic workflow", () => {
    it("is dispatch-only, under its own confirmation, and never on a schedule or a push", () => {
        assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
        assert.equal(text.includes("schedule:"), false);
        assert.equal(text.includes("RUN-WINPE-ANSWER-FILE-DIAGNOSTIC"), true);
        assert.match(workflow.jobs.execute.if, /RUN-WINPE-ANSWER-FILE-DIAGNOSTIC/u);
        assert.match(workflow.jobs.execute.if, /i7Gamer\/MySpeed/u);
        assert.deepEqual(workflow.permissions, {actions: "read", contents: "read"});
    });

    it("declares its own ceiling rather than inheriting the Stage 2 template's", () => {
        assert.equal(workflow.jobs.execute["timeout-minutes"],
            WINPE_DIAGNOSTIC_JOB_CEILING_MILLISECONDS / 60_000);
        assert.equal(workflow.jobs.prepare["timeout-minutes"], 10);
        const stage2Ceilings = [...fs.readFileSync(STAGE2, "utf8")
            .matchAll(/^\s*timeout-minutes: (\d+)$/gmu)].map(match => Number(match[1]));
        assert.deepEqual(stage2Ceilings, [10, 300]);
        assert.equal(workflow.jobs.execute["timeout-minutes"], 25);
    });

    it("anchors the budget to authenticated job metadata, with no local-clock fallback", () => {
        const anchor = step("Anchor the diagnostic budget to authenticated job metadata");
        assert.ok(anchor, "the anchor step is required");
        assert.match(anchor.with.script, /listJobsForWorkflowRunAttempt/u);
        assert.match(anchor.with.script, /anchorWinpeDiagnosticJobBudget/u);
        assert.equal(anchor.env.EXECUTE_JOB_NAME, workflow.jobs.execute.name,
            "the anchor has to name the job it is actually running in");
        /* The anchor runs before anything spends the budget it produces. */
        const names = workflow.jobs.execute.steps.map(value => value.name);
        assert.ok(names.indexOf(anchor.name) < names.indexOf("Build the diagnostic request and execute it"));
        const build = step("Build the diagnostic request and execute it");
        assert.equal(build.env.WINPE_WALL_DEADLINE_MILLISECONDS,
            "${{ steps.budget.outputs.deadline_ms }}");
        assert.match(build.run, /winpeDiagnosticBudget: \{label: "winpe-answer-file-diagnostic"/u);
        assert.equal(WINPE_DIAGNOSTIC_RESERVATION_LABEL, "winpe-answer-file-diagnostic");
    });

    it("authorizes the diagnostic explicitly and binds it to this run's nonce", () => {
        const build = step("Build the diagnostic request and execute it");
        assert.match(build.run, /winpeDiagnostic: \{confirmation: "winpe-answer-file-diagnostic-v1",\s*nonce: context\.nonce\}/u);
        /* The diagnostic and one specific boot acknowledgement are independently authorized. */
        assert.match(build.run, new RegExp(`bootConfirmation: "${INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME}"`, "u"));
    });

    it("distinguishes capture-complete, inconclusive and unsafe, and fails on unsafe", () => {
        const bound = step("Bound and classify the retained diagnostic evidence");
        for (const outcome of ["capture-complete", "inconclusive", "unsafe", "no-diagnostic-record",
            "refused-before-launch"])
            assert.ok(bound.run.includes(`"${outcome}"`), `outcome ${outcome} is missing`);
        assert.ok(bound.run.includes(WINPE_DIAGNOSTIC_CLASSIFICATION));
        /* The three flags are necessary but never sufficient on their own. */
        assert.match(bound.run, /flagsCorrect && result\.status === "diagnostic"/u);
        const gate = step("Require a safe, bounded diagnostic record");
        assert.match(gate.run, /capture-complete\|inconclusive\|refused-before-launch\) exit 0/u);
        assert.match(gate.run, /\*\) exit 1/u);
        assert.equal(gate.run.includes("unsafe) exit 0"), false);
    });

    it("uploads only the bounded redacted record, never the controller streams", () => {
        const upload = step("Upload the bounded, redacted diagnostic evidence");
        const uploaded = upload.with.path.split("\n").filter(line => line.trim().length > 0);
        assert.deepEqual(uploaded.map(line => path.posix.basename(line.trim())),
            ["diagnostic-result.json", "transport-summary.json"]);
        assert.equal(upload.with.path.includes("controller.stdout"), false);
        assert.equal(upload.with.path.includes("controller.stderr"), false);
        assert.equal(upload.with.path.includes("serial.log"), false);
        assert.equal(upload.with.path.includes("output.img"), false);
        /* The streams are still measured, so their absence is a decision and not an oversight. */
        const bound = step("Bound and classify the retained diagnostic evidence");
        assert.match(bound.run, /controller\.stdout/u);
        assert.match(bound.run, /never uploaded/u);
    });

    it("seals the exact nine-module closure including stage3 cleanup and runs the diagnostic suites before sealing it", () => {
        const tests = workflow.jobs.prepare.steps
            .find(value => value.name === "Run pure and injected closure tests").run;
        for (const suite of ["linuxWindowsCpuFloorWinpeDiagnosticQmp", "linuxWindowsCpuFloorWinpeDiagnosticScript",
            "linuxWindowsCpuFloorWinpeDiagnosticPublication", "linuxWindowsCpuFloorWinpeDiagnosticCollection",
            "linuxWindowsCpuFloorWinpeDiagnosticContract", "linuxWindowsCpuFloorWinpeDiagnosticWorkflow",
            "linuxWindowsCpuFloorStage3Cleanup"])
            assert.ok(tests.includes(`tests/server/${suite}.test.js`), `${suite} is not run before sealing`);
        const seal = workflow.jobs.prepare.steps.find(value => value.name === "Seal exact nine-module closure");
        assert.ok(seal, "seal step must be named Seal exact nine-module closure");
        const sealed = [...seal.run.matchAll(/install -m 600 scripts\/qualification\/([a-z0-9-]+\.mjs)/gu)]
            .map(match => match[1]);
        /* Nine closure members plus the two KVM modules staged a second time for the probe. */
        assert.deepEqual([...new Set(sealed)].sort(), [
            "linux-kvm-capability.mjs", "linux-kvm-privileged-capability.mjs",
            "linux-windows-cpu-floor-admission.mjs", "linux-windows-cpu-floor-stage2-controller.mjs",
            "linux-windows-cpu-floor-stage2-hosted.mjs", "linux-windows-cpu-floor-stage2-qmp.mjs",
            "linux-windows-cpu-floor-stage2.mjs", "linux-windows-cpu-floor-stage3-cleanup.mjs",
            "windows-msi-post-setup-activation.mjs"]);
        const manifestBlock = seal.run.slice(seal.run.indexOf("const names ="), seal.run.indexOf("const files ="));
        const manifestNames = [...manifestBlock.matchAll(/"([^"]+\.mjs)"/gu)].map(match => match[1]);
        assert.deepEqual(manifestNames, [
            "scripts/qualification/linux-windows-cpu-floor-admission.mjs",
            "scripts/qualification/linux-windows-cpu-floor-stage2-controller.mjs",
            "scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs",
            "scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs",
            "scripts/qualification/linux-windows-cpu-floor-stage2.mjs",
            "scripts/qualification/linux-windows-cpu-floor-stage3-cleanup.mjs",
            "scripts/qualification/linux-kvm-capability.mjs",
            "scripts/qualification/linux-kvm-privileged-capability.mjs",
            "scripts/qualification/windows-msi-post-setup-activation.mjs"]);
    });

    it("derives controller outer timeout bounds and charges kill grace inside the limit", () => {
        assert.equal(WINPE_DIAGNOSTIC_MINIMUM_SEQUENCE_MILLISECONDS, WINPE_DIAGNOSTIC_MINIMUM_SEQUENCE_SECONDS * 1_000);
        assert.equal(WINPE_DIAGNOSTIC_COLLECTION_RESERVE_MILLISECONDS, 60_000);
        const build = step("Build the diagnostic request and execute it");
        assert.equal(build.env.WINPE_WALL_DEADLINE_MILLISECONDS, "${{ steps.budget.outputs.deadline_ms }}");
        assert.equal(build.env.WINPE_HARD_STOP_MILLISECONDS, "${{ steps.budget.outputs.hard_stop_ms }}");
        assert.equal(build.env.SEQUENCE_KILL_GRACE_SECONDS, String(WINPE_DIAGNOSTIC_KILL_GRACE_MILLISECONDS / 1_000));
        assert.equal(build.env.MINIMUM_SEQUENCE_SECONDS, String(WINPE_DIAGNOSTIC_MINIMUM_SEQUENCE_SECONDS));
        assert.match(build.run, /grace_ms=\$\(\( WINPE_HARD_STOP_MILLISECONDS - WINPE_WALL_DEADLINE_MILLISECONDS \)\)/u);
        assert.match(build.run, /remaining_seconds=\$\(\( \(WINPE_WALL_DEADLINE_MILLISECONDS - now_ms\) \/ 1000 \)\)/u);
        assert.match(build.run, /remaining_seconds" -lt "\$MINIMUM_SEQUENCE_SECONDS/u);
        assert.match(build.run, /timeout --signal=TERM --kill-after=/u);
    });

    it("enforces independent always-run task-owned cleanup and fails closed on unproven cleanup", () => {
        const cleanup = step("Verify task-owned process cleanup");
        assert.ok(cleanup, "cleanup step is required");
        assert.equal(cleanup.if, "${{ always() && steps.execute_diagnostic.outcome != 'skipped' }}");
        assert.match(cleanup.run, /proof\.cleanupProven !== true/u);
        assert.match(cleanup.run, /verifyWinpeDiagnosticCleanup/u);

        const gate = step("Require a safe, bounded diagnostic record");
        assert.match(gate.run, /test "\$\{\{ steps\.cleanup\.outcome \}\}" = "success"/u,
            "gate must fail closed if cleanup failed, even with an inconclusive or complete outcome");
    });
});

describe("WinPE answer-file diagnostic budget and cleanup behavioral tests", () => {
    const NOW = 1_700_000_000_000;
    const STARTED_AT = NOW - 60_000; // started 1 minute ago

    it("anchors job budget to authenticated job metadata and derives valid bounds", () => {
        const jobs = [{
            name: "Collect WinPE answer-file diagnostics",
            run_id: 12345,
            run_attempt: 1,
            runner_name: "hosted-runner-1",
            status: "in_progress",
            started_at: new Date(STARTED_AT).toISOString()
        }];
        const anchor = anchorWinpeDiagnosticJobBudget({
            jobs, totalCount: 1,
            jobName: "Collect WinPE answer-file diagnostics",
            runId: "12345", runAttempt: "1", runnerName: "hosted-runner-1"
        }, () => NOW);
        assert.equal(anchor.startedAtUnixMilliseconds, STARTED_AT);
        assert.equal(anchor.hardStopUnixMilliseconds,
            STARTED_AT + WINPE_DIAGNOSTIC_JOB_CEILING_MILLISECONDS - WINPE_DIAGNOSTIC_RETENTION_RESERVE_MILLISECONDS);
        assert.equal(anchor.wallDeadlineUnixMilliseconds,
            anchor.hardStopUnixMilliseconds - WINPE_DIAGNOSTIC_KILL_GRACE_MILLISECONDS);
        assert.equal(anchor.remainingMilliseconds, anchor.wallDeadlineUnixMilliseconds - NOW);
    });

    it("refuses ambiguous, absent, future, or stale job start anchors", () => {
        assert.throws(() => anchorWinpeDiagnosticJobBudget({
            jobs: [], totalCount: 0,
            jobName: "Collect WinPE answer-file diagnostics",
            runId: "12345", runAttempt: "1", runnerName: "hosted-runner-1"
        }, () => NOW), /ambiguous or absent/u);

        const twoJobs = [
            {name: "Collect WinPE answer-file diagnostics", run_id: 12345, run_attempt: 1,
             runner_name: "hosted-runner-1", status: "in_progress", started_at: new Date(STARTED_AT).toISOString()},
            {name: "Collect WinPE answer-file diagnostics", run_id: 12345, run_attempt: 1,
             runner_name: "hosted-runner-1", status: "in_progress", started_at: new Date(STARTED_AT).toISOString()}
        ];
        assert.throws(() => anchorWinpeDiagnosticJobBudget({
            jobs: twoJobs, totalCount: 2,
            jobName: "Collect WinPE answer-file diagnostics",
            runId: "12345", runAttempt: "1", runnerName: "hosted-runner-1"
        }, () => NOW), /ambiguous or absent/u);

        const futureJob = [{
            name: "Collect WinPE answer-file diagnostics", run_id: 12345, run_attempt: 1,
            runner_name: "hosted-runner-1", status: "in_progress", started_at: new Date(NOW + 10_000).toISOString()
        }];
        assert.throws(() => anchorWinpeDiagnosticJobBudget({
            jobs: futureJob, totalCount: 1,
            jobName: "Collect WinPE answer-file diagnostics",
            runId: "12345", runAttempt: "1", runnerName: "hosted-runner-1"
        }, () => NOW), /start is invalid/u);

        const staleJob = [{
            name: "Collect WinPE answer-file diagnostics", run_id: 12345, run_attempt: 1,
            runner_name: "hosted-runner-1", status: "in_progress",
            started_at: new Date(NOW - WINPE_DIAGNOSTIC_JOB_CEILING_MILLISECONDS - 1_000).toISOString()
        }];
        assert.throws(() => anchorWinpeDiagnosticJobBudget({
            jobs: staleJob, totalCount: 1,
            jobName: "Collect WinPE answer-file diagnostics",
            runId: "12345", runAttempt: "1", runnerName: "hosted-runner-1"
        }, () => NOW), /start is invalid/u);
    });

    it("tightens allowance as preparation takes time and rejects prelaunch when budget exhausted", () => {
        const wallDeadline = NOW + 10 * 60_000;
        const budget = {label: WINPE_DIAGNOSTIC_RESERVATION_LABEL, wallDeadlineUnixMilliseconds: wallDeadline};
        assert.throws(() => admitWinpeDiagnosticReservation(budget, () => NOW, () => 0),
            /does not fit/u);

        const ampleDeadline = NOW + 20 * 60_000;
        const ampleBudget = {label: WINPE_DIAGNOSTIC_RESERVATION_LABEL, wallDeadlineUnixMilliseconds: ampleDeadline};
        const admitted = admitWinpeDiagnosticReservation(ampleBudget, () => NOW, () => 1_000);
        assert.equal(admitted.reservation.label, WINPE_DIAGNOSTIC_RESERVATION_LABEL);
        assert.equal(admitted.reservation.executionMilliseconds, WINPE_DIAGNOSTIC_GUEST_ALLOWANCE_MILLISECONDS);
        assert.equal(admitted.reservation.cleanupMilliseconds, WINPE_DIAGNOSTIC_CLEANUP_MILLISECONDS);
    });

    it("handles timeout exit codes (124, 137) and preserves diagnostic retention", () => {
        for (const exitCode of ["0", "1", "124", "137"]) {
            const parsed = /^(0|[1-9][0-9]{0,2})$/u.test(exitCode) ? Number(exitCode) : null;
            assert.equal(parsed, Number(exitCode));
        }
        assert.equal(/^(0|[1-9][0-9]{0,2})$/u.test(""), false);
        assert.equal(/^(0|[1-9][0-9]{0,2})$/u.test("unknown"), false);
    });

    it("uses the production cleanup proof to distinguish a known no-launch from an uncertain launch", async () => {
        assert.throws(() => readCpuFloorCleanupAuthorityReceipt("missing-file"), /path is invalid/u);
        const defaultOps = createHostedCpuFloorCleanupOperations();
        assert.equal(typeof defaultOps.isProcessGroupAlive, "function");
        const cleanupNonce = "0123456789abcdef0123456789abcdef";
        const cleanupRoot = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${cleanupNonce}`;
        const cleanupPaths = {root: cleanupRoot, nonce: cleanupNonce, qemuPid: `${cleanupRoot}/qemu.pid`,
            controllerResult: `/home/runner/work/_temp/myspeed-winpe-diagnostic-transport-${cleanupNonce}/diagnostic-result.json`};
        const knownNoLaunch = await verifyWinpeDiagnosticCleanup(cleanupPaths, {
            readLifecycleMarker: target => target.endsWith("controller-started") ? "controller-started" : null,
            pathExists: () => false
        });
        assert.deepEqual(knownNoLaunch, {cleanupProven: true, status: "known-no-launch"});
        const rejectedBeforeLaunch = await verifyWinpeDiagnosticCleanup(cleanupPaths, {
            readLifecycleMarker: () => null,
            pathExists: () => false,
            readRejectedBeforeLaunchResult: (target, nonce) => target === cleanupPaths.controllerResult &&
                nonce === cleanupNonce
        });
        assert.deepEqual(rejectedBeforeLaunch, {cleanupProven: true, status: "known-no-launch"});
        await assert.rejects(verifyWinpeDiagnosticCleanup(cleanupPaths, {
            readLifecycleMarker: () => "launch-attempted",
            pathExists: () => false
        }), /authority is absent after a possible launch/u);
        await assert.rejects(verifyWinpeDiagnosticCleanup(cleanupPaths, {
            readLifecycleMarker: () => null,
            pathExists: () => false
        }), /no-launch proof is absent/u);

        const authority = {
            pid: 1001, processGroupId: 1001, startTicks: "12345", executablePath: "/usr/bin/qemu-system-x86_64"
        };
        let alive = true;
        const killed = await cleanupTaskOwnedCpuProcesses({
            authorities: [authority],
            deadlineMilliseconds: CPU_FLOOR_CLEANUP_CONSTANTS.DEFAULT_CLEANUP_MILLISECONDS
        }, {
            readProcessIdentity: async pid => (alive ? {state: "present", pid, processGroupId: pid, startTicks: "12345", executablePath: "/usr/bin/qemu-system-x86_64"} : {state: "absent"}),
            signalProcessGroup: (_group, sig) => { if (sig === "SIGTERM" || sig === "SIGKILL") alive = false; },
            isProcessGroupAlive: async () => alive,
            monotonicMilliseconds: () => 0,
            wait: async () => {}
        });
        assert.equal(killed.cleanupProven, true);
        assert.equal(killed.results[0].status, "terminated");

        const unkillable = await cleanupTaskOwnedCpuProcesses({
            authorities: [authority],
            deadlineMilliseconds: 1_000
        }, {
            readProcessIdentity: async pid => ({state: "present", pid, processGroupId: pid, startTicks: "12345", executablePath: "/usr/bin/qemu-system-x86_64"}),
            signalProcessGroup: () => {},
            isProcessGroupAlive: async () => true,
            monotonicMilliseconds: (() => { let t = 0; return () => (t += 500); })(),
            wait: async () => {}
        });
        assert.equal(unkillable.cleanupProven, false);
    });
});
