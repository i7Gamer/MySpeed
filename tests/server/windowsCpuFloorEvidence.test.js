import {afterEach, beforeEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";

import {CPU_FLOOR_ARTIFACTS, WINDOWS_CPU_FLOOR_EVIDENCE_CONSTANTS, inspectWindowsCpuFloorEvidence}
    from "../../scripts/release/windows-cpu-floor-evidence.mjs";
import {STAGE3_CONSTANTS} from "../../scripts/qualification/linux-windows-cpu-floor-stage3.mjs";
import {CPU_FLOOR_FIXTURE, rewriteCpuFloorInspection, rewriteCpuFloorProvenance, writeCpuFloorEvidence}
    from "../helpers/windows-cpu-floor-evidence-fixture.mjs";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const REPOSITORY = "i7Gamer/MySpeed";
const RUN_ID = 123456;
const RUN_ATTEMPT = 1;
const EXECUTABLE_SHA256 = "1".repeat(64);
const OTHER_SHA256 = "9".repeat(64);
const EXECUTABLE_BYTES = 4096;
const CANDIDATE_ARTIFACT = {name: CPU_FLOOR_FIXTURE.CANDIDATE_ARTIFACT, id: 11,
    archiveDigest: `sha256:${"c".repeat(64)}`, archiveSize: 2048};
const PROBE_ARTIFACT = {name: CPU_FLOOR_FIXTURE.PROBE_ARTIFACT, id: 22,
    archiveDigest: `sha256:${"f".repeat(64)}`, archiveSize: 1024};
const EXPECTED_ARTIFACTS = ["qualified-windows-cpu-floor", "windows-cpu-floor-closure",
    "windows-cpu-floor-diagnostics", "windows-cpu-floor-evidence", "windows-cpu-floor-guest-bundle",
    "windows-cpu-readiness-closure", "windows-cpu-readiness-evidence"];
const MEBIBYTE = 1024 * 1024;
const EVIDENCE_LIMIT = 4 * MEBIBYTE;

describe("Windows CPU-floor release evidence", () => {
    let directory;

    const baseOptions = () => ({
        directory, sourceSha: SHA, runId: RUN_ID, runAttempt: RUN_ATTEMPT, repository: REPOSITORY,
        baselineAsset: {name: "MySpeed-windows-x64-baseline.exe", sha256: EXECUTABLE_SHA256, size: EXECUTABLE_BYTES},
        x64Asset: {name: "MySpeed-windows-x64.exe", sha256: EXECUTABLE_SHA256, size: EXECUTABLE_BYTES},
        actionsArtifacts: [{...CANDIDATE_ARTIFACT}, {...PROBE_ARTIFACT},
            {name: "MySpeed-windows-x64.exe", id: 33, archiveDigest: `sha256:${"3".repeat(64)}`, archiveSize: 2048}]
    });

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-cpu-floor-evidence-"));
        writeCpuFloorEvidence(directory, {repository: REPOSITORY, sourceSha: SHA, runId: RUN_ID,
            runAttempt: RUN_ATTEMPT, executableSha256: EXECUTABLE_SHA256, executableBytes: EXECUTABLE_BYTES,
            candidateArtifact: CANDIDATE_ARTIFACT, probeArtifact: PROBE_ARTIFACT});
    });

    afterEach(() => fs.rmSync(directory, {recursive: true, force: true}));

    it("names the exact extra artifact set a gated qualification run produces", () => {
        assert.deepEqual([...CPU_FLOOR_ARTIFACTS], EXPECTED_ARTIFACTS);
        assert.ok(Object.isFrozen(CPU_FLOOR_ARTIFACTS));
        assert.equal(WINDOWS_CPU_FLOOR_EVIDENCE_CONSTANTS.ARTIFACT_NAME, CPU_FLOOR_FIXTURE.ARTIFACT_NAME);
        assert.equal(WINDOWS_CPU_FLOOR_EVIDENCE_CONSTANTS.EVIDENCE_LIMIT_BYTES, EVIDENCE_LIMIT);
    });

    it("exports the guest CPU vector from the Stage 3 harness as the single source", () => {
        assert.equal(STAGE3_CONSTANTS.CPU_VECTOR, `${STAGE3_CONSTANTS.CPU_MODEL},avx=off,avx2=off`);
    });

    it("records passed evidence bound to the run, both Windows assets and both artifacts", async () => {
        const record = await inspectWindowsCpuFloorEvidence(baseOptions());
        assert.equal(record.status, "passed");
        assert.deepEqual(record.verifiedAssets, ["MySpeed-windows-x64-baseline.exe", "MySpeed-windows-x64.exe"]);
        assert.equal(record.executableSha256, EXECUTABLE_SHA256);
        assert.deepEqual(record.candidateArtifact, {name: CANDIDATE_ARTIFACT.name, id: CANDIDATE_ARTIFACT.id,
            archiveDigest: CANDIDATE_ARTIFACT.archiveDigest});
        assert.deepEqual(record.probeArtifact, {name: PROBE_ARTIFACT.name, id: PROBE_ARTIFACT.id,
            archiveDigest: PROBE_ARTIFACT.archiveDigest});
        assert.deepEqual(record.guestCpu, {model: STAGE3_CONSTANTS.CPU_MODEL, vector: STAGE3_CONSTANTS.CPU_VECTOR,
            sse42: true, popcnt: true, avx: false, avx2: false, osxsave: false});
        assert.equal(record.harnessClassification, STAGE3_CONSTANTS.CLASSIFICATION);
        assert.equal(record.installerConfirmation, CPU_FLOOR_FIXTURE.INSTALLER_CONFIRMATION);
        assert.deepEqual([record.sourceSha, record.runId, record.runAttempt, record.repository],
            [SHA, RUN_ID, RUN_ATTEMPT, REPOSITORY]);
        assert.equal(record.provenancePath, CPU_FLOOR_FIXTURE.PROVENANCE_FILE);
        assert.equal(record.inspectionPath, CPU_FLOOR_FIXTURE.INSPECTION_FILE);
        for (const file of [CPU_FLOOR_FIXTURE.PROVENANCE_FILE, CPU_FLOOR_FIXTURE.INSPECTION_FILE]) {
            const sidecar = fs.readFileSync(path.join(directory, `${file}.sha256`), "utf8").trim();
            assert.ok([record.provenanceSha256, record.inspectionSha256].includes(sidecar), file);
        }
        assert.deepEqual(Object.keys(record).sort(), ["candidateArtifact", "executableSha256", "guestCpu",
            "harnessClassification", "inspectionPath", "inspectionSha256", "installerConfirmation",
            "probeArtifact", "provenancePath", "provenanceSha256", "repository", "runAttempt", "runId",
            "sourceSha", "status", "verifiedAssets"]);
    });

    it("accepts string run identities from the CLI the same as numbers", async () => {
        await assert.doesNotReject(inspectWindowsCpuFloorEvidence({...baseOptions(),
            runId: String(RUN_ID), runAttempt: String(RUN_ATTEMPT)}));
    });

    const optionDefects = [
        ["invalid source SHA", {sourceSha: "A".repeat(40)}],
        ["non-positive run ID", {runId: 0}],
        ["non-integer run attempt", {runAttempt: 1.5}],
        // Each of these reads as the right run under Number() and must still be refused.
        ["a padded run ID string", {runId: ` ${RUN_ID}`}],
        ["a hexadecimal run ID string", {runId: `0x${RUN_ID.toString(16)}`}],
        ["an exponent run attempt string", {runAttempt: `${RUN_ATTEMPT}e0`}],
        ["invalid repository", {repository: "not a repository"}],
        ["a stale source SHA", {sourceSha: OTHER_SHA}],
        ["a different run", {runId: RUN_ID + 1}],
        ["a different repository", {repository: "fork/MySpeed"}],
        ["the Windows legs differ", {x64Asset: {name: "MySpeed-windows-x64.exe", sha256: OTHER_SHA256,
            size: EXECUTABLE_BYTES}}],
        ["the baseline asset differs from the tested file", {baselineAsset: {
            name: "MySpeed-windows-x64-baseline.exe", sha256: OTHER_SHA256, size: EXECUTABLE_BYTES}}],
        ["the baseline asset size differs", {baselineAsset: {name: "MySpeed-windows-x64-baseline.exe",
            sha256: EXECUTABLE_SHA256, size: EXECUTABLE_BYTES + 1}}],
        ["missing candidate artifact metadata", {actionsArtifacts: [{...PROBE_ARTIFACT}]}],
        ["missing probe artifact metadata", {actionsArtifacts: [{...CANDIDATE_ARTIFACT}]}],
        ["non-array artifact metadata", {actionsArtifacts: null}],
        ["candidate artifact ID mismatch", {actionsArtifacts: [{...CANDIDATE_ARTIFACT, id: 99}, {...PROBE_ARTIFACT}]}],
        ["candidate archive digest mismatch", {actionsArtifacts: [{...CANDIDATE_ARTIFACT,
            archiveDigest: `sha256:${"0".repeat(64)}`}, {...PROBE_ARTIFACT}]}],
        ["candidate archive size mismatch", {actionsArtifacts: [{...CANDIDATE_ARTIFACT, archiveSize: 1},
            {...PROBE_ARTIFACT}]}],
        ["probe artifact ID mismatch", {actionsArtifacts: [{...CANDIDATE_ARTIFACT}, {...PROBE_ARTIFACT, id: 98}]}],
        ["probe archive digest mismatch", {actionsArtifacts: [{...CANDIDATE_ARTIFACT}, {...PROBE_ARTIFACT,
            archiveDigest: `sha256:${"0".repeat(64)}`}]}]
    ];
    for (const [defect, overrides] of optionDefects)
        it(`rejects evidence when ${defect}`, async () => {
            await assert.rejects(inspectWindowsCpuFloorEvidence({...baseOptions(), ...overrides}), /CPU-floor/);
        });

    it("refuses evidence from a second run attempt even when it is self-consistent", async () => {
        rewriteCpuFloorInspection(directory, value => { value.context.runAttempt = "2"; });
        rewriteCpuFloorProvenance(directory, value => { value.runAttempt = 2; });
        await assert.rejects(inspectWindowsCpuFloorEvidence({...baseOptions(), runAttempt: 2}), /attempt/);
    });

    const fileDefects = [
        ["missing provenance", () => fs.unlinkSync(path.join(directory, CPU_FLOOR_FIXTURE.PROVENANCE_FILE))],
        ["missing inspection", () => fs.unlinkSync(path.join(directory, CPU_FLOOR_FIXTURE.INSPECTION_FILE))],
        ["missing provenance sidecar", () => fs.unlinkSync(path.join(directory,
            `${CPU_FLOOR_FIXTURE.PROVENANCE_FILE}.sha256`))],
        ["missing inspection sidecar", () => fs.unlinkSync(path.join(directory,
            `${CPU_FLOOR_FIXTURE.INSPECTION_FILE}.sha256`))],
        ["tampered inspection sidecar", () => fs.writeFileSync(path.join(directory,
            `${CPU_FLOOR_FIXTURE.INSPECTION_FILE}.sha256`), `${"0".repeat(64)}\n`)],
        ["sidecar without its newline", () => {
            const sidecar = path.join(directory, `${CPU_FLOOR_FIXTURE.PROVENANCE_FILE}.sha256`);
            fs.writeFileSync(sidecar, fs.readFileSync(sidecar, "utf8").trim());
        }],
        ["tampered inspection bytes", () => fs.appendFileSync(path.join(directory,
            CPU_FLOOR_FIXTURE.INSPECTION_FILE), " ")],
        ["oversize inspection", () => {
            const file = path.join(directory, CPU_FLOOR_FIXTURE.INSPECTION_FILE);
            fs.writeFileSync(file, Buffer.alloc(EVIDENCE_LIMIT + 1, " "));
        }],
        ["empty provenance", () => fs.writeFileSync(path.join(directory, CPU_FLOOR_FIXTURE.PROVENANCE_FILE), "")],
        ["non-file inspection", () => {
            const file = path.join(directory, CPU_FLOOR_FIXTURE.INSPECTION_FILE);
            fs.unlinkSync(file);
            fs.mkdirSync(file);
        }],
        ["hard-linked inspection", () => fs.linkSync(path.join(directory, CPU_FLOOR_FIXTURE.INSPECTION_FILE),
            path.join(directory, "..", `${path.basename(directory)}-link.json`))],
        ["unexpected extra member", () => fs.writeFileSync(path.join(directory, "extra.json"), "{}")],
        ["invalid provenance JSON", () => {
            const file = path.join(directory, CPU_FLOOR_FIXTURE.PROVENANCE_FILE);
            fs.writeFileSync(file, "{");
            fs.writeFileSync(`${file}.sha256`, `${createHash("sha256").update("{").digest("hex")}\n`);
        }]
    ];
    for (const [defect, mutate] of fileDefects)
        it(`rejects ${defect}`, async () => {
            mutate();
            try {
                await assert.rejects(inspectWindowsCpuFloorEvidence(baseOptions()), /CPU-floor/);
            } finally {
                fs.rmSync(path.join(directory, "..", `${path.basename(directory)}-link.json`), {force: true});
            }
        });

    const provenanceDefects = [
        ["an unexpected field", value => { value.reviewed = true; }],
        ["a missing field", value => { delete value.nonce; }],
        ["an unexpected candidate field", value => { value.candidate.extra = 1; }],
        ["an unexpected probe field", value => { value.probe.extra = 1; }],
        ["a wrong schema version", value => { value.schemaVersion = 2; }],
        ["a wrong kind", value => { value.kind = "myspeed-prerelease-cpu-floor-binding"; }],
        ["a failed status", value => { value.status = "failed"; }],
        ["a stale source SHA", value => { value.sourceSha = OTHER_SHA; }],
        ["a different repository", value => { value.repository = "fork/MySpeed"; }],
        ["a different run", value => { value.runId = RUN_ID + 1; }],
        ["a string run ID", value => { value.runId = String(RUN_ID); }],
        ["a second attempt", value => { value.runAttempt = 2; }],
        ["a malformed nonce", value => { value.nonce = "E".repeat(32); }],
        ["a different candidate artifact", value => { value.candidate.artifactName = "MySpeed-windows-x64.exe"; }],
        ["a candidate artifact ID mismatch", value => { value.candidate.artifactId = 99; }],
        ["a candidate archive digest mismatch", value => {
            value.candidate.archiveDigest = `sha256:${"0".repeat(64)}`; }],
        ["a candidate archive size mismatch", value => { value.candidate.archiveBytes += 1; }],
        ["a renamed executable", value => { value.candidate.fileName = "MySpeed-baseline.exe"; }],
        ["an executable size mismatch", value => { value.candidate.fileBytes += 1; }],
        ["a tested executable that is not the release asset", value => {
            value.candidate.fileSha256 = OTHER_SHA256; }],
        ["a probe from another artifact", value => { value.probe.artifactName = "windows-cpu-readiness-closure"; }],
        ["a probe artifact ID mismatch", value => { value.probe.artifactId = 98; }],
        ["a probe archive digest mismatch", value => { value.probe.archiveDigest = `sha256:${"0".repeat(64)}`; }],
        ["a probe archive size mismatch", value => { value.probe.archiveBytes += 1; }],
        ["an unadmitted installer policy", value => { value.installerConfirmation = "press-enter-forever"; }],
        ["a malformed closure digest", value => { value.closureManifestSha256 = "not-a-digest"; }],
        ["an inspection digest that is not the sealed file", value => { value.inspectionSha256 = OTHER_SHA256; }]
    ];
    for (const [defect, mutate] of provenanceDefects)
        it(`rejects provenance with ${defect}`, async () => {
            rewriteCpuFloorProvenance(directory, mutate);
            await assert.rejects(inspectWindowsCpuFloorEvidence(baseOptions()), /CPU-floor/);
        });

    const inspectionDefects = [
        ["a different kind", value => { value.kind = "myspeed-prerelease-cpu-floor-binding"; }],
        ["an unaccepted result", value => { value.accepted = false; }],
        ["a harness that claims to qualify", value => { value.qualifying = true; }],
        ["a different claim", value => { value.establishes = "reproduces-sealed-result"; }],
        ["a different classification", value => { value.classification = "windows-msi-lifecycle"; }],
        ["a different repository", value => { value.context.repository = "fork/MySpeed"; }],
        ["a stale source SHA", value => { value.context.sourceSha = OTHER_SHA; }],
        ["a different run", value => { value.context.runId = String(RUN_ID + 1); }],
        ["a numeric run attempt", value => { value.context.runAttempt = RUN_ATTEMPT; }],
        ["a second attempt", value => { value.context.runAttempt = "2"; }],
        ["another run's nonce", value => { value.context.nonce = "f".repeat(32); }],
        ["published-release provenance", value => { value.candidate.provenance = "published-release"; }],
        ["a candidate from another commit", value => { value.candidate.sourceSha = OTHER_SHA; }],
        ["a different candidate artifact", value => { value.candidate.artifactName = "MySpeed-windows-x64.exe"; }],
        ["a candidate artifact ID mismatch", value => { value.candidate.artifactId = "99"; }],
        ["a candidate archive digest mismatch", value => { value.candidate.archive.sha256 = "0".repeat(64); }],
        ["a candidate archive size mismatch", value => { value.candidate.archive.bytes = "1"; }],
        ["a candidate file digest mismatch", value => { value.candidate.file.sha256 = OTHER_SHA256; }],
        ["a staged file digest mismatch", value => { value.acquiredCandidate.stagedFile.sha256 = OTHER_SHA256; }],
        ["a guest that ran another executable", value => { value.guest.candidate.sha256 = OTHER_SHA256; }],
        ["a guest that ran another commit", value => { value.guest.candidate.sourceSha = OTHER_SHA; }],
        ["a different guest CPU model", value => { value.guest.cpu.model = "Nehalem"; }],
        ["AVX present", value => { value.guest.cpu.avx = true; }],
        ["AVX2 present", value => { value.guest.cpu.avx2 = true; }],
        ["OSXSAVE present", value => { value.guest.cpu.osxsave = true; }],
        ["SSE4.2 absent", value => { value.guest.cpu.sse42 = false; }],
        ["POPCNT absent", value => { value.guest.cpu.popcnt = false; }],
        ["a truthy rather than boolean AVX flag", value => { value.guest.cpu.avx = 0; }],
        ["no guest at all", value => { delete value.guest; }]
    ];
    for (const [defect, mutate] of inspectionDefects)
        it(`rejects an accepted inspection with ${defect}`, async () => {
            rewriteCpuFloorInspection(directory, mutate);
            await assert.rejects(inspectWindowsCpuFloorEvidence(baseOptions()), /CPU-floor/);
        });
});
