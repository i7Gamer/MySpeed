import path from "node:path";
import {isDeepStrictEqual} from "node:util";

const SCHEMA_VERSION = 1;
const PLAN_KIND = "myspeed-v1.6.1-post-release-msi-acquisition-plan";
const RECORD_KIND = "myspeed-v1.6.1-post-release-msi-acquisition-record";
const REPOSITORY = "i7Gamer/MySpeed";
const CANDIDATE_SOURCE_SHA = "4fa4dd40a89a062735f98bd85d685e0624ff46a8";
const RELEASE_ID = 388294074;
const TAG_NAME = "v1.6.1";
const VERSION = "1.6.1";
const WINDOWS_STAMP = "1.6.1.45";
const MAX_FILE_BYTES = 1_073_741_824;
const SHA256 = /^[0-9a-f]{64}$/u;
const SHA1 = /^[0-9a-f]{40}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,19}$/u;
const RUN_ATTEMPT = /^[1-9][0-9]{0,9}$/u;
const NONCE = /^[0-9a-f]{32}$/u;
const NODE_RUNTIME_SHA256 = "995a3fb3cefad590cd3f4b321532a4b9582fb9c6575320ed2e3e894caac3e362";
const PLAN_IDENTITY = Symbol("validated-v1.6.1-post-release-msi-acquisition-plan");

const githubSource = (bindingId, role, releaseId, releaseAssetId, tagName, sourceSha, name, bytes,
    sha256, outputName, provenance = "github-release-api-digest") => ({bindingId, role, outputName,
    source: {provenance, repository: REPOSITORY, releaseId, releaseAssetId, tagName, sourceSha, name,
        url: `https://github.com/${REPOSITORY}/releases/download/${tagName}/${name}`, bytes, sha256}});

const FILES = Object.freeze([
    githubSource("candidate-default", "msi", RELEASE_ID, 563103039, TAG_NAME, CANDIDATE_SOURCE_SHA,
        "MySpeed-installer.msi", 53702656,
        "5f9573c785ee8d51a661548e74da514a24c2932c200f1c0a1de6b6e0c1a03f6d", "candidate-default.msi",
        "github-release-asset"),
    githubSource("candidate-default", "exe", RELEASE_ID, 563103772, TAG_NAME, CANDIDATE_SOURCE_SHA,
        "MySpeed-windows-x64.exe", 111524352,
        "bc4eea0a06c890eb5c0da0472a1705b3219aac3f5000383d9847120b5681d154", "candidate-default.exe",
        "github-release-asset"),
    githubSource("candidate-baseline", "msi", RELEASE_ID, 563102948, TAG_NAME, CANDIDATE_SOURCE_SHA,
        "MySpeed-installer-baseline.msi", 53702656,
        "7536c7668dcb0721c643493f595bf8714114d9aa4807357a8263ffe1c9c6bbed", "candidate-baseline.msi",
        "github-release-asset"),
    githubSource("candidate-baseline", "exe", RELEASE_ID, 563103679, TAG_NAME, CANDIDATE_SOURCE_SHA,
        "MySpeed-windows-x64-baseline.exe", 111524352,
        "bc4eea0a06c890eb5c0da0472a1705b3219aac3f5000383d9847120b5681d154", "candidate-baseline.exe",
        "github-release-asset"),
    githubSource("authentic-1.6.0-default-msi", "msi", 384231789, 549130770, "v1.6.0",
        "64573464cb56e21884426e1b99f12b58cae01126", "MySpeed-installer.msi", 51445760,
        "97c7f843aff0290a547dc56a996c78a9d5d4350b7cee954445117b13ad50debc", "authentic-1.6.0-default.msi"),
    githubSource("authentic-1.6.0-baseline-msi", "msi", 384231789, 549129968, "v1.6.0",
        "64573464cb56e21884426e1b99f12b58cae01126", "MySpeed-installer-baseline.msi", 51101696,
        "d26f3acf30cfbe130ed32cb5d09ce1ccffe134e81261625bf87e49f3a5de81d2",
        "authentic-1.6.0-baseline.msi"),
    githubSource("authentic-1.1.0-msi", "msi", 366720262, 505104227, "v1.1.0",
        "0868e6bbc6fd29b1cc98e604be82609fb57a0cac", "MySpeed-installer.msi", 50552832,
        "8c4095dfe68b77fb2c43fe6996f3d2bb0fd78bf46eedec0cc18777a91b7712e5", "authentic-1.1.0.msi"),
    {bindingId: "node-22.19.0-windows-x64", role: "runtime-archive",
        outputName: "node-v22.19.0-win-x64.zip", source: {provenance: "nodejs-release-shasums",
            version: "22.19.0", name: "node-v22.19.0-win-x64.zip",
            url: "https://nodejs.org/dist/v22.19.0/node-v22.19.0-win-x64.zip", bytes: 35424607,
            sha256: "ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86",
            executableSha256: NODE_RUNTIME_SHA256}}
]);

