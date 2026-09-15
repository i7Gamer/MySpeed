/*
 * Synthetic prerequisite evidence for the Windows MSI lifecycle tests.
 *
 * These are the two prerequisites a real run must supply: the sacrificial rollback calibration an
 * earlier hosted run retained, and an executed IFEO containment calibration produced by this run's
 * own disposable guest. The fixture builds documents that the production inspector accepts, so a
 * test that wants a rejection mutates one obligation rather than inventing a shape the inspector
 * never sees in practice.
 *
 * The rollback half is the shape `windows-msi-rollback-calibration.yml` actually retains under
 * `windows-msi-sacrificial-executor-boundary`: a `myspeed-msi-sacrificial-native-calibration` receipt
 * and the `myspeed-owned-job-observed-launch` record beside it. Every default below is a value from
 * the inspected artifact of run 34817703654 attempt 1, including the event SHA that genuinely
 * differs from its source SHA.
 *
 * Nothing here executes anything: these are the retained bytes such producers publish.
 */
import {createHash} from "node:crypto";

const ROLLBACK_WORKFLOW = "windows-msi-rollback-calibration.yml";
const ROLLBACK_ARTIFACT = "windows-msi-sacrificial-executor-boundary";
const ROLLBACK_ARTIFACT_ID = "10337212686";
const ROLLBACK_ARTIFACT_BYTES = "3069";
const ROLLBACK_ARTIFACT_DIGEST = "sha256:b3cf1edcea84b084625622073e129d9f3156bb4dd9b8f6553ec7fed80d5c6fab";
const ROLLBACK_RUN_ID = "34817703654";
const ROLLBACK_RUN_ATTEMPT = "1";
const ROLLBACK_SOURCE_SHA = "92f0ff3eab126271548684a5384c7b2ff2213655";
const ROLLBACK_EVENT_SHA = "0a85c86194d74164b50f9a64bcd3a4213f6b60da";
const ROLLBACK_NONCE = "4c4d25645801462792f17a660934e138";
const PREDECESSOR_PAYLOAD_SHA = "d3007b3e85e42d36018e4a1231a6eff90fa4b7fbb898d215fadf2fdd809081de";
const SECURITY_DESCRIPTOR_SHA = "d8085e6ae4eb507bd388f4387d85b4403ba985fed7754cb3bc8f540bf4b9242a";
const POWERSHELL_SHA = "f1f0ba58b157a1e4509d67f49266be9c94c463636c76d368e375a235cbaeee1d";
const AUTHENTIC_OLD_BINDING = "authentic-1.6.0-default-msi";

/* The observed post-`RemoveExistingProducts` write failure the calibration is built around. */
const OBSERVED_INSTALL_RETURN_CODE = 1603;
/* The producer's "product is absent" state. */
const ABSENT_PRODUCT_STATE = -1;
/* An ordinary installed-product state, as the predecessor reports it after the rollback. */
const INSTALLED_PRODUCT_STATE = 5;

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

const retain = value => {
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    return {bytes: String(bytes.length), sha256: sha256(bytes), bytesBase64: bytes.toString("base64")};
};

export const createWindowsMsiRollbackCallbackTimeline = (overrides = {}) => ({Failure: null,
    FailureStage: null, FailureNativeErrorCode: null, CleanupFailure: null, CleanupFailureStage: null,
    CleanupFailureNativeErrorCode: null, RemovalStartSeen: true, RemovalProductSeen: true,
    InstallFilesSeen: true, DenyInjectionAttempted: true, InstallDataSeen: true, ErrorSeen: true,
    InstallFilesStartCount: 2, DenyReproofCount: 1, SecurityRestoredBeforeCancel: true,
    ErrorResponse: 2, ErrorCode: 1310, ErrorSystemCode: 0, InstallContextBalanced: true,
    Records: [{MessageTypeCode: 134_217_728, Fields: ["INSTALL", "", ""], Field1Integer: null},
        {MessageTypeCode: 436_207_616, Fields: ["MySpeed rollback sacrificial candidate"],
            Field1Integer: null}], ...overrides});

