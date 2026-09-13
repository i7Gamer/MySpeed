import {describe, it} from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {EventEmitter} from "node:events";
import fs from "node:fs";
import {PassThrough} from "node:stream";

import {
    CAPABILITY_LIMITS,
    KVM_PROBE_SOURCE,
    buildCapabilityEvidence,
    classifyKvmProbe,
    createClosureManifest,
    parseResourceObservation,
    readResourceObservation,
    resolveCgroupLayout,
    runCapabilityObservation,
    runOwnedProcess,
    validateClosureManifest,
    validateHostedContext
} from "../../scripts/qualification/linux-kvm-capability.mjs";

const WORKFLOW_PATH = new URL("../../.github/workflows/linux-kvm-capability.yml", import.meta.url);
const MODULE_NAME = "linux-kvm-capability.mjs";
const REPOSITORY = "i7Gamer/MySpeed";
const SOURCE_SHA = "a".repeat(40);
const EVENT_SHA = "b".repeat(40);
const RUN_ID = "123456789";
const RUN_ATTEMPT = "2";
const NONCE = "0123456789abcdef0123456789abcdef";
const context = () => ({
    schemaVersion: 1,
    repository: REPOSITORY,
    sourceSha: SOURCE_SHA,
    eventSha: EVENT_SHA,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    nonce: NONCE,
    environment: {
        GITHUB_ACTIONS: "true",
        CI: "true",
        RUNNER_OS: "Linux",
        RUNNER_ARCH: "X64",
        RUNNER_ENVIRONMENT: "github-hosted",
        ImageOS: "ubuntu24",
        ImageVersion: "20260907.1"
    }
});

const deviceFacts = () => ({
    lstat: {kind: "character-device", dev: "1", ino: "2", rdev: "259", mode: "8576", uid: "1001", gid: "123"},
    fstat: {kind: "character-device", dev: "1", ino: "2", rdev: "259", mode: "8576", uid: "1001", gid: "123"},
    reopen: {kind: "character-device", dev: "1", ino: "2", rdev: "259", mode: "8576", uid: "1001", gid: "123"}
});

const passedProbe = () => ({
    schemaVersion: 1,
    status: "passed",
    stage: "complete",
    errno: 0,
    apiVersion: 12,
    exitReason: 5,
    cleanupProven: true,
    device: deviceFacts()
});

const processRecord = overrides => ({exitCode: 0, signal: null, timedOut: false, stdoutOverflow: false,
    stderrOverflow: false, cleanupProven: true, errorObserved: false, ...overrides});

const observedRun = (stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), overrides = {}) => ({
    process: processRecord(overrides), stdout, stderr
});

const compilerRecord = () => ({
    path: "/usr/bin/x86_64-linux-gnu-gcc-13",
    sha256: "d".repeat(64),
    version: "gcc (Ubuntu) 13.3.0",
    argv: ["-std=c11"],
    versionObservation: observedRun(Buffer.from("gcc (Ubuntu) 13.3.0\n")),
    compileObservation: observedRun()
});
const rawResources = () => ({
    filesystem: {
        availableBlocks: "20000000",
        blockSize: "4096",
        type: "ext4",
        mountOptions: "rw,relatime",
        taskPath: "/home/runner/work/_temp"
    },
    memory: {
        memAvailableBytes: "15000000000",
        cgroupLevels: [
            {path: "/sys/fs/cgroup", limitBytes: null, currentBytes: "4000000000"},
            {path: "/sys/fs/cgroup/actions_job", limitBytes: "16000000000", currentBytes: "3000000000"}
        ]
    },
    cpu: {logicalProcessors: 4, cgroupLevels: [
        {path: "/sys/fs/cgroup", quota: null, period: "100000"},
        {path: "/sys/fs/cgroup/actions_job", quota: "400000", period: "100000"}
    ]},
    tools: {qemuSystemX8664: null, ovmf: []}
});

