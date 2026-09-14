import assert from "node:assert/strict";
import crypto from "node:crypto";
import {EventEmitter} from "node:events";
import fs from "node:fs";
import {describe, it} from "node:test";
import {PassThrough} from "node:stream";

import {
    buildIsolatedAptVectors,
    collectHostedAdmissionObservations,
    createHostedQemuProcessLauncher,
    createHostedStage2Operations,
    parseInReleaseIndexes,
    parseGuestFailure,
    parseGuestOutcome,
    parseGuestOutput,
    parseProbeArtifactEvidence,
    parseWimInfo,
    measureOwnedTreeBytes,
    observeHostedRuntimeResources,
    resolveSelectedDependencies,
    runHostedOwnedProcess,
    runMonitoredQemu
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";
import {STAGE2_PROVENANCE, TOP_LEVEL_PACKAGE_PINS} from "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";

const NONCE = "0123456789abcdef0123456789abcdef";
const CAPTURED_PROBE_BUILD = JSON.parse(fs.readFileSync(new URL(
    "../fixtures/linux-windows-cpu-floor-stage2/probe-build-34834310907.json", import.meta.url), "utf8"));

function context() {
    return {schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: "a".repeat(40), eventSha: "b".repeat(40),
        runId: "123", runAttempt: "1", nonce: NONCE, environment: {GITHUB_ACTIONS: "true", CI: "true",
            RUNNER_OS: "Linux", RUNNER_ARCH: "X64", RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24",
            ImageVersion: "20260907.1"}};
}

function paths() {
    const root = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${NONCE}`;
    return {root, packageRoot: `${root}/packages`, portableRoot: `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}`,
        probeRoot: `${root}/probes`,
        windowsIso: `${root}/windows.iso`, installWim: `${root}/install.wim`, seedIso: `${root}/seed.iso`,
        outputDisk: `${root}/output.img`, systemDisk: `${root}/system.qcow2`, ovmfVars: `${root}/OVMF_VARS.fd`,
        serialLog: `${root}/serial.log`, qemuPid: `${root}/qemu.pid`};
}

const okProcess = {exitCode: 0, signal: null, timedOut: false, stdoutOverflow: false, stderrOverflow: false,
    cleanupProven: true, errorObserved: false};
const directoryIdentity = target => ({path: target, dev: "1", ino: target === "/tmp" ? "1" : "2", uid: "0",
    gid: "0", mode: target === "/tmp" ? "1777" : "755", ordinaryUserWritable: target === "/tmp",
    sticky: target === "/tmp"});
const rootFileIdentity = target => ({path: target, bytes: "4096", sha256: "f".repeat(64),
    ownership: {uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false}});
const commandIdentity = target => ({...rootFileIdentity(target), invocationPath: target});

describe("hosted Stage 2 native adapter preparation", () => {
    it("accepts only bounded fail-closed guest bootstrap diagnostics", () => {
        const value = {schemaVersion: 1, status: "failed", nonce: NONCE, stage: "guest-bootstrap",
            failure: "probe execution failed"};
        assert.deepEqual(parseGuestFailure(Buffer.from(JSON.stringify(value)), NONCE), value);
        assert.deepEqual(parseGuestOutcome(Buffer.from(JSON.stringify(value)), NONCE), value);
        for (const mutate of [
            record => { record.status = "observed"; },
            record => { record.nonce = "f".repeat(32); },
            record => { record.failure = "bad\nmessage"; },
            record => { record.extra = true; }
        ]) {
            const changed = structuredClone(value);
            mutate(changed);
            assert.throws(() => parseGuestFailure(Buffer.from(JSON.stringify(changed)), NONCE), /failure evidence/i);
        }
    });

    it("drains outputs larger than the Stage 1 cap under a fixed Stage 2 bound", async () => {
        const output = Buffer.alloc(20_000, 0x61);
        const child = new EventEmitter();
        child.pid = 123;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        const observation = await runHostedOwnedProcess("/owned/tool", [], {timeoutMs: 1_000}, {
            spawnImpl: () => {
                queueMicrotask(() => { child.stdout.write(output); child.emit("close", 0, null); });
                return child;
            }, isGroupAlive: () => false
        });
        assert.equal(observation.process.stdoutOverflow, false);
        assert.deepEqual(observation.stdout, output);
    });

    it("hands a lingering owned group to the external privileged cleanup owner without hanging", async () => {
        const child = new EventEmitter();
        child.pid = 321;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        const pending = runHostedOwnedProcess("/owned/tool", [], {timeoutMs: 1_000,
            onTerminationRequested: reason => { assert.equal(reason, "lingering-process-group"); return true; }}, {
            spawnImpl: () => { queueMicrotask(() => child.emit("close", 0, null)); return child; },
            isGroupAlive: () => true
        });
        const observation = await pending;
        assert.equal(observation.process.cleanupProven, false);
    });

    it("settles an unsuccessful external cleanup handoff at the cleanup deadline", async () => {
        const child = new EventEmitter();
        child.pid = 322; child.stdout = new PassThrough(); child.stderr = new PassThrough();
        const timers = [];
        const pending = runHostedOwnedProcess("/owned/tool", [], {timeoutMs: 1_000,
            onTerminationRequested: reason => { assert.equal(reason, "deadline"); return true; }}, {
            spawnImpl: () => child, setTimer: callback => { timers.push(callback); return timers.length; },
            clearTimer: () => undefined, isGroupAlive: () => true
        });
        timers[0]();
        assert.equal(timers.length, 2);
        timers[1]();
        assert.equal((await pending).process.cleanupProven, false);
    });

    it("exposes a bounded settlement request for an independently detected monitor failure", async () => {
        const child = new EventEmitter();
        child.pid = 323; child.stdout = new PassThrough(); child.stderr = new PassThrough();
        const timers = [];
        let requestSettlement = null;
        const pending = runHostedOwnedProcess("/owned/tool", [], {timeoutMs: 1_000,
            onTerminationRequested: reason => { assert.equal(reason, "monitor-low-memory"); return true; },
            onTerminationReady: request => { requestSettlement = request; }}, {
            spawnImpl: () => child, setTimer: callback => { timers.push(callback); return timers.length; },
            clearTimer: () => undefined, isGroupAlive: () => true
        });
        assert.equal(typeof requestSettlement, "function");
        requestSettlement("monitor-low-memory");
        assert.equal(timers.length, 2);
        timers[1]();
        assert.equal((await pending).process.cleanupProven, false);
    });

    it("settles after a monitor-triggered privileged teardown failure", async () => {
        let finish;
        const operation = new Promise(resolve => { finish = resolve; });
        let settlementReason = null;
        let clock = 0;
        const result = await runMonitoredQemu({
            runOwned: (command, argv, options) => {
                options.onSpawn(2300);
                options.onTerminationReady(reason => {
                    settlementReason = reason;
                    finish({process: {...okProcess, exitCode: null, cleanupProven: false}, stdout: Buffer.alloc(0),
                        stderr: Buffer.alloc(0)});
                });
                return operation;
            },
            pathExists: () => true,
            readOwnedVerified: () => ({bytes: Buffer.from("2345\n")}),
            readQemuProcessIdentity: () => ({state: "present", pid: 2345, processGroupId: 2300,
                startTicks: "77", executablePath: "/owned/loader"}),
            observeRuntimeResources: () => ({taskBytes: "1", freeBytes: "90000000000",
                effectiveMemoryBytes: "4294967295"}),
            monotonicMilliseconds: () => clock,
            wait: async milliseconds => { clock += milliseconds; },
            isProcessGroupAlive: () => true,
            terminateQemuGroup: async () => false
        }, {command: "/usr/bin/sudo", argv: [], timeoutMs: 1_000, maxStreamBytes: 1_024,
            pidPath: "/owned/qemu.pid", expectedExecutable: "/owned/loader", executionDeadline: 100_000,
            resources: {taskPath: "/owned", roots: ["/owned"]}});
        assert.equal(settlementReason, "monitor-low-memory");
        assert.equal(result.terminationReason, "low-memory");
        assert.equal(result.observation.process.cleanupProven, false);
    });

    it("terminates and settles when the process-group observer throws", async () => {
        let finish;
        const operation = new Promise(resolve => { finish = resolve; });
        let clock = 0;
        let terminationCalls = 0;
        let settlementReason = null;
        const result = await runMonitoredQemu({
            runOwned: (command, argv, options) => {
                options.onSpawn(2300);
                options.onTerminationReady(reason => {
                    settlementReason = reason;
                    finish({process: {...okProcess, exitCode: 137, cleanupProven: false}, stdout: Buffer.alloc(0),
                        stderr: Buffer.alloc(0)});
                });
                return operation;
            },
            pathExists: () => false,
            monotonicMilliseconds: () => { clock += 31_000; return clock; },
            wait: async () => undefined,
            isProcessGroupAlive: () => { throw new Error("process-group observation failed"); },
            terminateQemuGroup: async request => { assert.equal(request.processGroupId, 2300);
                terminationCalls += 1; return false; }
        }, {command: "/usr/bin/sudo", argv: [], timeoutMs: 1_000, maxStreamBytes: 1_024,
            pidPath: "/owned/qemu.pid", expectedExecutable: "/owned/loader", executionDeadline: 100_000,
            resources: {taskPath: "/owned", roots: ["/owned"]}});
        assert.equal(terminationCalls, 1);
        assert.equal(settlementReason, "monitor-identity-timeout");
        assert.equal(result.terminationReason, "identity-timeout");
        assert.equal(result.observation.process.cleanupProven, false);
    });

    it("counts a symbolic-link inode without traversing its target", () => {
        const children = new Map([["/root", ["link"]]]);
        const facts = new Map([["/root", {isSymbolicLink: () => false, isFile: () => false,
            isDirectory: () => true, size: 0n}], ["/root/link", {isSymbolicLink: () => true,
            isFile: () => false, isDirectory: () => false, size: 21n}]]);
        const observed = [];
        assert.equal(measureOwnedTreeBytes(["/root"], {lstatSync: target => { observed.push(target); return facts.get(target); },
            readdirSync: target => children.get(target)}), 21n);
        assert.deepEqual(observed, ["/root", "/root/link"]);
    });

    it("builds an isolated empty-status apt snapshot update and resolver", () => {
        const vectors = buildIsolatedAptVectors(paths());
        assert.equal(vectors.sourcesBytes.toString("utf8"),
            `deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] ${STAGE2_PROVENANCE.ubuntuSnapshot.baseUrl} noble main universe\n` +
            `deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] ${STAGE2_PROVENANCE.ubuntuSnapshot.baseUrl} noble-updates main universe\n`);
        assert.equal(vectors.emptyStatusBytes.length, 0);
        assert.equal(vectors.update.command, "/usr/bin/apt-get");
        assert.equal(vectors.update.argv.includes("update"), true);
        assert.equal(vectors.resolve.argv.includes("--no-install-recommends"), true);
        assert.equal(vectors.aptEnvironment.APT_CONFIG, vectors.aptConfig);
        assert.equal(vectors.common.includes("DPkg::Pre-Invoke::="), true);
        assert.equal(vectors.common.includes("APT::Update::Post-Invoke-Success::="), true);
        assert.deepEqual(vectors.resolve.argv.slice(-TOP_LEVEL_PACKAGE_PINS.length),
            TOP_LEVEL_PACKAGE_PINS.map(value => `${value.name}:${value.architecture}=${value.version}`));
    });

    it("selects the complete signed package index set across valid zero-byte checksum rows", () => {
        const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        const observed = [{suite: "noble", main: {bytes: "1401160",
            sha256: "2a6a199e1031a5c279cb346646d594993f35b1c03dd4a82aaa0323980dd92451"},
        universe: {bytes: "15037908",
            sha256: "ba9057fa1b91438cc8a1d26808d00c85389fe101d0c1496254df97236405599a"}},
        {suite: "noble-updates", main: {bytes: "1262968",
            sha256: "4963d0592fb3c977ec0b7593ec8e202b4906b048f625760742c063965da7b175"},
        universe: {bytes: "1690332",
            sha256: "cf06d0b20daa7eea4d4a4f4abc0fd8b29aed8389367681c6f6653c5068155265"}}];
        const releaseFor = value => Buffer.from("-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA512\n\n" +
            "Origin: Ubuntu\nSHA256:\n" +
            ` ${value.main.sha256} ${value.main.bytes} main/binary-amd64/Packages.xz\n` +
            ` ${emptyHash} 0 main/debian-installer/binary-amd64/Packages\n` +
            ` ${value.universe.sha256} ${value.universe.bytes} universe/binary-amd64/Packages.xz\n` +
            "Acquire-By-Hash: yes\n-----BEGIN PGP SIGNATURE-----\n");

        for (const value of observed) assert.deepEqual(parseInReleaseIndexes(releaseFor(value), value.suite),
            [{suite: value.suite, component: "main", architecture: "amd64",
                path: `dists/${value.suite}/main/binary-amd64/Packages.xz`, bytes: value.main.bytes,
                sha256: value.main.sha256, listedSha256: value.main.sha256},
            {suite: value.suite, component: "universe", architecture: "amd64",
                path: `dists/${value.suite}/universe/binary-amd64/Packages.xz`, bytes: value.universe.bytes,
                sha256: value.universe.sha256, listedSha256: value.universe.sha256}]);

        const release = releaseFor(observed[0]);
        const mainHash = observed[0].main.sha256;

        const duplicate = Buffer.from(release.toString("utf8").replace("Acquire-By-Hash: yes",
            ` ${mainHash} ${observed[0].main.bytes} main/binary-amd64/Packages.xz\nAcquire-By-Hash: yes`));
        assert.throws(() => parseInReleaseIndexes(duplicate, "noble"), /duplicated/u);
        const zeroSelected = Buffer.from(release.toString("utf8").replace(
            `${mainHash} ${observed[0].main.bytes} main/binary-amd64/Packages.xz`,
            `${emptyHash} 0 main/binary-amd64/Packages.xz`));
        assert.throws(() => parseInReleaseIndexes(zeroSelected, "noble"), /size/u);
        const missing = Buffer.from(release.toString("utf8").replace(
            "universe/binary-amd64/Packages.xz", "restricted/binary-amd64/Packages.xz"));
        assert.throws(() => parseInReleaseIndexes(missing, "noble"), /incomplete/u);
        const malformed = Buffer.from(release.toString("utf8").replace(emptyHash, "not-a-sha256"));
        assert.throws(() => parseInReleaseIndexes(malformed, "noble"), /malformed/u);
    });

    it("resolves a selected virtual provider and rejects ambiguous providers", () => {
        const records = [{name: "consumer", architecture: "amd64", version: "1", dependsOn: []},
            {name: "provider", architecture: "amd64", version: "1", dependsOn: []}];
        const expressions = new Map([["consumer", ["virtual-abi"]]]);
        resolveSelectedDependencies(records, expressions, new Map([["provider", "virtual-abi (= 1)"]]));
        assert.deepEqual(records[0].dependsOn, ["provider:amd64=1"]);
        const ambiguous = structuredClone(records);
        ambiguous.push({name: "provider-two", architecture: "amd64", version: "1", dependsOn: []});
        assert.throws(() => resolveSelectedDependencies(ambiguous, expressions,
            new Map([["provider", "virtual-abi"], ["provider-two", "virtual-abi"]])), /ambiguous/u);
    });

    it("rejects non-hosted context before filesystem, process or network activity", async () => {
        const calls = [];
        const altered = context(); altered.environment.GITHUB_ACTIONS = "false";
        assert.throws(() => createHostedStage2Operations({context: altered, paths: paths(), dependencies: {
            mkdirExclusive: () => calls.push("mkdir"), runOwned: () => calls.push("run"),
            downloadPinned: () => calls.push("network")
        }}), /hosted|context|environment/u);
        assert.deepEqual(calls, []);
    });

    it("collects actual statvfs units and complete self-cgroup ancestry before acquisition", async () => {
        const taskPath = "/home/runner/work/_temp";
        const levels = [{path: "/sys/fs/cgroup", limitBytes: null, currentBytes: null},
            {path: "/sys/fs/cgroup/actions_job", limitBytes: "16000000000", currentBytes: "1000000000"}];
        const observations = await collectHostedAdmissionObservations({context: context(), paths: paths(), dependencies: {
            readResources: target => ({filesystem: {taskPath: target, type: "ext4", mountOptions: "rw,relatime"},
                memory: {memAvailableBytes: "15226159104", cgroupLevels: levels,
                    cgroupHeadroomBytes: "15000000000", effectiveAvailableBytes: "15000000000"}}),
            readCgroupLayout: () => ({root: "/", mountPoint: "/sys/fs/cgroup",
                processDirectory: "/sys/fs/cgroup/actions_job", ancestorDirectories: levels.map(level => level.path)}),
            inspectOwned: target => ({path: target, bytes: "1", sha256: "a".repeat(64),
                ownership: {uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false}}),
            runOwned: async (command, argv) => { assert.equal(command, "/usr/bin/stat");
                if (argv[0] === "--printf=%m\\n") {
                    assert.deepEqual(argv, ["--printf=%m\\n", "--", taskPath]);
                    return {process: okProcess, stdout: Buffer.from("/\n"), stderr: Buffer.alloc(0)};
                }
                assert.deepEqual(argv, ["--file-system", "--printf=%a\\n%S\\n", "--", taskPath]);
                return {process: okProcess, stdout: Buffer.from("19816114\n4096\n"), stderr: Buffer.alloc(0)}; },
            pathExists: () => false, assertWritable: target => assert.equal(target, taskPath)
        }});
        assert.equal(observations.filesystem.mountPoint, "/");
        assert.equal(observations.filesystem.availableBytes, "81166802944");
        assert.equal(observations.memory.selfCgroupPath, "/sys/fs/cgroup/actions_job");
        assert.deepEqual(observations.memory.cgroupLevels.map(level => level.path), levels.map(level => level.path));
    });

    it("uses literal statvfs newlines and a separately bounded owned-tree observation at runtime", async () => {
        const taskPath = "/home/runner/work/_temp";
        const observed = await observeHostedRuntimeResources({
            readResources: () => ({memory: {effectiveAvailableBytes: "15000000000"}}),
            runOwned: async (command, argv) => { assert.equal(command, "/usr/bin/stat");
                assert.deepEqual(argv, ["--file-system", "--printf=%a\\n%S\\n", "--", taskPath]);
                return {process: okProcess, stdout: Buffer.from("20000000\n4096\n"), stderr: Buffer.alloc(0)}; },
            treeBytes: roots => { assert.deepEqual(roots, ["/owned", "/portable"]); return 21n; }
        }, {taskPath, roots: ["/owned", "/portable"]});
        assert.deepEqual(observed, {taskBytes: "21", freeBytes: "81920000000",
            effectiveMemoryBytes: "15000000000"});
    });

    it("parses bounded WIM metadata and removes the duplicate WIM before guest disk creation", async () => {
        const text = "WIM Information:\n----------------\nPath: /owned/install.wim\nGUID: 00000000\n\n" +
            "Available Images:\n-----------------\n" +
            "Index: 1\nName: Windows Server 2025 Standard Evaluation\nArchitecture: x86_64\n" +
            "Edition ID: ServerStandardEval\nInstallation Type: Server Core\nTotal Bytes: 15000000000\n\n" +
            "Index: 2\nName: Windows Server 2025 SERVERSTANDARD\nArchitecture: x86_64\n" +
            "Edition ID: ServerStandardEval\nInstallation Type: Server\nTotal Bytes: 24699866265\n";
        assert.equal(parseWimInfo(Buffer.from(text)).length, 2);
        assert.deepEqual(parseWimInfo(Buffer.from(text))[0], {index: 1,
            name: "Windows Server 2025 Standard Evaluation", architecture: "x64", editionId: "ServerStandardEval",
            installationType: "Server Core", totalBytes: "15000000000"});
        assert.throws(() => parseWimInfo(Buffer.alloc(1_048_577)), /bound/u);
        let removed = false;
        const adapter = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
            runOwned: async (command, argv, options) => {
                assert.equal(command.endsWith("ld-linux-x86-64.so.2"), true);
                assert.deepEqual(argv.slice(0, 5), ["--argv0", `${paths().portableRoot}/usr/bin/wiminfo`,
                    "--library-path", `${paths().portableRoot}/lib/x86_64-linux-gnu`,
                    `${paths().portableRoot}/usr/bin/wimlib-imagex`]);
                assert.equal(argv.at(-1), paths().installWim);
                assert.equal(options.maxStreamBytes, 1_048_576);
                return {process: okProcess, stdout: Buffer.from(text), stderr: Buffer.alloc(0)};
            }, removeOwned: target => { assert.equal(target, paths().installWim); removed = true; },
            pathExists: target => target === paths().installWim && !removed
        }});
        const installWim = {path: paths().installWim, sha256: "5".repeat(64)};
        const inventory = await adapter.inspectInstallWim({paths: paths(), installWim, toolchain: {runtime: {
            loader: {path: `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`},
            libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]},
        wiminfo: {path: `${paths().portableRoot}/usr/bin/wimlib-imagex`,
            invocationPath: `${paths().portableRoot}/usr/bin/wiminfo`}}});
        assert.equal(inventory.images.length, 2);
        assert.deepEqual(inventory.removal, {path: installWim.path, sha256: installWim.sha256, removed: true});
        assert.equal(removed, true);
    });

    it("recomputes guest CPU bits, exception exits and zero-network state from raw output", () => {
        const cpuid = {schemaVersion: 1, kind: "cpuid", maxBasicLeaf: 7,
            leaf1: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00900000", edx: "0x00000000"},
            leaf7Subleaf0: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00000000", edx: "0x00000000"},
            xcr0: null, features: {sse42: true, popcnt: true, osxsave: false, avx: false, avx2: false}};
        const output = role => Buffer.from(JSON.stringify({schemaVersion: 1, kind: role,
            result: {"known-good": 42, "known-bad": 13, sse42: 2276049685, popcnt: 32}[role]}) + "\n").toString("base64");
        const runs = [
            {role: "cpuid", exitCode: 0, stdoutBase64: Buffer.from(JSON.stringify(cpuid) + "\n").toString("base64"),
                stderrBase64: ""},
            ...["known-good", "known-bad", "sse42", "popcnt"].map(role => ({role,
                exitCode: role === "known-bad" ? 19 : 0, stdoutBase64: output(role), stderrBase64: ""})),
            ...["illegal", "avx", "avx2"].map(role => ({role, exitCode: 3221225501, stdoutBase64: "",
                stderrBase64: ""}))
        ];
        const parsed = parseGuestOutput(Buffer.from(JSON.stringify({schemaVersion: 1, nonce: NONCE, runs,
            network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}})), NONCE);
        assert.deepEqual(parsed.cpu, cpuid.features);
        assert.deepEqual(parsed.instructions, {sse42: "completed", popcnt: "completed",
            avx: "illegal-instruction", avx2: "illegal-instruction"});
        const altered = structuredClone({schemaVersion: 1, nonce: NONCE, runs, network: {hardwareNics: 0,
            enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}});
        altered.runs.find(run => run.role === "avx").exitCode = 0;
        assert.throws(() => parseGuestOutput(Buffer.from(JSON.stringify(altered)), NONCE), /AVX|illegal/u);
        const lowLeaf = structuredClone({schemaVersion: 1, nonce: NONCE, runs, network: {hardwareNics: 0,
            enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}});
        const lowCpuid = structuredClone(cpuid); lowCpuid.maxBasicLeaf = 1;
        lowLeaf.runs.find(run => run.role === "cpuid").stdoutBase64 = Buffer.from(JSON.stringify(lowCpuid)).toString("base64");
        assert.throws(() => parseGuestOutput(Buffer.from(JSON.stringify(lowLeaf)), NONCE), /maximum basic leaf/u);
    });

    it("uses exact package URLs/hashes, root extraction vectors and reviewed sudo QEMU launcher", async () => {
        const calls = [];
        const closure = {packages: TOP_LEVEL_PACKAGE_PINS.map(value => ({...value, dependsOn: []}))};
        const packageIdentities = new Map();
        for (const value of closure.packages) {
            packageIdentities.set(`${paths().packageRoot}/${value.name}.deb`, value);
            packageIdentities.set(`${paths().portableRoot}/.packages/${sha256ForTest(Buffer.from(
                `${value.name}:${value.architecture}=${value.version}`)).slice(0, 16)}.deb`, value);
        }
        const dependencies = {
            mkdirExclusive: target => calls.push(["mkdir", target]),
            writeExclusive: (target, bytes) => calls.push(["write", target, bytes.length]),
            downloadPinned: async request => { calls.push(["download", request.url, request.path, request.sha256]);
                return {path: request.path, bytes: request.bytes, sha256: request.sha256}; },
            runOwned: async (command, argv, options) => { calls.push(["run", command, argv, options]);
                const stdout = argv.includes(`${paths().portableRoot}/usr/lib/7zip/7z`) && argv.includes("i") ?
                    Buffer.from(`Libs:\n 0 : 23.01 : ${paths().portableRoot}/usr/lib/7zip/7z.so\n\n` +
                        "Formats:\n 0  ED       m  Iso      iso img        CD001\n") : Buffer.alloc(0);
                return {process: okProcess, stdout, stderr: Buffer.alloc(0)}; },
            inspectOwned: target => ({path: target.endsWith("/usr/bin/wiminfo") ?
                `${paths().portableRoot}/usr/bin/wimlib-imagex` :
                target.endsWith("/usr/bin/mformat") || target.endsWith("/usr/bin/mcopy") ?
                    `${paths().portableRoot}/usr/bin/mtools` : target,
                sha256: packageIdentities.get(target)?.sha256 ?? "f".repeat(64),
                ownership: {uid: "0", gid: "0", mode: packageIdentities.has(target) ? "444" : "555",
                    ordinaryUserWritable: false}, bytes: packageIdentities.get(target)?.bytes ?? "4096"}),
            inspectDirectory: directoryIdentity,
            pathExists: () => false,
            inventoryOwnedTree: (target, selector) => ({bytes: selector ? "128" : "512",
                sha256: (selector ? "d" : "e").repeat(64), root: target}),
            readOwned: () => Buffer.alloc(0),
            readOwnedVerified: target => ({bytes: Buffer.from("{}"), identity: {
                path: target, bytes: "2", sha256: "2".repeat(64)}}),
            runMonitoredQemu: async request => { calls.push(["monitored", request]); return {
                observation: {process: okProcess, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)},
                identity: {pid: 2345, processGroupId: 2300, startTicks: "77",
                    executablePath: `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`},
                absentAfter: true, processGroupGone: true, terminationReason: null}; },
            copyExclusive: () => undefined
        };
        const adapter = createHostedStage2Operations({context: context(), paths: paths(), dependencies});
        await adapter.acquirePackages({packageClosure: closure, paths: paths()});
        assert.equal(calls.filter(call => call[0] === "download").length, TOP_LEVEL_PACKAGE_PINS.length);
        assert.equal(calls.find(call => call[0] === "download")[1],
            `${STAGE2_PROVENANCE.ubuntuSnapshot.baseUrl}${TOP_LEVEL_PACKAGE_PINS[0].filename}`);
        const toolchain = await adapter.extractPortableTools({packageClosure: closure,
            acquisition: {packages: closure.packages.map(value => ({reference: `${value.name}:${value.architecture}=${value.version}`,
                path: `${paths().packageRoot}/${value.name}.deb`, bytes: value.bytes, sha256: value.sha256}))},
            paths: paths(), privilegeMode: "reviewed-sudo-kvm"});
        assert.equal(toolchain.wiminfo.path, `${paths().portableRoot}/usr/bin/wimlib-imagex`);
        assert.equal(toolchain.wiminfo.invocationPath, `${paths().portableRoot}/usr/bin/wiminfo`);
        assert.equal(toolchain.mformat.path, `${paths().portableRoot}/usr/bin/mtools`);
        assert.equal(toolchain.mformat.invocationPath, `${paths().portableRoot}/usr/bin/mformat`);
        assert.equal(toolchain.sevenZip.path, `${paths().portableRoot}/usr/lib/7zip/7z`);
        assert.equal(toolchain.sevenZip.invocationPath, `${paths().portableRoot}/usr/lib/7zip/7z`);
        const extract = calls.find(call => call[0] === "run" && call[2].some(value => value.endsWith("/dpkg-deb")));
        assert.deepEqual(extract[2].slice(0, 8), ["-n", "--", "/usr/bin/timeout", "--foreground", "--signal=KILL",
            "25s", "/usr/bin/dpkg-deb", "-x"]);
        const loader = `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`;
        const version = calls.find(call => call[0] === "run" && call[2].includes("--version"));
        assert.equal(version[1], loader);
        assert.deepEqual(version[2].slice(0, 5), ["--argv0", `${paths().portableRoot}/usr/bin/qemu-system-x86_64`,
            "--library-path",
            `${paths().portableRoot}/usr/lib/x86_64-linux-gnu:${paths().portableRoot}/usr/lib/7zip`,
            `${paths().portableRoot}/usr/bin/qemu-system-x86_64`]);
        const sevenZipInfo = calls.find(call => call[0] === "run" && call[2].includes(toolchain.sevenZip.path) &&
            call[2].includes("i"));
        assert.equal(sevenZipInfo[1], loader);
        assert.deepEqual(sevenZipInfo[2], ["--argv0", toolchain.sevenZip.invocationPath, "--library-path",
            `${paths().portableRoot}/usr/lib/x86_64-linux-gnu:${paths().portableRoot}/usr/lib/7zip`,
            toolchain.sevenZip.path, "i"]);

        const sevenZipExtractionInput = {packageClosure: closure,
            acquisition: {packages: closure.packages.map(value => ({
                reference: `${value.name}:${value.architecture}=${value.version}`,
                path: `${paths().packageRoot}/${value.name}.deb`, bytes: value.bytes, sha256: value.sha256}))},
            paths: paths(), privilegeMode: "reviewed-sudo-kvm"};
        const withoutModule = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
            ...dependencies,
            runOwned: async (command, argv) => ({process: okProcess,
                stdout: argv.includes(`${paths().portableRoot}/usr/lib/7zip/7z`) && argv.includes("i") ?
                    Buffer.from("Formats:\n 0  ED       m  Iso      iso img        CD001\n") : Buffer.alloc(0),
                stderr: Buffer.alloc(0)})
        }});
        await assert.rejects(withoutModule.extractPortableTools(sevenZipExtractionInput), /7-Zip module/u);
        const withoutIso = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
            ...dependencies,
            runOwned: async (command, argv) => ({process: okProcess,
                stdout: argv.includes(`${paths().portableRoot}/usr/lib/7zip/7z`) && argv.includes("i") ?
                    Buffer.from(`Libs:\n 0 : 23.01 : ${paths().portableRoot}/usr/lib/7zip/7z.so\n`) : Buffer.alloc(0),
                stderr: Buffer.alloc(0)})
        }});
        await assert.rejects(withoutIso.extractPortableTools(sevenZipExtractionInput), /7-Zip ISO support/u);
        const launch = await adapter.launchOwnedQemu({paths: paths(), toolchain,
            privilegeMode: "reviewed-sudo-kvm", argv: ["-nic", "none"]});
        assert.equal(launch.guest, null);
        assert.equal(launch.process.cleanupProven, true);
        assert.equal(launch.process.qemuPid, 2345);
        assert.equal(launch.process.qemuStartTicks, "77");
        assert.equal(launch.process.launcherExecutablePath, toolchain.runtime.loader.path);
        assert.equal(launch.process.processGroupId, 2300);
        assert.equal(launch.process.qemuPidAbsentAfter, true);
        const qemu = calls.find(call => call[0] === "monitored")[1];
        assert.equal(qemu.command, "/usr/bin/sudo");
        assert.deepEqual(qemu.argv.slice(0, 9), ["-n", "--", "/usr/bin/timeout", "--foreground", "--signal=KILL",
            "16200s", toolchain.runtime.loader.path, "--argv0", toolchain.qemu.invocationPath]);
    });

    it("captures the live QEMU PID/start/executable identity before accepting its cleanup", async () => {
        let identityReads = 0;
        const qemuPath = `${paths().portableRoot}/usr/bin/qemu-system-x86_64`;
        const adapter = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
            inspectOwned: rootFileIdentity,
            inspectDirectory: directoryIdentity,
            runOwned: async (command, argv, options) => { options?.onSpawn?.(2300); return {
                process: okProcess, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}; },
            pathExists: target => target === paths().qemuPid,
            readOwnedVerified: target => target === paths().qemuPid ?
                {bytes: Buffer.from("2345\n"), identity: {path: target, bytes: "5", sha256: "1".repeat(64)}} :
                {bytes: Buffer.from("{}"), identity: {path: target, bytes: "2", sha256: "2".repeat(64)}},
            readProcessIdentity: pid => {
                assert.equal(pid, 2345);
                identityReads += 1;
                return identityReads === 1 ? {state: "present", processGroupId: 2300, startTicks: "77",
                    executablePath: `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`} :
                    {state: "absent"};
            }, isProcessGroupAlive: () => false, observeRuntimeResources: () => ({taskBytes: "1",
                freeBytes: "90000000000", effectiveMemoryBytes: "15000000000"}),
            monotonicMilliseconds: () => identityReads, wait: async () => undefined
        }});
        const toolchain = {runtime: {loader: rootFileIdentity(
            `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`),
        libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]}, qemu: commandIdentity(qemuPath),
        mcopy: commandIdentity(`${paths().portableRoot}/usr/bin/mcopy`)};
        const launch = await adapter.launchOwnedQemu({paths: paths(), toolchain,
            privilegeMode: "reviewed-sudo-kvm", argv: ["-nic", "none"]});
        assert.equal(launch.process.cleanupProven, true);
        assert.deepEqual({pid: launch.process.qemuPid, startTicks: launch.process.qemuStartTicks,
            executablePath: launch.process.launcherExecutablePath, absent: launch.process.qemuPidAbsentAfter},
        {pid: 2345, startTicks: "77",
            executablePath: `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`, absent: true});
    });

    it("exposes the normalized monitored QEMU process proof without parsing guest output", async () => {
        const calls = [];
        const loader = `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`;
        const toolchain = {runtime: {loader: rootFileIdentity(loader),
            libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]},
        qemu: commandIdentity(`${paths().portableRoot}/usr/bin/qemu-system-x86_64`)};
        const launcher = createHostedQemuProcessLauncher({context: context(), paths: paths(), dependencies: {
            inspectOwned: rootFileIdentity,
            inspectDirectory: directoryIdentity,
            runMonitoredQemu: async request => { calls.push(request); return {
                observation: {process: okProcess, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)},
                identity: {pid: 2345, processGroupId: 2300, startTicks: "77", executablePath: loader},
                absentAfter: true, processGroupGone: true, terminationReason: null}; }
        }});
        const result = await launcher({paths: paths(), toolchain,
            privilegeMode: "reviewed-sudo-kvm", argv: ["-nic", "none"]});
        assert.deepEqual(Object.keys(result).sort(), ["argv", "executionSucceeded", "process", "processFlags"]);
        assert.equal(result.executionSucceeded, true);
        assert.deepEqual(result.processFlags, {errorObserved: false, stdoutOverflow: false, stderrOverflow: false});
        assert.equal(result.process.cleanupProven, true);
        assert.equal(result.process.treeGone, true);
        assert.equal(result.process.qemuPidAbsentAfter, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].command, "/usr/bin/sudo");
        assert.equal(calls.some(call => call.argv?.some(value => value === "::result.json")), false);
    });

    it("keeps stream, process, cleanup, and privilege failures out of both parser and generic success", async () => {
        const loader = `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`;
        const toolchain = {runtime: {loader: rootFileIdentity(loader),
            libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]},
        qemu: commandIdentity(`${paths().portableRoot}/usr/bin/qemu-system-x86_64`),
        mcopy: commandIdentity(`${paths().portableRoot}/usr/bin/mcopy`)};
        for (const changedProcess of [
            {...okProcess, errorObserved: true},
            {...okProcess, stdoutOverflow: true},
            {...okProcess, stderrOverflow: true},
            {...okProcess, cleanupProven: false}
        ]) {
            let extractionAttempted = false;
            const dependencies = {inspectOwned: rootFileIdentity, inspectDirectory: directoryIdentity,
                runOwned: async () => { extractionAttempted = true; return {process: okProcess,
                    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}; },
                runMonitoredQemu: async () => ({observation: {process: changedProcess,
                    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)},
                identity: {pid: 2345, processGroupId: 2300, startTicks: "77", executablePath: loader},
                absentAfter: true, processGroupGone: true, terminationReason: null})};
            const launcher = createHostedQemuProcessLauncher({context: context(), paths: paths(), dependencies});
            const processOnly = await launcher({paths: paths(), toolchain,
                privilegeMode: "reviewed-sudo-kvm", argv: ["-nic", "none"]});
            assert.equal(processOnly.executionSucceeded, false);
            assert.deepEqual(processOnly.failureDiagnostic, {schemaVersion: 1,
                kind: "qemu-launch-failure-diagnostic", process: processOnly.process,
                processFlags: {errorObserved: changedProcess.errorObserved,
                    stdoutOverflow: changedProcess.stdoutOverflow, stderrOverflow: changedProcess.stderrOverflow},
                stderr: {bytes: "0", sha256: crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
                    bytesBase64: ""}});
            assert.deepEqual(processOnly.processFlags, {errorObserved: changedProcess.errorObserved,
                stdoutOverflow: changedProcess.stdoutOverflow, stderrOverflow: changedProcess.stderrOverflow});
            const adapter = createHostedStage2Operations({context: context(), paths: paths(), dependencies});
            const stage2 = await adapter.launchOwnedQemu({paths: paths(), toolchain,
                privilegeMode: "reviewed-sudo-kvm", argv: ["-nic", "none"]});
            assert.equal(stage2.guest, null);
            assert.equal(extractionAttempted, false);
        }
        const launcher = createHostedQemuProcessLauncher({context: context(), paths: paths(), dependencies: {
            inspectOwned: rootFileIdentity, inspectDirectory: directoryIdentity}});
        await assert.rejects(() => launcher({paths: paths(), toolchain,
            privilegeMode: "unreviewed", argv: ["-nic", "none"]}), /privilege mode/i);
    });

    it("extracts bounded guest failure evidence only after clean QEMU teardown", async () => {
        const failure = {schemaVersion: 1, status: "failed", nonce: NONCE, stage: "guest-bootstrap",
            failure: "synthetic provider failure"};
        const extracted = [];
        const adapter = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
            inspectOwned: rootFileIdentity,
            inspectDirectory: directoryIdentity,
            runOwned: async (_command, argv) => { extracted.push(argv.find(value => value.startsWith("::")));
                return {process: okProcess, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}; },
            runMonitoredQemu: async () => ({observation: {process: okProcess, stdout: Buffer.alloc(0),
                stderr: Buffer.alloc(0)}, identity: {pid: 2345, processGroupId: 2300, startTicks: "77",
                executablePath: `${paths().portableRoot}/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`},
            absentAfter: true, processGroupGone: true, terminationReason: null}),
            readOwnedVerified: target => ({bytes: Buffer.from(JSON.stringify(failure)), identity: {
                path: target, bytes: String(Buffer.byteLength(JSON.stringify(failure))), sha256: "1".repeat(64)}})
        }});
        const toolchain = {runtime: {loader: rootFileIdentity(
            `${paths().portableRoot}/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`),
        libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]},
        qemu: commandIdentity(`${paths().portableRoot}/usr/bin/qemu-system-x86_64`),
        mcopy: commandIdentity(`${paths().portableRoot}/usr/bin/mcopy`)};
        const result = await adapter.launchOwnedQemu({paths: paths(), toolchain,
            privilegeMode: "reviewed-sudo-kvm", argv: ["-nic", "none"]});
        assert.deepEqual(result.guest, failure);
        assert.deepEqual(extracted, ["::result.json"]);
        assert.equal(result.process.cleanupProven, true);
        assert.equal(result.process.treeGone, true);
    });

    it("aborts when no QEMU identity appears within the bounded startup window", async () => {
        let clock = 0, finish, groupAlive = true;
        const adapter = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
            inspectOwned: rootFileIdentity, inspectDirectory: directoryIdentity,
            runOwned: (command, argv, options) => {
                if (argv.includes("/usr/bin/kill")) { groupAlive = false;
                    finish({process: {...okProcess, exitCode: 137}, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)});
                    return Promise.resolve({process: okProcess, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}); }
                options.onSpawn(2300); return new Promise(resolve => { finish = resolve; });
            }, pathExists: () => false, monotonicMilliseconds: () => clock,
            wait: async milliseconds => { clock += milliseconds; },
            isProcessGroupAlive: () => groupAlive
        }});
        const toolchain = {runtime: {loader: rootFileIdentity(
            `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`),
        libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]},
        qemu: commandIdentity(`${paths().portableRoot}/usr/bin/qemu-system-x86_64`),
        mcopy: commandIdentity(`${paths().portableRoot}/usr/bin/mcopy`)};
        const result = await adapter.launchOwnedQemu({paths: paths(), toolchain,
            privilegeMode: "reviewed-sudo-kvm", argv: ["-nic", "none"]});
        assert.equal(result.process.terminationReason, "identity-timeout");
        assert.equal(result.process.cleanupProven, false);
    });

    it("aborts a retained root QEMU group after sustained low memory and proves it gone", async () => {
        let clock = 0, identityReads = 0, finish, groupAlive = true;
        const processCalls = [];
        const adapter = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
            inspectOwned: rootFileIdentity, inspectDirectory: directoryIdentity,
            runOwned: (command, argv, options) => {
                processCalls.push([command, argv]);
                if (argv.includes("/usr/bin/kill")) {
                    groupAlive = false;
                    finish({process: {...okProcess, exitCode: 137}, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)});
                    return Promise.resolve({process: okProcess, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)});
                }
                if (argv.includes("/usr/bin/readlink")) return Promise.resolve({process: okProcess,
                    stdout: Buffer.from(`${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2\n`),
                    stderr: Buffer.alloc(0)});
                options.onSpawn(2300);
                options.onTerminationReady(reason => assert.equal(reason, "monitor-low-memory"));
                return new Promise(resolve => { finish = resolve; });
            }, pathExists: target => target === paths().qemuPid,
            readOwnedVerified: target => ({bytes: Buffer.from("2345\n"), identity: {path: target, bytes: "5",
                sha256: "1".repeat(64)}}),
            readProcessIdentity: () => ++identityReads <= 2 ? {state: "present", processGroupId: 2300,
                startTicks: "77", executablePath: null} : {state: "absent"},
            observeRuntimeResources: () => ({taskBytes: "1", freeBytes: "90000000000",
                effectiveMemoryBytes: "4294967295"}),
            monotonicMilliseconds: () => clock,
            wait: async milliseconds => { clock += milliseconds; },
            isProcessGroupAlive: group => { assert.equal(group, 2300); return groupAlive; }
        }});
        const toolchain = {runtime: {loader: rootFileIdentity(
            `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`),
        libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]},
        qemu: commandIdentity(`${paths().portableRoot}/usr/bin/qemu-system-x86_64`),
        mcopy: commandIdentity(`${paths().portableRoot}/usr/bin/mcopy`)};
        const result = await adapter.launchOwnedQemu({paths: paths(), toolchain,
            privilegeMode: "reviewed-sudo-kvm", argv: ["-nic", "none"]});
        assert.equal(result.process.terminationReason, "low-memory");
        assert.equal(result.process.cleanupProven, true);
        assert.equal(result.process.treeGone, true);
        assert.deepEqual(processCalls.find(([, argv]) => argv.includes("/usr/bin/kill"))[1].slice(-4),
            ["/usr/bin/kill", "-KILL", "--", "-2300"]);
    });

    it("binds the official ISO redirect, strong ETag, exact length and twin local digests", async () => {
        const calls = [];
        const digest = "a".repeat(64);
        const adapter = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
            downloadPinned: async request => {
                calls.push(request);
                return {path: request.path, bytes: request.bytes, sha256: digest,
                    finalUrl: request.finalUrl, etag: request.expectedEtag};
            },
            inspectOwned: target => ({path: target, bytes: STAGE2_PROVENANCE.windowsIso.bytes,
                sha256: digest, ownership: {uid: "1001", gid: "127", mode: "600", ordinaryUserWritable: false}})
        }});
        const result = await adapter.acquireWindowsIso({paths: paths(), provenance: STAGE2_PROVENANCE.windowsIso});
        assert.deepEqual(calls, [{url: STAGE2_PROVENANCE.windowsIso.aliasUrl,
            finalUrl: STAGE2_PROVENANCE.windowsIso.finalUrl, path: paths().windowsIso,
            bytes: STAGE2_PROVENANCE.windowsIso.bytes, sha256: null,
            expectedEtag: STAGE2_PROVENANCE.windowsIso.strongEtag}]);
        assert.equal(result.finalUrl, STAGE2_PROVENANCE.windowsIso.finalUrl);
        assert.equal(result.etag, STAGE2_PROVENANCE.windowsIso.strongEtag);
        assert.equal(result.observerA.sha256, digest);
        assert.equal(result.observerB.sha256, digest);
    });

    it("replays producer result identity before accepting probe executable bytes", () => {
        assert.deepEqual(CAPTURED_PROBE_BUILD.source, {runId: "34834310907", runAttempt: "1",
            sourceSha: "dce629fd50ea007221b3a9f2698c32a573bca160"});
        const files = CAPTURED_PROBE_BUILD.build.map(({mode, executable}) => ({role: mode,
            name: `${mode.replaceAll("-", "_")}.exe`, bytes: String(executable.bytes), sha256: executable.sha256}));
        const artifact = {sourceSha: context().sourceSha, runId: context().runId, runAttempt: context().runAttempt, files};
        const evidence = {schemaVersion: 1, kind: "myspeed-windows-cpu-readiness", status: "completed",
            qualifying: false, calibrationPassed: true, classification: "windows-native-host-observation-nonqualifying",
            sourceSha: artifact.sourceSha, eventSha: "b".repeat(40), runId: artifact.runId,
            runAttempt: artifact.runAttempt, nonce: "c".repeat(32), imageVersion: "20260907.1", failures: [],
            observations: {closureFiles: [], discovery: {}, preflight: {}, build: CAPTURED_PROBE_BUILD.build.map(record => ({mode: record.mode,
                macro: "PROBE", architecture: "/arch:SSE2", compileArguments: [], linkArguments: [], object: {},
                executable: structuredClone(record.executable)})), disassembly: [], calibration: {calibrationPassed: true,
                assessment: {calibrationPassed: true}, runs: []}, operations: [], cleanup: {}}};
        const bytes = Buffer.from(JSON.stringify(evidence));
        assert.deepEqual(parseProbeArtifactEvidence(bytes, artifact), {sourceSha: artifact.sourceSha,
            runId: artifact.runId, runAttempt: artifact.runAttempt, eventSha: evidence.eventSha,
            nonce: evidence.nonce, imageVersion: evidence.imageVersion});
        const changed = structuredClone(evidence);
        changed.observations.build[5].executable.sha256 = "f".repeat(64);
        assert.throws(() => parseProbeArtifactEvidence(Buffer.from(JSON.stringify(changed)), artifact),
            /executable evidence/u);
        const wrongRole = structuredClone(evidence);
        wrongRole.observations.build[0].executable.role = "executable";
        assert.throws(() => parseProbeArtifactEvidence(Buffer.from(JSON.stringify(wrongRole)), artifact),
            /executable evidence/u);
        for (const invalidBytes of [files[0].bytes, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            const invalid = structuredClone(evidence);
            invalid.observations.build[0].executable.bytes = invalidBytes;
            assert.throws(() => parseProbeArtifactEvidence(Buffer.from(JSON.stringify(invalid)), artifact),
                /executable evidence/u);
        }
    });

    it("verifies generated disk geometry and returns computed package-tree manifests", async () => {
        const calls = [];
        const packageIdentities = new Map(TOP_LEVEL_PACKAGE_PINS.flatMap(value => [
            [`${paths().packageRoot}/${value.name}.deb`, value],
            [`${paths().portableRoot}/.packages/${sha256ForTest(Buffer.from(
                `${value.name}:${value.architecture}=${value.version}`)).slice(0, 16)}.deb`, value]]));
        const identity = target => ({path: target.endsWith("/usr/bin/mcopy") || target.endsWith("/usr/bin/mformat") ?
            `${paths().portableRoot}/usr/bin/mtools` : target,
            bytes: packageIdentities.get(target)?.bytes ?? (target.endsWith("output.img") ? "67108864" :
                target.endsWith("bootstrap.ps1") ? "1" : "4096"),
            sha256: packageIdentities.get(target)?.sha256 ?? (target.endsWith("bootstrap.ps1") ?
                sha256ForTest(Buffer.from("x")) : "a".repeat(64)),
            ownership: {uid: "0", gid: "0", mode: packageIdentities.has(target) ? "444" : "555",
                ordinaryUserWritable: false}});
        const adapter = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
            runOwned: async (command, argv, options) => {
                calls.push([command, argv, options]);
                const stdout = argv.includes(`${paths().portableRoot}/usr/lib/7zip/7z`) && argv.includes("i") ?
                    Buffer.from(`Libs:\n 0 : 23.01 : ${paths().portableRoot}/usr/lib/7zip/7z.so\n\n` +
                        "Formats:\n 0  ED       m  Iso      iso img        CD001\n") :
                    argv.includes("info") && argv.includes(`${paths().portableRoot}/usr/bin/qemu-img`) ?
                        Buffer.from(JSON.stringify({format: "qcow2",
                        "virtual-size": 51_539_607_552})) : Buffer.alloc(0);
                return {process: okProcess, stdout, stderr: Buffer.alloc(0)};
            },
            inspectOwned: identity,
            inspectDirectory: directoryIdentity,
            pathExists: () => false,
            inventoryOwnedTree: (target, selector) => ({root: target, bytes: selector ? "128" : "512",
                sha256: (selector ? "d" : "e").repeat(64)}),
            mkdirExclusive: () => undefined, writeExclusive: () => undefined, copyExclusive: () => undefined,
            makeSizedFile: () => undefined
        }});
        const closure = {packages: TOP_LEVEL_PACKAGE_PINS.map(value => ({...value, dependsOn: []}))};
        const toolchain = await adapter.extractPortableTools({packageClosure: closure,
            acquisition: {packages: closure.packages.map(value => ({reference: `${value.name}:${value.architecture}=${value.version}`,
                path: `${paths().packageRoot}/${value.name}.deb`, bytes: value.bytes, sha256: value.sha256}))},
            paths: paths(), privilegeMode: "reviewed-sudo-kvm"});
        assert.deepEqual(toolchain.installedFilesManifest, {bytes: "512", sha256: "e".repeat(64)});
        assert.deepEqual(toolchain.licensesManifest, {bytes: "128", sha256: "d".repeat(64)});
        const inline = Buffer.from("x");
        await adapter.prepareOfflineMedia({paths: paths(), toolchain, seedSpec: {sha256: "b".repeat(64), files: [{
            name: "bootstrap.ps1", kind: "inline", bytes: "1", sha256: sha256ForTest(inline),
            bytesBase64: inline.toString("base64")}]}});
        assert.ok(calls.some(([command, argv]) => command === toolchain.runtime.loader.path &&
            JSON.stringify(argv.slice(-4)) === JSON.stringify([toolchain.qemuImg.path, "info", "--output=json",
                paths().systemDisk])));
        assert.ok(calls.some(([, argv]) => argv.includes(toolchain.sevenZip.path) && argv.includes(paths().seedIso) &&
            argv.some(value => value.endsWith("/seed-verify"))));
        for (const role of ["mformat"]) {
            assert.equal(toolchain[role].path, `${paths().portableRoot}/usr/bin/mtools`);
            assert.ok(calls.some(([, argv]) => argv[0] === "--argv0" &&
                argv[1] === `${paths().portableRoot}/usr/bin/${role}` && argv.includes(toolchain[role].path)));
        }
    });
});

function sha256ForTest(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}
