import {createHash} from "node:crypto";

const SCHEMA_VERSION = 1;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const ARCHIVE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MEBIBYTE = 1024 * 1024;
const MANIFEST_LIMIT = 10 * MEBIBYTE;
const CANDIDATE_LIMIT = 1024 * MEBIBYTE;
const PRESEAL_ARTIFACT = "release-candidate-manifest";
const NATIVE_BLOCKERS = ["Windows native full verification with enforced outbound denial",
    "Windows native CPU-floor verification", "Disposable Windows MSI lifecycle acceptance"];
const WINDOWS_ASSETS = [
    ["MySpeed-windows-x64.exe", "MySpeed.exe", "MySpeed-windows-x64.exe"],
    ["MySpeed-windows-x64-baseline.exe", "MySpeed.exe", "MySpeed-windows-x64-baseline.exe"],
    ["release-msi-MySpeed-installer.msi", "MySpeed-installer.msi", "MySpeed-installer.msi"],
    ["release-msi-MySpeed-installer-baseline.msi", "MySpeed-installer.msi", "MySpeed-installer-baseline.msi"]
];

const boundedPositive = (value, maximum = Number.MAX_SAFE_INTEGER) =>
    Number.isSafeInteger(value) && value > 0 && value <= maximum;

const checkArchive = (value, limit) => {
    if (!value || typeof value.name !== "string" || !boundedPositive(value.id)
        || !boundedPositive(value.archiveSize, limit) || typeof value.archiveDigest !== "string"
        || !ARCHIVE_DIGEST.test(value.archiveDigest)) throw new Error("Candidate archive metadata differs");
};
// The caller must first reconstruct candidateManifest with the trusted release validator.
// This binder links requests to that reconstruction; it does not validate native proof or clear gates.
export const bindNativeCandidatePreseal = ({candidateManifest, presealBytes, presealArtifact, qualification}) => {
    if (!qualification || typeof qualification.repository !== "string"
        || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(qualification.repository)
        || typeof qualification.sourceSha !== "string" || !COMMIT_SHA.test(qualification.sourceSha)
        || !boundedPositive(qualification.runId) || !boundedPositive(qualification.runAttempt))
        throw new Error("Candidate qualification identity differs");
    if (candidateManifest?.schemaVersion !== SCHEMA_VERSION
        || candidateManifest.source?.repository !== qualification.repository
        || candidateManifest.source?.sha !== qualification.sourceSha
        || candidateManifest.run?.id !== qualification.runId
        || candidateManifest.run?.attempt !== qualification.runAttempt)
        throw new Error("Reconstructed candidate provenance differs");
    const promotion = candidateManifest.promotion;
    if (promotion?.eligible !== false
        || ["windowsNative", "windowsCpuFloor", "msiLifecycle"].some(gate => promotion.evidence?.[gate] !== null)
        || !Array.isArray(promotion.blockers)
        || NATIVE_BLOCKERS.some(blocker => !promotion.blockers.includes(blocker)))
        throw new Error("Candidate preseal must retain every native blocker");
    if (!Buffer.isBuffer(presealBytes) || presealBytes.length === 0 || presealBytes.length > MANIFEST_LIMIT
        || !presealBytes.equals(Buffer.from(JSON.stringify(candidateManifest, null, 2) + "\n")))
        throw new Error("Candidate preseal bytes differ from trusted reconstruction");
    checkArchive(presealArtifact, MANIFEST_LIMIT);
    if (presealArtifact.name !== PRESEAL_ARTIFACT) throw new Error("Candidate preseal artifact name differs");
    if (!Array.isArray(candidateManifest.actionsArtifacts) || !Array.isArray(candidateManifest.releaseAssets))
        throw new Error("Candidate artifact inventory is absent");
    const artifactNames = new Set();
    const artifactIds = new Set([presealArtifact.id]);
    for (const artifact of candidateManifest.actionsArtifacts) {
        if (!boundedPositive(artifact?.id) || artifactNames.has(artifact.name) || artifactIds.has(artifact.id))
            throw new Error("Candidate artifact identity is duplicated or invalid");
        artifactNames.add(artifact.name); artifactIds.add(artifact.id);
    }
    const windowsAssets = WINDOWS_ASSETS.map(([artifact, file, name]) => {
        const matches = candidateManifest.releaseAssets.filter(value => value.name === name);
        if (matches.length !== 1) throw new Error("Required Windows candidate asset is absent or duplicated");
        const asset = matches[0];
        if (asset.artifact !== artifact || asset.path !== file || typeof asset.sha256 !== "string"
            || !SHA256.test(asset.sha256) || !boundedPositive(asset.size, CANDIDATE_LIMIT))
            throw new Error("Windows candidate asset identity differs");
        const actionsArtifact = candidateManifest.actionsArtifacts.find(value => value.name === artifact);
        checkArchive(actionsArtifact, CANDIDATE_LIMIT);
        return structuredClone({...asset, actionsArtifact});
    });
    return {qualification: structuredClone(qualification),
        manifest: {...structuredClone(presealArtifact),
            sha256: createHash("sha256").update(presealBytes).digest("hex"), bytes: presealBytes.length},
        windowsAssets};
};
