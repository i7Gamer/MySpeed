import assert from "node:assert/strict";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";

import {
    PRIVILEGED_LIMITS,
    buildPrivilegedArguments,
    createPrivilegedClosureManifest,
    runPrivilegedRetry,
    validateOrdinaryPermissionDenied
} from "../../scripts/qualification/linux-kvm-privileged-capability.mjs";
import {
    createClosureManifest,
    KVM_PROBE_SOURCE
} from "../../scripts/qualification/linux-kvm-capability.mjs";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const QA_ROOT = path.resolve(TEST_DIRECTORY, "..", "..");
const WORKFLOW_PATH = path.join(QA_ROOT, ".github", "workflows", "linux-kvm-privileged-capability.yml");
const ORDINARY_WORKFLOW_PATH = path.join(QA_ROOT, ".github", "workflows", "linux-kvm-capability.yml");
const CORE_BYTES = Buffer.from("core bytes");
const EXTENSION_BYTES = Buffer.from("extension bytes");
const PROBE_BYTES = Buffer.from("probe binary");
const SUDO_BYTES = Buffer.from("sudo binary");
const TIMEOUT_BYTES = Buffer.from("timeout binary");
const ZERO_SHA = "0".repeat(64);
const BASH_PATH = process.platform === "win32" ? path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe") :
    "/bin/bash";