export const createWindowsMsiRollbackNativeState = (overrides = {}) => ({PredecessorInstallReturn: 0,
    CandidateInstallReturn: OBSERVED_INSTALL_RETURN_CODE, PredecessorUninstallReturn: 0,
    CandidateUninstallReturn: 0, PredecessorAfterRollback: INSTALLED_PRODUCT_STATE,
    CandidateAfterRollback: ABSENT_PRODUCT_STATE, PredecessorAfterCleanup: ABSENT_PRODUCT_STATE,
    CandidateAfterCleanup: ABSENT_PRODUCT_STATE, postReturnStateObserved: true,
    predecessorPayloadRestored: true, candidateAbsent: true, sentinelPreserved: true,
    sentinelBytesPreserved: true, securityRestored: true, accepted: true,
    predecessorPayloadSha256: PREDECESSOR_PAYLOAD_SHA, directoryIdentity: "d6f2a281:000a0000000466a1",
    directoryFinalPath: `C:\\ProgramData\\MyspeedRollback-${ROLLBACK_NONCE}`,
    securityDescriptorBeforeSha256: SECURITY_DESCRIPTOR_SHA,
    securityDescriptorAfterSha256: SECURITY_DESCRIPTOR_SHA, primaryFailure: null, cleanupFailures: [],
    Callback: createWindowsMsiRollbackCallbackTimeline(), ...overrides});

export const createWindowsMsiRollbackCalibrationDocument = (overrides = {}) => ({schemaVersion: 1,
    kind: "myspeed-msi-sacrificial-native-calibration", status: "observed", qualifying: false,
    nativeExecutionAttempted: true, failureCategory: null, sourceSha: ROLLBACK_SOURCE_SHA,
    eventSha: ROLLBACK_EVENT_SHA, runId: ROLLBACK_RUN_ID, runAttempt: ROLLBACK_RUN_ATTEMPT,
    nonce: ROLLBACK_NONCE, result: createWindowsMsiRollbackNativeState(), releaseGatesCleared: [],
    ...overrides});

export const createWindowsMsiOwnedLaunchDocument = (overrides = {}) => ({schemaVersion: 1,
    kind: "myspeed-owned-job-observed-launch", status: "completed", authorizesTransfer: false,
    executable: {path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        expectedSha256: POWERSHELL_SHA, beforeSha256: POWERSHELL_SHA, afterSha256: POWERSHELL_SHA},
    process: {processId: 3008, assignedBeforeResume: true, resumed: true,
        retainedHandleThroughExit: true},
    arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
        "D:\\a\\_temp\\msi-rollback-calibration-closure\\windows-msi-rollback-native.ps1",
        "-Mode", "InvokeHostedCalibration", "-InputJson", JSON.stringify({runId: ROLLBACK_RUN_ID,
            runAttempt: "1", eventSha: ROLLBACK_EVENT_SHA, sourceSha: ROLLBACK_SOURCE_SHA,
            nonce: ROLLBACK_NONCE})],
    timedOut: false, forced: false, exitCode: 0, processTreeExitProven: true,
    handles: {job: "closed", process: "closed", thread: "closed"}, failure: null, ...overrides});

/*
 * One retained `containment-launch-*.json` record: an IFEO stub interception, which is a blocked
 * launch attempt and never an execution of the old payload.
 */
const DEFAULT_NONCE = "9".repeat(32);

export const createWindowsMsiContainmentLaunchRecord = (processId, overrides = {},
    nonce = DEFAULT_NONCE) => ({
    schemaVersion: 1, kind: "myspeed-windows-msi-guest-containment-launch",
    name: `containment-launch-${nonce}-${processId}.json`, bytes: "118",
    sha256: sha256(Buffer.from(`containment-launch-${processId}`, "utf8")), processId,
    intercepted: true, ...overrides});

/*
 * The digest the containment helper takes over its own ordered listing: the {name,bytes,sha256}
 * tuples, compressed JSON, UTF-8 without a BOM. The fixture derives it from the records it builds so
 * that a document it produces is internally consistent the way a real one is.
 */
