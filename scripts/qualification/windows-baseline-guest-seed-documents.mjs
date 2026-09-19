import crypto from "node:crypto";

const SCHEMA_VERSION = 1;
const REQUEST_KIND = "myspeed-windows-baseline-guest-request";
const EXECUTION_KIND = "myspeed-windows-baseline-guest-execution-manifest";
const PROFILE = "baseline-cpu";
const ARTIFACT_NAME = "MySpeed-windows-x64-baseline.exe";
const MAX_CANDIDATE_BYTES = 512 * 1024 * 1024;
const MAX_FIXTURE_BYTES = 64 * 1024 * 1024;
const MAX_CONTROLLER_BYTES = 2 * 1024 * 1024;
const MAX_PROBE_BYTES = 8 * 1024 * 1024;
/*
 * The QEMU model name Stage 3 boots this guest with. CPUID reports a brand string, not this alias,
 * so the guest cannot measure it and echoes what the host seeded. The alias is only a label: the
 * proof of the floor is the CPUID feature projection the host recomputes from the raw leaves.
 */
const CPU_MODEL = "Westmere-v2";
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const SCENARIOS = Object.freeze([
    {scenario: "populated-first-boot", port: 43_101},
    {scenario: "populated-restart", port: 43_102},
    {scenario: "fresh-no-config-reset", port: 43_103}
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
/* Kept identical to linux-kvm-capability.mjs' hosted context, which is what Stage 3 compares against. */
const CONTEXT_KEYS = Object.freeze(["environment", "eventSha", "nonce", "repository", "runAttempt", "runId",
    "schemaVersion", "sourceSha"]);
const ENVIRONMENT_KEYS = Object.freeze(["CI", "GITHUB_ACTIONS", "ImageOS", "ImageVersion", "RUNNER_ARCH",
    "RUNNER_ENVIRONMENT", "RUNNER_OS"]);

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, expected, label) => {
    if (!isObject(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
        throw new TypeError(`${label} schema differs`);
};
const exactString = (value, pattern, label) => {
    const match = typeof value === "string" ? pattern.exec(value) : null;
    if (match === null || match.index !== 0 || match[0].length !== value.length)
        throw new TypeError(`${label} differs`);
    return value;
};
const decimal = (value, maximum, label) => {
    exactString(value, /^[1-9][0-9]*$/u, label);
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number > maximum) throw new TypeError(`${label} differs`);
    return value;
};
const hash = (value, label) => exactString(value, SHA256_PATTERN, label);
const windowsRoot = (name, nonce) => `C:\\Windows\\Temp\\myspeed-baseline-${name}-${nonce}`;

/*
 * The whole hosted context, carried to the guest byte for byte.
 *
 * Stage 3 compares the context the guest publishes against the one it seeded, so anything dropped
 * here can never match again. Narrowing this to the five identity fields is what made the host's
 * comparison unsatisfiable: the guest could not echo an `environment` it was never given.
 */
function validateContext(value) {
    exactKeys(value, CONTEXT_KEYS, "baseline seed context");
    if (value.schemaVersion !== SCHEMA_VERSION) throw new TypeError("baseline seed context schema differs");
    exactString(value.repository, /^[0-9A-Za-z._-]{1,100}\/[0-9A-Za-z._-]{1,100}$/u, "baseline seed repository");
    exactString(value.sourceSha, /^[0-9a-f]{40}$/u, "baseline seed source SHA");
    exactString(value.eventSha, /^[0-9a-f]{40}$/u, "baseline seed event SHA");
    exactString(value.runId, /^[1-9][0-9]{0,19}$/u, "baseline seed run ID");
    exactString(value.runAttempt, /^[1-9][0-9]{0,9}$/u, "baseline seed run attempt");
    exactString(value.nonce, /^[0-9a-f]{32}$/u, "baseline seed nonce");
    exactKeys(value.environment, ENVIRONMENT_KEYS, "baseline seed environment");
    for (const name of ENVIRONMENT_KEYS)
        exactString(value.environment[name], /^[0-9A-Za-z._-]{1,128}$/u, `baseline seed environment ${name}`);
    return structuredClone(value);
}

function validateInputIdentity(value, maximum, label) {
    exactKeys(value, ["bytes", "sha256"], label);
    decimal(value.bytes, maximum, `${label} bytes`);
    hash(value.sha256, `${label} SHA`);
    return structuredClone(value);
}

function jsonRecord(name, value) {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    if (bytes.length < 2 || bytes.length > MAX_DOCUMENT_BYTES)
        throw new TypeError(`baseline ${name} byte size differs`);
    return {name, bytes: String(bytes.length), sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        bytesBase64: bytes.toString("base64")};
}

export function buildWindowsBaselineGuestSeedDocuments(input) {
    exactKeys(input, ["candidate", "candidateController", "cleanStopController", "context", "cpuidProbe",
        "fixtureBundle", "imageVersion", "manifestSha256"], "baseline seed input");
    const context = validateContext(input.context);
    exactKeys(input.candidate, ["artifactName", "bytes", "sha256", "sourceSha"], "baseline seed candidate");
    if (input.candidate.artifactName !== ARTIFACT_NAME)
        throw new TypeError("baseline seed candidate artifact name differs");
    decimal(input.candidate.bytes, MAX_CANDIDATE_BYTES, "baseline seed candidate bytes");
    hash(input.candidate.sha256, "baseline seed candidate SHA");
    exactString(input.candidate.sourceSha, /^[0-9a-f]{40}$/u, "baseline seed candidate source SHA");
    // The candidate is a different release than the harness that stages this guest; the fixture
    // bundle is stamped with this SHA, so it must never collapse onto the harness context SHA.
    if (input.candidate.sourceSha === context.sourceSha)
        throw new TypeError("baseline seed candidate source SHA differs");
    const candidate = structuredClone(input.candidate);
    const fixture = validateInputIdentity(input.fixtureBundle, MAX_FIXTURE_BYTES, "baseline seed fixture");
    const candidateController = validateInputIdentity(input.candidateController, MAX_CONTROLLER_BYTES,
        "baseline seed candidate controller");
    const cleanStopController = validateInputIdentity(input.cleanStopController, MAX_CONTROLLER_BYTES,
        "baseline seed clean-stop controller");
    /*
     * The CPU floor probe. Stage 3 stages it beside the candidate and the guest must prove the floor
     * from its own measurement, so the executor needs a hashed identity to open rather than a path
     * it guessed from the layout.
     */
    const cpuidProbe = validateInputIdentity(input.cpuidProbe, MAX_PROBE_BYTES, "baseline seed CPUID probe");
    exactString(input.imageVersion, /^[0-9A-Za-z._-]{1,128}$/u, "baseline seed image version");
    hash(input.manifestSha256, "baseline seed manifest SHA");

    const taskRoot = windowsRoot("task", context.nonce);
    const inputRoot = windowsRoot("input", context.nonce);
    const runtimeRoot = windowsRoot("runtime", context.nonce);
    const fixtureIdentity = {path: `${inputRoot}\\fixture-bundle.json`, bytes: fixture.bytes,
        sha256: fixture.sha256};
    const request = {schemaVersion: SCHEMA_VERSION, kind: REQUEST_KIND, profile: PROFILE, qualifying: false,
        context, candidate: {artifactName: candidate.artifactName, path: `${taskRoot}\\MySpeed.exe`,
            sourceSha: candidate.sourceSha, bytes: candidate.bytes, sha256: candidate.sha256},
        fixture: fixtureIdentity,
        paths: {taskRoot, populatedWork: `${taskRoot}\\populated`, resetWork: `${taskRoot}\\reset`},
        scenarios: structuredClone(SCENARIOS)};
    const execution = {schemaVersion: SCHEMA_VERSION, kind: EXECUTION_KIND, sourceSha: context.sourceSha,
        eventSha: context.eventSha, runId: context.runId, runAttempt: context.runAttempt, nonce: context.nonce,
        imageVersion: input.imageVersion, manifestSha256: input.manifestSha256, cpuModel: CPU_MODEL,
        candidateSource: {path: `${inputRoot}\\MySpeed.exe`, bytes: candidate.bytes, sha256: candidate.sha256},
        candidateController: {path: `${runtimeRoot}\\scripts\\qualification\\windows-native-candidate-controller.ps1`,
            bytes: candidateController.bytes, sha256: candidateController.sha256},
        cleanStopController: {path: `${runtimeRoot}\\scripts\\qualification\\windows-clean-stop-controller.ps1`,
            bytes: cleanStopController.bytes, sha256: cleanStopController.sha256},
        cpuidProbe: {path: `${inputRoot}\\cpuid.exe`, bytes: cpuidProbe.bytes, sha256: cpuidProbe.sha256},
        fixtureBundle: fixtureIdentity};
    return Object.freeze({taskRoot, inputRoot, runtimeRoot, request, execution,
        requestRecord: jsonRecord("request.json", request), executionRecord: jsonRecord("execution.json", execution)});
}

export const WINDOWS_BASELINE_GUEST_SEED_DOCUMENT_CONSTANTS = Object.freeze({ARTIFACT_NAME, CPU_MODEL, MAX_CANDIDATE_BYTES,
    MAX_CONTROLLER_BYTES, MAX_DOCUMENT_BYTES, MAX_FIXTURE_BYTES, MAX_PROBE_BYTES, SCENARIOS});

