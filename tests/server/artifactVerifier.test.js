import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    assertLinuxNetworkIsolation,
    assertOwnedListener,
    assertOriginalBuildUnavailable,
    assertPortFree,
    buildLocalOrigin,
    checkJsonResponse,
    checkPng,
    requestLocal,
    sanitizedEnvironment,
    stopOwnedProcess,
    waitForListenerFreeExit,
    waitForOwnedListener
} from "../../scripts/qualification/safety.mjs";
import {
    awaitHealthcheckHandshake,
    assertRuntimeIdentity,
    checkCfspeedtestVersion,
    clientScriptTargets,
    createEvidenceDirectory,
    EVIDENCE_DIRECTORY_MODE,
    EVIDENCE_FILE_MODE,
    parseArguments as parseVerifierArguments,
    removeOwnedWork
} from "../../scripts/qualification/check-artifact.mjs";
import {
    FIXTURE_MARKER,
    loadHandoffFixture,
    makeFixtureAccessibleToUid,
    prepareStaticFixtures
} from "../../scripts/qualification/fixture.mjs";
import { checkPopulatedDatabase, checkResetDatabase } from "../../scripts/qualification/sqlite-check.mjs";

const TEST_HOST = "127.0.0.1";
const TEST_PORT = 43127;
const OWNED_PID = 8123;
const FOREIGN_PID = 9123;
const MOCK_FAILURE_EXIT = 97;
const PNG_WIDTH = 1200;
const PNG_HEIGHT = 600;
const REPOSITORY = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const REPOSITORY_COMMIT = execFileSync("git", ["rev-parse", "HEAD"], {cwd: REPOSITORY, encoding: "utf8"}).trim();
const FIXTURE_SCRIPT = path.join(REPOSITORY, "scripts", "qualification", "fixture.mjs");
const WINDOWS_GIT_BASH = "C:/Program Files/Git/bin/bash.exe";
const BASH_EXECUTABLE = process.platform === "win32" ? WINDOWS_GIT_BASH : "bash";
const VERIFY_IMAGE_SCRIPT = path.join(REPOSITORY, "scripts", "verify-image.sh");
const toBashPath = (value) => process.platform === "win32"
    ? value.replace(/^([A-Za-z]):/, (_match, drive) => `/${drive.toLowerCase()}`).replaceAll("\\", "/")
    : value;

const png = ({width = PNG_WIDTH, height = PNG_HEIGHT} = {}) => {
    const bytes = Buffer.alloc(64, 1);
    Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
    bytes.writeUInt32BE(13, 8);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
};

