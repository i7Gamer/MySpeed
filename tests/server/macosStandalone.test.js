import {describe, it} from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    buildMacosSeedProfile,
    buildMacosRuntimeProfile,
    createMacosRuntimeIsolationRecord,
    parseArguments,
    runMacosStandaloneVerification
} from "../../scripts/qualification/verify-macos-standalone.mjs";
import {buildSandboxProfile} from "../../scripts/qualification/macos-isolation.mjs";

const SOURCE_SHA = "a".repeat(40);
const ARTIFACT_SHA = "b".repeat(64);
const RUN_ID = 347_466_822_96;
const RUN_ATTEMPT = 2;
const REPOSITORY = "i7Gamer/MySpeed";
const ARCHITECTURE = "x64";
const ARTIFACT_NAME = "MySpeed-macos-x64";
const WRITABLE_DIRECTORY_MODE = 0o700;
const RETAINED_RUNTIME_DIRECTORY = "runtime";
const VERIFIER_FILES = [
    "check-artifact.mjs",
    "fixture.mjs",
    "macos-isolation.mjs",
    "safety.mjs",
    "sqlite-check.mjs"
];

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const denialProbe = () => {
    const denial = {denied: true, code: "EPERM", timedOut: false};
    return {inherited: true, forbidden: {tcp4: denial, tcp6: denial, udp4: denial, udp6: denial}};
};
const fullProbe = () => {
    const denial = {denied: true, code: "EPERM", timedOut: false};
    return {
        schemaVersion: 1,
        loopback: {roundTrip: true, host: "127.0.0.1"},
        temporaryFile: {roundTrip: true},
        sourceRoot: denial,
        sourceSentinel: denial,
        forbidden: denialProbe().forbidden,
        helper: denialProbe()
    };
};

const setup = context => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-macos-standalone-test-"));
    context.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const sourceRoot = path.join(root, "source");
    const runnerTemp = path.join(root, "runner-temp");
    const qualificationDirectory = path.join(sourceRoot, "scripts", "qualification");
    const evidenceDir = path.join(runnerTemp, "evidence");
    fs.mkdirSync(qualificationDirectory, {recursive: true});
    fs.mkdirSync(runnerTemp);
    fs.writeFileSync(path.join(sourceRoot, "package.json"), "{}\n");
    fs.writeFileSync(path.join(sourceRoot, "bun.lock"), "synthetic lock\n");
    for (const file of VERIFIER_FILES)
        fs.writeFileSync(path.join(qualificationDirectory, file), `synthetic ${file}\n`);
    const artifact = path.join(root, ARTIFACT_NAME);
    fs.writeFileSync(artifact, "synthetic candidate\n", {mode: 0o700});
    return {root, sourceRoot, runnerTemp, qualificationDirectory, evidenceDir, artifact};
};

const options = paths => ({
    artifact: paths.artifact,
    artifactSha256: sha256(fs.readFileSync(paths.artifact)),
    repo: paths.sourceRoot,
    evidenceDir: paths.evidenceDir,
    sourceSha: SOURCE_SHA,
    expectedArch: ARCHITECTURE,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    repository: REPOSITORY
});

const makeRetainedRuntimeRemovable = ({retained, runnerTemp, randomId}) => {
    const expected = path.join(fs.realpathSync(runnerTemp), `myspeed-macos-standalone-${randomId}`);
    assert.equal(path.resolve(retained), expected);
    assert.equal(fs.realpathSync(retained), expected);
    const retainedStats = fs.lstatSync(retained);
    assert.equal(retainedStats.isDirectory(), true);
    assert.equal(retainedStats.isSymbolicLink(), false);

    const runtime = path.join(retained, RETAINED_RUNTIME_DIRECTORY);
    assert.equal(fs.realpathSync(runtime), runtime);
    const runtimeStats = fs.lstatSync(runtime);
    assert.equal(runtimeStats.isDirectory(), true);
    assert.equal(runtimeStats.isSymbolicLink(), false);
    fs.chmodSync(runtime, WRITABLE_DIRECTORY_MODE);
};

