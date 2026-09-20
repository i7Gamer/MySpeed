import assert from "node:assert/strict";
import path from "node:path";
import {describe, it} from "node:test";

import {runPrereleaseCpuFloorHostedInputs} from
    "../../scripts/release/prerelease-cpu-floor-hosted-inputs.mjs";
import {bindPrereleaseCpuFloorTarget} from "../../scripts/release/prerelease-cpu-floor-target.mjs";
import {WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS} from
    "../../scripts/qualification/windows-baseline-guest-runtime-bundle.mjs";

const SHA = character => character.repeat(64);
const HARNESS_SHA = "d".repeat(40);
const OTHER_SHA = "4".repeat(40);
const NONCE = "2".repeat(32);
const REPOSITORY = "i7Gamer/MySpeed";
const RUN_ID = 123;
const RUN_ATTEMPT = 1;
const ARCHIVE_BYTES = 46649471;
const ARCHIVE_SHA = SHA("c");
const EXE_SHA = SHA("d");
const OBSERVED_AT = "2026-09-20T09:30:00Z";
const TEMP = "/home/runner/work/_temp";
const STAGE3_ROOT = `${TEMP}/myspeed-stage3-${NONCE}`;
const BUNDLE_ROOT = `${TEMP}/myspeed-branch-bundle-${NONCE}`;
const RUNTIME_INSTALLER =
    "runtime/scripts/qualification/windows-baseline-guest-runtime-installer.ps1";