describe("artifact verifier input boundary", () => {
    it("creates intentionally exportable evidence without relaxing fixture modes", () => {
        const calls = [];
        const created = createEvidenceDirectory("/evidence", {
            mkdir: (...args) => calls.push(["mkdir", ...args]),
            mkdtemp: (prefix) => {
                calls.push(["mkdtemp", prefix]);
                return `${prefix}synthetic`;
            },
            chmod: (...args) => calls.push(["chmod", ...args])
        });
        assert.match(created, /myspeed-evidence-synthetic$/);
        assert.deepEqual(calls.at(-1), ["chmod", created, 0o755]);
        assert.equal(EVIDENCE_DIRECTORY_MODE, 0o755);
        assert.equal(EVIDENCE_FILE_MODE, 0o644);
    });

    it("accepts only literal loopback origins", () => {
        assert.equal(buildLocalOrigin(TEST_HOST, TEST_PORT), `http://${TEST_HOST}:${TEST_PORT}`);
        assert.equal(buildLocalOrigin("::1", TEST_PORT), `http://[::1]:${TEST_PORT}`);

        for (const host of ["localhost", "0.0.0.0", "::", "192.0.2.1", "example.com"])
            assert.throws(() => buildLocalOrigin(host, TEST_PORT), /literal loopback/i);

        for (const port of [0, -1, 65536, 1.5, "5216"])
            assert.throws(() => buildLocalOrigin(TEST_HOST, port), /port/i);
    });

    it("refuses a compiled run while its original build root is readable", () => {
        const readable = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-build-root-"));
        try {
            assert.throws(() => assertOriginalBuildUnavailable(readable), /still readable/i);
            assert.throws(() => assertOriginalBuildUnavailable("relative/build"), /absolute path/i);
            assert.doesNotThrow(() => assertOriginalBuildUnavailable(path.join(readable, "absent")));
        } finally {
            fs.rmSync(readable, {recursive: true, force: true});
        }
    });

    it("builds a small child environment without inherited service or network settings", () => {
        const source = {
            PATH: "safe-path",
            SystemRoot: "safe-root",
            TEMP: "safe-temp",
            DB_TYPE: "mysql",
            DB_HOST: "production-db",
            HTTP_PROXY: "http://proxy.invalid",
            HTTPS_PROXY: "http://proxy.invalid",
            ALL_PROXY: "socks://proxy.invalid",
            NO_PROXY: "*",
            TRUST_PROXY: "true",
            TRUSTED_AUTH_HEADER: "x-user",
            ALLOW_NO_PASSWORD: "true",
            PREVIEW_MODE: "true",
            RUN_TEST_ON_STARTUP: "true",
            SECRET_FROM_HOST: "must-not-cross"
        };

        const before = structuredClone(source);
        assert.deepEqual(sanitizedEnvironment(source, {host: TEST_HOST, port: TEST_PORT}), {
            PATH: "safe-path",
            SystemRoot: "safe-root",
            TEMP: "safe-temp",
            NODE_ENV: "production",
            DB_TYPE: "sqlite",
            SERVER_HOST: TEST_HOST,
            SERVER_PORT: String(TEST_PORT),
            RUN_TEST_ON_STARTUP: "false"
        });
        assert.deepEqual(source, before, "sanitizing the child environment mutated the parent environment");
    });

    it("does not let optional additions override the isolation settings", () => {
        const environment = sanitizedEnvironment({}, {
            host: TEST_HOST,
            port: TEST_PORT,
            extra: {
                DB_TYPE: "mysql",
                SERVER_HOST: "0.0.0.0",
                SERVER_PORT: "5216",
                RUN_TEST_ON_STARTUP: "true"
            }
        });

        assert.equal(environment.DB_TYPE, "sqlite");
        assert.equal(environment.SERVER_HOST, TEST_HOST);
        assert.equal(environment.SERVER_PORT, String(TEST_PORT));
        assert.equal(environment.RUN_TEST_ON_STARTUP, "false");
    });

    it("makes preseeded handoff and source-backed fixture modes mutually exclusive", () => {
        assert.throws(() => parseVerifierArguments([
            "--command", "/candidate", "--repo", "/source",
            "--preseeded-fixture-manifest", "/input/manifest.json",
            "--work", "/work", "--reset-work", "/reset", "--keep-work"
        ]), /forbids --repo/i);
        assert.throws(() => parseVerifierArguments([
            "--command", "/candidate", "--preseeded-fixture-manifest", "/input/manifest.json",
            "--work", "/work", "--keep-work"
        ]), /--reset-work/i);
        assert.doesNotThrow(() => parseVerifierArguments([
            "--command", "/candidate", "--preseeded-fixture-manifest", "/input/manifest.json",
            "--work", "/work", "--reset-work", "/reset", "--keep-work",
            "--healthcheck-handshake", "/evidence"
        ]));
        assert.throws(() => parseVerifierArguments([
            "--command", "/candidate", "--repo", "/source", "--mode", "listener-free-reset",
            "--healthcheck-handshake", "/evidence"
        ]), /requires full/i);
    });
});

