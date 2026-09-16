import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {describe, it} from "node:test";

import {
    WINPE_DIAGNOSTIC_MEMBER_READ_BYTES,
    createHostedStage2Operations,
    publishWinpeDiagnosticMember,
    runHostedOwnedProcess,
    winpeDiagnosticGuestSecret
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";
import {WINPE_DIAGNOSTIC_MEMBERS} from "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";
import {WINPE_DIAGNOSTIC_CONFIRMATION} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs";

const NONCE = "0123456789abcdef0123456789abcdef";
const AUTHORIZATION = {confirmation: WINPE_DIAGNOSTIC_CONFIRMATION, nonce: NONCE};
const SECRET = winpeDiagnosticGuestSecret(NONCE);

const context = () => ({schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: "a".repeat(40),
    eventSha: "b".repeat(40), runId: "123", runAttempt: "1", nonce: NONCE,
    environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
        RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260907.1"}});

function paths() {
    const root = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${NONCE}`;
    return {root, packageRoot: `${root}/packages`, portableRoot: `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}`,
        probeRoot: `${root}/probes`, windowsIso: `${root}/windows.iso`, installWim: `${root}/install.wim`,
        seedIso: `${root}/seed.iso`, outputDisk: `${root}/output.img`, systemDisk: `${root}/system.qcow2`,
        ovmfVars: `${root}/OVMF_VARS.fd`, serialLog: `${root}/serial.log`, qemuPid: `${root}/qemu.pid`};
}

const rootFileIdentity = target => ({path: target, bytes: "4096", sha256: "f".repeat(64),
    ownership: {uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false}});
const commandIdentity = target => ({...rootFileIdentity(target), invocationPath: target});
const directoryIdentity = target => ({path: target, dev: "1", ino: target === "/tmp" ? "1" : "2", uid: "0",
    gid: "0", mode: target === "/tmp" ? "1777" : "755", ordinaryUserWritable: target === "/tmp",
    sticky: target === "/tmp"});
const okProcess = {exitCode: 0, signal: null, timedOut: false, stdoutOverflow: false, stderrOverflow: false,
    cleanupProven: true, errorObserved: false};

function toolchain() {
    const portableRoot = paths().portableRoot;
    return {firmware: {searchPath: `${portableRoot}/usr/share/qemu`,
        kvmvapic: rootFileIdentity(`${portableRoot}/usr/share/qemu/kvmvapic.bin`),
        vga: rootFileIdentity(`${portableRoot}/usr/share/seabios/vgabios-stdvga.bin`)},
    runtime: {loader: rootFileIdentity(`${portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`),
        libraryPath: [`${portableRoot}/lib/x86_64-linux-gnu`]},
    qemu: commandIdentity(`${portableRoot}/usr/bin/qemu-system-x86_64`),
    mcopy: commandIdentity(`${portableRoot}/usr/bin/mcopy`)};
}

/*
 * A launch whose QEMU never really runs: the monitored launcher is injected, so the only thing the
 * adapter actually exercises here is what happens after the guest is gone - the identity checks,
 * the budget and the bounded extraction. No image, no disk and no process are touched.
 */
function adapter({members = {}, validateOutputDisk, monotonic, processFor = () => okProcess,
    onRun = () => undefined, lateBoot = null, cleanupProven = true} = {}) {
    const runs = [];
    let now = 0;
    const operations = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
        inspectOwned: rootFileIdentity,
        inspectDirectory: directoryIdentity,
        pathExists: () => false,
        monotonicMilliseconds: () => (monotonic === undefined ? (now += 1) : monotonic()),
        validateOutputDisk: validateOutputDisk ?? ((target, expected) => ({path: target, dev: "3", ino: "4",
            bytes: "67108864", expected: expected ?? null})),
        runOwned: async (command, argv, options) => {
            const member = argv.at(-2)?.replace(/^::/u, "");
            runs.push({member, timeoutMs: options.timeoutMs, maxStreamBytes: options.maxStreamBytes,
                destination: argv.at(-1)});
            onRun(member);
            const stdout = members[member] ?? null;
            return {process: processFor(member), stdout: stdout ?? Buffer.alloc(0), stderr: Buffer.alloc(0)};
        },
        runMonitoredQemu: async () => ({
            observation: {process: {...okProcess, exitCode: null, signal: "SIGKILL", timedOut: true},
                stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)},
            identity: {pid: 2345, startTicks: "77",
                executablePath: toolchain().runtime.loader.path, processGroupId: 2300},
            qmp: null, lateBoot, monitorFailure: null, absentAfter: true,
            processGroupGone: cleanupProven, terminationReason: "deadline"})
    }});
    return {operations, runs};
}

const launchInput = (overrides = {}) => ({paths: paths(), toolchain: toolchain(),
    privilegeMode: "ordinary-kvm", argv: ["-nic", "none"], winpeDiagnostic: AUTHORIZATION,
    reservation: {label: "winpe-answer-file-diagnostic", executionMilliseconds: 360_000,
        cleanupMilliseconds: 300_000}, ...overrides});

describe("WinPE diagnostic collection reads only the allowlisted members", () => {
    it("extracts each allowlisted member to stdout under a live cap and publishes a redacted body", async () => {
        const body = Buffer.from(`Setup found answer file, password ${SECRET}\r\n`, "utf8");
        const {operations, runs} = adapter({members: {"MSACT.LOG": body,
            "MSDIAG.OK": Buffer.from(`MYSPEEDOUT ${NONCE}\r\n`, "utf8")},
        processFor: member => ["MSACT.LOG", "MSDIAG.OK"].includes(member) ? okProcess :
            {...okProcess, exitCode: 1}});
        const launched = await operations.launchOwnedQemu(launchInput({
            winpeDiagnosticCollectionDeadlineMilliseconds: 10_000_000}));
        assert.deepEqual(runs.map(run => run.member), WINPE_DIAGNOSTIC_MEMBERS.map(member => member.name));
        /* Destination `-` is stdout: no runner temporary file is created for any member. */
        assert.ok(runs.every(run => run.destination === "-"));
        assert.ok(runs.every(run => run.maxStreamBytes === WINPE_DIAGNOSTIC_MEMBER_READ_BYTES));
        const collection = launched.winpeDiagnostic.collection;
        assert.equal(collection.status, "capture-complete");
        assert.equal(collection.outputDiskVerified, true);
        const captured = collection.members.find(member => member.name === "MSACT.LOG");
        assert.equal(captured.status, "captured");
        const published = Buffer.from(captured.textBase64, "base64").toString("utf8");
        assert.ok(published.includes("Setup found answer file"));
        assert.equal(published.includes(SECRET), false);
        assert.equal(captured.redactionHits, 1);
        assert.equal(collection.members.filter(member => member.status === "absent").length, 5);
        assert.equal(launched.guest, null);
        assert.equal(launched.winpeDiagnostic.nonce, NONCE);
    });

    it("calls the guest completion marker missing rather than reporting a complete capture", async () => {
        const {operations} = adapter({members: {"MSACT.LOG": Buffer.from("log\r\n", "utf8")},
            processFor: member => member === "MSACT.LOG" ? okProcess : {...okProcess, exitCode: 1}});
        const launched = await operations.launchOwnedQemu(launchInput({
            winpeDiagnosticCollectionDeadlineMilliseconds: 10_000_000}));
        assert.equal(launched.winpeDiagnostic.collection.status, "inconclusive");
        assert.match(launched.winpeDiagnostic.collection.failure, /completion marker/u);
    });

    it("reports inconclusive and withholds when a member cannot be redacted", async () => {
        const mixed = Buffer.concat([Buffer.alloc(64, 0x41), Buffer.from(SECRET, "utf8"),
            Buffer.from(SECRET, "utf16le")]);
        const {operations} = adapter({members: {"MSACT.LOG": mixed,
            "MSDIAG.OK": Buffer.from(`MYSPEEDOUT ${NONCE}\r\n`, "utf8")},
        processFor: member => ["MSACT.LOG", "MSDIAG.OK"].includes(member) ? okProcess :
            {...okProcess, exitCode: 1}});
        const launched = await operations.launchOwnedQemu(launchInput({
            winpeDiagnosticCollectionDeadlineMilliseconds: 10_000_000}));
        const collection = launched.winpeDiagnostic.collection;
        assert.equal(collection.status, "inconclusive");
        assert.match(collection.failure, /withheld/u);
        const withheld = collection.members.find(member => member.name === "MSACT.LOG");
        assert.equal(withheld.status, "withheld-mixed-encoding");
        assert.equal(withheld.textBase64, undefined);
    });
});

describe("WinPE diagnostic collection refuses to read at all when it is not safe", () => {
    it("never runs an extraction when the guest process tree was not proven gone", async () => {
        const {operations, runs} = adapter({cleanupProven: false});
        const launched = await operations.launchOwnedQemu(launchInput({
            winpeDiagnosticCollectionDeadlineMilliseconds: 10_000_000}));
        assert.deepEqual(runs, []);
        assert.equal(launched.winpeDiagnostic.collection.status, "unsafe");
        assert.equal(launched.winpeDiagnostic.collection.outputDiskVerified, false);
        assert.match(launched.winpeDiagnostic.collection.failure, /not proven gone/u);
    });

    it("never runs an extraction when the output disk is no longer the file this task created", async () => {
        let call = 0;
        const {operations, runs} = adapter({validateOutputDisk: () => {
            call += 1;
            if (call === 1) return {path: paths().outputDisk, dev: "3", ino: "4"};
            throw new Error("output disk identity changed");
        }});
        const launched = await operations.launchOwnedQemu(launchInput({
            winpeDiagnosticCollectionDeadlineMilliseconds: 10_000_000}));
        assert.deepEqual(runs, []);
        assert.equal(launched.winpeDiagnostic.collection.status, "unsafe");
        assert.match(launched.winpeDiagnostic.collection.failure, /identity changed/u);
    });

    it("stops before a member whose extraction the remaining budget can no longer fund", async () => {
        let now = 0;
        const {operations, runs} = adapter({monotonic: () => now,
            onRun: () => { now += 400; },
            members: {}, processFor: () => ({...okProcess, exitCode: 1})});
        const launched = await operations.launchOwnedQemu(launchInput({
            winpeDiagnosticCollectionDeadlineMilliseconds: 1_000}));
        assert.ok(runs.length >= 1 && runs.length < WINPE_DIAGNOSTIC_MEMBERS.length,
            `expected a partial member sweep, observed ${runs.length}`);
        const collection = launched.winpeDiagnostic.collection;
        assert.equal(collection.status, "inconclusive");
        assert.match(collection.failure, /budget was exhausted/u);
        assert.equal(collection.members.at(-1).status, "budget-exhausted");
        /* Every extraction is given only what is left, never the full command allowance. */
        assert.ok(runs.every(run => run.timeoutMs <= 1_000));
    });

    it("distinguishes a timed-out, a failing and an uncleaned extraction from an absent member", async () => {
        const outcomes = {"MSDIAG.STA": {...okProcess, exitCode: null, timedOut: true},
            "MSACT.LOG": {...okProcess, exitCode: null, errorObserved: true},
            "MSERR.LOG": {...okProcess, cleanupProven: false},
            "MSBTACT.LOG": {...okProcess, exitCode: 1}};
        const {operations} = adapter({processFor: member => outcomes[member] ?? {...okProcess, exitCode: 1}});
        const launched = await operations.launchOwnedQemu(launchInput({
            winpeDiagnosticCollectionDeadlineMilliseconds: 10_000_000}));
        const byName = new Map(launched.winpeDiagnostic.collection.members.map(m => [m.name, m.status]));
        assert.equal(byName.get("MSDIAG.STA"), "timeout");
        assert.equal(byName.get("MSACT.LOG"), "tool-error");
        assert.equal(byName.get("MSERR.LOG"), "cleanup-unproven");
        assert.equal(byName.get("MSBTACT.LOG"), "absent");
        assert.equal(launched.winpeDiagnostic.collection.status, "inconclusive");
    });
});

/*
 * These drive the real `runHostedOwnedProcess` against a real writing subprocess, which is the
 * mechanism the extraction bound rests on. The byte accounting is identical on every platform; the
 * process-group cleanup proof needs a POSIX group, so only that assertion is conditional. Nothing
 * here is mcopy - see the result document for what a real FAT round trip does and does not prove.
 */
const POSIX_GROUPS = process.platform !== "win32";

describe("WinPE diagnostic extraction bound is enforced while the subprocess runs", () => {
    it("stops a member that grows without limit at the cap, with no runner temporary file", async () => {
        const emitter = "const b=Buffer.alloc(65536,65);for(;;){if(!process.stdout.write(b))break;}";
        const started = Date.now();
        const observed = await runHostedOwnedProcess(process.execPath, ["-e", emitter],
            {timeoutMs: 30_000, maxStreamBytes: WINPE_DIAGNOSTIC_MEMBER_READ_BYTES});
        assert.equal(observed.stdout.length, WINPE_DIAGNOSTIC_MEMBER_READ_BYTES);
        assert.equal(observed.process.stdoutOverflow, true);
        assert.equal(observed.process.timedOut, false);
        assert.ok(Date.now() - started < 20_000, "the cap has to stop the writer, not the deadline");
    });

    it("is the production cap: a chunk that exactly fills it is accepted, not called an overflow", async () => {
        const exact = `process.stdout.write(Buffer.alloc(${WINPE_DIAGNOSTIC_MEMBER_READ_BYTES}, 66))`;
        const observed = await runHostedOwnedProcess(process.execPath, ["-e", exact],
            {timeoutMs: 30_000, maxStreamBytes: WINPE_DIAGNOSTIC_MEMBER_READ_BYTES});
        assert.equal(observed.stdout.length, WINPE_DIAGNOSTIC_MEMBER_READ_BYTES);
        assert.equal(observed.process.stdoutOverflow, false,
            "the prototype's >= would have called an exactly-full read an overflow");
        if (POSIX_GROUPS) assert.equal(observed.process.cleanupProven, true);
    });

    it("refuses a stream bound larger than the shipped ceiling", async () => {
        await assert.rejects(runHostedOwnedProcess(process.execPath, ["-e", "0"],
            {timeoutMs: 1_000, maxStreamBytes: 2_097_153}), /process bounds are invalid/u);
        assert.ok(WINPE_DIAGNOSTIC_MEMBER_READ_BYTES < 2_097_152);
    });
});

/*
 * The one link in the chain that needs the real tools: a FAT image written with mformat, a member
 * written with mcopy, and the same member read back to stdout by the exact invocation the collector
 * builds. It proves the invocation and the stdout destination, not durability through `ide-hd` and
 * not a guest's write surviving SIGKILL - only a native run can show that.
 */
describe("WinPE diagnostic mcopy round trip", () => {
    const mtools = (() => {
        for (const root of ["/usr/bin", "/bin"]) {
            const mformat = path.join(root, "mformat");
            const mcopy = path.join(root, "mcopy");
            if (fs.existsSync(mformat) && fs.existsSync(mcopy)) return {mformat, mcopy};
        }
        return null;
    })();

    it("reads an allowlisted member back from a real FAT image straight to stdout", async t => {
        if (mtools === null) return t.skip("mtools is not installed on this host");
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-winpe-mcopy-"));
        t.after(() => fs.rmSync(root, {recursive: true, force: true}));
        const image = path.join(root, "output.img");
        const source = path.join(root, "MSACT.LOG");
        const body = Buffer.from(`[0x0600055c] IMAGE  Found answer file ${SECRET}\r\n`, "utf8");
        fs.writeFileSync(source, body);
        fs.writeFileSync(image, Buffer.alloc(67_108_864));
        const run = (command, argv) => spawnSync(command, argv,
            {encoding: "buffer", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"]});
        assert.equal(run(mtools.mformat, ["-i", image, "-v", "MYSPEEDOUT", "::"]).status, 0);
        assert.equal(run(mtools.mcopy, ["-i", image, source, "::MSACT.LOG"]).status, 0);
        const observed = await runHostedOwnedProcess(mtools.mcopy,
            ["-i", image, "::MSACT.LOG", "-"],
            {timeoutMs: 30_000, maxStreamBytes: WINPE_DIAGNOSTIC_MEMBER_READ_BYTES});
        assert.equal(observed.process.exitCode, 0);
        assert.ok(observed.stdout.includes(Buffer.from("Found answer file", "utf8")));
        const record = publishWinpeDiagnosticMember("MSACT.LOG", observed, [SECRET]);
        assert.equal(record.status, "captured");
        assert.equal(Buffer.from(record.textBase64, "base64").includes(Buffer.from(SECRET, "utf8")), false);
        /* And an absent member is an absent member, not an empty success. */
        const missing = await runHostedOwnedProcess(mtools.mcopy, ["-i", image, "::MSDIAG.OK", "-"],
            {timeoutMs: 30_000, maxStreamBytes: WINPE_DIAGNOSTIC_MEMBER_READ_BYTES});
        assert.equal(publishWinpeDiagnosticMember("MSDIAG.OK", missing, [SECRET]).status, "absent");
    });
});

describe("WinPE diagnostic record carries no unredacted stream", () => {
    it("never attaches the serial console prefix or the raw QEMU stderr", async () => {
        /*
         * The ordinary failure path attaches a bounded serial-console prefix and the raw QEMU
         * stderr to `failureDiagnostic`. Those are unredacted guest and process streams; a
         * diagnostic run returns before that record can reach its result, and this asserts it.
         */
        const {operations} = adapter({members: {"MSDIAG.OK": Buffer.from(`MYSPEEDOUT ${NONCE}\r\n`, "utf8")},
            processFor: member => member === "MSDIAG.OK" ? okProcess : {...okProcess, exitCode: 1}});
        const launched = await operations.launchOwnedQemu(launchInput({
            winpeDiagnosticCollectionDeadlineMilliseconds: 10_000_000}));
        const serialized = JSON.stringify(launched.winpeDiagnostic);
        assert.equal(serialized.includes("serialLog"), false);
        assert.equal(serialized.includes("stderr"), false);
        assert.deepEqual(Object.keys(launched.winpeDiagnostic).sort(),
            ["collection", "confirmation", "input", "kind", "nonce", "schemaVersion"]);
    });

    it("refuses to read when the output disk was never identified before the launch", async () => {
        const {operations, runs} = adapter({validateOutputDisk: () => { throw new Error("not owned"); }});
        const launched = await operations.launchOwnedQemu(launchInput({
            winpeDiagnosticCollectionDeadlineMilliseconds: 10_000_000}));
        assert.deepEqual(runs, []);
        assert.equal(launched.winpeDiagnostic.collection.status, "unsafe");
        assert.match(launched.winpeDiagnostic.collection.failure, /not identified before the launch/u);
    });
});