export const windowsMsiContainmentInventorySha256 = records =>
    sha256(Buffer.from(JSON.stringify(records.map(record =>
        ({name: record.name, bytes: Number(record.bytes), sha256: record.sha256}))), "utf8"));

export const createWindowsMsiContainmentCalibrationDocument = (overrides = {}) => {
    const productCode = overrides.productCode ?? "{0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0}";
    const nonce = overrides.nonce ?? DEFAULT_NONCE;
    const launchRecords = overrides.launchRecords
        ?? [createWindowsMsiContainmentLaunchRecord(2140, {}, nonce)];
    /* A history that is not a list at all is left for the consumer itself to refuse. */
    const inventory = overrides.launchInventorySha256 ?? (Array.isArray(launchRecords)
        ? windowsMsiContainmentInventorySha256(launchRecords) : sha256(Buffer.from("[]", "utf8")));
    const {launchInventorySha256: _inventory, ...rest} = overrides;
    return {schemaVersion: 1, kind: "myspeed-windows-msi-guest-containment-calibration", qualifying: false,
        releaseGatesCleared: [], bindingId: AUTHENTIC_OLD_BINDING, productCode,
        msiSha256: overrides.msiSha256 ?? "a".repeat(64),
        helperSha256: overrides.helperSha256 ?? "c".repeat(64),
        guestSerial: overrides.guestSerial ?? "7".repeat(32), nonce, launchRecords,
        install: {status: "completed", mode: "Install", productCode, ifeoActive: true,
            oldPayloadExecutionCount: 0, registryRestored: false, launchInventorySha256: inventory},
        remove: {status: "completed", mode: "Remove", productCode, ifeoActive: false,
            oldPayloadExecutionCount: 0, registryRestored: true, launchInventorySha256: inventory},
        ...rest};
};

export const createWindowsMsiPrerequisiteEvidenceFixture = ({context, rollbackDocument, containmentDocument,
    launchDocument, rollbackProvenance, containmentProvenance} = {}) => {
    if (!context) throw new TypeError("prerequisite evidence fixture needs an execution context");
    const rollbackValue = rollbackDocument ?? createWindowsMsiRollbackCalibrationDocument();
    const guestSerial = containmentProvenance?.guestSerial
        ?? sha256(Buffer.from(`${context.nonce}\0containment`)).slice(0, 32);
    const containmentValue = containmentDocument
        ?? createWindowsMsiContainmentCalibrationDocument({guestSerial, nonce: context.nonce});
    const launchValue = launchDocument ?? createWindowsMsiOwnedLaunchDocument();
    const rollbackCalibration = {schemaVersion: 1, kind: "myspeed-windows-msi-prerequisite-evidence",
        prerequisiteId: "msi-api-rollback-controller", producer: "hosted-run-artifact",
        provenance: {repository: context.repository, workflow: ROLLBACK_WORKFLOW,
            runId: ROLLBACK_RUN_ID, runAttempt: ROLLBACK_RUN_ATTEMPT, sourceSha: ROLLBACK_SOURCE_SHA,
            eventSha: ROLLBACK_EVENT_SHA, artifactId: ROLLBACK_ARTIFACT_ID,
            artifactName: ROLLBACK_ARTIFACT, artifactBytes: ROLLBACK_ARTIFACT_BYTES,
            artifactDigest: ROLLBACK_ARTIFACT_DIGEST, officialArtifactDigest: ROLLBACK_ARTIFACT_DIGEST,
            ...rollbackProvenance},
        document: retain(rollbackValue), launch: retain(launchValue)};
    const oldContainment = {schemaVersion: 1, kind: "myspeed-windows-msi-prerequisite-evidence",
        prerequisiteId: "authentic-old-ifeo-containment", producer: "in-guest-calibration",
        provenance: {repository: context.repository, sourceSha: context.sourceSha,
            eventSha: context.eventSha, runId: context.runId, runAttempt: context.runAttempt,
            nonce: context.nonce, guestSerial, ...containmentProvenance},
        document: retain(containmentValue)};
    return {rollbackCalibration, oldContainment,
        rollbackCalibrationSha256: rollbackCalibration.document.sha256,
        oldContainmentSha256: oldContainment.document.sha256};
};
