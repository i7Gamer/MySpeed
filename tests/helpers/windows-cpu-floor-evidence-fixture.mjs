import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";

/*
 * Synthetic retained Windows CPU-floor evidence, shaped like what the candidate workflow uploads as
 * `qualified-windows-cpu-floor`: the launcher's accepted inspection copied byte for byte, and the
 * provenance record the workflow writes beside it, each with a `<file>.sha256` sidecar.
 *
 * The inspection mirrors the object `inspectPrereleaseCpuFloorEvidence` returns. Its exact key paths
 * have not yet been compared with a real accepted file, so this fixture is the assumption, not proof.
 */

export const CPU_FLOOR_FIXTURE = Object.freeze({
    ARTIFACT_NAME: "qualified-windows-cpu-floor",
    PROVENANCE_FILE: "windows-cpu-floor-provenance.json",
    INSPECTION_FILE: "windows-cpu-floor-inspection.json",
    CANDIDATE_ARTIFACT: "MySpeed-windows-x64-baseline.exe",
    PROBE_ARTIFACT: "windows-cpu-readiness-evidence",
    NONCE: "e".repeat(32),
    INSTALLER_CONFIRMATION: "cadence-enter-before-setup-v3",
    CLOSURE_SHA256: "d".repeat(64),
    CLASSIFICATION: "windows-baseline-cpu-floor-full-runtime-stage3-nonqualifying",
    CPU_MODEL: "Westmere-v2"
});

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const bareDigest = value => value.slice("sha256:".length);

const writeSealed = (directory, file, value) => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    fs.writeFileSync(path.join(directory, file), bytes);
    fs.writeFileSync(path.join(directory, `${file}.sha256`), `${sha256(bytes)}\n`);
    return sha256(bytes);
};

export const buildCpuFloorInspection = ({repository, sourceSha, runId, runAttempt, executableSha256,
    executableBytes, candidateArtifact}) => {
    const context = {schemaVersion: 1, repository, sourceSha, eventSha: sourceSha, runId: String(runId),
        runAttempt: String(runAttempt), nonce: CPU_FLOOR_FIXTURE.NONCE,
        environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
            RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "synthetic"}};
    const file = {name: "MySpeed.exe", bytes: String(executableBytes), sha256: executableSha256};
    const candidate = {provenance: "branch-build", sourceSha, artifactId: String(candidateArtifact.id),
        artifactName: CPU_FLOOR_FIXTURE.CANDIDATE_ARTIFACT, runId: String(runId), runAttempt: String(runAttempt),
        archive: {bytes: String(candidateArtifact.archiveSize), sha256: bareDigest(candidateArtifact.archiveDigest)},
        file};
    return {
        schemaVersion: 1,
        kind: "myspeed-prerelease-cpu-floor-evidence",
        accepted: true,
        qualifying: false,
        releaseGateCleared: false,
        releaseGatesCleared: [],
        establishes: "branch-build-runs-on-cpu-floor",
        classification: CPU_FLOOR_FIXTURE.CLASSIFICATION,
        context,
        candidate,
        acquiredCandidate: {candidate: structuredClone(candidate),
            stagedFile: {...file, path: `/home/runner/work/_temp/myspeed-stage3-${CPU_FLOOR_FIXTURE.NONCE}/candidate/MySpeed.exe`}},
        guest: {schemaVersion: 1, status: "observed", profile: "baseline-cpu", cleanupProven: true,
            context: structuredClone(context), releaseGatesCleared: [],
            candidate: {artifactName: CPU_FLOOR_FIXTURE.CANDIDATE_ARTIFACT, sha256: executableSha256, sourceSha},
            cpu: {model: CPU_FLOOR_FIXTURE.CPU_MODEL, sse42: true, popcnt: true, avx: false, avx2: false,
                osxsave: false, xcr0: null, cpuidBytesBase64: "e30=", cpuidSha256: sha256(Buffer.from("{}"))},
            network: {}, verifier: {}},
        qemuProcess: {},
        media: {},
        stage2: {},
        harness: {sourceSha}
    };
};

export const buildCpuFloorProvenance = ({repository, sourceSha, runId, runAttempt, executableSha256,
    executableBytes, candidateArtifact, probeArtifact, inspectionSha256}) => ({
    schemaVersion: 1,
    kind: "myspeed-qualification-windows-cpu-floor-provenance",
    status: "passed",
    repository,
    sourceSha,
    runId: Number(runId),
    runAttempt: Number(runAttempt),
    nonce: CPU_FLOOR_FIXTURE.NONCE,
    candidate: {artifactName: CPU_FLOOR_FIXTURE.CANDIDATE_ARTIFACT, artifactId: candidateArtifact.id,
        archiveDigest: candidateArtifact.archiveDigest, archiveBytes: candidateArtifact.archiveSize,
        fileName: "MySpeed.exe", fileBytes: executableBytes, fileSha256: executableSha256},
    probe: {artifactName: CPU_FLOOR_FIXTURE.PROBE_ARTIFACT, artifactId: probeArtifact.id,
        archiveDigest: probeArtifact.archiveDigest, archiveBytes: probeArtifact.archiveSize},
    installerConfirmation: CPU_FLOOR_FIXTURE.INSTALLER_CONFIRMATION,
    closureManifestSha256: CPU_FLOOR_FIXTURE.CLOSURE_SHA256,
    inspectionSha256
});

/** Writes both sealed records into `directory` and returns the values written. */
export const writeCpuFloorEvidence = (directory, options) => {
    fs.mkdirSync(directory, {recursive: true});
    const inspection = buildCpuFloorInspection(options);
    const inspectionSha256 = writeSealed(directory, CPU_FLOOR_FIXTURE.INSPECTION_FILE, inspection);
    const provenance = buildCpuFloorProvenance({...options, inspectionSha256});
    writeSealed(directory, CPU_FLOOR_FIXTURE.PROVENANCE_FILE, provenance);
    return {inspection, provenance};
};

const readJson = (directory, file) => JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));

/** Rewrites the provenance with a fresh sidecar, leaving the inspection untouched. */
export const rewriteCpuFloorProvenance = (directory, update) => {
    const provenance = readJson(directory, CPU_FLOOR_FIXTURE.PROVENANCE_FILE);
    update(provenance);
    writeSealed(directory, CPU_FLOOR_FIXTURE.PROVENANCE_FILE, provenance);
};

/** Rewrites the inspection and reseals both it and the provenance digest that binds it. */
export const rewriteCpuFloorInspection = (directory, update) => {
    const inspection = readJson(directory, CPU_FLOOR_FIXTURE.INSPECTION_FILE);
    update(inspection);
    const inspectionSha256 = writeSealed(directory, CPU_FLOOR_FIXTURE.INSPECTION_FILE, inspection);
    rewriteCpuFloorProvenance(directory, provenance => { provenance.inspectionSha256 = inspectionSha256; });
};