const CURRENT_IDENTITIES = FILES.slice(0, 4);
const ROOT_KEYS = ["schemaVersion", "kind", "status", "authority", "legacyPresealHostCompatible",
    "harness", "candidate", "originalQualification", "publication", "candidates"];
const CONTEXT_KEYS = ["repository", "sourceSha", "eventSha", "runId", "runAttempt", "imageVersion", "nonce"];

const fail = message => { throw new Error(`Invalid v1.6.1 post-release MSI acquisition: ${message}`); };
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys, label) => {
    if (!isObject(value)) fail(`${label} must be an object`);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
        fail(`${label} keys differ`);
};
const exactPattern = (value, pattern, label) => {
    if (typeof value !== "string") fail(`${label} must be a string`);
    const match = pattern.exec(value);
    if (!match || match.index !== 0 || match[0].length !== value.length) fail(`${label} differs`);
    return value;
};
const exactInteger = (value, label, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${label} differs`);
    return value;
};
const deepFreeze = value => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
};
const same = (actual, expected, label) => {
    if (!isDeepStrictEqual(actual, expected)) fail(`${label} differs`);
};

const validateContext = (actual, expected) => {
    exactKeys(expected, CONTEXT_KEYS, "expected harness context");
    exactKeys(actual, CONTEXT_KEYS, "envelope harness context");
    for (const value of [actual, expected]) {
        if (value.repository !== REPOSITORY) fail("harness repository differs");
        exactPattern(value.sourceSha, SHA1, "harness source SHA");
        exactPattern(value.eventSha, SHA1, "harness event SHA");
        if (value.sourceSha !== value.eventSha || value.sourceSha === CANDIDATE_SOURCE_SHA)
            fail("harness source binding differs");
        exactPattern(value.runId, POSITIVE_DECIMAL, "harness run ID");
        exactPattern(value.runAttempt, RUN_ATTEMPT, "harness run attempt");
        exactPattern(value.nonce, NONCE, "harness nonce");
        exactPattern(value.imageVersion, /^[0-9A-Za-z._-]{1,64}$/u, "harness image version");
    }
    same(actual, expected, "harness context");
};

const validateEnvelope = (value, expectedContext) => {
    exactKeys(value, ROOT_KEYS, "MSI envelope");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== "myspeed-v1.6.1-post-release-msi-request-provenance"
        || value.status !== "bound" || value.authority !== "request-provenance-only"
        || value.legacyPresealHostCompatible !== false) fail("MSI envelope identity differs");
    validateContext(value.harness, expectedContext);
    same(value.candidate, {repository: REPOSITORY, sourceSha: CANDIDATE_SOURCE_SHA, version: VERSION,
        windowsStamp: WINDOWS_STAMP, tagName: TAG_NAME}, "candidate identity");
    same(value.publication, {releaseId: RELEASE_ID, tagName: TAG_NAME,
        publishedAt: "2026-09-14T10:00:58Z"}, "publication identity");
    if (!isObject(value.originalQualification)
        || value.originalQualification.manifest?.sha256 !==
            "7339a6446d048bbae93759734bcafc94208e2b847af15677e847ae9a4b2f8bca"
        || value.originalQualification.archive?.name !== "release-qualification-manifest"
        || value.originalQualification.run?.id !== 34829932391
        || value.originalQualification.run?.attempt !== 1) fail("original qualification identity differs");
    if (!Array.isArray(value.candidates) || value.candidates.length !== 2)
        fail("candidate inventory differs");
    for (const [index, bindingId] of ["candidate-default", "candidate-baseline"].entries()) {
        const candidate = value.candidates[index];
        exactKeys(candidate, ["bindingId", "msi", "exe"], `candidate ${bindingId}`);
        if (candidate.bindingId !== bindingId) fail("candidate order differs");
        for (const role of ["msi", "exe"]) {
            const expected = CURRENT_IDENTITIES.find(file => file.bindingId === bindingId && file.role === role);
            const source = expected.source;
            same(candidate[role], {provenance: source.provenance,
                releaseAssetId: String(source.releaseAssetId), name: source.name, url: source.url,
                bytes: source.bytes, sha256: source.sha256}, `${bindingId} ${role} publication`);
        }
    }
};

const validateRoot = value => {
    if (typeof value !== "string" || value.length === 0 || value.length > 1024
        || /[\x00-\x1f\x7f/]/u.test(value) || !path.win32.isAbsolute(value)
        || path.win32.normalize(value) !== value)
        fail("acquisition root differs");
    return value;
};

export const buildV161PostReleaseMsiAcquisitionPlan = (envelope, expectedHarnessContext,
    acquisitionRoot) => {
    validateEnvelope(envelope, expectedHarnessContext);
    const root = validateRoot(acquisitionRoot);
    const plan = {schemaVersion: SCHEMA_VERSION, kind: PLAN_KIND, authority: "acquisition-and-inspection-only",
        preparation: {repository: REPOSITORY, candidateSourceSha: CANDIDATE_SOURCE_SHA,
            harnessSourceSha: expectedHarnessContext.sourceSha, runId: expectedHarnessContext.runId,
            runAttempt: expectedHarnessContext.runAttempt, imageVersion: expectedHarnessContext.imageVersion,
            nonce: expectedHarnessContext.nonce},
        files: FILES.map(file => ({bindingId: file.bindingId, role: file.role,
            destinationPath: path.win32.join(root, file.outputName), source: structuredClone(file.source)})),
        runtime: {archiveBindingId: "node-22.19.0-windows-x64", format: "zip",
            member: "node-v22.19.0-win-x64/node.exe",
            destinationPath: path.win32.join(root, "node-v22.19.0-win-x64", "node.exe"),
            sha256: NODE_RUNTIME_SHA256},
        inspection: {scope: "windows-installer-database-read-only",
            bindings: FILES.filter(file => file.role === "msi").map(file => file.bindingId),
            properties: ["ProductCode", "ProductVersion", "UpgradeCode"], nativeExecution: false},
        fixturePreparation: [
            {bindingId: "lower-stamp-fixture", source: ".github/workflows/build-msi.yml",
                status: "requires-deterministic-prepare-adapter",
                requirement: "derive-identities-from-inspected-candidate-and-use-a-lower-windows-stamp"},
            {bindingId: "safe-rollback-predecessor",
                source: "scripts/qualification/windows-msi-rollback-calibration.ps1",
                mode: "GetFixtures", role: "predecessor"}
        ]};
    Object.defineProperty(plan, PLAN_IDENTITY, {value: true});
    return deepFreeze(plan);
};

const assertPlan = plan => {
    if (!isObject(plan) || !Object.isFrozen(plan) || plan[PLAN_IDENTITY] !== true)
        fail("plan must come from the authenticated builder");
};

export const createV161PostReleaseMsiAcquisitionRecord = (plan, observations, runtime) => {
    assertPlan(plan);
    if (!Array.isArray(observations) || observations.length !== plan.files.length)
        fail("local observation inventory differs");
    const files = observations.map((local, index) => {
        exactKeys(local, ["bindingId", "role", "path", "bytes", "sha256"], "local observation");
        const expected = plan.files[index];
        if (local.bindingId !== expected.bindingId || local.role !== expected.role
            || local.path !== expected.destinationPath) fail("local observation binding differs");
        if (exactInteger(local.bytes, "local observation bytes", 1, MAX_FILE_BYTES) !== expected.source.bytes)
            fail("local observation bytes differ");
        if (exactPattern(local.sha256, SHA256, "local observation SHA-256") !== expected.source.sha256)
            fail("local observation SHA-256 differs");
        return {bindingId: expected.bindingId, role: expected.role,
            source: structuredClone(expected.source), local: {path: local.path, bytes: local.bytes,
             sha256: local.sha256}};
    });
    exactKeys(runtime, ["path", "bytes", "sha256"], "local runtime observation");
    if (runtime.path !== plan.runtime.destinationPath) fail("local runtime path differs");
    exactInteger(runtime.bytes, "local runtime bytes", 1, MAX_FILE_BYTES);
    if (exactPattern(runtime.sha256, SHA256, "local runtime SHA-256") !== plan.runtime.sha256)
        fail("local runtime SHA-256 differs");
    return deepFreeze({schemaVersion: SCHEMA_VERSION, kind: RECORD_KIND,
        authority: "windows-hosted-preparation-only", preparation: structuredClone(plan.preparation), files,
        runtime: {archiveBindingId: plan.runtime.archiveBindingId,
            local: {path: runtime.path, bytes: runtime.bytes, sha256: runtime.sha256}}});
};

export const validateV161PostReleaseMsiAcquisitionRecord = (value, plan) => {
    assertPlan(plan);
    exactKeys(value, ["schemaVersion", "kind", "authority", "preparation", "files", "runtime"],
        "acquisition record");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== RECORD_KIND
        || value.authority !== "windows-hosted-preparation-only") fail("acquisition record identity differs");
    same(value.preparation, plan.preparation, "acquisition record preparation binding");
    if (!Array.isArray(value.files) || value.files.length !== plan.files.length)
        fail("acquisition record file inventory differs");
    const observations = value.files.map((file, index) => {
        exactKeys(file, ["bindingId", "role", "source", "local"], "acquisition record file");
        same(file.source, plan.files[index].source, "acquisition record source");
        exactKeys(file.local, ["path", "bytes", "sha256"], "acquisition record local file");
        return {bindingId: file.bindingId, role: file.role, ...file.local};
    });
    exactKeys(value.runtime, ["archiveBindingId", "local"], "acquisition record runtime");
    if (value.runtime.archiveBindingId !== plan.runtime.archiveBindingId)
        fail("acquisition record runtime binding differs");
    exactKeys(value.runtime.local, ["path", "bytes", "sha256"], "acquisition record local runtime");
    const expected = createV161PostReleaseMsiAcquisitionRecord(plan, observations, value.runtime.local);
    if (!isDeepStrictEqual(value, expected)) fail("serialized acquisition record differs");
    return true;
};
