import {afterEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve("scripts/qualification/windows-cpu-readiness-controller.ps1");
const POWERSHELL = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const PROCESS_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;
const RUN_ID = "123456789";
const RUN_ATTEMPT = "2";
const EVENT_SHA = "1".repeat(40);
const SOURCE_SHA = "2".repeat(40);
const NONCE = "3".repeat(32);
const CLOSURE_KIND = "myspeed-windows-cpu-readiness-closure";
const MANIFEST_NAME = "closure.json";
const FILES = [
    "windows-cpu-floor-probe.c",
    "windows-cpu-readiness.ps1",
    "windows-cpu-readiness-controller.ps1",
    "windows-cpu-tool-child.ps1",
    "windows-cpu-file-identity.ps1",
    "media-job-launcher.ps1"
];
const OPERATION_IDS = [
    "discover-vswhere", "environment-preflight",
    ...["cpuid", "known-good", "known-bad", "illegal", "sse42", "popcnt", "avx", "avx2"].flatMap(mode =>
        [`compile-${mode}`, `link-${mode}`]),
    ...["cpuid", "illegal", "sse42", "popcnt", "avx", "avx2"].map(mode => `disassemble-${mode}`),
    ...["cpuid", "known-good", "known-bad", "illegal", "sse42", "popcnt", "avx", "avx2"].map(mode => `probe-${mode}`)
];
const roots = [];

const invoke = (mode, values = {}, environment = process.env) => {
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Mode", mode];
    for (const [name, value] of Object.entries(values)) args.push(`-${name}`, String(value));
    return childProcess.spawnSync(POWERSHELL, args, {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS, env: {...environment}});
};

const fixture = () => {
    const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-cpu-controller-")));
    roots.push(parent);
    const closureRoot = path.join(parent, "closure");
    fs.mkdirSync(closureRoot);
    for (const name of FILES) fs.writeFileSync(path.join(closureRoot, name), `fixture:${name}\n`);
    const manifestPath = path.join(closureRoot, MANIFEST_NAME);
    const evidencePath = path.join(parent, `myspeed-cpu-readiness-${NONCE}`, "result.json");
    return {parent, closureRoot, manifestPath, evidencePath};
};

const bound = value => ({
    ExpectedRunId: RUN_ID,
    ExpectedRunAttempt: RUN_ATTEMPT,
    ExpectedEventSha: EVENT_SHA,
    ExpectedSourceSha: SOURCE_SHA,
    Nonce: NONCE,
    ...value
});

describe("Windows CPU readiness controller", {skip: process.platform !== "win32" && "Windows only"}, () => {
    it("emits only the exact six-file run-bound manifest with create-new semantics", {timeout: TEST_TIMEOUT_MS}, () => {
        const value = fixture();
        const first = invoke("EmitClosureManifest", bound({ClosureRoot: value.closureRoot, ManifestPath: value.manifestPath}));
        assert.equal(first.error, undefined, first.error?.message);
        assert.equal(first.status, 0, first.stderr);
        const manifest = JSON.parse(fs.readFileSync(value.manifestPath, "utf8"));
        assert.equal(manifest.schemaVersion, 1);
        assert.equal(manifest.kind, CLOSURE_KIND);
        assert.equal(manifest.expectedRunId, RUN_ID);
        assert.deepEqual(manifest.files.map(file => file.name), FILES);
        for (const entry of manifest.files) {
            const bytes = fs.readFileSync(path.join(value.closureRoot, entry.name));
            assert.equal(entry.bytes, bytes.length);
            assert.equal(entry.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
        }
        const duplicate = invoke("EmitClosureManifest", bound({ClosureRoot: value.closureRoot, ManifestPath: value.manifestPath}));
        assert.notEqual(duplicate.status, 0);
        assert.match(duplicate.stderr, /exists|create-new/i);
    });

    it("rejects closure membership and path drift before manifest creation", {timeout: TEST_TIMEOUT_MS}, () => {
        for (const mutate of [
            value => { fs.writeFileSync(path.join(value.closureRoot, "extra.ps1"), "extra"); },
            value => { fs.unlinkSync(path.join(value.closureRoot, FILES[0])); },
            value => { value.manifestPath = path.join(value.parent, "outside.json"); }
        ]) {
            const value = fixture();
            mutate(value);
            const result = invoke("EmitClosureManifest", bound({ClosureRoot: value.closureRoot, ManifestPath: value.manifestPath}));
            assert.notEqual(result.status, 0);
            assert.equal(fs.existsSync(value.manifestPath), false);
        }
    });

    it("validates exact manifest bindings, file order, lengths, and hashes", {timeout: TEST_TIMEOUT_MS}, () => {
        const value = fixture();
        const produced = invoke("EmitClosureManifest", bound({ClosureRoot: value.closureRoot, ManifestPath: value.manifestPath}));
        assert.equal(produced.status, 0, produced.stderr);
        const accepted = invoke("TestValidateClosure", bound({ClosureRoot: value.closureRoot, ManifestPath: value.manifestPath}));
        assert.equal(accepted.status, 0, accepted.stderr);
        assert.equal(JSON.parse(accepted.stdout).accepted, true);

        for (const mutate of [
            manifest => { manifest.expectedRunAttempt = "3"; },
            manifest => { manifest.files[0].bytes += 1; },
            manifest => { manifest.files[0].sha256 = "f".repeat(64); },
            manifest => { manifest.files.reverse(); },
            manifest => { manifest.extra = true; }
        ]) {
            const changed = fixture();
            const generated = invoke("EmitClosureManifest", bound({ClosureRoot: changed.closureRoot, ManifestPath: changed.manifestPath}));
            assert.equal(generated.status, 0, generated.stderr);
            const manifest = JSON.parse(fs.readFileSync(changed.manifestPath, "utf8"));
            mutate(manifest);
            fs.writeFileSync(changed.manifestPath, JSON.stringify(manifest));
            const rejected = invoke("TestValidateClosure", bound({ClosureRoot: changed.closureRoot, ManifestPath: changed.manifestPath}));
            assert.notEqual(rejected.status, 0);
        }
    });

    it("rejects local native invocation before evidence creation or helper import", {timeout: TEST_TIMEOUT_MS}, () => {
        const value = fixture();
        const produced = invoke("EmitClosureManifest", bound({ClosureRoot: value.closureRoot, ManifestPath: value.manifestPath}));
        assert.equal(produced.status, 0, produced.stderr);
        const environment = {...process.env};
        for (const name of ["GITHUB_ACTIONS", "CI", "RUNNER_OS", "RUNNER_ARCH", "RUNNER_ENVIRONMENT", "GITHUB_REPOSITORY",
            "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA", "ImageOS", "ImageVersion"])
            delete environment[name];
        const result = invoke("InvokeHostedReadiness", bound({ClosureRoot: value.closureRoot,
            ManifestPath: value.manifestPath, EvidencePath: value.evidencePath}), environment);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /hosted context/i);
        assert.equal(fs.existsSync(path.dirname(value.evidencePath)), false);
        assert.doesNotMatch(result.stderr, /Add-Type|compiler|vswhere/i);
    });

    it("keeps imports inert and exposes a guarded real native adapter", {timeout: TEST_TIMEOUT_MS}, () => {
        const imported = invoke("Library");
        assert.equal(imported.status, 0, imported.stderr);
        assert.equal(imported.stdout, "");
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source, /function Get-MyspeedNativeControllerOperations/);
        const native = source.slice(source.indexOf("function Invoke-MyspeedHostedReadiness"));
        assert.ok(native.indexOf("Assert-MyspeedControllerHostedContext") < native.indexOf("Assert-MyspeedClosure"));
        assert.ok(native.indexOf("Assert-MyspeedClosure") < native.indexOf("Invoke-MyspeedNativeController"));
        assert.doesNotMatch(source, /not yet bound|did not return evidence/i);
        for (const name of ["Invoke-MyspeedDiscoverTools", "Invoke-MyspeedPreflight", "Invoke-MyspeedBuildMatrix",
            "Invoke-MyspeedDisassemblyMatrix", "Invoke-MyspeedNativeCalibration", "Assert-MyspeedAggregateEvidenceBound"])
            assert.match(source, new RegExp(`function ${name}`));
        assert.match(source, /\$script:ExpectedOperationCount = 32/);
        const linkArguments = source.match(/\$script:LinkArguments = @\(([\s\S]*?)\)/u)?.[1];
        assert.ok(linkArguments?.includes("'/MANIFEST:NO'"), "Probe linking must not create unowned manifest sidecars");
        assert.match(source, /Read-MyspeedVerifiedFileBytes/);
        assert.doesNotMatch(source, /ReadAllBytes|SearchOption\]::AllDirectories/);
        assert.doesNotMatch(source, /Invoke-WebRequest|Start-BitsTransfer|git\s+checkout|New-Service|Set-NetFirewall/i);
    });

    it("dispatches multiple arguments inside an isolated dynamic module", {timeout: TEST_TIMEOUT_MS}, () => {
        const result = invoke("TestModuleDispatch");
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {first: "alpha", second: "beta"});
    });

    it("pins the exact ordered 32-operation execution plan", {timeout: TEST_TIMEOUT_MS}, () => {
        const result = invoke("TestOperationPlan");
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout).operationIds, OPERATION_IDS);
        assert.equal(OPERATION_IDS.length, 32);
    });

    it("drives the real native phase sequencer through injected operations and always cleans up", {timeout: TEST_TIMEOUT_MS}, () => {
        const prefix = ["initialize", "discover-tools", "preflight", "build", "disassemble", "calibrate"];
        for (const failAt of [null, ...prefix, "cleanup"]) {
            const result = invoke("TestNativeLifecycle", {InputJson: JSON.stringify({failAt})});
            assert.equal(result.status, 0, `${failAt}: ${result.stderr}`);
            const evidence = JSON.parse(result.stdout);
            const expectedPrefix = failAt === null || failAt === "cleanup" ? prefix : prefix.slice(0, prefix.indexOf(failAt) + 1);
            assert.deepEqual(evidence.events, [...expectedPrefix, "cleanup"]);
            assert.equal(evidence.calibrationPassed, failAt === null);
            assert.equal(evidence.failures.length === 0, failAt === null);
        }
    });

    it("rejects ambiguous argv and malformed retained child error-mode evidence", {timeout: TEST_TIMEOUT_MS}, () => {
        const envelope = (isProbe = true) => ({
            isProbe,
            arguments: ["alpha", "beta"],
            result: {
                classification: "windows-native-host-observation-nonqualifying",
                bindings: {arguments: ["alpha", "beta"]},
                errorMode: isProbe
                    ? {required: true, requiredFlags: 3, before: 0, during: 3, after: 0, restored: true}
                    : {required: false, requiredFlags: 0, before: null, during: null, after: null, restored: true}
            }
        });
        for (const valid of [envelope(true), envelope(false)]) {
            const result = invoke("TestChildEnvelope", {InputJson: JSON.stringify(valid)});
            assert.equal(result.status, 0, result.stderr);
        }
        const invalid = [
            value => { value.result.classification = "other"; },
            value => { value.result.bindings.arguments = ["alpha\nbeta"]; value.arguments = ["alpha", "beta\n"]; },
            value => { value.result.bindings.arguments[0] = 1; },
            value => { value.result.errorMode.requiredFlags = 0; },
            value => { value.result.errorMode.during = 7; },
            value => { value.result.errorMode.after = 1; },
            value => { value.result.errorMode.restored = false; }
        ];
        for (const mutate of invalid) {
            const value = envelope(true);
            mutate(value);
            const result = invoke("TestChildEnvelope", {InputJson: JSON.stringify(value)});
            assert.notEqual(result.status, 0);
        }
    });

    it("bounds only directly owned files and rejects nested evidence directories", {timeout: TEST_TIMEOUT_MS}, () => {
        const value = fixture();
        const evidenceRoot = path.dirname(value.evidencePath);
        fs.mkdirSync(evidenceRoot);
        const ownedPath = path.join(evidenceRoot, "owned.txt");
        fs.writeFileSync(ownedPath, "bounded");
        const accepted = invoke("TestAggregate", {InputJson: JSON.stringify({root: evidenceRoot, ownedPaths: [ownedPath]})});
        assert.equal(accepted.status, 0, accepted.stderr);
        fs.mkdirSync(path.join(evidenceRoot, "nested"));
        const rejected = invoke("TestAggregate", {InputJson: JSON.stringify({root: evidenceRoot, ownedPaths: [ownedPath]})});
        assert.notEqual(rejected.status, 0);
        assert.match(rejected.stderr, /directory|reparse/i);
    });

    it("runs the injected lifecycle in fixed order and always cleans up", {timeout: TEST_TIMEOUT_MS}, () => {
        const expected = ["validate-closure", "validate-inputs", "discover-tools", "preflight", "build",
            "disassemble", "calibrate", "cleanup", "write-evidence"];
        const success = invoke("TestLifecycle", {InputJson: JSON.stringify({failAt: null})});
        assert.equal(success.status, 0, success.stderr);
        const passed = JSON.parse(success.stdout);
        assert.deepEqual(passed.events, expected);
        assert.equal(passed.status, "completed");
        assert.equal(passed.calibrationPassed, true);
        assert.equal(passed.qualifying, false);

        for (const failAt of ["validate-closure", "validate-inputs", "discover-tools", "preflight", "build",
            "disassemble", "calibrate", "cleanup", "write-evidence", "overflow", "identity-drift", "result-collision"]) {
            const result = invoke("TestLifecycle", {InputJson: JSON.stringify({failAt})});
            assert.equal(result.status, 0, `${failAt}: ${result.stderr}`);
            const failed = JSON.parse(result.stdout);
            assert.equal(failed.status, "failed", failAt);
            assert.equal(failed.calibrationPassed, false, failAt);
            assert.equal(failed.qualifying, false, failAt);
            assert.ok(failed.events.includes("cleanup"), failAt);
            assert.ok(failed.failures.length > 0, failAt);
        }
    });
});

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true});
});