describe("listener ownership gate", () => {
    const listener = (overrides = {}) => ({
        address: TEST_HOST,
        port: TEST_PORT,
        pid: OWNED_PID,
        ...overrides
    });

    it("accepts the exact literal address only when the launched PID owns it", () => {
        assert.doesNotThrow(() => assertOwnedListener({
            listeners: [listener()], host: TEST_HOST, port: TEST_PORT, pid: OWNED_PID
        }));
    });

    it("refuses wildcard and foreign listeners before any request", () => {
        assert.throws(() => assertOwnedListener({
            listeners: [listener({address: "0.0.0.0"})], host: TEST_HOST, port: TEST_PORT, pid: OWNED_PID
        }), /wildcard/i);
        assert.throws(() => assertOwnedListener({
            listeners: [listener({pid: FOREIGN_PID})], host: TEST_HOST, port: TEST_PORT, pid: OWNED_PID
        }), /owned by pid/i);
        assert.throws(() => assertOwnedListener({
            listeners: [], host: TEST_HOST, port: TEST_PORT, pid: OWNED_PID
        }), /not listening/i);
        assert.throws(() => assertOwnedListener({
            listeners: [listener({address: "0:0:0:0:0:0:0:0"})],
            host: "::1", port: TEST_PORT, pid: OWNED_PID
        }), /wildcard/i);
    });

    it("refuses an occupied port without issuing an HTTP request", async () => {
        let requests = 0;
        const inspect = () => {
            requests += 0;
            return [listener({pid: FOREIGN_PID})];
        };

        await assert.rejects(assertPortFree({host: TEST_HOST, port: TEST_PORT, inspect}), /already occupied/i);
        assert.equal(requests, 0);
    });

    it("reports a child crash and a bounded listener timeout", async () => {
        await assert.rejects(waitForOwnedListener({
            child: {pid: OWNED_PID, exitCode: 17, signalCode: null},
            host: TEST_HOST,
            port: TEST_PORT,
            timeoutMs: 10,
            inspect: () => []
        }), /exited before listening/i);

        await assert.rejects(waitForOwnedListener({
            child: {pid: OWNED_PID, exitCode: null, signalCode: null},
            host: TEST_HOST,
            port: TEST_PORT,
            timeoutMs: 1,
            pollMs: 1,
            inspect: () => [],
            delay: async () => undefined
        }), /timed out/i);
    });

    it("fails if a listener-free child opens any address on its assigned port", async () => {
        await assert.rejects(waitForListenerFreeExit({
            child: {pid: OWNED_PID, exitCode: null, signalCode: null},
            port: TEST_PORT,
            timeoutMs: 10,
            inspect: () => [listener({address: "0.0.0.0"})]
        }), /listener-free process opened/i);
    });

    it("fails closed when listener inspection through the stable verifier PID fails", async () => {
        const denied = Object.assign(new Error(`EACCES: scandir '/proc/${OWNED_PID}/fd'`), {code: "EACCES"});
        let inspectedPid;

        await assert.rejects(waitForListenerFreeExit({
            child: {pid: OWNED_PID, exitCode: null, signalCode: null},
            port: TEST_PORT,
            timeoutMs: 100,
            pollMs: 5,
            inspect: (pid) => {
                inspectedPid = pid;
                throw denied;
            }
        }), (error) => error === denied);

        assert.equal(inspectedPid, process.pid);
    });

    it("does not inspect sockets after the child exit is observable", async () => {
        let inspections = 0;
        const exitCode = await waitForListenerFreeExit({
            child: {pid: OWNED_PID, exitCode: MOCK_FAILURE_EXIT, signalCode: null},
            port: TEST_PORT,
            timeoutMs: 100,
            inspect: () => {
                inspections += 1;
                return [];
            }
        });

        assert.equal(exitCode, MOCK_FAILURE_EXIT);
        assert.equal(inspections, 0);
    });
});

describe("local HTTP checks", () => {
    const origin = buildLocalOrigin(TEST_HOST, TEST_PORT);

    it("never follows a redirect", async () => {
        let redirectMode;
        const fetchImpl = async (_url, options) => {
            redirectMode = options.redirect;
            return new Response(null, {status: 302, headers: {location: "https://example.com/"}});
        };

        await assert.rejects(requestLocal(origin, "/api/health", {fetchImpl}), /redirect/i);
        assert.equal(redirectMode, "manual");
    });

    it("refuses absolute and protocol-relative request targets", async () => {
        const fetchImpl = async () => { throw new Error("fetch must not run"); };

        for (const target of ["https://example.com/", "//example.com/", "api/health"])
            await assert.rejects(requestLocal(origin, target, {fetchImpl}), /relative path/i);
    });

    it("requires the expected JSON body and a real 1200x600 PNG", async () => {
        checkJsonResponse({status: 200, body: {status: "ok", database: "up"}},
            {status: "ok", database: "up"});
        assert.throws(() => checkJsonResponse({status: 200, body: {status: "bad"}}, {status: "ok"}),
            /status/i);

        assert.deepEqual(checkPng(png()), {width: PNG_WIDTH, height: PNG_HEIGHT, bytes: 64});
        assert.throws(() => checkPng(Buffer.from("not png")), /PNG/i);
        assert.throws(() => checkPng(png({width: 1})), /1200x600/i);
    });

    it("normalizes and checks every root-relative or dot-relative client script", () => {
        const origin = buildLocalOrigin(TEST_HOST, TEST_PORT);
        const html = '<script src="./themeBoot.js"></script>'
            + '<script type="module" src="./assets/index-abc.js?build=1"></script>'
            + '<script src="/absolute.js"></script>';
        assert.deepEqual(clientScriptTargets(html, origin), [
            "/themeBoot.js",
            "/assets/index-abc.js?build=1",
            "/absolute.js"
        ]);
        for (const source of ["//example.com/escape.js", "https://example.com/escape.js", ".\\escape.js"])
            assert.throws(() => clientScriptTargets(`<script src="${source}"></script>`, origin),
                /escaped|backslash/i);
    });
});

