import {describe, it} from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    assertHostedMacEnvironment,
    buildSandboxArguments,
    buildSandboxProfile,
    parseArguments,
    runIsolationProbe,
    runMacosIsolationCanary,
    validateProbeResult
} from "../../scripts/qualification/macos-isolation.mjs";

const EXPECTED_ARCH = "arm64";
const RUNNER_ARCH = "ARM64";
const SOURCE_SENTINEL = "package.json";
const SOURCE_SENTINEL_CONTENTS = "synthetic source sentinel\n";
const MAX_SOURCE_SENTINEL_BYTES = 1_048_576;
const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
const VALID_DENIAL = {denied: true, code: "EPERM", timedOut: false};
const VALID_RESULT = {
    schemaVersion: 1,
    loopback: {roundTrip: true, host: "127.0.0.1"},
    temporaryFile: {roundTrip: true},
    sourceRoot: VALID_DENIAL,
    sourceSentinel: VALID_DENIAL,
    forbidden: {
        tcp4: VALID_DENIAL,
        tcp6: {denied: true, code: "EACCES", timedOut: false},
        udp4: VALID_DENIAL,
        udp6: VALID_DENIAL
    },
    helper: {
        inherited: true,
        forbidden: {tcp4: VALID_DENIAL, tcp6: VALID_DENIAL, udp4: VALID_DENIAL, udp6: VALID_DENIAL}
    }
};

const setup = context => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-macos-isolation-test-"));
    context.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const sourceRoot = path.join(root, "source");
    const runnerTemp = path.join(root, "runner-temp");
    const evidenceDir = path.join(runnerTemp, "evidence");
    fs.mkdirSync(sourceRoot);
    fs.mkdirSync(runnerTemp);
    fs.writeFileSync(path.join(sourceRoot, SOURCE_SENTINEL), SOURCE_SENTINEL_CONTENTS);
    return {root, sourceRoot, runnerTemp, evidenceDir};
};