function context() {
    return {schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: "a".repeat(40),
        eventSha: "b".repeat(40), runId: "123", runAttempt: "1", nonce: "c".repeat(32),
        environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
            RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260907.1"}};
}

function deviceFacts() {
    return {kind: "character-device", dev: "1", ino: "2", rdev: "259", mode: "8624", uid: "0", gid: "993"};
}

function permissionProbe() {
    return {schemaVersion: 1, status: "failed", stage: "open", errno: 13, apiVersion: null,
        exitReason: null, cleanupProven: true,
        device: {lstat: deviceFacts(), fstat: null, reopen: null}};
}

function passedProbe() {
    const facts = deviceFacts();
    return {schemaVersion: 1, status: "passed", stage: "complete", errno: 0, apiVersion: 12,
        exitReason: 5, cleanupProven: true,
        device: {lstat: {...facts}, fstat: {...facts}, reopen: {...facts}}};
}

function processRecord(overrides = {}) {
    return {exitCode: 0, signal: null, timedOut: false, stdoutOverflow: false, stderrOverflow: false,
        cleanupProven: true, errorObserved: false, ...overrides};
}

function processIdentity(pid = 4242, startTicks = "12345") {
    return {schemaVersion: 1, kind: "linux-kvm-probe-process", pid, startTicks};
}

function identityBytes(identity = processIdentity()) {
    return Buffer.from(`${JSON.stringify(identity)}\n`);
}

function toolIdentity(toolPath, bytes) {
    return {path: toolPath, bytes: Buffer.from(bytes), facts: {dev: "1", ino: toolPath.endsWith("sudo") ? "2" : "3",
        mode: "33261", uid: "0", gid: "0", size: String(bytes.length)}};
}

function ordinaryEvidence(coreManifest = createClosureManifest({context: context(), moduleBytes: CORE_BYTES})) {
    const probe = permissionProbe();
    const stdout = Buffer.from(`${JSON.stringify(probe)}\n`);
    const stderr = identityBytes();
    return {schemaVersion: 1, status: "failed",
        classification: "github-hosted-linux-kvm-capability-nonqualifying", capability: "permission-denied",
        qualifying: false, releaseGateCleared: false, context: context(), closure: coreManifest.module,
        source: {sha256: crypto.createHash("sha256").update(Buffer.from(KVM_PROBE_SOURCE)).digest("hex"),
            bytes: Buffer.byteLength(KVM_PROBE_SOURCE)},
        probeBinary: {bytes: PROBE_BYTES.length, sha256: crypto.createHash("sha256").update(PROBE_BYTES).digest("hex")},
        process: processRecord(), streams: {
            stdout: {bytes: stdout.length, sha256: crypto.createHash("sha256").update(stdout).digest("hex"),
                base64: stdout.toString("base64")},
            stderr: {bytes: stderr.length, sha256: crypto.createHash("sha256").update(stderr).digest("hex"),
                base64: stderr.toString("base64")}},
        probe};
}

function observation(stdout = Buffer.alloc(0), overrides = {}, stderr = Buffer.alloc(0)) {
    return {process: processRecord(overrides), stdout, stderr};
}

describe("hosted Linux privileged KVM capability retry", () => {
    it("builds the one exact shell-free sudo/timeout command and named deadlines", () => {
        assert.deepEqual(buildPrivilegedArguments("/runner/temp/myspeed-kvm-capability-" + "c".repeat(32) + "/probe"), [
            "-n", "--", "/usr/bin/timeout", "--foreground", "--signal=KILL", "30s",
            "/runner/temp/myspeed-kvm-capability-" + "c".repeat(32) + "/probe"
        ]);
        assert.deepEqual(PRIVILEGED_LIMITS, {outerTimeoutMs: 40_000, cleanupTimeoutMs: 5_000,
            rootTimeoutSeconds: 30, streamBytes: 16_384, resultBytes: 131_072, toolBytes: 67_108_864,
            pollIntervalMs: 50});
    });

    it("seals both runtime files and the ordinary manifest into one exact context", () => {
        const coreManifest = createClosureManifest({context: context(), moduleBytes: CORE_BYTES});
        const manifest = createPrivilegedClosureManifest({context: context(), coreBytes: CORE_BYTES,
            extensionBytes: EXTENSION_BYTES, coreManifestBytes: Buffer.from(`${JSON.stringify(coreManifest)}\n`)});
        assert.deepEqual(Object.keys(manifest), ["schemaVersion", "context", "files"]);
        assert.deepEqual(manifest.files.map(file => file.name), ["closure.json", "linux-kvm-capability.mjs",
            "linux-kvm-privileged-capability.mjs"]);
        assert.equal(Object.isFrozen(manifest), true);
    });

    it("retries only an exact same-context ordinary permission denial", () => {
        const coreManifest = createClosureManifest({context: context(), moduleBytes: CORE_BYTES});
        const ordinary = ordinaryEvidence(coreManifest);
        assert.equal(validateOrdinaryPermissionDenied({ordinary, ordinaryBytes: Buffer.from(`${JSON.stringify(ordinary)}\n`),
            context: context(), coreManifest, probeBytes: PROBE_BYTES}).capability, "permission-denied");
        for (const mutate of [
            value => { value.capability = "device-absent"; },
            value => { value.qualifying = true; },
            value => { value.context.runAttempt = "2"; },
            value => { value.probe.errno = 0; },
            value => { value.probeBinary.sha256 = ZERO_SHA; },
            value => { value.streams.stdout.base64 = Buffer.from("{}\n").toString("base64"); },
            value => { value.streams.stderr.base64 = Buffer.from("malformed\n").toString("base64"); }
        ]) {
            const changed = structuredClone(ordinary);
            mutate(changed);
            assert.throws(() => validateOrdinaryPermissionDenied({ordinary: changed,
                ordinaryBytes: Buffer.from(`${JSON.stringify(changed)}\n`), context: context(), coreManifest,
                probeBytes: PROBE_BYTES}));
        }
    });

    it("runs only the fixed retry, binds tools/binary/streams, and remains nonqualifying", async () => {
        const coreManifest = createClosureManifest({context: context(), moduleBytes: CORE_BYTES});
        const ordinary = ordinaryEvidence(coreManifest);
        const ordinaryBytes = Buffer.from(`${JSON.stringify(ordinary)}\n`);
        const calls = [];
        const written = [];
        const result = await runPrivilegedRetry({context: context(), coreManifest, ordinary, ordinaryBytes,
            workRoot: "/runner/temp/myspeed-kvm-capability-" + "c".repeat(32),
            probePath: "/runner/temp/myspeed-kvm-capability-" + "c".repeat(32) + "/probe",
            resultPath: "/runner/temp/myspeed-kvm-capability-" + "c".repeat(32) + "/privileged-result.json"}, {
            readProbe: () => Buffer.from(PROBE_BYTES),
            resolveTool(toolPath) {
                return toolIdentity(toolPath, toolPath.endsWith("sudo") ? SUDO_BYTES : TIMEOUT_BYTES);
            },
            async runOwned(command, argv, timeoutMs) {
                calls.push({command, argv, timeoutMs});
                if (argv[0] === "--version") return observation(Buffer.from(`${path.basename(command)} 1.0\n`));
                return observation(Buffer.from(`${JSON.stringify(passedProbe())}\n`), {}, identityBytes());
            },
            observeOwnedProbeProcess: () => ({state: "absent"}),
            monotonicMs: (() => { const values = [100, 101]; return () => values.shift(); })(),
            sleep: async () => {},
            writeExclusive(filePath, bytes, maximumBytes) { written.push({filePath, bytes: Buffer.from(bytes), maximumBytes}); }
        });
        assert.deepEqual(calls.map(call => call.command), ["/usr/bin/sudo", "/usr/bin/timeout", "/usr/bin/sudo"]);
        assert.deepEqual(calls.at(-1).argv, buildPrivilegedArguments(
            "/runner/temp/myspeed-kvm-capability-" + "c".repeat(32) + "/probe"));
        assert.equal(calls.at(-1).timeoutMs, PRIVILEGED_LIMITS.outerTimeoutMs);
        assert.equal(result.status, "observed");
        assert.equal(result.capability, "usable");
        assert.equal(result.qualifying, false);
        assert.equal(result.releaseGateCleared, false);
        assert.deepEqual(result.privileged.rootProbeProcess.identity, processIdentity());
        assert.deepEqual(result.privileged.rootProbeProcess.after, {state: "absent"});
        assert.equal(result.ordinary.sha256, crypto.createHash("sha256").update(ordinaryBytes).digest("hex"));
        assert.equal(written.length, 1);
        assert.equal(written[0].maximumBytes, PRIVILEGED_LIMITS.resultBytes);
    });

    it("fails closed for lingering root probe, timeout, output overflow, or changed binary", async () => {
        const coreManifest = createClosureManifest({context: context(), moduleBytes: CORE_BYTES});
        const ordinary = ordinaryEvidence(coreManifest);
        const base = {
            readProbe: () => Buffer.from(PROBE_BYTES),
            resolveTool: toolPath => toolIdentity(toolPath, toolPath.endsWith("sudo") ? SUDO_BYTES : TIMEOUT_BYTES),
            runOwned: async (command, argv) => argv[0] === "--version" ? observation(Buffer.from("version 1\n")) :
                observation(Buffer.from(`${JSON.stringify(passedProbe())}\n`), {}, identityBytes()),
            observeOwnedProbeProcess: () => ({state: "absent"}), monotonicMs: () => 100, sleep: async () => {},
            writeExclusive() {}
        };
        const request = {context: context(), coreManifest, ordinary,
            ordinaryBytes: Buffer.from(`${JSON.stringify(ordinary)}\n`),
            workRoot: "/runner/temp/myspeed-kvm-capability-" + "c".repeat(32),
            probePath: "/runner/temp/myspeed-kvm-capability-" + "c".repeat(32) + "/probe",
            resultPath: "/runner/temp/myspeed-kvm-capability-" + "c".repeat(32) + "/privileged-result.json"};
        const linger = await runPrivilegedRetry(request, {...base,
            observeOwnedProbeProcess: () => ({state: "present", pid: 4242, startTicks: "12345",
                executablePath: request.probePath}),
            monotonicMs: (() => { const values = [0, PRIVILEGED_LIMITS.cleanupTimeoutMs]; return () => values.shift(); })()});
        assert.equal(linger.capability, "cleanup-unproved");
        const timedOut = await runPrivilegedRetry(request, {...base,
            runOwned: async (command, argv) => argv[0] === "--version" ? observation(Buffer.from("version 1\n")) :
                observation(Buffer.alloc(0), {timedOut: true, exitCode: null, cleanupProven: false})});
        assert.equal(timedOut.capability, "cleanup-unproved");
        const overflow = await runPrivilegedRetry(request, {...base,
            runOwned: async (command, argv) => argv[0] === "--version" ? observation(Buffer.from("version 1\n")) :
                observation(Buffer.alloc(0), {stdoutOverflow: true}, identityBytes())});
        assert.equal(overflow.capability, "process-failed");
        let reads = 0;
        const changed = await runPrivilegedRetry(request, {...base,
            readProbe: () => ++reads === 1 ? Buffer.from(PROBE_BYTES) : Buffer.from("changed")});
        assert.equal(changed.capability, "execution-failed");
        const missingIdentity = await runPrivilegedRetry(request, {...base,
            runOwned: async (command, argv) => argv[0] === "--version" ? observation(Buffer.from("version 1\n")) :
                observation(Buffer.from(`${JSON.stringify(passedProbe())}\n`))});
        assert.equal(missingIdentity.capability, "cleanup-unproved");
        const reusedPid = await runPrivilegedRetry(request, {...base,
            observeOwnedProbeProcess: () => ({state: "present", pid: 4242, startTicks: "54321",
                executablePath: request.probePath})});
        assert.equal(reusedPid.capability, "cleanup-unproved");
        for (const facts of [
            {uid: "1000"},
            {mode: String(0o100777)}
        ]) {
            const unsafeTool = await runPrivilegedRetry(request, {...base,
                resolveTool(toolPath) {
                    const identity = toolIdentity(toolPath, toolPath.endsWith("sudo") ? SUDO_BYTES : TIMEOUT_BYTES);
                    Object.assign(identity.facts, facts);
                    return identity;
                }});
            assert.equal(unsafeTool.capability, "execution-failed");
            assert.equal(unsafeTool.stage, "tool-identities");
        }
    });

    it("skips privilege when the exact ordinary probe is already usable", async () => {
        const coreManifest = createClosureManifest({context: context(), moduleBytes: CORE_BYTES});
        const ordinary = ordinaryEvidence(coreManifest);
        ordinary.status = "passed";
        ordinary.capability = "usable";
        ordinary.probe = passedProbe();
        const stdout = Buffer.from(`${JSON.stringify(ordinary.probe)}\n`);
        ordinary.streams.stdout = {bytes: stdout.length,
            sha256: crypto.createHash("sha256").update(stdout).digest("hex"), base64: stdout.toString("base64")};
        let runs = 0;
        const result = await runPrivilegedRetry({context: context(), coreManifest, ordinary,
            ordinaryBytes: Buffer.from(`${JSON.stringify(ordinary)}\n`),
            workRoot: "/runner/temp/myspeed-kvm-capability-" + "c".repeat(32),
            probePath: "/runner/temp/myspeed-kvm-capability-" + "c".repeat(32) + "/probe",
            resultPath: "/runner/temp/myspeed-kvm-capability-" + "c".repeat(32) + "/privileged-result.json"}, {
            readProbe: () => Buffer.from(PROBE_BYTES), resolveTool() { throw new Error("unexpected tool"); },
            async runOwned() { runs += 1; }, observeOwnedProbeProcess() { throw new Error("unexpected observer"); },
            monotonicMs: () => 0, sleep: async () => {}, writeExclusive() {}}
        );
        assert.equal(runs, 0);
        assert.equal(result.status, "observed");
        assert.equal(result.capability, "ordinary-usable");
        assert.equal(result.retryPerformed, false);
        assert.equal(result.qualifying, false);
    });

    it("uses a separate same-repository PR/manual workflow and keeps both observations", async () => {
        const {parse} = await import("yaml");
        const source = fs.readFileSync(WORKFLOW_PATH, "utf8");
        const workflow = parse(source);
        assert.deepEqual(Object.keys(workflow.on), ["pull_request", "workflow_dispatch"]);
        assert.equal(workflow.jobs.prepare.if, "github.repository == 'i7Gamer/MySpeed' && " +
            "(github.event_name != 'pull_request' || (github.event.pull_request.head.repo.full_name == " +
            "github.repository && github.event.pull_request.base.ref == 'development'))");
        assert.deepEqual(workflow.permissions, {actions: "read", contents: "read"});
        assert.deepEqual(Object.keys(workflow.jobs), ["prepare", "observe"]);
        assert.equal(workflow.jobs.observe.needs, "prepare");
        assert.equal(workflow.jobs.observe["timeout-minutes"], 5);
        const observeSource = workflow.jobs.observe.steps.map(step => step.run ?? "").join("\n");
        assert.match(observeSource, /linux-kvm-capability\.mjs[\s\S]*probe/u);
        assert.match(observeSource, /linux-kvm-privileged-capability\.mjs[\s\S]*retry/u);
        const assertion = workflow.jobs.observe.steps.find(step => step.name === "Assert bounded nonqualifying result");
        assert.match(assertion.run, /status !== "observed"/u);
        assert.match(assertion.run, /\["usable", "ordinary-usable"\]/u);
        assert.doesNotMatch(observeSource, /(?:chmod|chown|modprobe|apt-get|qemu-system|curl|wget)/u);
        assert.match(observeSource, /work_root\/result\.json/u);
        assert.match(observeSource, /privileged-result\.json/u);
        assert.doesNotMatch(source, /pull_request_target|secrets\.|continue-on-error/u);
        const checkout = workflow.jobs.prepare.steps.find(step => step.uses?.startsWith("actions/checkout@"));
        assert.equal(checkout.with["persist-credentials"], false);
        assert.equal(workflow.jobs.prepare.steps.some(step =>
            step.uses === "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6"), true);
        assert.match(workflow.jobs.prepare.steps.map(step => step.run ?? "").join("\n"),
            /bun install --frozen-lockfile --ignore-scripts/u);
        assert.deepEqual(workflow.on.pull_request.paths, [
            ".github/workflows/linux-kvm-privileged-capability.yml",
            "scripts/qualification/linux-kvm-capability.mjs",
            "scripts/qualification/linux-kvm-privileged-capability.mjs",
            "tests/server/linuxKvmCapability.test.js",
            "tests/server/linuxKvmPrivilegedCapability.test.js"
        ]);
        assert.equal(workflow.jobs.observe.steps.some(step => step.uses?.startsWith("actions/checkout@")), false);
        const upload = workflow.jobs.observe.steps.find(step => step.uses?.startsWith("actions/upload-artifact@"));
        assert.equal(upload.if, "always()");
        assert.match(upload.with.path, /\/result\.json/u);
        assert.match(upload.with.path, /privileged-result\.json/u);
        const ordinaryWorkflow = parse(fs.readFileSync(ORDINARY_WORKFLOW_PATH, "utf8"));
        assert.deepEqual(Object.keys(ordinaryWorkflow.on), ["workflow_dispatch"]);
    });

    it("continues only an exit-one permission observation through the actual workflow shell", async () => {
        const {parse} = await import("yaml");
        const workflow = parse(fs.readFileSync(WORKFLOW_PATH, "utf8"));
        const shell = workflow.jobs.observe.steps.find(step =>
            step.name === "Preserve ordinary observation then perform fixed privileged retry").run;
        const cases = [
            {name: "permission", exit: 1, write: true, status: "failed", capability: "permission-denied",
                expectedStatus: 0, retry: true},
            {name: "missing", exit: 1, write: false, status: "failed", capability: "permission-denied",
                expectedStatus: 1, retry: false},
            {name: "inconsistent", exit: 1, write: true, status: "passed", capability: "usable",
                expectedStatus: 1, retry: false}
        ];
        for (const item of cases) {
            const runnerTemp = fs.mkdtempSync(path.join(QA_ROOT, `.kvm-shell-${item.name}-`));
            try {
                const runnerTempShell = path.relative(process.cwd(), runnerTemp).replaceAll("\\", "/");
                const closureRoot = path.join(runnerTemp, "linux-kvm-capability-closure");
                fs.mkdirSync(closureRoot);
                for (const name of ["closure.json", "linux-kvm-capability.mjs",
                    "linux-kvm-privileged-capability.mjs", "privileged-closure.json"])
                    fs.writeFileSync(path.join(closureRoot, name), name);
                const retryMarker = path.join(runnerTemp, "retry-called");
                const ordinary = JSON.stringify({schemaVersion: 1, status: item.status,
                    capability: item.capability, qualifying: false, releaseGateCleared: false});
                const stub = String.raw`
PATH="/usr/bin:$PATH"
node() {
  case "$1:$2" in
    *linux-kvm-capability.mjs:probe)
      mkdir -p "$RUNNER_TEMP/myspeed-kvm-capability-$EXPECTED_NONCE"
      if [ "$STUB_WRITE_RESULT" = true ]; then
        printf '%s\n' "$STUB_ORDINARY_JSON" > "$RUNNER_TEMP/myspeed-kvm-capability-$EXPECTED_NONCE/result.json"
      fi
      return "$STUB_ORDINARY_EXIT"
      ;;
    *linux-kvm-privileged-capability.mjs:retry)
      printf 'called\n' > "$STUB_RETRY_MARKER"
      return 0
      ;;
    *) command node "$@" ;;
  esac
}
`;
                const result = spawnSync(BASH_PATH, ["-c", `${stub}\n${shell}`], {encoding: "utf8", env: {
                    ...process.env,
                    RUNNER_TEMP: runnerTempShell, EXPECTED_NONCE: "c".repeat(32),
                    EXPECTED_SOURCE_SHA: "a".repeat(40), EXPECTED_EVENT_SHA: "b".repeat(40), EXPECTED_RUN_ID: "1",
                    EXPECTED_RUN_ATTEMPT: "1", STUB_WRITE_RESULT: String(item.write),
                    STUB_ORDINARY_EXIT: String(item.exit), STUB_ORDINARY_JSON: ordinary,
                    STUB_RETRY_MARKER: `${runnerTempShell}/retry-called`}});
                assert.equal(result.status, item.expectedStatus, `${item.name}: ${result.stderr}`);
                assert.equal(fs.existsSync(retryMarker), item.retry);
            } finally {
                fs.rmSync(runnerTemp, {recursive: true, force: true});
            }
        }
    });
});