const context = () => ({schemaVersion: 1, repository: REPOSITORY, sourceSha: HARNESS_SHA,
    eventSha: HARNESS_SHA, runId: String(RUN_ID), runAttempt: String(RUN_ATTEMPT), nonce: NONCE,
    environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
        RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260901.1"}});

const target = () => bindPrereleaseCpuFloorTarget({
    harnessSourceSha: HARNESS_SHA, observedAt: OBSERVED_AT,
    candidate: {repository: REPOSITORY, sourceSha: HARNESS_SHA, version: "1.6.2",
        windowsStamp: "1.6.2.1"},
    buildArtifact: {repository: REPOSITORY, id: 10500000001,
        name: "MySpeed-windows-x64-baseline.exe", size: ARCHIVE_BYTES, digest: `sha256:${ARCHIVE_SHA}`,
        expired: false, createdAt: "2026-09-20T09:00:00Z", updatedAt: "2026-09-20T09:00:00Z",
        expiresAt: "2026-12-19T09:00:00Z", runId: RUN_ID, runAttempt: RUN_ATTEMPT,
        headSha: HARNESS_SHA}});

const bundleFile = (relativePath, sourceSha = HARNESS_SHA) =>
    ({relativePath, sourceSha, bytes: 10, sha256: SHA("1")});

const bundle = (overrides = []) => ({root: BUNDLE_ROOT, files: [
    bundleFile("node.exe"), bundleFile("fixture/transport.json"), bundleFile(RUNTIME_INSTALLER),
    ...WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS
        .map(name => bundleFile(`runtime/${name}`)),
    ...overrides]});

const roots = () => ({stage3: STAGE3_ROOT, candidate: `${STAGE3_ROOT}/candidate`,
    closure: `${TEMP}/myspeed-stage3-closure-${NONCE}`,
    stage2Closure: `${TEMP}/myspeed-stage2-closure-${NONCE}`,
    transport: `${TEMP}/myspeed-stage2-transport-${NONCE}`,
    envelope: `${TEMP}/myspeed-stage3-sequence-envelope-${NONCE}`});

const input = (overrides = {}) => ({
    target: target(), hostedContext: context(), bundle: bundle(),
    candidateArchive: {bytes: String(ARCHIVE_BYTES), sha256: ARCHIVE_SHA},
    candidateExe: {path: `${TEMP}/candidate/MySpeed.exe`, bytes: 524288, sha256: EXE_SHA},
    candidateDeclaredSha256: EXE_SHA,
    observedAt: OBSERVED_AT, probeArtifact: {sourceSha: HARNESS_SHA},
    probes: [{role: "avx", name: "avx.exe", path: "/probe/avx.exe", bytes: 5, sha256: SHA("2")}],
    roots: roots(), closureRecords: [{name: "sealed"}],
    stage3Plan: {installerConfirmation: "no-input", wallDeadlineUnixMilliseconds: 1789000000000},
    ...overrides});

const capture = () => {
    const seen = {staged: [], prepared: null, launched: null, stage2Closure: null, directories: []};
    return {seen, dependencies: {
        readOwned: () => Buffer.from("candidate-executable"),
        makeDirectory: value => seen.directories.push(value),
        prepareGuest: value => {
            seen.prepared = value;
            return {files: [{name: "node.exe"}]};
        },
        stageFile: (target_, bytes) => seen.staged.push({path: target_, bytes}),
        makeStage2Closure: (...value) => {
            seen.stage2Closure = value;
        },
        launch: async value => {
            seen.launched = value;
            return {accepted: true, qualifying: false};
        }
    }};
};

describe("pre-release CPU-floor hosted input adapter", () => {
    it("stages the executable alone and hands the guest a branch-build candidate", async () => {
        const {seen, dependencies} = capture();
        const result = await runPrereleaseCpuFloorHostedInputs(input(), dependencies);

        assert.equal(result.accepted, true);
        /*
         * One file, not three. The published path carries a summary and a manifest beside the
         * executable; a branch build has neither, and staging placeholders for them would put two
         * files into the guest whose provenance nothing established.
         */
        assert.deepEqual(seen.staged.map(value => path.basename(value.path)), ["MySpeed.exe"]);
        assert.equal(seen.prepared.candidate.provenance, "branch-build");
        assert.equal(seen.prepared.candidate.sourceSha, HARNESS_SHA);
        assert.equal(seen.prepared.runtimeSources.length,
            WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS.length);
        assert.equal(seen.prepared.outputRoot, `${STAGE3_ROOT}/candidate`);
        assert.equal(seen.prepared.probes[0].bytes, "5");
        assert.deepEqual(seen.stage2Closure, [roots().closure, roots().stage2Closure]);
        assert.deepEqual(seen.launched.guestFiles, [{name: "node.exe"}]);
    });

    /*
     * The guest carries this value through and only checks that it is a digest. It should still be
     * a digest that means something, and the artifact this run produced is the root of the whole
     * binding's provenance.
     */
    it("carries this run's artifact digest where a release would carry its sealed manifest", async () => {
        const {seen, dependencies} = capture();
        await runPrereleaseCpuFloorHostedInputs(input(), dependencies);
        assert.equal(seen.prepared.manifestSha256, ARCHIVE_SHA);
    });

    it("refuses a bundle with a missing file or one built from another commit", async () => {
        const missing = bundle();
        missing.files = missing.files.filter(file => file.relativePath !== "fixture/transport.json");
        await assert.rejects(runPrereleaseCpuFloorHostedInputs(
            input({bundle: missing}), capture().dependencies), /bundle file is missing or differs/u);

        const foreign = bundle();
        foreign.files = foreign.files.map(file => file.relativePath === RUNTIME_INSTALLER
            ? {...file, sourceSha: OTHER_SHA} : file);
        await assert.rejects(runPrereleaseCpuFloorHostedInputs(
            input({bundle: foreign}), capture().dependencies), /bundle file is missing or differs/u);
    });

    it("refuses roots that are not the ones this run's nonce names", async () => {
        await assert.rejects(runPrereleaseCpuFloorHostedInputs(
            input({roots: {...roots(), candidate: `${STAGE3_ROOT}/elsewhere`}}),
            capture().dependencies), /Stage 3 roots differ/u);
    });

    it("refuses an archive that is not the one the run recorded", async () => {
        await assert.rejects(runPrereleaseCpuFloorHostedInputs(
            input({candidateArchive: {bytes: String(ARCHIVE_BYTES), sha256: SHA("e")}}),
            capture().dependencies), /archive digest/u);
    });

    it("refuses an execution the Stage 3 consumer did not accept", async () => {
        const {dependencies} = capture();
        dependencies.launch = async () => ({accepted: false});
        await assert.rejects(runPrereleaseCpuFloorHostedInputs(input(), dependencies),
            /did not accept the execution/u);
    });

    it("refuses unknown or missing input keys rather than ignoring them", async () => {
        await assert.rejects(runPrereleaseCpuFloorHostedInputs({...input(), extra: true},
            capture().dependencies), /input schema differs/u);
        const {probes, ...missing} = input();
        assert.ok(probes);
        await assert.rejects(runPrereleaseCpuFloorHostedInputs(missing, capture().dependencies),
            /input schema differs/u);
    });
});
