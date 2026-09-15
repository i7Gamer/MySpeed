const MATRIX_SCHEMA_VERSION = 1;
const MATRIX_KIND = "myspeed-windows-msi-lifecycle-matrix-contract";
const MATRIX_STATUS = "unimplemented";
const UPGRADE_CODE = "A1B2C3D4-5E6F-7890-ABCD-EF1234567890";
const RUNTIME_BOUND = "runtime-bound";
const INSPECT_AND_BIND = "inspect-and-bind";

const CANDIDATE_BINDINGS = {
    releaseVersion: RUNTIME_BOUND,
    windowsStamp: RUNTIME_BOUND,
    upgradeCode: UPGRADE_CODE,
    default: {
        msi: {
            actionsArtifact: "release-msi-MySpeed-installer.msi",
            innerFile: "MySpeed-installer.msi",
            releaseAsset: "MySpeed-installer.msi",
            productCode: INSPECT_AND_BIND,
            sha256: INSPECT_AND_BIND
        },
        executable: {
            actionsArtifact: "MySpeed-windows-x64.exe",
            innerFile: "MySpeed.exe",
            releaseAsset: "MySpeed-windows-x64.exe",
            installedFile: "MySpeed.exe",
            sha256: INSPECT_AND_BIND
        }
    },
    baseline: {
        msi: {
            actionsArtifact: "release-msi-MySpeed-installer-baseline.msi",
            innerFile: "MySpeed-installer.msi",
            releaseAsset: "MySpeed-installer-baseline.msi",
            productCode: INSPECT_AND_BIND,
            sha256: INSPECT_AND_BIND
        },
        executable: {
            actionsArtifact: "MySpeed-windows-x64-baseline.exe",
            innerFile: "MySpeed.exe",
            releaseAsset: "MySpeed-windows-x64-baseline.exe",
            installedFile: "MySpeed.exe",
            sha256: INSPECT_AND_BIND
        }
    }
};

const EXTERNAL_BINDINGS = [
    "lower-stamp-fixture",
    "safe-rollback-predecessor",
    "authentic-1.6.0-default-msi",
    "authentic-1.6.0-baseline-msi",
    "authentic-1.1.0-msi"
];

const SHARED_PREREQUISITES = [
    "fresh-disposable-environment",
    "exact-artifact-product-and-payload-identities",
    "offline-boundary",
    "service-oracle",
    "synthetic-data-only",
    "complete-owned-cleanup"
];

const STANDARD_PREREQUISITES = ["offline-boundary", "service-oracle"];
const AUTHENTIC_PREREQUISITES = [
    ...STANDARD_PREREQUISITES,
    "historical-launch-role-inventory",
    "authentic-old-ifeo-containment"
];

const scenario = (id, from, to, operations, expectedOutcome, prerequisites = STANDARD_PREREQUISITES,
    blocking = true) => ({
    id,
    blocking,
    freshEnvironment: true,
    from,
    to,
    operations,
    prerequisites,
    expectedOutcome
});