describe("hosted Linux KVM capability contract", () => {
    it("embeds the exact minimal KVM HLT operations and named bounds", () => {
        for (const token of ["KVM_GET_API_VERSION", "KVM_CREATE_VM", "KVM_SET_USER_MEMORY_REGION",
            "KVM_CREATE_VCPU", "KVM_GET_VCPU_MMAP_SIZE", "KVM_GET_SREGS", "KVM_SET_SREGS",
            "KVM_SET_REGS", "KVM_RUN", "KVM_EXIT_HLT", "lstat", "fstat", "S_ISCHR"])
            assert.match(KVM_PROBE_SOURCE, new RegExp(`\\b${token}\\b`), token);
        assert.equal(CAPABILITY_LIMITS.probeTimeoutMs, 30_000);
        assert.equal(CAPABILITY_LIMITS.cleanupTimeoutMs, 5_000);
        assert.equal(CAPABILITY_LIMITS.streamBytes, 16_384);
        assert.equal(CAPABILITY_LIMITS.resultBytes, 131_072);
        assert.equal(CAPABILITY_LIMITS.probeMemoryBytes, 4_096);
    });

    it("accepts only the exact hosted Linux source/run context", () => {
        assert.deepEqual(validateHostedContext(context()), context());
        const mutations = [
            value => { value.extra = true; },
            value => { value.sourceSha = "A".repeat(40); },
            value => { value.runId = "01"; },
            value => { value.runAttempt = 0; },
            value => { value.nonce = "A".repeat(32); },
            value => { value.environment.CI = "false"; },
            value => { value.environment.RUNNER_OS = "Windows"; },
            value => { value.environment.RUNNER_ARCH = "ARM64"; },
            value => { value.environment.RUNNER_ENVIRONMENT = "self-hosted"; },
            value => { value.environment.ImageOS = "ubuntu24-custom"; },
            value => { value.environment.ImageVersion = "bad value"; },
            value => { value.sourceSha += "\n"; },
            value => { value.runId += "\n"; },
            value => { value.nonce += "\n"; },
            value => { value.environment.ImageVersion += "\n"; }
        ];
        for (const mutate of mutations) {
            const value = structuredClone(context());
            mutate(value);
            assert.throws(() => validateHostedContext(value));
        }
    });

    it("seals and verifies the exact one-file closure", () => {
        const bytes = Buffer.from("reviewed module bytes\n");
        const manifest = createClosureManifest({context: context(), moduleBytes: bytes});
        assert.deepEqual(validateClosureManifest({manifest, moduleBytes: bytes, expectedContext: context()}), manifest);
        assert.equal(manifest.module.name, MODULE_NAME);
        assert.equal(manifest.module.bytes, bytes.length);
        assert.equal(manifest.module.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
        for (const mutate of [
            value => { value.module.sha256 = "0".repeat(64); },
            value => { value.module.bytes += 1; },
            value => { value.module.name = "other.mjs"; },
            value => { value.context.runAttempt = "3"; },
            value => { value.extra = true; }
        ]) {
            const changed = structuredClone(manifest);
            mutate(changed);
            assert.throws(() => validateClosureManifest({manifest: changed, moduleBytes: bytes,
                expectedContext: context()}));
        }
    });

    it("records the informational statfs product and computes effective cgroup memory", () => {
        const parsed = parseResourceObservation(rawResources());
        assert.equal(parsed.filesystem.informationalBavailTimesBsize, "81920000000");
        assert.equal(Object.hasOwn(parsed.filesystem, "availableBytes"), false);
        assert.equal(parsed.memory.cgroupHeadroomBytes, "13000000000");
        assert.equal(parsed.memory.effectiveAvailableBytes, "13000000000");
        assert.equal(parsed.cpu.effectiveLogicalProcessors, 4);

        const unlimited = rawResources();
        unlimited.memory.cgroupLevels = [{path: "/sys/fs/cgroup", limitBytes: null,
            currentBytes: "3000000000"}];
        assert.equal(parseResourceObservation(unlimited).memory.effectiveAvailableBytes, "15000000000");

        const quota = rawResources();
        quota.cpu.cgroupLevels[1].quota = "150000";
        assert.equal(parseResourceObservation(quota).cpu.effectiveLogicalProcessors, 1.5);
    });

    it("resolves the process cgroup beneath the exact cgroup2 mount and every ancestor", () => {
        const layout = resolveCgroupLayout({
            cgroup: "0::/actions_job/abc123\n",
            mountInfo: "29 23 0:26 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n"
        });
        assert.equal(layout.processDirectory, "/sys/fs/cgroup/actions_job/abc123");
        assert.deepEqual(layout.ancestorDirectories, [
            "/sys/fs/cgroup",
            "/sys/fs/cgroup/actions_job",
            "/sys/fs/cgroup/actions_job/abc123"
        ]);
        assert.throws(() => resolveCgroupLayout({cgroup: "1:memory:/legacy\n", mountInfo: ""}));
    });

    it("reads raw cgroup2 files and treats only an absent hierarchy-root limit as unlimited", () => {
        const workRoot = "/home/runner/work/_temp/capability";
        const mountInfo = [
            "29 23 0:26 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw",
            "30 23 8:1 / /home/runner/work/_temp rw,relatime - ext4 /dev/sda1 rw"
        ].join("\n");
        const files = new Map([
            ["/proc/meminfo", "MemAvailable:       14648438 kB\n"],
            ["/proc/self/cgroup", "0::/actions_job/capability\n"],
            ["/proc/self/mountinfo", `${mountInfo}\n`],
            ["/sys/fs/cgroup/actions_job/memory.max", "16000000000\n"],
            ["/sys/fs/cgroup/actions_job/memory.current", "3000000000\n"],
            ["/sys/fs/cgroup/actions_job/cpu.max", "300000 100000\n"],
            ["/sys/fs/cgroup/actions_job/capability/memory.max", "12000000000\n"],
            ["/sys/fs/cgroup/actions_job/capability/memory.current", "2000000000\n"],
            ["/sys/fs/cgroup/actions_job/capability/cpu.max", "200000 100000\n"]
        ]);
        const filesystem = {
            statfsSync() { return {bavail: 20_000_000n, bsize: 4_096n}; },
            readFileSync(filePath) {
                if (!files.has(filePath)) throw new Error(`unexpected read: ${filePath}`);
                return files.get(filePath);
            },
            existsSync(filePath) { return files.has(filePath); },
            realpathSync(filePath) { return filePath; }
        };
        const parsed = readResourceObservation({workRoot, filesystem, availableParallelism: () => 4});
        assert.deepEqual(parsed.memory.cgroupLevels[0],
            {path: "/sys/fs/cgroup", limitBytes: null, currentBytes: null});
        assert.equal(parsed.memory.effectiveAvailableBytes, "10000000000");
        assert.equal(parsed.cpu.effectiveLogicalProcessors, 2);

        files.delete("/sys/fs/cgroup/actions_job/memory.current");
        assert.throws(() => readResourceObservation({workRoot, filesystem, availableParallelism: () => 4}),
            /incomplete/);

        files.set("/sys/fs/cgroup/actions_job/memory.current", "3000000000\n");
        files.set("/proc/self/mountinfo", `${mountInfo.replace("0:26 / /sys/fs/cgroup",
            "0:26 /actions_job /sys/fs/cgroup")}\n`);
        files.set("/sys/fs/cgroup/capability/memory.max", "12000000000\n");
        files.set("/sys/fs/cgroup/capability/memory.current", "2000000000\n");
        files.set("/sys/fs/cgroup/capability/cpu.max", "200000 100000\n");
        assert.throws(() => readResourceObservation({workRoot, filesystem, availableParallelism: () => 4}),
            /incomplete/);
    });

    it("rejects malformed, unsafe, or imprecise resource observations", () => {
        const mutations = [
            value => { value.filesystem.availableBlocks = "01"; },
            value => { value.filesystem.type = "nfs"; },
            value => { value.filesystem.mountOptions = "ro,relatime"; },
            value => { value.filesystem.taskPath = "relative"; },
            value => { value.memory.memAvailableBytes = "0"; },
            value => { value.memory.cgroupLevels[1].currentBytes = null; },
            value => { value.memory.cgroupLevels[1].currentBytes = "17000000000"; },
            value => { value.cpu.logicalProcessors = 0; },
            value => { value.cpu.cgroupLevels[1].period = "0"; },
            value => { value.tools.qemuSystemX8664 = "tmp/qemu"; },
            value => { value.tools.qemuSystemX8664 += "\n"; },
            value => { value.filesystem.taskPath += "\n"; }
        ];
        for (const mutate of mutations) {
            const value = structuredClone(rawResources());
            mutate(value);
            assert.throws(() => parseResourceObservation(value));
        }
    });

    it("classifies a bound HLT run as capability-only evidence", () => {
        const result = classifyKvmProbe({
            process: processRecord(),
            probe: passedProbe()
        });
        assert.deepEqual(result, {classification: "usable", usable: true, qualifying: false});
    });

    it("distinguishes absence, permission, ioctl, timeout, overflow, and cleanup failures", () => {
        const cases = [
            [{...passedProbe(), status: "failed", stage: "open", errno: 2, apiVersion: null,
                exitReason: null, device: {lstat: deviceFacts().lstat, fstat: null, reopen: null}}, "device-absent"],
            [{...passedProbe(), status: "failed", stage: "open", errno: 13, apiVersion: null,
                exitReason: null, device: {lstat: deviceFacts().lstat, fstat: null, reopen: null}}, "permission-denied"],
            [{...passedProbe(), status: "failed", stage: "lstat", errno: 1, apiVersion: null,
                exitReason: null, device: {lstat: null, fstat: null, reopen: null}}, "permission-denied"],
            [{...passedProbe(), status: "failed", stage: "get-api-version", errno: 25,
                apiVersion: null, exitReason: null}, "ioctl-failed"],
            [{...passedProbe(), status: "failed", stage: "api-version", errno: 0,
                apiVersion: 11, exitReason: null}, "api-version-mismatch"],
            [{...passedProbe(), status: "failed", stage: "run", errno: 5,
                exitReason: null}, "run-failed"],
            [{...passedProbe(), status: "failed", stage: "cleanup", errno: 0,
                cleanupProven: false}, "cleanup-unproved"]
        ];
        for (const [probe, classification] of cases) {
            assert.equal(classifyKvmProbe({
                process: processRecord(), probe
            }).classification, classification);
        }
        const processCases = [
            ["timedOut", "timeout"], ["stdoutOverflow", "output-overflow"],
            ["stderrOverflow", "output-overflow"], ["cleanupProven", "cleanup-unproved"]
        ];
        for (const [key, classification] of processCases) {
            const process = processRecord();
            process[key] = key === "cleanupProven" ? false : true;
            assert.equal(classifyKvmProbe({process, probe: passedProbe()}).classification, classification);
        }
    });

    it("rejects device identity drift, a non-character device, and wrong exit semantics", () => {
        for (const mutate of [
            value => { value.device.fstat.ino = "3"; },
            value => { value.device.reopen.rdev = "260"; },
            value => { value.device.lstat.kind = "regular-file"; },
            value => { value.exitReason = 6; }
        ]) {
            const probe = passedProbe();
            mutate(probe);
            assert.throws(() => classifyKvmProbe({
                process: processRecord(), probe
            }));
        }
    });

    it("builds strict nonqualifying evidence for both usable and failed observations", () => {
        const manifest = createClosureManifest({context: context(), moduleBytes: Buffer.from("bytes")});
        const evidence = buildCapabilityEvidence({
            context: context(), manifest, resources: parseResourceObservation(rawResources()),
            sourceSha256: crypto.createHash("sha256").update(Buffer.from(KVM_PROBE_SOURCE)).digest("hex"),
            probeBinary: {before: Buffer.from("probe"), after: Buffer.from("probe")},
            compiler: compilerRecord(),
            process: processRecord(), rawStreams: {stdout: Buffer.from(`${JSON.stringify(passedProbe())}\n`),
                stderr: Buffer.alloc(0)}, probe: passedProbe(),
            startedMonotonicNs: "100", finishedMonotonicNs: "200"
        });
        assert.equal(evidence.status, "passed");
        assert.equal(evidence.classification, "github-hosted-linux-kvm-capability-nonqualifying");
        assert.equal(evidence.capability, "usable");
        assert.equal(evidence.qualifying, false);
        assert.equal(evidence.releaseGateCleared, false);
        assert.equal(evidence.durationNs, "100");
        assert.equal(evidence.streams.stdout.sha256,
            crypto.createHash("sha256").update(Buffer.from(`${JSON.stringify(passedProbe())}\n`)).digest("hex"));
        assert.equal(Buffer.from(evidence.streams.stdout.base64, "base64").toString(),
            `${JSON.stringify(passedProbe())}\n`);

        const failedProcess = {...evidence.process, timedOut: true};
        const failed = buildCapabilityEvidence({...evidence, context: context(), manifest,
            resources: evidence.resources, sourceSha256: evidence.source.sha256,
            probeBinary: {before: Buffer.from("probe"), after: Buffer.from("probe")},
            compiler: compilerRecord(), process: failedProcess,
            rawStreams: {stdout: Buffer.from(`${JSON.stringify(passedProbe())}\n`), stderr: Buffer.alloc(0)},
            probe: passedProbe(),
            startedMonotonicNs: "100", finishedMonotonicNs: "200"});
        assert.equal(failed.status, "failed");
        assert.equal(failed.capability, "timeout");
        assert.equal(failed.qualifying, false);
    });

    it("runs the real orchestration seam and retains bounded failure evidence", async () => {
        const manifest = createClosureManifest({context: context(), moduleBytes: Buffer.from("bytes")});
        const probe = passedProbe();
        const writes = [];
        const executions = [
            observedRun(Buffer.from("gcc (Ubuntu) 13.3.0\n")),
            observedRun(),
            observedRun(Buffer.from(`${JSON.stringify(probe)}\n`))
        ];
        const operations = {
            writeExclusive(filePath, bytes, maximumBytes) { writes.push({filePath, bytes: Buffer.from(bytes), maximumBytes}); },
            resolveCompiler() { return {path: "/usr/bin/x86_64-linux-gnu-gcc-13", bytes: Buffer.from("compiler")}; },
            readOwnedFile(filePath) {
                return filePath.endsWith("probe.c") ? Buffer.from(KVM_PROBE_SOURCE) : Buffer.from("probe-binary");
            },
            async runOwned() {
                const observation = executions.shift();
                return runOwnedProcess("/synthetic/tool", [], CAPABILITY_LIMITS.probeTimeoutMs, {
                    spawnImpl() {
                        const child = new EventEmitter();
                        child.pid = 4242;
                        child.stdout = new PassThrough();
                        child.stderr = new PassThrough();
                        queueMicrotask(() => {
                            child.stdout.end(observation.stdout);
                            child.stderr.end(observation.stderr);
                            child.emit("close", observation.process.exitCode, observation.process.signal);
                        });
                        return child;
                    },
                    killGroup() {},
                    isGroupAlive() { return false; }
                });
            },
            readResources() { return parseResourceObservation(rawResources()); },
            monotonicNs: (() => { const values = [100n, 200n]; return () => values.shift(); })()
        };
        const evidence = await runCapabilityObservation({context: context(), manifest,
            workRoot: "/runner/temp/myspeed-kvm-capability-0123456789abcdef0123456789abcdef",
            resultPath: "/runner/temp/myspeed-kvm-capability-0123456789abcdef0123456789abcdef/result.json"},
        operations);
        assert.equal(evidence.status, "passed");
        assert.equal(writes.length, 2);
        assert.equal(JSON.parse(writes[1].bytes).status, "passed");

        const failedWrites = [];
        const failedOperations = {...operations,
            writeExclusive(filePath, bytes, maximumBytes) {
                failedWrites.push({filePath, bytes: Buffer.from(bytes), maximumBytes});
            },
            resolveCompiler() { throw new Error("synthetic compiler identity failure"); }};
        const failed = await runCapabilityObservation({context: context(), manifest,
            workRoot: "/runner/temp/myspeed-kvm-capability-0123456789abcdef0123456789abcdef",
            resultPath: "/runner/temp/myspeed-kvm-capability-0123456789abcdef0123456789abcdef/result.json"},
        failedOperations);
        assert.equal(failed.status, "failed");
        assert.equal(failed.stage, "compiler-identity");
        assert.equal(failed.qualifying, false);
        assert.equal(failedWrites.length, 2);
        assert.equal(JSON.parse(failedWrites[1].bytes).error, "synthetic compiler identity failure");
    });

    it("settles at the cleanup deadline when a killed process never closes its pipes", async () => {
        const child = new EventEmitter();
        child.pid = 4242;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        const timers = [];
        const promise = runOwnedProcess("/synthetic/tool", [], CAPABILITY_LIMITS.probeTimeoutMs, {
            spawnImpl: () => child,
            setTimer(callback, delay) { timers.push({callback, delay}); return callback; },
            clearTimer() {},
            killGroup() {},
            isGroupAlive() { return true; }
        });
        assert.equal(timers.length, 1);
        const executionTimer = timers.shift();
        assert.equal(executionTimer.delay, CAPABILITY_LIMITS.probeTimeoutMs);
        executionTimer.callback();
        assert.equal(timers.length, 1);
        const cleanupTimer = timers.shift();
        assert.equal(cleanupTimer.delay, CAPABILITY_LIMITS.cleanupTimeoutMs);
        cleanupTimer.callback();
        const result = await promise;
        assert.equal(result.process.timedOut, true);
        assert.equal(result.process.cleanupProven, false);
        assert.equal(result.process.exitCode, null);
    });

    it("bounds cleanup when an owned child reports an asynchronous process error", async () => {
        const child = new EventEmitter();
        child.pid = 4343;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        const timers = [];
        let kills = 0;
        const promise = runOwnedProcess("/synthetic/tool", [], CAPABILITY_LIMITS.probeTimeoutMs, {
            spawnImpl: () => child,
            setTimer(callback, delay) { timers.push({callback, delay}); return callback; },
            clearTimer() {},
            killGroup() { kills += 1; },
            isGroupAlive() { return true; }
        });
        child.emit("error", new Error("synthetic post-spawn error"));
        assert.equal(kills, 1);
        assert.equal(timers.at(-1).delay, CAPABILITY_LIMITS.cleanupTimeoutMs);
        timers.at(-1).callback();
        const result = await promise;
        assert.equal(result.process.cleanupProven, false);
        assert.equal(result.process.errorObserved, true);
        assert.equal(result.process.exitCode, null);
    });

    it("retains an asynchronous process error even when close later reports success", async () => {
        const child = new EventEmitter();
        child.pid = 4444;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        const promise = runOwnedProcess("/synthetic/tool", [], CAPABILITY_LIMITS.probeTimeoutMs, {
            spawnImpl: () => child,
            setTimer() { return Symbol("timer"); },
            clearTimer() {},
            killGroup() {},
            isGroupAlive() { return false; }
        });
        child.emit("error", new Error("synthetic post-spawn error"));
        child.emit("close", 0, null);
        const result = await promise;
        assert.equal(result.process.cleanupProven, true);
        assert.equal(result.process.errorObserved, true);
        assert.deepEqual(classifyKvmProbe({process: result.process, probe: passedProbe()}),
            {classification: "process-failed", usable: false, qualifying: false});
    });
});

describe("manual and same-repository PR nonpublishing capability workflow", () => {
    it("uses a source-bound producer and a no-checkout exact-artifact execution job", async () => {
        const {parse} = await import("yaml");
        const workflow = parse(fs.readFileSync(WORKFLOW_PATH, "utf8"));
        assert.deepEqual(Object.keys(workflow.on), ["pull_request", "workflow_dispatch"]);
        assert.deepEqual(workflow.on.pull_request.paths, [
            ".github/workflows/linux-kvm-capability.yml",
            "scripts/qualification/linux-kvm-capability.mjs",
            "tests/server/linuxKvmCapability.test.js"
        ]);
        assert.deepEqual(workflow.permissions, {actions: "read", contents: "read"});
        assert.deepEqual(Object.keys(workflow.jobs), ["prepare", "observe"]);
        assert.equal(workflow.env.EXPECTED_SOURCE_SHA,
            "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}");
        assert.equal(workflow.env.EXPECTED_EVENT_SHA, "${{ github.sha }}");
        assert.equal(workflow.jobs.prepare.if, "github.repository == 'i7Gamer/MySpeed' && " +
            "(github.event_name != 'pull_request' || (github.event.pull_request.head.repo.full_name == " +
            "github.repository && github.event.pull_request.base.ref == 'development'))");
        assert.equal(workflow.jobs.prepare["runs-on"], "ubuntu-24.04");
        assert.equal(workflow.jobs.observe["runs-on"], "ubuntu-24.04");
        assert.equal(workflow.jobs.prepare["timeout-minutes"], 5);
        assert.equal(workflow.jobs.observe["timeout-minutes"], 5);
        const uses = job => job.steps.filter(step => step.uses);
        const checkout = uses(workflow.jobs.prepare).find(step => step.uses.startsWith("actions/checkout@"));
        assert.equal(checkout.with.ref,
            "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}");
        assert.equal(checkout.with["persist-credentials"], false);
        const setupNode = uses(workflow.jobs.prepare).find(step => step.uses.startsWith("actions/setup-node@"));
        assert.equal(setupNode.with["node-version"], "22.19.0");
        const pureTests = workflow.jobs.prepare.steps.find(step => step.name === "Run pure and injected capability tests");
        assert.match(pureTests.run, /tests\/server\/linuxKvmCapability\.test\.js/u);
        const seal = workflow.jobs.prepare.steps.find(step => step.name === "Seal one-file runtime closure");
        assert.match(seal.run, /scripts\/qualification\/linux-kvm-capability\.mjs/u);
        assert.doesNotMatch(`${pureTests.run}\n${seal.run}`, /\.qa-release/u);
        assert.doesNotMatch(`${pureTests.run}\n${seal.run}`, /(?:npm|pnpm|yarn|bun)\s+install/iu);
        assert.equal(uses(workflow.jobs.observe).some(step => step.uses.startsWith("actions/checkout@")), false);
        const download = uses(workflow.jobs.observe).find(step => step.uses.startsWith("actions/download-artifact@"));
        assert.equal(download.with["artifact-ids"], "${{ needs.prepare.outputs.artifact_id }}");
        assert.equal(download.with["merge-multiple"], true);
        assert.equal(workflow.jobs.observe.needs, "prepare");
    });

    it("forbids privileged/media/QEMU operations and retains bounded evidence on every outcome", async () => {
        const source = fs.readFileSync(WORKFLOW_PATH, "utf8");
        for (const forbidden of ["sudo ", "modprobe", "chmod ", "apt-get", "docker ",
            "qemu-system", "Invoke-WebRequest", "curl ", "wget "])
            assert.doesNotMatch(source, new RegExp(forbidden, "i"), forbidden);
        const {parse} = await import("yaml");
        const workflow = parse(source);
        const upload = workflow.jobs.observe.steps.find(step => step.uses?.startsWith("actions/upload-artifact@"));
        assert.equal(upload.if, "always()");
        assert.equal(upload.with["if-no-files-found"], "error");
        assert.equal(upload.with["retention-days"], 7);
        assert.match(source, /nonqualifying|non-qualifying/);
        assert.doesNotMatch(source, /secrets\.|continue-on-error|releaseGateCleared:\s*true/);
        assert.doesNotMatch(source, /pull_request_target|\n\s*push:/u);
    });
});
