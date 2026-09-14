import {describe, it} from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
    buildWindowsNativeStandaloneExecutionPlan,
    buildWindowsNativeStandaloneAcquiredExecutionPlan,
    executeWindowsNativeStandaloneExecutionPlan,
    executeWindowsNativeStandaloneRequestFiles,
    materializeWindowsNativeStandaloneFixture
} from "../../scripts/qualification/windows-native-standalone-hosted.mjs";
import {createWindowsNativeStandaloneEvidenceFixture} from
    "../helpers/windows-native-standalone-evidence-fixture.mjs";
import {assertWindowsNativeStandaloneProofRequest} from "../../scripts/qualification/windows-native-standalone-proof.mjs";

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/qualification/windows-native-standalone-hosted.mjs");

const HASH = "a".repeat(64);
const SOURCE_SHA = "b".repeat(40);
const EVENT_SHA = "c".repeat(40);
const NONCE = "0123456789abcdef0123456789abcdef";
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const PRESEAL_ARCHIVE_DIGEST = `sha256:${"9".repeat(64)}`;
const inventory = root => Object.fromEntries(fs.readdirSync(root, {recursive: true, withFileTypes: true})
    .filter(entry => entry.isFile()).map(entry => {
        const file = path.join(entry.parentPath, entry.name);
        return [path.relative(root, file).replaceAll(path.sep, "/"), sha(fs.readFileSync(file))];
    }).sort(([left], [right]) => left.localeCompare(right)));