describe("runtime isolation and teardown", () => {
    it("refuses Linux namespaces that still have a non-loopback route", () => {
        assert.throws(() => assertLinuxNetworkIsolation({
            platform: "linux",
            routeTable: "Iface Destination Gateway Flags\neth0 00000000 0100007F 0003",
            ipv6RouteTable: ""
        }), /outbound route/i);
        assert.doesNotThrow(() => assertLinuxNetworkIsolation({
            platform: "linux",
            routeTable: "Iface Destination Gateway Flags\nlo 00000000 00000000 0001",
            ipv6RouteTable: ""
        }));
        assert.throws(() => assertLinuxNetworkIsolation({
            platform: "linux",
            routeTable: "Iface Destination Gateway Flags",
            ipv6RouteTable: `${"0".repeat(128)} 00000000 00000000 00000001 eth0`
        }), /IPv6 route/i);
        assert.throws(() => assertLinuxNetworkIsolation({platform: "win32", routeTable: ""}),
            /cannot prove/i);
    });

    it("reports a child that remains alive after both owned stop attempts", async () => {
        const calls = [];
        const child = {
            pid: OWNED_PID,
            exitCode: null,
            signalCode: null,
            kill(signal) { calls.push(signal); return true; }
        };

        await assert.rejects(stopOwnedProcess(child, {
            waitForExit: async () => false,
            gracefulTimeoutMs: 1,
            forcedTimeoutMs: 1
        }), /still running/i);
        assert.deepEqual(calls, ["SIGTERM", "SIGKILL"]);
    });

    it("uses a graceful stop when the owned child exits", async () => {
        const calls = [];
        const child = {
            pid: OWNED_PID,
            exitCode: null,
            signalCode: null,
            kill(signal) { calls.push(signal); return true; }
        };

        await stopOwnedProcess(child, {waitForExit: async () => true});
        assert.deepEqual(calls, ["SIGTERM"]);
    });

    it("requires the unprivileged image process to retain no effective capabilities", () => {
        const status = "Name:\tbun\nUid:\t1000\t1000\t1000\t1000\nCapEff:\t0000000000000000\n";
        assert.doesNotThrow(() => assertRuntimeIdentity({
            child: {pid: OWNED_PID},
            expectedUid: "1000",
            work: "unused",
            platform: "linux",
            readStatus: () => status,
            readDataUid: () => 1000
        }));
        assert.throws(() => assertRuntimeIdentity({
            child: {pid: OWNED_PID},
            expectedUid: "1000",
            work: "unused",
            platform: "linux",
            readStatus: () => status.replace(/0+\n$/, "0000000000080000\n"),
            readDataUid: () => 1000
        }), /effective capabilities/i);
    });

    it("executes the baked cfspeedtest and requires its exact version", () => {
        const calls = [];
        const runBinary = (binary, args, options) => {
            calls.push({binary, args, options});
            return "cfspeedtest 2.2.2\n";
        };

        assert.equal(checkCfspeedtestVersion({
            work: "/qualification-work",
            expectedVersion: "2.2.2",
            environment: {PATH: "safe"},
            runBinary
        }), "cfspeedtest 2.2.2");
        assert.deepEqual(calls[0].args, ["--version"]);
        assert.match(calls[0].binary, /bin[\\/]cfspeedtest$/);
        assert.throws(() => checkCfspeedtestVersion({
            work: "/qualification-work",
            expectedVersion: "2.2.2",
            environment: {},
            runBinary: () => "cfspeedtest 2.2.1\n"
        }), /exact version 2\.2\.2/i);
    });

    it("holds the verified child until an exact fresh healthcheck acknowledgement arrives", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-healthcheck-test-"));
        const request = path.join(directory, "healthcheck-request.json");
        const acknowledgement = path.join(directory, "healthcheck-ack.json");
        const child = {pid: OWNED_PID, exitCode: null, signalCode: null};

        try {
            let copied = false;
            const result = await awaitHealthcheckHandshake({
                directory,
                child,
                port: TEST_PORT,
                write: (file, bytes, options) => {
                    assert.equal(options.mode, EVIDENCE_FILE_MODE);
                    fs.writeFileSync(file, bytes, options);
                },
                sleep: async () => {
                    if (!copied) {
                        fs.copyFileSync(request, acknowledgement, fs.constants.COPYFILE_EXCL);
                        copied = true;
                    }
                }
            });
            assert.equal(result.observed, true);
            assert.equal(result.pid, OWNED_PID);
            assert.equal(result.port, TEST_PORT);
            assert.deepEqual(fs.readFileSync(acknowledgement), fs.readFileSync(request));

            fs.rmSync(request);
            fs.rmSync(acknowledgement);
            fs.writeFileSync(acknowledgement, "stale");
            await assert.rejects(awaitHealthcheckHandshake({directory, child, port: TEST_PORT}), /stale/i);
            assert.equal(fs.existsSync(request), false);
        } finally {
            fs.rmSync(directory, {recursive: true, force: true});
        }
    });

    it("fails a mismatched healthcheck acknowledgement or a child exit", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-healthcheck-negative-test-"));
        const request = path.join(directory, "healthcheck-request.json");
        const acknowledgement = path.join(directory, "healthcheck-ack.json");

        try {
            await assert.rejects(awaitHealthcheckHandshake({
                directory,
                child: {pid: OWNED_PID, exitCode: null, signalCode: null},
                port: TEST_PORT,
                sleep: async () => fs.writeFileSync(acknowledgement, "not-the-request", {flag: "wx"})
            }), /match/i);

            fs.rmSync(request);
            fs.rmSync(acknowledgement);
            await assert.rejects(awaitHealthcheckHandshake({
                directory,
                child: {pid: OWNED_PID, exitCode: 1, signalCode: null},
                port: TEST_PORT
            }), /exited/i);
        } finally {
            fs.rmSync(directory, {recursive: true, force: true});
        }
    });

    it("refuses stale fixtures and reports cleanup failures", () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-verifier-test-"));
        const work = fs.mkdtempSync(path.join(parent, "myspeed-qualification-"));
        const nonce = "test-owned-nonce";

        try {
            prepareStaticFixtures({work, nonce, platform: "linux"});
            assert.ok(fs.existsSync(path.join(work, FIXTURE_MARKER)));
            assert.throws(() => prepareStaticFixtures({work, nonce, platform: "linux"}), /stale fixture/i);
            assert.throws(() => removeOwnedWork(work, nonce, () => { throw new Error("cleanup denied"); }),
                /cleanup denied/i);
            assert.ok(fs.existsSync(work), "failed cleanup silently removed the evidence directory");
        } finally {
            fs.rmSync(parent, {recursive: true, force: true});
        }
    });

    it("refuses caller-supplied work data and unexpected binaries before writing fixtures", () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-verifier-existing-test-"));
        const work = path.join(parent, "myspeed-qualification-existing");

        try {
            fs.mkdirSync(path.join(work, "data"), {recursive: true});
            const database = path.join(work, "data", "storage.db");
            fs.writeFileSync(database, "pre-existing database");
            assert.throws(() => prepareStaticFixtures({work, nonce: "nonce", platform: "linux"}),
                /pre-existing fixture data/i);
            assert.equal(fs.readFileSync(database, "utf8"), "pre-existing database");
            assert.equal(fs.existsSync(path.join(work, FIXTURE_MARKER)), false);

            fs.rmSync(path.join(work, "data"), {recursive: true, force: true});
            fs.mkdirSync(path.join(work, "bin"), {recursive: true});
            const binary = path.join(work, "bin", "speedtest");
            fs.writeFileSync(binary, "pre-existing binary");
            assert.throws(() => prepareStaticFixtures({work, nonce: "nonce", platform: "linux"}),
                /pre-existing fixture binary/i);
            assert.equal(fs.readFileSync(binary, "utf8"), "pre-existing binary");
            assert.equal(fs.existsSync(path.join(work, FIXTURE_MARKER)), false);

            fs.rmSync(binary);
            const baked = path.join(work, "bin", "cfspeedtest");
            fs.writeFileSync(baked, "baked cli");
            assert.doesNotThrow(() => prepareStaticFixtures({
                work,
                nonce: "nonce",
                platform: "linux",
                allowedExistingBinaries: ["cfspeedtest"]
            }));
            assert.equal(fs.readFileSync(baked, "utf8"), "baked cli");
        } finally {
            fs.rmSync(parent, {recursive: true, force: true});
        }
    });

    it("changes ownership only after proving the complete fixture tree belongs to this run", () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-verifier-owner-test-"));
        const work = fs.mkdtempSync(path.join(parent, "myspeed-qualification-"));
        const nonce = "ownership-test-nonce";

        try {
            prepareStaticFixtures({work, nonce, platform: "linux"});
            const changed = [];
            makeFixtureAccessibleToUid({
                work,
                nonce,
                uid: "1000",
                chown: (file, uid, gid) => changed.push({file, uid, gid})
            });
            assert.ok(changed.some(({file}) => file === work));
            assert.ok(changed.some(({file}) => file === path.join(work, "data")));
            assert.ok(changed.some(({file}) => file === path.join(work, "bin")));
            assert.ok(changed.every(({uid, gid}) => uid === 1000 && gid === -1));

            const markerLink = path.join(parent, "linked-marker.json");
            fs.linkSync(path.join(work, FIXTURE_MARKER), markerLink);
            const unsafeChanges = [];
            assert.throws(() => makeFixtureAccessibleToUid({
                work,
                nonce,
                uid: "1000",
                chown: (...args) => unsafeChanges.push(args)
            }), /linked file/i);
            assert.deepEqual(unsafeChanges, []);
            fs.rmSync(markerLink);

            const unsafe = path.join(work, "data", "unsafe-link");
            assert.throws(() => makeFixtureAccessibleToUid({
                work,
                nonce,
                uid: "1000",
                lstat: (file) => file === unsafe
                    ? {isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true}
                    : fs.lstatSync(file),
                readdir: (directory) => directory === path.join(work, "data")
                    ? [...fs.readdirSync(directory), "unsafe-link"]
                    : fs.readdirSync(directory),
                chown: (...args) => unsafeChanges.push(args)
            }), /symbolic link/i);
            assert.deepEqual(unsafeChanges, [], "ownership changed before the whole tree was validated");

            assert.throws(() => makeFixtureAccessibleToUid({
                work,
                nonce: "foreign-nonce",
                uid: "1000",
                chown: (...args) => unsafeChanges.push(args)
            }), /identity/i);
            assert.deepEqual(unsafeChanges, []);
        } finally {
            fs.rmSync(parent, {recursive: true, force: true});
        }
    });

    it("seeds with real migrations and reopens the synthetic database", () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-verifier-db-test-"));
        const work = fs.mkdtempSync(path.join(parent, "myspeed-qualification-"));
        const nonce = "database-owned-nonce";
        const environment = sanitizedEnvironment(process.env, {host: TEST_HOST, port: TEST_PORT});

        try {
            for (const command of ["seed", "check"]) {
                const result = spawnSync(process.execPath, [
                    FIXTURE_SCRIPT, command, "--repo", REPOSITORY, "--work", work, "--nonce", nonce
                ], {cwd: REPOSITORY, env: environment, encoding: "utf8", timeout: 30_000});

                assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`);
            }

            assert.ok(fs.statSync(path.join(work, "data", "storage.db")).size > 0);
            removeOwnedWork(work, nonce);
            assert.equal(fs.existsSync(work), false);
        } finally {
            fs.rmSync(parent, {recursive: true, force: true});
        }
    });

    it("creates and validates a versioned two-work handoff without importing application code at runtime", async () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-handoff-test-"));
        const work = path.join(parent, "populated");
        const resetWork = path.join(parent, "reset");
        const manifestPath = path.join(parent, "handoff.json");
        fs.mkdirSync(work);
        fs.mkdirSync(resetWork);

        try {
            const createdProcess = spawnSync(process.execPath, [
                FIXTURE_SCRIPT, "handoff",
                "--repo", REPOSITORY,
                "--work", work,
                "--reset-work", resetWork,
                "--manifest", manifestPath,
                "--source-sha", REPOSITORY_COMMIT
            ], {cwd: REPOSITORY, encoding: "utf8", timeout: 30_000});
            assert.equal(createdProcess.status, 0, `${createdProcess.stdout}\n${createdProcess.stderr}`);
            const created = JSON.parse(createdProcess.stdout.trim().split(/\r?\n/).at(-1));
            assert.equal(created.schemaVersion, 1);
            await assert.rejects(loadHandoffFixture({
                file: manifestPath,
                work,
                resetWork
            }), /writable at runtime/i);
            const loaded = await loadHandoffFixture({
                file: manifestPath,
                work,
                resetWork,
                requireReadOnly: false
            });
            assert.equal(loaded.populated.nonce, created.populated.nonce);
            await checkPopulatedDatabase(path.join(work, "data", "storage.db"), loaded.expected);

            assert.equal(fs.existsSync(path.join(resetWork, "data", "storage.db")), false);
            fs.writeFileSync(path.join(resetWork, "data", "storage.db"), "not sqlite");
            await assert.rejects(checkResetDatabase(path.join(resetWork, "data", "storage.db")));
            fs.rmSync(path.join(resetWork, "data", "storage.db"));
            fs.writeFileSync(path.join(resetWork, "unexpected.txt"), "unexpected");
            await assert.rejects(loadHandoffFixture({
                file: manifestPath,
                work,
                resetWork,
                requireReadOnly: false
            }), /file inventory/i);
            fs.rmSync(path.join(resetWork, "unexpected.txt"));

            const tampered = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
            tampered.populated.markerSha256 = "0".repeat(64);
            fs.writeFileSync(manifestPath, JSON.stringify(tampered));
            await assert.rejects(loadHandoffFixture({
                file: manifestPath,
                work,
                resetWork,
                requireReadOnly: false
            }), /marker hash/i);
        } finally {
            fs.rmSync(parent, {recursive: true, force: true});
        }
    });
});

describe("thin platform entrypoints", () => {
    it("delegates PowerShell without mutating the parent environment or launching directly", () => {
        const source = fs.readFileSync(path.join(REPOSITORY, "scripts", "verify-binary.ps1"), "utf8");

        assert.match(source, /qualification\/check-artifact\.mjs/);
        assert.doesNotMatch(source, /Start-Process|\$env:SERVER_(?:HOST|PORT)\s*=/i);
        assert.match(source, /listener-free-reset/);
        assert.match(source, /--original-build-root/);
    });

    it("keeps image requests inside a network-none container with no published ports", () => {
        const source = fs.readFileSync(path.join(REPOSITORY, "scripts", "verify-image.sh"), "utf8");

        assert.match(source, /--network none/);
        assert.match(source, /\/qualification\/check-artifact\.mjs/);
        assert.match(source, /"\$DOCKER" port "\$CONTAINER"/);
        assert.deepEqual(source.split(/\r?\n/).filter((line) =>
            /^\s*-(?:p|P)(?:\s|$)|--publish(?:=|\s)/.test(line)), []);
        assert.doesNotMatch(source, /\bcurl\b/);
        assert.match(source, /--cap-add SYS_PTRACE/);
        assert.match(source, /--expected-cfspeedtest-version "\$CFSPEEDTEST_VERSION"/);
    });

    it("does not delete a pre-existing Docker resource on a generated-name collision", (context) => {
        if (process.platform === "win32" && !fs.existsSync(BASH_EXECUTABLE)) {
            context.skip("Git Bash is unavailable");
            return;
        }

        const temporaryDirectory = fs.mkdtempSync(path.join(REPOSITORY, ".artifact-verifier-docker-mock-"));
        context.after(() => fs.rmSync(temporaryDirectory, {recursive: true, force: true}));
        const mockDocker = path.join(temporaryDirectory, "docker-mock.sh");
        const commandLog = path.join(temporaryDirectory, "commands.log");
        fs.writeFileSync(mockDocker, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MOCK_DOCKER_LOG"
if [ "$1 $2" = "image inspect" ]; then
    printf '{}\\n'
    exit 0
fi
if [ "$1" = "inspect" ]; then
    exit 1
fi
if [ "$1 $2" = "volume inspect" ] && [[ "$3" = *-data ]]; then
    exit 0
fi
if [ "$1 $2" = "volume inspect" ]; then
    exit 1
fi
exit ${MOCK_FAILURE_EXIT}
`);
        fs.chmodSync(mockDocker, 0o700);

        const result = spawnSync(BASH_EXECUTABLE, [toBashPath(VERIFY_IMAGE_SCRIPT),
            "synthetic-image"], {
            env: {
                ...process.env,
                DOCKER_CLI: "./docker-mock.sh",
                MOCK_DOCKER_LOG: "commands.log",
                RUNNER_TEMP: "."
            },
            cwd: temporaryDirectory,
            encoding: "utf8"
        });
        assert.equal(fs.existsSync(commandLog), true, `${result.stdout}${result.stderr}`);
        const commands = fs.readFileSync(commandLog, "utf8");

        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}${result.stderr}`, /already exists/i);
        assert.match(commands, /volume inspect .*?-data/);
        assert.doesNotMatch(commands, /(?:^|\n)(?:container )?rm |volume rm /);
    });

    it("removes a label-proven volume after a later Docker creation failure", (context) => {
        if (process.platform === "win32" && !fs.existsSync(BASH_EXECUTABLE)) {
            context.skip("Git Bash is unavailable");
            return;
        }

        const temporaryDirectory = fs.mkdtempSync(path.join(REPOSITORY, ".artifact-verifier-docker-cleanup-"));
        context.after(() => fs.rmSync(temporaryDirectory, {recursive: true, force: true}));
        const mockDocker = path.join(temporaryDirectory, "docker-mock.sh");
        const commandLog = path.join(temporaryDirectory, "commands.log");
        fs.writeFileSync(mockDocker, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MOCK_DOCKER_LOG"
if [ "$1 $2" = "image inspect" ]; then
    printf '{}\\n'
    exit 0
fi
if [ "$1" = "inspect" ]; then
    exit 1
fi
if [ "$1 $2" = "volume create" ]; then
    name="\${5}"
    if [[ "$name" = *-bin ]]; then
        exit ${MOCK_FAILURE_EXIT}
    fi
    printf '%s\\n' "$name" > owned-name
    printf '%s\\n' "\${4#*=}" > owned-token
    printf '%s\\n' "$name"
    exit 0
fi
if [ "$1 $2" = "volume inspect" ]; then
    name="\${!#}"
    [ -f owned-name ] && [ "$(cat owned-name)" = "$name" ] || exit 1
    if [ "$3" = "--format" ]; then
        cat owned-token
    fi
    exit 0
fi
if [ "$1 $2" = "volume rm" ]; then
    rm -f owned-name owned-token
    exit 0
fi
exit ${MOCK_FAILURE_EXIT}
`);
        fs.chmodSync(mockDocker, 0o700);

        const result = spawnSync(BASH_EXECUTABLE, [toBashPath(VERIFY_IMAGE_SCRIPT),
            "synthetic-image"], {
            env: {
                ...process.env,
                DOCKER_CLI: "./docker-mock.sh",
                MOCK_DOCKER_LOG: "commands.log",
                RUNNER_TEMP: "."
            },
            cwd: temporaryDirectory,
            encoding: "utf8"
        });
        const commands = fs.readFileSync(commandLog, "utf8");

        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}${result.stderr}`, /Could not create task-owned Docker volume/);
        assert.match(commands, /volume create .*?-data/);
        assert.match(commands, /volume rm .*?-data/);
        assert.doesNotMatch(commands, /volume rm .*?-bin/);
    });
});
