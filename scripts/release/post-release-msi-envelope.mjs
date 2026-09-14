import {isDeepStrictEqual} from "node:util";

import {buildV161WindowsExeAcquisitionPlan} from "./post-release-target.mjs";

const SCHEMA_VERSION = 1;
const REPOSITORY = "i7Gamer/MySpeed";
const CANDIDATE_VERSION = "1.6.1";
const LEGACY_PRESEAL_NAME = "release-candidate-manifest";
const ORIGINAL_QUALIFICATION_NAME = "release-qualification-manifest";
const CONTEXT_KEYS = ["eventSha", "imageVersion", "nonce", "repository", "runAttempt", "runId", "sourceSha"];
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,19}$/u;
const RUN_ATTEMPT = /^[1-9][0-9]{0,9}$/u;
const IMAGE_VERSION = /^[0-9A-Za-z._-]{1,64}$/u;
const NONCE = /^[0-9a-f]{32}$/u;
const CANDIDATE_BINDINGS = Object.freeze([
    {bindingId: "candidate-default", msi: "MySpeed-installer.msi", exe: "MySpeed-windows-x64.exe"},
    {bindingId: "candidate-baseline", msi: "MySpeed-installer-baseline.msi",
        exe: "MySpeed-windows-x64-baseline.exe"}
]);

const fail = message => { throw new Error(`Invalid v1.6.1 post-release MSI envelope: ${message}`); };

const exactKeys = (value, keys, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
        fail(`${label} keys differ`);
};

const exactString = (value, pattern, label) => {
    if (typeof value !== "string") fail(`${label} must be a string`);
    const match = pattern.exec(value);
    if (!match || match.index !== 0 || match[0].length !== value.length) fail(`${label} differs`);
    return value;
};

const deepFreeze = value => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
};

const validateContext = (context, target) => {
    exactKeys(context, CONTEXT_KEYS, "harness context");
    if (context.repository !== REPOSITORY || context.sourceSha !== target.harness.sourceSha)
        fail("harness identity differs from the authenticated target");
    exactString(context.sourceSha, COMMIT_SHA, "harness source SHA");
    exactString(context.eventSha, COMMIT_SHA, "harness event SHA");
    if (context.eventSha !== context.sourceSha) fail("harness event SHA differs from its source");
    if (context.sourceSha === target.candidate.sourceSha) fail("harness and candidate sources must be distinct");
    exactString(context.runId, POSITIVE_DECIMAL, "harness run ID");
    exactString(context.runAttempt, RUN_ATTEMPT, "harness run attempt");
    exactString(context.imageVersion, IMAGE_VERSION, "harness image version");
    exactString(context.nonce, NONCE, "harness nonce");
};

const publishedIdentity = (asset, expectedName) => {
    if (!asset || asset.name !== expectedName || asset.provenance !== "github-release-asset")
        fail(`published candidate ${expectedName} is absent`);
    return {provenance: asset.provenance, releaseAssetId: String(asset.id), name: asset.name,
        url: asset.url, bytes: asset.size, sha256: asset.digest.slice("sha256:".length)};
};

export const createV161PostReleaseMsiEnvelope = (target, harnessContext) => {
    const exePlan = buildV161WindowsExeAcquisitionPlan(target);
    validateContext(harnessContext, target);
    if (target.candidate.version !== CANDIDATE_VERSION) fail("candidate version differs");
    if (target.originalQualification.archive.name !== ORIGINAL_QUALIFICATION_NAME)
        fail("original qualification archive differs");
    const publishedByName = new Map(target.publication.assets.map(asset => [asset.name, asset]));
    const executableByName = new Map(exePlan.assets.map(asset => [asset.name, asset]));
    const candidates = CANDIDATE_BINDINGS.map(binding => {
        const msi = publishedIdentity(publishedByName.get(binding.msi), binding.msi);
        const publishedExe = publishedIdentity(publishedByName.get(binding.exe), binding.exe);
        const plannedExe = executableByName.get(binding.exe);
        if (!plannedExe || String(plannedExe.id) !== publishedExe.releaseAssetId
                || plannedExe.bytes !== publishedExe.bytes || plannedExe.sha256 !== publishedExe.sha256)
            fail(`published candidate ${binding.exe} differs from the authenticated acquisition plan`);
        return {bindingId: binding.bindingId, msi, exe: publishedExe};
    });
    const ids = candidates.flatMap(candidate => [candidate.msi.releaseAssetId, candidate.exe.releaseAssetId]);
    if (new Set(ids).size !== ids.length) fail("published candidate release asset IDs are duplicated");
    return deepFreeze({
        schemaVersion: SCHEMA_VERSION,
        kind: "myspeed-v1.6.1-post-release-msi-request-provenance",
        status: "bound",
        authority: "request-provenance-only",
        legacyPresealHostCompatible: target.originalQualification.archive.name === LEGACY_PRESEAL_NAME,
        harness: structuredClone(harnessContext),
        candidate: structuredClone(target.candidate),
        originalQualification: {
            manifest: structuredClone(target.originalQualification.manifest),
            archive: structuredClone(target.originalQualification.archive),
            run: structuredClone(target.originalQualification.run)
        },
        publication: {releaseId: target.publication.releaseId, tagName: target.publication.tagName,
            publishedAt: target.publication.publishedAt},
        candidates
    });
};

export const validateV161PostReleaseMsiEnvelope = (value, target, expectedHarnessContext) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("envelope must be an object");
    const expected = createV161PostReleaseMsiEnvelope(target, expectedHarnessContext);
    if (!isDeepStrictEqual(value, expected)) fail("serialized envelope differs from the authenticated target");
    return true;
};