const createTransport = root => {
    const populated = path.join(root, "transport-populated");
    const reset = path.join(root, "transport-reset");
    fs.mkdirSync(path.join(populated, "data", "servers"), {recursive: true});
    fs.mkdirSync(path.join(populated, "bin"), {recursive: true});
    fs.mkdirSync(path.join(reset, "data", "servers"), {recursive: true});
    fs.mkdirSync(path.join(reset, "bin"), {recursive: true});
    const populatedNonce = "1".repeat(48);
    const resetNonce = "2".repeat(48);
    const createdAt = "2026-09-14T00:00:00.000Z";
    for (const [directory, nonce] of [[populated, populatedNonce], [reset, resetNonce]]) {
        for (const provider of ["ookla.json", "librespeed.json"])
            fs.writeFileSync(path.join(directory, "data", "servers", provider), "{}\n", {flag: "wx"});
        for (const binary of ["speedtest.exe", "librespeed-cli.exe", "cfspeedtest.exe", "iperf3.exe"])
            fs.writeFileSync(path.join(directory, "bin", binary), `fixture ${nonce}\n`, {flag: "wx"});
        fs.writeFileSync(path.join(directory, ".myspeed-qualification.json"), JSON.stringify({nonce,
            root: directory, dataDirectory: path.join(directory, "data"), binaryDirectory: path.join(directory, "bin"),
            createdAt}, null, 2) + "\n", {flag: "wx"});
    }
    fs.writeFileSync(path.join(populated, "data", "storage.db"), "sqlite-fixture", {flag: "wx"});
    const manifest = {schemaVersion: 1, source: {commit: SOURCE_SHA, bunLockSha256: HASH,
        packageSha256: "d".repeat(64)}, populated: {root: "C:\\producer\\populated", nonce: populatedNonce,
        markerSha256: sha(fs.readFileSync(path.join(populated, ".myspeed-qualification.json"))),
        databaseSha256: sha(fs.readFileSync(path.join(populated, "data", "storage.db"))),
        filesSha256: inventory(populated)}, reset: {root: "C:\\producer\\reset", nonce: resetNonce,
        markerSha256: sha(fs.readFileSync(path.join(reset, ".myspeed-qualification.json"))),
        filesSha256: inventory(reset)}, expected: {ping: "123.456", resultId: "qualification-seed-row",
        passwordValueSha256: "e".repeat(64)}};
    const manifestPath = path.join(root, "transport.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), {flag: "wx"});
    return {manifestPath, populated, reset, manifest};
};

const executionInput = () => {
    const taskRoot = `C:\\runner\\myspeed-native-standalone-${NONCE}`;
    const closure = `${taskRoot}\\closure`;
    const scenarios = ["populated-first-boot", "populated-restart", "fresh-no-config-reset"];
    return {schemaVersion: 1, kind: "myspeed-windows-native-standalone-execution-input", qualifying: false,
        expectedRunId: "12345", expectedRunAttempt: "2", expectedEventSha: EVENT_SHA,
        expectedSourceSha: SOURCE_SHA, expectedImageVersion: "20260914.1", nonce: NONCE,
        qualification: {sourceSha: SOURCE_SHA, runId: "98765", runAttempt: "3", manifestSha256: HASH,
            artifactId: "8001", artifactDigest: `sha256:${"f".repeat(64)}`}, taskRoot,
        closure: {proofPath: `${closure}\\windows-native-standalone-proof.mjs`, proofSha256: HASH,
            adapterPath: `${closure}\\windows-native-standalone-adapter.mjs`, adapterSha256: HASH,
            hostPath: `${closure}\\windows-native-standalone-host.ps1`, hostSha256: HASH,
            candidateControllerPath: `${closure}\\windows-native-candidate-controller.ps1`,
            candidateControllerSha256: HASH, cleanStopControllerPath: `${closure}\\windows-clean-stop-controller.ps1`,
            cleanStopControllerSha256: HASH, canaryPath: `${closure}\\windows-winsw-offline-canary.ps1`,
            canarySha256: HASH}, node: {path: "C:\\hostedtoolcache\\node.exe", sha256: HASH},
        powershell: {path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", sha256: HASH},
        fixtures: ["default", "baseline"].map(alias => ({alias,
            manifestPath: `${taskRoot}\\fixture-${alias}.json`, manifestSha256: HASH,
            populatedWork: `${taskRoot}\\fixture-${alias}-populated`, resetWork: `${taskRoot}\\fixture-${alias}-reset`})),
        candidates: ["default", "baseline"].map((alias, aliasIndex) => ({alias,
            artifactLogicalName: alias === "default" ? "MySpeed-windows-x64.exe" : "MySpeed-windows-x64-baseline.exe",
            artifactId: String(7001 + aliasIndex), artifactDigest: `sha256:${String(aliasIndex + 7).repeat(64)}`,
            sourcePath: `${taskRoot}\\candidate-${alias}\\${alias === "default" ? "MySpeed-windows-x64.exe" : "MySpeed-windows-x64-baseline.exe"}`,
            expectedSha256: String(aliasIndex + 1).repeat(64),
            sourceIdentity: {path: `${taskRoot}\\candidate-${alias}\\${alias === "default" ? "MySpeed-windows-x64.exe" : "MySpeed-windows-x64-baseline.exe"}`,
                bytes: 1024 + aliasIndex, sha256: String(aliasIndex + 1).repeat(64), volumeSerial: "1".repeat(8),
                fileId: String(aliasIndex + 2).repeat(16), linkCount: 1, reparsePoint: false},
            scenarios: scenarios.map((scenario, scenarioIndex) => {
                const scenarioNonce = crypto.createHash("sha256").update(`${NONCE}\0${alias}\0${scenario}`)
                    .digest("hex").slice(0, 32);
                const root = `C:\\runner\\myspeed-native-candidate-${scenarioNonce}`;
                return {scenario, nonce: scenarioNonce, taskRoot: root, candidatePath: `${root}\\MySpeed.exe`,
                    candidateIdentity: {path: `${root}\\MySpeed.exe`, bytes: 1024 + aliasIndex,
                        sha256: String(aliasIndex + 1).repeat(64), volumeSerial: "3".repeat(8),
                        fileId: String(scenarioIndex + 4).repeat(16), linkCount: 1, reparsePoint: false},
                    controllerPath: `${root}\\windows-clean-stop-controller.ps1`};
            })}))};
};

const acquiredExecutionInput = () => {
    const input = executionInput();
    const releaseAssets = [
        ["MySpeed-windows-x64.exe", "MySpeed-windows-x64.exe", input.candidates[0].expectedSha256],
        ["MySpeed-windows-x64-baseline.exe", "MySpeed-windows-x64-baseline.exe",
            input.candidates[1].expectedSha256],
        ["release-msi-MySpeed-installer.msi", "MySpeed-installer.msi", "4".repeat(64)],
        ["release-msi-MySpeed-installer-baseline.msi", "MySpeed-installer-baseline.msi", "5".repeat(64)]
    ];
    const actionsArtifacts = releaseAssets.map(([artifact], index) => ({name: artifact, id: 7001 + index,
        archiveSize: 4096 + index, archiveDigest: `sha256:${String(index + 6).repeat(64)}`}));
    input.candidates.forEach((candidate, index) => {
        candidate.artifactId = String(actionsArtifacts[index].id);
        candidate.artifactDigest = actionsArtifacts[index].archiveDigest;
    });
    const manifest = {schemaVersion: 1, source: {repository: "i7Gamer/MySpeed", sha: SOURCE_SHA},
        run: {id: Number(input.expectedRunId), attempt: Number(input.expectedRunAttempt)},
        promotion: {eligible: false, evidence: {windowsNative: null, windowsCpuFloor: null, msiLifecycle: null},
            blockers: ["Windows native full verification with enforced outbound denial",
                "Windows native CPU-floor verification", "Disposable Windows MSI lifecycle acceptance"]},
        actionsArtifacts, releaseAssets: releaseAssets.map(([artifact, name, digest], index) => ({artifact,
            path: index < 2 ? "MySpeed.exe" : "MySpeed-installer.msi", name, sha256: digest, size: 1024 + index}))};
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    input.qualification = {repository: "i7Gamer/MySpeed", sourceSha: SOURCE_SHA,
        runId: input.expectedRunId, runAttempt: input.expectedRunAttempt,
        manifestPath: "C:\\runner\\preseal\\qualification-manifest.json", artifactId: "9001",
        artifactDigest: PRESEAL_ARCHIVE_DIGEST, artifactSize: bytes.length + 128};
    return {input, bytes};
};

describe("Windows native standalone hosted request factory", () => {
    it("binds an acquired same-run preseal and both exact candidate artifacts before building requests", async () => {
        const acquired = acquiredExecutionInput();
        const plan = await buildWindowsNativeStandaloneAcquiredExecutionPlan(acquired.input, {
            readBytes: async file => {
                assert.equal(file, acquired.input.qualification.manifestPath);
                return acquired.bytes;
            }
        });
        assert.equal(plan.proofRequest.manifestSha256, sha(acquired.bytes));
        assert.equal(plan.proofRequest.qualificationRunId, acquired.input.expectedRunId);
        assert.equal(plan.proofRequest.candidates[0].artifactId, acquired.input.candidates[0].artifactId);
        for (const mutate of [
            value => { value.candidates[0].artifactDigest = `sha256:${"0".repeat(64)}`; },
            value => { value.candidates[1].expectedSha256 = "0".repeat(64); },
            value => { value.expectedRunAttempt = "3"; }
        ]) {
            const changed = acquiredExecutionInput();
            mutate(changed.input);
            await assert.rejects(buildWindowsNativeStandaloneAcquiredExecutionPlan(changed.input,
                {readBytes: async () => changed.bytes}), /preseal|candidate|qualification|run/i);
        }
    });

    it("invokes the guarded host and replays all three retained raw evidence documents", async () => {
        const evidence = await createWindowsNativeStandaloneEvidenceFixture();
        const proofRequest = JSON.parse(evidence.proofRequestBytes.toString("utf8"));
        const hostRequest = JSON.parse(evidence.hostRequestBytes.toString("utf8"));
        const plan = {proofRequest, proofRequestBytes: evidence.proofRequestBytes,
            proofRequestSha256: sha(evidence.proofRequestBytes), hostRequest,
            hostRequestBytes: evidence.hostRequestBytes, hostRequestSha256: sha(evidence.hostRequestBytes)};
        const invocations = [];
        const files = new Map([[hostRequest.resultPath, evidence.hostResultBytes],
            [hostRequest.coordinatorArguments[2], evidence.proofRequestBytes],
            [path.win32.join(hostRequest.taskRoot, "host.request.json"), evidence.hostRequestBytes]]);
        const inspection = await executeWindowsNativeStandaloneExecutionPlan(plan, {
            invokeHost: async value => { invocations.push(value); return {exitCode: 0, stdout: "", stderr: ""}; },
            readBytes: async file => files.get(file)
        });
        assert.equal(invocations.length, 1);
        const hostJsonLimit = 262_144;
        const windowsLineEndingBytes = 2;
        assert.ok(invocations[0].maximumOutputBytes >= hostJsonLimit + windowsLineEndingBytes,
            "stdout must fit the host's full bounded JSON result and line ending");
        assert.ok(invocations[0].maximumOutputBytes >= evidence.hostResultBytes.length + windowsLineEndingBytes);
        const forcedCleanupTimeoutMs = 10_000;
        const postDeadlineCleanupOperations = 8;
        const coldStartupAllowanceMs = 60_000;
        assert.ok(invocations[0].timeoutMilliseconds >= hostRequest.hardDeadlineMs
            + postDeadlineCleanupOperations * forcedCleanupTimeoutMs + coldStartupAllowanceMs,
        "outer termination must leave room for cold startup and bounded cleanup after the inner deadline");
        assert.equal(invocations[0].executable, proofRequest.powershellPath);
        assert.deepEqual(invocations[0].arguments.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive",
            "-ExecutionPolicy"]);
        assert.ok(invocations[0].arguments.includes(hostRequest.hostPath));
        assert.ok(invocations[0].arguments.includes(plan.hostRequestSha256));
        assert.equal(inspection.status, "accepted");
        assert.equal(inspection.hostResultSha256, sha(evidence.hostResultBytes));
        const fromFiles = await executeWindowsNativeStandaloneRequestFiles({
            hostRequestPath: path.win32.join(hostRequest.taskRoot, "host.request.json"),
            hostRequestSha256: plan.hostRequestSha256,
            proofRequestPath: hostRequest.coordinatorArguments[2], proofRequestSha256: plan.proofRequestSha256
        }, {invokeHost: async () => ({exitCode: 0, stdout: "", stderr: ""}),
            readBytes: async file => files.get(file)});
        assert.deepEqual(fromFiles, inspection);
        await assert.rejects(executeWindowsNativeStandaloneExecutionPlan(plan, {
            invokeHost: async () => ({exitCode: 1, stdout: "", stderr: "bounded failure"}),
            readBytes: async file => files.get(file)
        }), /host exited 1: bounded failure/u);
        await assert.rejects(executeWindowsNativeStandaloneExecutionPlan(plan, {
            invokeHost: async () => ({exitCode: 0, stdout: "", stderr: ""}),
            readBytes: async file => file === hostRequest.coordinatorArguments[2]
                ? Buffer.concat([files.get(file), Buffer.from(" ")]) : files.get(file)
        }), /retained request bytes changed/u);
    });

    it("revalidates and relocates an exact transport fixture before creating an executor-local handoff", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-standalone-transport-"));
        try {
            const transport = createTransport(root);
            const output = {outputManifestPath: path.join(root, "execution.json"),
                populatedRoot: path.join(root, "execution-populated"), resetRoot: path.join(root, "execution-reset")};
            const value = await materializeWindowsNativeStandaloneFixture({...transport,
                ...output, expectedSourceSha: SOURCE_SHA});
            assert.equal(value.populated.root, path.resolve(output.populatedRoot));
            assert.equal(value.reset.root, path.resolve(output.resetRoot));
            assert.equal(value.populated.databaseSha256, transport.manifest.populated.databaseSha256);
            assert.equal(JSON.parse(fs.readFileSync(path.join(output.populatedRoot,
                ".myspeed-qualification.json"), "utf8")).root, path.resolve(output.populatedRoot));
            assert.equal(value.populated.filesSha256[".myspeed-qualification.json"], value.populated.markerSha256);
            await assert.rejects(materializeWindowsNativeStandaloneFixture({...transport,
                ...output, expectedSourceSha: SOURCE_SHA}), /existing|exists/i);
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("builds six distinct exact controller requests and cross-bound proof and host requests", () => {
        const plan = buildWindowsNativeStandaloneExecutionPlan(executionInput());
        assert.deepEqual(assertWindowsNativeStandaloneProofRequest(plan.proofRequest), plan.proofRequest);
        assert.equal(plan.controllerRequests.length, 6);
        assert.equal(new Set(plan.controllerRequests.map(entry => entry.value.taskRoot.toLowerCase())).size, 6);
        assert.equal(plan.proofRequest.candidates[0].controllerRequests.length, 3);
        assert.equal(plan.proofRequest.qualificationManifestArtifactId, "8001");
        assert.equal(plan.proofRequest.qualificationManifestArtifactDigest, `sha256:${"f".repeat(64)}`);
        assert.equal(plan.hostRequest.proofRequestSha256, plan.proofRequestSha256);
        assert.equal(plan.proofRequest.candidates[0].sha256, executionInput().candidates[0].expectedSha256);
        assert.deepEqual(plan.hostRequest.coordinatorArguments,
            [executionInput().closure.proofPath, "--request", `${executionInput().taskRoot}\\proof.request.json`,
                "--sha256", plan.proofRequestSha256]);
        for (const entry of plan.controllerRequests) {
            assert.equal(entry.value.taskRoot.endsWith(entry.value.nonce), true);
            assert.equal(entry.value.candidatePath.startsWith(`${entry.value.taskRoot}\\`), true);
            assert.equal(entry.value.controllerPath.startsWith(`${entry.value.taskRoot}\\`), true);
            assert.deepEqual(entry.value.arguments,
                entry.value.scenario === "fresh-no-config-reset" ? ["--reset-password"] : []);
        }
    });

    it("writes the exact request graph through the bounded stdin CLI", {skip: process.platform !== "win32"}, () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-standalone-plan-"));
        try {
            const input = executionInput();
            input.taskRoot = path.join(parent, `myspeed-native-standalone-${NONCE}`);
            const closure = path.join(input.taskRoot, "closure");
            Object.assign(input.closure, {
                proofPath: path.join(closure, "windows-native-standalone-proof.mjs"),
                adapterPath: path.join(closure, "windows-native-standalone-adapter.mjs"),
                hostPath: path.join(closure, "windows-native-standalone-host.ps1"),
                candidateControllerPath: path.join(closure, "windows-native-candidate-controller.ps1"),
                cleanStopControllerPath: path.join(closure, "windows-clean-stop-controller.ps1"),
                canaryPath: path.join(closure, "windows-winsw-offline-canary.ps1")
            });
            input.node.path = path.join(input.taskRoot, "tools", "node.exe");
            input.powershell.path = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
            input.fixtures.forEach(entry => {
                entry.manifestPath = path.join(input.taskRoot, `fixture-${entry.alias}.json`);
                entry.populatedWork = path.join(input.taskRoot, `fixture-${entry.alias}-populated`);
                entry.resetWork = path.join(input.taskRoot, `fixture-${entry.alias}-reset`);
            });
            input.candidates.forEach(candidate => {
                candidate.sourcePath = path.join(input.taskRoot, `candidate-${candidate.alias}`,
                    candidate.artifactLogicalName);
                candidate.sourceIdentity.path = candidate.sourcePath;
                candidate.scenarios.forEach(scenario => {
                    scenario.taskRoot = path.join(parent, `myspeed-native-candidate-${scenario.nonce}`);
                    scenario.candidatePath = path.join(scenario.taskRoot, "MySpeed.exe");
                    scenario.candidateIdentity.path = scenario.candidatePath;
                    scenario.controllerPath = path.join(scenario.taskRoot, "windows-clean-stop-controller.ps1");
                    fs.mkdirSync(scenario.taskRoot);
                });
            });
            fs.mkdirSync(input.taskRoot);
            const result = childProcess.spawnSync(process.execPath, [MODULE, "--build"], {
                input: JSON.stringify(input), encoding: "utf8", timeout: 15_000
            });
            assert.equal(result.status, 0, result.stderr);
            const summary = JSON.parse(result.stdout);
            assert.equal(summary.controllerRequests.length, 6);
            assert.equal(summary.proofRequestSha256,
                sha(fs.readFileSync(path.join(input.taskRoot, "proof.request.json"))));
            assert.equal(summary.hostRequestSha256,
                sha(fs.readFileSync(path.join(input.taskRoot, "host.request.json"))));
            for (const entry of summary.controllerRequests)
                assert.equal(entry.sha256, sha(fs.readFileSync(entry.path)));
        } finally { fs.rmSync(parent, {recursive: true, force: true}); }
    });

    it("rejects stale qualification, alias, scenario, identity and path bindings", () => {
        for (const mutate of [
            value => { value.qualification.sourceSha = "0".repeat(40); },
            value => { value.candidates[0].artifactLogicalName = "wrong"; },
            value => { value.candidates[0].scenarios.reverse(); },
            value => { value.candidates[0].expectedSha256 = "0".repeat(64); },
            value => { value.candidates[0].scenarios[0].candidateIdentity.sha256 = "0".repeat(64); },
            value => { value.candidates[0].scenarios[0].candidateIdentity.path = value.candidates[0].sourcePath; },
            value => { value.candidates[0].scenarios[0].controllerPath =
                `${value.candidates[0].scenarios[0].taskRoot}\\windows-native-candidate-controller.ps1`; },
            value => { value.candidates[0].sourceIdentity.linkCount = 2; },
            value => { value.candidates[0].scenarios[0].taskRoot = value.taskRoot; },
            value => { value.fixtures[1].alias = "default"; }
        ]) {
            const input = structuredClone(executionInput());
            mutate(input);
            assert.throws(() => buildWindowsNativeStandaloneExecutionPlan(input));
        }
    });
});