const SCENARIOS = [
    scenario("clean-default", "empty", "candidate-default",
        ["install-candidate", "seed-data", "run-oracle", "restart-service-and-run-oracle", "cleanup"],
        "candidate-default-installed-and-healthy"),
    scenario("clean-baseline", "empty", "candidate-baseline",
        ["install-candidate", "seed-data", "run-oracle", "restart-service-and-run-oracle", "cleanup"],
        "candidate-baseline-installed-and-healthy"),
    scenario("swap-default-to-baseline", "candidate-default", "candidate-baseline",
        ["install-source", "seed-data", "install-target", "verify-sole-related-product", "run-oracle", "cleanup"],
        "baseline-replaces-default-and-preserves-data"),
    scenario("swap-baseline-to-default", "candidate-baseline", "candidate-default",
        ["install-source", "seed-data", "install-target", "verify-sole-related-product", "run-oracle", "cleanup"],
        "default-replaces-baseline-and-preserves-data"),
    scenario("lower-stamp-promotion", "lower-stamp-fixture", "candidate-default",
        ["install-fixture", "seed-data", "install-candidate", "verify-higher-stamp", "run-oracle", "cleanup"],
        "higher-stamp-candidate-replaces-fixture"),
    scenario("higher-to-lower-stamp-diagnostic", "candidate-default", "lower-stamp-fixture",
        ["install-candidate", "seed-data", "install-lower-stamp-fixture", "record-product-file-service-and-data-state",
            "cleanup"],
        "record-observed-lower-stamp-behavior-without-policy-claim", STANDARD_PREREQUISITES, false),
    scenario("repair-executable", "candidate-default-with-damaged-executable", "candidate-default",
        ["install-candidate", "seed-data", "stop-service", "damage-owned-executable", "force-repair-executable",
            "run-oracle", "cleanup"],
        "exact-executable-restored-with-data-and-service-configuration-intact"),
    scenario("repair-configuration", "candidate-default-with-damaged-configuration", "candidate-default",
        ["install-candidate", "seed-data", "stop-service", "damage-owned-configuration", "repair-configuration",
            "run-oracle", "cleanup"],
        "exact-configuration-restored-and-service-healthy"),
    scenario("transaction-rollback", "safe-rollback-predecessor", "candidate-default",
        ["install-predecessor", "seed-data", "inject-post-removal-failure", "verify-rollback",
            "restart-and-run-oracle", "cleanup"],
        "candidate-install-fails-and-predecessor-is-restored",
        [...STANDARD_PREREQUISITES, "msi-api-rollback-controller", "sacrificial-rollback-trigger"]),
    scenario("uninstall-reinstall", "candidate-default", "candidate-baseline",
        ["install-source", "seed-data", "uninstall-source", "verify-product-service-and-program-files-removed",
            "install-target", "run-oracle-with-preserved-data", "cleanup"],
        "uninstall-removes-owned-installation-and-reinstall-preserves-data"),
    scenario("authentic-1-6-0-default", "authentic-1.6.0-default-msi", "candidate-default",
        ["install-contained-predecessor", "seed-data", "install-candidate", "remove-containment",
            "run-candidate-oracle", "cleanup"],
        "candidate-replaces-authentic-default-without-old-application-execution", AUTHENTIC_PREREQUISITES),
    scenario("authentic-1-6-0-baseline", "authentic-1.6.0-baseline-msi", "candidate-baseline",
        ["install-contained-predecessor", "seed-data", "install-candidate", "remove-containment",
            "run-candidate-oracle", "cleanup"],
        "candidate-replaces-authentic-baseline-without-old-application-execution", AUTHENTIC_PREREQUISITES),
    scenario("authentic-1-1-0-migration", "authentic-1.1.0-msi", "candidate-default",
        ["install-contained-predecessor", "seed-legacy-data", "install-candidate", "verify-one-time-migration",
            "remove-containment", "run-candidate-oracle", "cleanup"],
        "legacy-data-copied-once-and-protected", AUTHENTIC_PREREQUISITES),
    scenario("legacy-no-overwrite", "authentic-1.1.0-msi-with-destination-data", "candidate-default",
        ["install-contained-predecessor", "seed-legacy-and-destination-sentinels", "install-candidate",
            "verify-destination-not-overwritten", "remove-containment", "run-candidate-oracle", "cleanup"],
        "preexisting-destination-data-remains-authoritative", AUTHENTIC_PREREQUISITES)
];

const TEMPLATE = {
    schemaVersion: MATRIX_SCHEMA_VERSION,
    kind: MATRIX_KIND,
    status: MATRIX_STATUS,
    qualifying: false,
    releaseGatesCleared: [],
    candidateBindings: CANDIDATE_BINDINGS,
    externalBindings: EXTERNAL_BINDINGS,
    sharedPrerequisites: SHARED_PREREQUISITES,
    scenarios: SCENARIOS
};

const copy = value => JSON.parse(JSON.stringify(value));

const assertExact = (actual, expected, label) => {
    if (Array.isArray(expected)) {
        if (!Array.isArray(actual) || actual.length !== expected.length)
            throw new Error(`${label} matrix contract differs`);
        for (let index = 0; index < expected.length; index++)
            assertExact(actual[index], expected[index], `${label}[${index}]`);
        return;
    }
    if (expected !== null && typeof expected === "object") {
        if (actual === null || typeof actual !== "object" || Array.isArray(actual))
            throw new Error(`${label} matrix contract differs`);
        const actualKeys = Object.keys(actual).sort();
        const expectedKeys = Object.keys(expected).sort();
        if (actualKeys.length !== expectedKeys.length ||
            actualKeys.some((key, index) => key !== expectedKeys[index]))
            throw new Error(`${label} matrix contract differs`);
        for (const key of expectedKeys) assertExact(actual[key], expected[key], `${label}.${key}`);
        return;
    }
    if (typeof actual !== typeof expected || !Object.is(actual, expected))
        throw new Error(`${label} matrix contract differs`);
};

export const createWindowsMsiMatrixContract = () => copy(TEMPLATE);

export const validateWindowsMsiMatrixContract = value => {
    assertExact(value, TEMPLATE, "Windows MSI");
    return {accepted: true};
};