describe("macOS standalone wrapper inputs", () => {
    it("parses only the exact required interface", () => {
        const parsed = parseArguments([
            "--artifact", "/candidate/MySpeed-macos-arm64",
            "--artifact-sha256", ARTIFACT_SHA,
            "--repo", "/source",
            "--evidence-dir", "/evidence",
            "--source-sha", SOURCE_SHA,
            "--expected-arch", "arm64",
            "--run-id", String(RUN_ID),
            "--run-attempt", String(RUN_ATTEMPT),
            "--repository", REPOSITORY
        ]);
        assert.deepEqual(parsed, {
            artifact: "/candidate/MySpeed-macos-arm64",
            artifactSha256: ARTIFACT_SHA,
            repo: "/source",
            evidenceDir: "/evidence",
            sourceSha: SOURCE_SHA,
            expectedArch: "arm64",
            runId: RUN_ID,
            runAttempt: RUN_ATTEMPT,
            repository: REPOSITORY
        });
        for (const values of [
            [],
            ["--artifact", "/candidate"],
            ["--unknown", "value"],
            ["--artifact", "a", "--artifact", "b"]
        ]) assert.throws(() => parseArguments(values), /missing|unknown|duplicate/i);
    });

    it("uses a source-readable seed profile that still denies every network operation", () => {
        const profile = buildMacosSeedProfile();
        assert.match(profile, /^\(version 1\)/);
        assert.match(profile, /\(deny network\*\)/);
        assert.doesNotMatch(profile, /SOURCE_ROOT|file-read|network-(?:bind|inbound|outbound)/);
    });

    it("hardens the trusted runtime closure against same-user writes", () => {
        const profile = buildMacosRuntimeProfile();
        assert.ok(profile.startsWith(buildSandboxProfile()));
        assert.match(profile, /\(param "VERIFIER_ROOT"\)/);
        assert.match(profile, /\(deny file-write\*/);
    });
});

describe("macOS standalone isolation record", () => {
    it("binds the candidate, context, summary, profile, canary, and exact five-file closure", () => {
        const verifierFiles = Object.fromEntries(VERIFIER_FILES.map((file, index) => [file,
            String(index).repeat(64)]));
        const record = createMacosRuntimeIsolationRecord({
            sourceSha: SOURCE_SHA,
            artifactSha256: ARTIFACT_SHA,
            architecture: "arm64",
            runId: RUN_ID,
            runAttempt: RUN_ATTEMPT,
            repository: REPOSITORY,
            summarySha256: "c".repeat(64),
            profileSha256: "d".repeat(64),
            canarySha256: "e".repeat(64),
            canaryProfileSha256: "f".repeat(64),
            handoffSha256: "1".repeat(64),
            seed: {profileSha256: "a".repeat(64), sandboxStatus: 0, sandboxSignal: null,
                probe: denialProbe()},
            canaryHelper: denialProbe(),
            candidateFile: {name: "MySpeed-macos-arm64", sha256: ARTIFACT_SHA},
            verifierFiles
        });
        assert.deepEqual(record, {
            schemaVersion: 1,
            status: "passed",
            sourceSha: SOURCE_SHA,
            artifactSha256: ARTIFACT_SHA,
            architecture: "arm64",
            platform: "darwin",
            runId: RUN_ID,
            runAttempt: RUN_ATTEMPT,
            repository: REPOSITORY,
            summarySha256: "c".repeat(64),
            profileSha256: "d".repeat(64),
            canarySha256: "e".repeat(64),
            canaryProfileSha256: "f".repeat(64),
            handoffSha256: "1".repeat(64),
            seed: {profileSha256: "a".repeat(64), sandboxStatus: 0, sandboxSignal: null,
                probe: denialProbe()},
            canaryHelper: denialProbe(),
            candidateFile: {name: "MySpeed-macos-arm64", sha256: ARTIFACT_SHA},
            verifierFiles
        });
        assert.throws(() => createMacosRuntimeIsolationRecord({...record, artifactSha256: "bad"}), /SHA-256/i);
        assert.throws(() => createMacosRuntimeIsolationRecord({...record,
            verifierFiles: {...verifierFiles, "extra.mjs": "f".repeat(64)}}), /verifier/i);
    });
});

describe("macOS standalone orchestration", () => {
    it("fails before any candidate staging when the canary main probe is incomplete", context => {
        const variants = [
            ["a", probe => { probe.loopback.roundTrip = false; }, /loopback/i],
            ["b", probe => { probe.sourceRoot.denied = false; }, /source-root/i],
            ["c", probe => { probe.forbidden.tcp4.denied = false; }, /main-process/i]
        ];
        for (const [label, mutate, expected] of variants) {
            const paths = setup(context);
            const profile = Buffer.from(buildSandboxProfile());
            const probe = fullProbe();
            mutate(probe);
            const canary = {
                schemaVersion: 1,
                status: "passed",
                architecture: ARCHITECTURE,
                platform: "darwin",
                sourceRoot: paths.sourceRoot,
                sourceRootPreSandboxReadable: true,
                sourceSentinel: {path: path.join(paths.sourceRoot, "package.json"), preSandboxReadable: true},
                profile: {sha256: sha256(profile)},
                probe,
                sandbox: {status: 0, signal: null},
                cleanup: {temporaryFilesRemoved: true, processTreeExitProven: true}
            };
            let sandboxInvoked = false;
            assert.throws(() => runMacosStandaloneVerification(options(paths), {
                environment: {
                    CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted",
                    RUNNER_ARCH: "X64", RUNNER_TEMP: paths.runnerTemp
                },
                platform: "darwin",
                architecture: ARCHITECTURE,
                qualificationDirectory: paths.qualificationDirectory,
                runCanary: canaryOptions => {
                    fs.mkdirSync(canaryOptions.evidenceDir);
                    fs.writeFileSync(path.join(canaryOptions.evidenceDir, "macos-isolation.sb"), profile);
                    fs.writeFileSync(path.join(canaryOptions.evidenceDir, "macos-isolation.json"),
                        JSON.stringify(canary) + "\n");
                    return canary;
                },
                runSandbox: () => { sandboxInvoked = true; },
                randomId: () => label.repeat(48)
            }), expected);
            assert.equal(sandboxInvoked, false);
        }
    });

    it("rejects a qualification summary whose reset fixture escapes the owned reset directory", context => {
        const paths = setup(context);
        const randomId = "9".repeat(48);
        const taskRoot = path.join(paths.runnerTemp, `myspeed-macos-standalone-${randomId}`);
        const populated = path.join(taskRoot, "populated");
        const reset = path.join(taskRoot, "reset");
        const canaryProfile = Buffer.from(buildSandboxProfile());
        const canary = {
            schemaVersion: 1,
            status: "passed",
            architecture: ARCHITECTURE,
            platform: "darwin",
            sourceRoot: paths.sourceRoot,
            sourceRootPreSandboxReadable: true,
            sourceSentinel: {path: path.join(paths.sourceRoot, "package.json"), preSandboxReadable: true},
            profile: {sha256: sha256(canaryProfile)},
            probe: fullProbe(),
            sandbox: {status: 0, signal: null},
            cleanup: {temporaryFilesRemoved: true, processTreeExitProven: true}
        };
        let sandboxCalls = 0;
        assert.throws(() => runMacosStandaloneVerification(options(paths), {
            environment: {
                CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted",
                RUNNER_ARCH: "X64", RUNNER_TEMP: paths.runnerTemp
            },
            platform: "darwin",
            architecture: ARCHITECTURE,
            qualificationDirectory: paths.qualificationDirectory,
            runCanary: canaryOptions => {
                fs.mkdirSync(canaryOptions.evidenceDir);
                fs.writeFileSync(path.join(canaryOptions.evidenceDir, "macos-isolation.sb"), canaryProfile);
                fs.writeFileSync(path.join(canaryOptions.evidenceDir, "macos-isolation.json"),
                    JSON.stringify(canary) + "\n");
                return canary;
            },
            runSandbox: (_command, args) => {
                sandboxCalls += 1;
                if (args.at(-1) === "helper") return {status: 0, signal: null,
                    stdout: JSON.stringify(denialProbe()) + "\n", stderr: ""};
                if (args.includes("handoff")) {
                    fs.mkdirSync(populated, {recursive: true});
                    fs.mkdirSync(reset, {recursive: true});
                    fs.writeFileSync(args[args.indexOf("--manifest") + 1], "{}\n");
                }
                return {status: 0, signal: null, stdout: "", stderr: ""};
            },
            collectSummary: ({evidenceDir, output}) => {
                const summary = {
                    status: "passed", exit: 0, sourceSha: SOURCE_SHA, mode: "full",
                    platform: "darwin", architecture: ARCHITECTURE,
                    artifactSha256: options(paths).artifactSha256,
                    fixtures: {populated: {root: populated}, reset: {root: populated}},
                    networkIsolation: {
                        kind: "macos-seatbelt", sourceRoot: paths.sourceRoot,
                        sourceSentinel: path.join(paths.sourceRoot, "package.json"),
                        workRoot: populated, probe: fullProbe()
                    }
                };
                const bytes = Buffer.from(JSON.stringify(summary) + "\n");
                const rawEvidence = path.join(evidenceDir, "myspeed-evidence-synthetic");
                fs.mkdirSync(rawEvidence);
                fs.writeFileSync(path.join(rawEvidence, "summary.json"), bytes);
                fs.writeFileSync(output, bytes, {flag: "wx"});
                fs.writeFileSync(`${output}.sha256`, `${sha256(bytes)}\n`, {flag: "wx"});
                return {summary, sha256: sha256(bytes)};
            },
            randomId: () => randomId
        }), /fixture context/i);
        assert.equal(sandboxCalls, 3);
    });

    it("seeds under network denial, then runs a source-denied readonly closure and emits bound flat evidence", context => {
        const paths = setup(context);
        const calls = [];
        const canaryProfile = Buffer.from(buildSandboxProfile());
        const runtimeProfile = Buffer.from(buildMacosRuntimeProfile());
        const canary = {
            schemaVersion: 1,
            status: "passed",
            architecture: ARCHITECTURE,
            platform: "darwin",
            sourceRoot: paths.sourceRoot,
            sourceRootPreSandboxReadable: true,
            sourceSentinel: {path: path.join(paths.sourceRoot, "package.json"), preSandboxReadable: true},
            profile: {sha256: sha256(canaryProfile)},
            probe: fullProbe(),
            sandbox: {status: 0, signal: null},
            cleanup: {temporaryFilesRemoved: true, processTreeExitProven: true}
        };
        const runCanary = canaryOptions => {
            fs.mkdirSync(canaryOptions.evidenceDir);
            fs.writeFileSync(path.join(canaryOptions.evidenceDir, "macos-isolation.sb"), canaryProfile);
            fs.writeFileSync(path.join(canaryOptions.evidenceDir, "macos-isolation.json"),
                JSON.stringify(canary) + "\n");
            return canary;
        };
        const runSandbox = (_command, args, spawnOptions) => {
            calls.push({args, options: spawnOptions,
                profile: fs.readFileSync(args[args.indexOf("-f") + 1], "utf8")});
            if (args.at(-1) === "helper") {
                return {status: 0, signal: null,
                    stdout: JSON.stringify(denialProbe()) + "\n",
                    stderr: ""};
            }
            if (args.includes("handoff")) {
                const manifest = args[args.indexOf("--manifest") + 1];
                fs.mkdirSync(args[args.indexOf("--work") + 1], {recursive: true});
                fs.mkdirSync(args[args.indexOf("--reset-work") + 1], {recursive: true});
                fs.writeFileSync(manifest, JSON.stringify({schemaVersion: 1}) + "\n");
            }
            return {status: 0, signal: null, stdout: "", stderr: ""};
        };
        const collect = ({evidenceDir, output, sourceSha, mode}) => {
            assert.equal(sourceSha, SOURCE_SHA);
            assert.equal(mode, "full");
            const runtimeCall = calls.at(-1);
            const summary = {status: "passed", exit: 0, sourceSha: SOURCE_SHA, mode,
                platform: "darwin", architecture: ARCHITECTURE,
                artifactSha256: options(paths).artifactSha256,
                fixtures: {
                    populated: {root: runtimeCall.args[runtimeCall.args.indexOf("--work") + 1]},
                    reset: {root: runtimeCall.args[runtimeCall.args.indexOf("--reset-work") + 1]}
                },
                networkIsolation: {
                    kind: "macos-seatbelt",
                    sourceRoot: paths.sourceRoot,
                    sourceSentinel: path.join(paths.sourceRoot, "package.json"),
                    workRoot: runtimeCall.args[runtimeCall.args.indexOf("--work") + 1],
                    probe: fullProbe()
                }};
            const bytes = Buffer.from(JSON.stringify(summary) + "\n");
            const rawEvidence = path.join(evidenceDir, "myspeed-evidence-synthetic");
            fs.mkdirSync(rawEvidence);
            fs.writeFileSync(path.join(rawEvidence, "summary.json"), bytes);
            fs.writeFileSync(output, bytes, {flag: "wx"});
            fs.writeFileSync(`${output}.sha256`, `${sha256(bytes)}\n`, {flag: "wx"});
            return {summary, sha256: sha256(bytes)};
        };

        const result = runMacosStandaloneVerification(options(paths), {
            environment: {
                CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted",
                RUNNER_ARCH: "X64", RUNNER_TEMP: paths.runnerTemp
            },
            platform: "darwin",
            architecture: ARCHITECTURE,
            qualificationDirectory: paths.qualificationDirectory,
            runCanary,
            runSandbox,
            collectSummary: collect,
            randomId: () => "c".repeat(48)
        });

        assert.equal(calls.length, 3);
        assert.match(calls[0].profile, /deny network\*/);
        assert.ok(calls[1].args.includes("handoff"));
        const runtime = calls[2];
        assert.deepEqual(runtime.args.slice(0, 6), ["-D", `SOURCE_ROOT=${paths.sourceRoot}`,
            "-D", `VERIFIER_ROOT=${path.dirname(runtime.args[runtime.args.indexOf("--command") + 1])}`,
            "-f", path.join(paths.evidenceDir, "macos-runtime-profile.sb")]);
        assert.equal(runtime.args[runtime.args.indexOf("-f") + 1],
            path.join(paths.evidenceDir, "macos-runtime-profile.sb"));
        assert.ok(runtime.args.includes("--preseeded-fixture-manifest"));
        assert.ok(runtime.args.includes("--original-build-root"));
        assert.ok(runtime.args.includes("--macos-source-sentinel"));
        assert.equal(runtime.args.includes("--repo"), false);
        assert.equal(runtime.args.includes("--source-sha"), false);
        const command = runtime.args[runtime.args.indexOf("--command") + 1];
        assert.equal(path.basename(command), ARTIFACT_NAME);
        assert.equal(path.dirname(command), path.dirname(runtime.args[runtime.args.indexOf("--artifact") + 1]));

        const expectedFiles = [
            "macos-canary.json", "macos-canary.json.sha256",
            "macos-canary-profile.sb", "macos-canary-profile.sb.sha256",
            "macos-runtime-isolation.json", "macos-runtime-isolation.json.sha256",
            "macos-runtime-profile.sb", "macos-runtime-profile.sb.sha256",
            ARTIFACT_NAME, `${ARTIFACT_NAME}.sha256`,
            "qualification-evidence",
            "qualification-summary.json", "qualification-summary.json.sha256"
        ];
        assert.deepEqual(fs.readdirSync(paths.evidenceDir).sort(), expectedFiles.sort());
        const record = JSON.parse(fs.readFileSync(path.join(paths.evidenceDir,
            "macos-runtime-isolation.json"), "utf8"));
        assert.equal(record.artifactSha256, options(paths).artifactSha256);
        assert.equal(record.sourceSha, SOURCE_SHA);
        assert.equal(record.profileSha256, sha256(runtimeProfile));
        assert.equal(record.canaryProfileSha256, sha256(canaryProfile));
        assert.equal(record.seed.sandboxStatus, 0);
        assert.equal(record.seed.probe.forbidden.udp6.denied, true);
        assert.equal(record.canaryHelper.inherited, true);
        assert.deepEqual(record.candidateFile, {name: ARTIFACT_NAME, sha256: options(paths).artifactSha256});
        assert.deepEqual(Object.keys(record.verifierFiles).sort(), VERIFIER_FILES);
        assert.equal(result.isolationRecord.status, "passed");
        assert.deepEqual(fs.readdirSync(paths.runnerTemp), ["evidence"], "owned runtime root leaked");
    });

    it("rejects linked/wrong-name/hash-mismatched candidates before invoking Seatbelt", context => {
        const paths = setup(context);
        let invoked = false;
        const dependencies = {
            environment: {RUNNER_TEMP: paths.runnerTemp},
            platform: "darwin",
            architecture: ARCHITECTURE,
            qualificationDirectory: paths.qualificationDirectory,
            runCanary: () => { invoked = true; },
            runSandbox: () => { invoked = true; }
        };
        assert.throws(() => runMacosStandaloneVerification({...options(paths), artifactSha256: ARTIFACT_SHA},
            dependencies), /hash/i);
        const wrongName = path.join(paths.root, "wrong-name");
        fs.copyFileSync(paths.artifact, wrongName);
        assert.throws(() => runMacosStandaloneVerification({...options(paths), artifact: wrongName}, dependencies),
            /filename/i);
        const linkedDirectory = path.join(paths.root, "linked");
        fs.mkdirSync(linkedDirectory);
        const hardLink = path.join(linkedDirectory, ARTIFACT_NAME);
        fs.linkSync(paths.artifact, hardLink);
        assert.throws(() => runMacosStandaloneVerification({...options(paths), artifact: hardLink}, dependencies),
            /unlinked regular file/i);
        assert.equal(invoked, false);
    });

    it("retains the owned task root after timeout or any nonzero sandbox exit", context => {
        const variants = [
            ["d", {
                status: null,
                signal: "SIGTERM",
                error: Object.assign(new Error("timed out"), {code: "ETIMEDOUT"}),
                stdout: "",
                stderr: ""
            }, /timed out/i],
            ["e", {status: 1, signal: null, stdout: "", stderr: "failed"}, /sandbox-exec failed/i],
            ["f", new Error("spawn threw"), /spawn threw/i]
        ];
        for (const [identity, sandboxResult, expected] of variants) {
            const paths = setup(context);
            const profile = Buffer.from(buildSandboxProfile());
            const canary = {
                schemaVersion: 1,
                status: "passed",
                architecture: ARCHITECTURE,
                platform: "darwin",
                sourceRoot: paths.sourceRoot,
                sourceRootPreSandboxReadable: true,
                sourceSentinel: {path: path.join(paths.sourceRoot, "package.json"), preSandboxReadable: true},
                profile: {sha256: sha256(profile)},
                probe: fullProbe(),
                sandbox: {status: 0, signal: null},
                cleanup: {temporaryFilesRemoved: true, processTreeExitProven: true}
            };
            const randomId = identity.repeat(48);
            const retained = path.join(paths.runnerTemp, `myspeed-macos-standalone-${randomId}`);
            try {
                assert.throws(() => runMacosStandaloneVerification(options(paths), {
                    environment: {
                        CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted",
                        RUNNER_ARCH: "X64", RUNNER_TEMP: paths.runnerTemp
                    },
                    platform: "darwin",
                    architecture: ARCHITECTURE,
                    qualificationDirectory: paths.qualificationDirectory,
                    runCanary: canaryOptions => {
                        fs.mkdirSync(canaryOptions.evidenceDir);
                        fs.writeFileSync(path.join(canaryOptions.evidenceDir, "macos-isolation.sb"), profile);
                        fs.writeFileSync(path.join(canaryOptions.evidenceDir, "macos-isolation.json"),
                            JSON.stringify(canary) + "\n");
                        return canary;
                    },
                    runSandbox: () => {
                        if (sandboxResult instanceof Error) throw sandboxResult;
                        return sandboxResult;
                    },
                    randomId: () => randomId
                }), expected);
                assert.equal(fs.existsSync(retained), true);
                const failure = JSON.parse(fs.readFileSync(path.join(paths.evidenceDir,
                    "macos-wrapper-failure.json"), "utf8"));
                assert.deepEqual(failure.cleanup, {processTreeExitProven: false, taskRootRetained: true});
            } finally {
                if (fs.existsSync(retained)) makeRetainedRuntimeRemovable({retained,
                    runnerTemp: paths.runnerTemp, randomId});
            }
        }
    });
});