describe("macOS Seatbelt canary profile", () => {
    it("denies all network access before allowing only literal loopback operations", () => {
        const profile = buildSandboxProfile();
        assert.match(profile, /^\(version 1\)/);
        assert.match(profile, /\(deny network\*\)/);
        assert.match(profile, /\(allow network-bind \(local ip "localhost:\*"\)\)/);
        assert.match(profile, /\(allow network-inbound \(local ip "localhost:\*"\)\)/);
        assert.match(profile, /\(allow network-outbound \(remote ip "localhost:\*"\)\)/);
        assert.doesNotMatch(profile, /127\.0\.0\.1|::1|remote (?:tcp|udp) "\*:/);
    });

    it("denies the parameterized source root itself and every descendant without interpolation", () => {
        const profile = buildSandboxProfile();
        assert.match(profile, /\(deny file-write\*/);
        assert.match(profile, /\(deny file-read\*/);
        assert.match(profile, /\(literal \(param "SOURCE_ROOT"\)\)/);
        assert.match(profile, /\(subpath \(param "SOURCE_ROOT"\)\)/);
        assert.doesNotMatch(profile, /Users|runner|workspace/);
    });

    it("passes canonical paths only through sandbox-exec -D parameters", () => {
        const args = buildSandboxArguments({
            profileFile: "/private/tmp/profile.sb",
            sourceRoot: "/Users/runner/work/project/project",
            scriptFile: "/private/tmp/macos-isolation.mjs",
            workRoot: "/private/tmp/work",
            sourceSentinel: "/Users/runner/work/project/project/package.json"
        });
        assert.deepEqual(args.slice(0, 4), ["-D", "SOURCE_ROOT=/Users/runner/work/project/project", "-f",
            "/private/tmp/profile.sb"]);
        assert.deepEqual(args.slice(4, 6), [process.execPath, "/private/tmp/macos-isolation.mjs"]);
        assert.ok(args.includes("probe"));
        assert.ok(args.includes("--work-root"));
        assert.ok(args.includes("--source-sentinel"));
    });
});

describe("macOS canary input boundary", () => {
    it("accepts only an exact hosted GitHub macOS architecture and canonical directories", context => {
        const {sourceRoot, runnerTemp} = setup(context);
        const result = assertHostedMacEnvironment({
            expectedArch: EXPECTED_ARCH,
            sourceRoot,
            platform: "darwin",
            architecture: EXPECTED_ARCH,
            environment: {
                CI: "true",
                GITHUB_ACTIONS: "true",
                RUNNER_ENVIRONMENT: "github-hosted",
                RUNNER_ARCH,
                RUNNER_TEMP: runnerTemp
            }
        });
        assert.equal(result.sourceRoot, fs.realpathSync(sourceRoot));
        assert.equal(result.runnerTemp, fs.realpathSync(runnerTemp));
        assert.equal(result.architecture, EXPECTED_ARCH);
    });

    it("rejects non-macOS, self-hosted, architecture drift, aliases and nested roots", context => {
        const {sourceRoot, runnerTemp} = setup(context);
        const base = {
            expectedArch: EXPECTED_ARCH,
            sourceRoot,
            platform: "darwin",
            architecture: EXPECTED_ARCH,
            environment: {
                CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted",
                RUNNER_ARCH, RUNNER_TEMP: runnerTemp
            }
        };
        assert.throws(() => assertHostedMacEnvironment({...base, platform: "linux"}), /macOS/i);
        assert.throws(() => assertHostedMacEnvironment({...base,
            environment: {...base.environment, RUNNER_ENVIRONMENT: "self-hosted"}}), /hosted/i);
        assert.throws(() => assertHostedMacEnvironment({...base, architecture: "x64"}), /architecture/i);
        assert.throws(() => assertHostedMacEnvironment({...base,
            environment: {...base.environment, RUNNER_ARCH: "X64"}}), /architecture/i);
        assert.throws(() => assertHostedMacEnvironment({...base, sourceRoot: `${sourceRoot}${path.sep}..${path.sep}source`}),
            /canonical/i);
        assert.throws(() => assertHostedMacEnvironment({...base,
            environment: {...base.environment, RUNNER_TEMP: path.join(sourceRoot, "nested")}}), /separate/i);
    });

    it("parses only the bounded canary and internal probe interfaces", () => {
        assert.deepEqual(parseArguments([
            "canary", "--expected-arch", "x64", "--source-root", "/source",
            "--evidence-dir", "/evidence", "--source-sentinel", "package.json"
        ]), {
            command: "canary", expectedArch: "x64", sourceRoot: "/source",
            evidenceDir: "/evidence", sourceSentinel: "package.json"
        });
        assert.throws(() => parseArguments(["canary", "--expected-arch", "x64"]), /source-root/i);
        assert.throws(() => parseArguments(["candidate", "--expected-arch", "x64"]), /command/i);
        assert.throws(() => parseArguments(["canary", "--unknown", "value"]), /unknown/i);
        assert.throws(() => parseArguments([
            "canary", "--expected-arch", "x64", "--expected-arch", "arm64",
            "--source-root", "/source", "--evidence-dir", "/evidence"
        ]), /duplicate/i);
    });
});

describe("macOS canary result boundary", () => {
    it("runs every pre-candidate control and validates the inherited helper result", async () => {
        const calls = [];
        const result = await runIsolationProbe({
            sourceRoot: "/source",
            sourceSentinel: "/source/package.json",
            workRoot: "/work"
        }, {
            loopbackRoundTrip: async () => {
                calls.push("loopback");
                return VALID_RESULT.loopback;
            },
            temporaryFileRoundTrip: work => {
                calls.push(["temporary", work]);
                return VALID_RESULT.temporaryFile;
            },
            fileDenial: file => {
                calls.push(["denial", file]);
                return VALID_DENIAL;
            },
            forbiddenProbes: async () => {
                calls.push("forbidden");
                return VALID_RESULT.forbidden;
            },
            helperProbe: () => {
                calls.push("helper");
                return VALID_RESULT.helper;
            }
        });
        assert.deepEqual(result, VALID_RESULT);
        assert.deepEqual(calls, ["loopback", ["temporary", "/work"], ["denial", "/source"],
            ["denial", "/source/package.json"], "forbidden", "helper"]);
    });

    it("accepts only complete policy denials plus loopback and temporary-file round trips", () => {
        assert.deepEqual(validateProbeResult(structuredClone(VALID_RESULT)), VALID_RESULT);
        for (const update of [
            result => { result.loopback.roundTrip = false; },
            result => { result.temporaryFile.roundTrip = false; },
            result => { result.sourceRoot.code = "ENOENT"; },
            result => { result.sourceSentinel.denied = false; },
            result => { result.forbidden.tcp4.timedOut = true; },
            result => { result.forbidden.tcp6.code = "ECONNREFUSED"; },
            result => { delete result.forbidden.udp4; },
            result => { result.forbidden.udp6.code = "ENETUNREACH"; },
            result => { result.helper.inherited = false; },
            result => { result.helper.forbidden.tcp4.code = "ETIMEDOUT"; }
        ]) {
            const result = structuredClone(VALID_RESULT);
            update(result);
            assert.throws(() => validateProbeResult(result), /probe|denial|round.trip|helper/i);
        }
    });

    it("creates a fresh temp root, invokes only the absolute sandbox executable and retains bound evidence", context => {
        const {sourceRoot, runnerTemp, evidenceDir} = setup(context);
        const calls = [];
        const sandboxBytes = Buffer.from("synthetic sandbox executable");
        const result = runMacosIsolationCanary({
            expectedArch: EXPECTED_ARCH,
            sourceRoot,
            evidenceDir,
            sourceSentinel: SOURCE_SENTINEL
        }, {
            platform: "darwin",
            architecture: EXPECTED_ARCH,
            environment: {
                CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted",
                RUNNER_ARCH, RUNNER_TEMP: runnerTemp, ImageOS: "macos15", ImageVersion: "synthetic"
            },
            readFile: file => file === SANDBOX_EXECUTABLE ? sandboxBytes : fs.readFileSync(file),
            spawnSandbox: (command, args, options) => {
                calls.push({command, args, options});
                return {status: 0, signal: null, stdout: `${JSON.stringify(VALID_RESULT)}\n`, stderr: ""};
            }
        });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].command, SANDBOX_EXECUTABLE);
        assert.match(calls[0].args[1], /^SOURCE_ROOT=/);
        assert.ok(calls[0].options.timeout > 0);
        assert.equal(result.status, "passed");
        assert.equal(result.architecture, EXPECTED_ARCH);
        assert.equal(result.sandboxExecutable.path, SANDBOX_EXECUTABLE);
        assert.equal(result.sandboxExecutable.sha256,
            crypto.createHash("sha256").update(sandboxBytes).digest("hex"));
        assert.equal(result.profile.sha256,
            crypto.createHash("sha256").update(fs.readFileSync(path.join(evidenceDir, "macos-isolation.sb"))).digest("hex"));
        assert.deepEqual(result.sourceSentinel, {
            path: path.join(sourceRoot, SOURCE_SENTINEL),
            byteLength: Buffer.byteLength(SOURCE_SENTINEL_CONTENTS),
            sha256: crypto.createHash("sha256").update(SOURCE_SENTINEL_CONTENTS).digest("hex"),
            preSandboxReadable: true
        });
        assert.equal(result.sourceRootPreSandboxReadable, true);
        assert.deepEqual(result.probe, VALID_RESULT);
        assert.ok(fs.existsSync(path.join(evidenceDir, "macos-isolation.json")));
        assert.deepEqual(fs.readdirSync(runnerTemp), ["evidence"], "owned temporary canary root leaked");
        assert.deepEqual(result.cleanup, {temporaryFilesRemoved: true, processTreeExitProven: true});
    });

    it("requires a fresh direct child of canonical RUNNER_TEMP for evidence", context => {
        const {root, sourceRoot, runnerTemp} = setup(context);
        const dependencies = {
            platform: "darwin",
            architecture: EXPECTED_ARCH,
            environment: {
                CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted",
                RUNNER_ARCH, RUNNER_TEMP: runnerTemp
            }
        };
        const options = {expectedArch: EXPECTED_ARCH, sourceRoot, sourceSentinel: SOURCE_SENTINEL};
        assert.throws(() => runMacosIsolationCanary({...options, evidenceDir: path.join(root, "outside")}, dependencies),
            /evidence.*RUNNER_TEMP|direct child/i);
        const nestedParent = path.join(runnerTemp, "nested");
        fs.mkdirSync(nestedParent);
        assert.throws(() => runMacosIsolationCanary({...options,
            evidenceDir: path.join(nestedParent, "evidence")}, dependencies), /direct child/i);
    });

    it("proves and fingerprints a bounded readable source sentinel before sandbox execution", context => {
        const {sourceRoot, runnerTemp, evidenceDir} = setup(context);
        let spawned = false;
        assert.throws(() => runMacosIsolationCanary({
            expectedArch: EXPECTED_ARCH, sourceRoot, evidenceDir, sourceSentinel: SOURCE_SENTINEL
        }, {
            platform: "darwin",
            architecture: EXPECTED_ARCH,
            environment: {
                CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted",
                RUNNER_ARCH, RUNNER_TEMP: runnerTemp
            },
            readSourceSentinel: () => {
                const error = new Error("synthetic pre-existing denial");
                error.code = "EACCES";
                throw error;
            },
            spawnSandbox: () => {
                spawned = true;
                throw new Error("must not spawn");
            }
        }), /pre-existing denial/i);
        assert.equal(spawned, false);
        const evidence = JSON.parse(fs.readFileSync(path.join(evidenceDir, "macos-isolation.json"), "utf8"));
        assert.equal(evidence.status, "failed");
        assert.equal(evidence.sourceSentinel.preSandboxReadable, false);
        assert.equal(evidence.sourceSentinel.sha256, null);
    });

    it("refuses an oversized source sentinel without reading or spawning it", context => {
        const {sourceRoot, runnerTemp, evidenceDir} = setup(context);
        const oversizedBytes = MAX_SOURCE_SENTINEL_BYTES + 1;
        fs.truncateSync(path.join(sourceRoot, SOURCE_SENTINEL), oversizedBytes);
        let read = false;
        let spawned = false;
        assert.throws(() => runMacosIsolationCanary({
            expectedArch: EXPECTED_ARCH, sourceRoot, evidenceDir, sourceSentinel: SOURCE_SENTINEL
        }, {
            platform: "darwin",
            architecture: EXPECTED_ARCH,
            environment: {
                CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted",
                RUNNER_ARCH, RUNNER_TEMP: runnerTemp
            },
            readSourceSentinel: () => {
                read = true;
                return Buffer.alloc(0);
            },
            spawnSandbox: () => {
                spawned = true;
                return {};
            }
        }), /read limit/i);
        assert.equal(read, false);
        assert.equal(spawned, false);
    });

    it("fails closed, records diagnostics and cleans owned temporary state", context => {
        const {sourceRoot, runnerTemp, evidenceDir} = setup(context);
        const failure = new Error("sandbox invocation should not be thrown by the mock");
        assert.throws(() => runMacosIsolationCanary({
            expectedArch: EXPECTED_ARCH,
            sourceRoot,
            evidenceDir,
            sourceSentinel: SOURCE_SENTINEL
        }, {
            platform: "darwin",
            architecture: EXPECTED_ARCH,
            environment: {
                CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted",
                RUNNER_ARCH, RUNNER_TEMP: runnerTemp
            },
            readFile: file => file === SANDBOX_EXECUTABLE ? Buffer.from("sandbox") : fs.readFileSync(file),
            spawnSandbox: () => ({status: 65, signal: null, stdout: "", stderr: "profile rejected"})
        }), error => {
            assert.notEqual(error, failure);
            assert.match(error.message, /sandbox.*65/i);
            return true;
        });
        const evidence = JSON.parse(fs.readFileSync(path.join(evidenceDir, "macos-isolation.json"), "utf8"));
        assert.equal(evidence.status, "failed");
        assert.match(evidence.sandbox.stderr, /profile rejected/);
        assert.deepEqual(fs.readdirSync(runnerTemp), ["evidence"]);
        assert.deepEqual(evidence.cleanup, {temporaryFilesRemoved: true, processTreeExitProven: false});
    });

    it("records timeout uncertainty separately from temporary-file cleanup", context => {
        const {sourceRoot, runnerTemp, evidenceDir} = setup(context);
        const timeout = Object.assign(new Error("spawnSync timed out"), {code: "ETIMEDOUT"});
        assert.throws(() => runMacosIsolationCanary({
            expectedArch: EXPECTED_ARCH, sourceRoot, evidenceDir, sourceSentinel: SOURCE_SENTINEL
        }, {
            platform: "darwin",
            architecture: EXPECTED_ARCH,
            environment: {
                CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted",
                RUNNER_ARCH, RUNNER_TEMP: runnerTemp
            },
            readFile: file => file === SANDBOX_EXECUTABLE ? Buffer.from("sandbox") : fs.readFileSync(file),
            spawnSandbox: () => ({status: null, signal: "SIGTERM", stdout: "", stderr: "", error: timeout})
        }), /timed out/i);
        const evidence = JSON.parse(fs.readFileSync(path.join(evidenceDir, "macos-isolation.json"), "utf8"));
        assert.equal(evidence.status, "failed");
        assert.equal(evidence.sandbox.error.code, "ETIMEDOUT");
        assert.deepEqual(evidence.cleanup, {temporaryFilesRemoved: true, processTreeExitProven: false});
    });

    it("records a missing sandbox executable and still cleans the owned temporary root", context => {
        const {sourceRoot, runnerTemp, evidenceDir} = setup(context);
        assert.throws(() => runMacosIsolationCanary({
            expectedArch: EXPECTED_ARCH,
            sourceRoot,
            evidenceDir,
            sourceSentinel: SOURCE_SENTINEL
        }, {
            platform: "darwin",
            architecture: EXPECTED_ARCH,
            environment: {
                CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted",
                RUNNER_ARCH, RUNNER_TEMP: runnerTemp
            },
            readFile: file => {
                if (file === SANDBOX_EXECUTABLE) {
                    const error = new Error("missing sandbox executable");
                    error.code = "ENOENT";
                    throw error;
                }
                return fs.readFileSync(file);
            }
        }), /missing sandbox executable/i);
        const evidence = JSON.parse(fs.readFileSync(path.join(evidenceDir, "macos-isolation.json"), "utf8"));
        assert.equal(evidence.status, "failed");
        assert.equal(evidence.sandboxExecutable.sha256, null);
        assert.deepEqual(fs.readdirSync(runnerTemp), ["evidence"]);
        assert.deepEqual(evidence.cleanup, {temporaryFilesRemoved: true, processTreeExitProven: false});
    });
});
