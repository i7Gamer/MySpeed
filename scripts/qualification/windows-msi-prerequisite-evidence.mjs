/*
 * Prerequisite evidence for the post-release Windows MSI lifecycle matrix.
 *
 * The matrix contract names prerequisites that a row is not allowed to assume: `transaction-rollback`
 * needs `msi-api-rollback-controller`, and the four authentic-predecessor rows need
 * `authentic-old-ifeo-containment`. Both used to reach the row request as bare 64-character
 * hexadecimal strings that any value satisfied, which proved nothing about an execution having
 * happened. A SHA-256 of the helper that would do the work proves even less: it is code provenance,
 * and the helper is already pinned separately in the guest closure.
 *
 * What a prerequisite carries instead is the producer's own retained document: its exact bytes, the
 * digest recomputed from those bytes, the typed identity of the producing run, and a replay of the
 * acceptance semantics the producer published. The digest the row request carries is then the digest
 * of evidence that was inspected here, and an independent consumer holding the same retained bytes
 * reaches the same conclusion without trusting anybody's `accepted` flag.
 *
 * Two producer roles exist, and they are not interchangeable. A hosted-run artifact was produced by
 * an earlier hosted run at its own commit - historical provenance, deliberately not required to equal
 * the execution run. An in-guest calibration only means anything if this run's disposable guest
 * produced it, so its provenance is pinned to the execution context.
 *
 * The rollback prerequisite is satisfied by the documents `windows-msi-rollback-calibration.yml`
 * actually retains under `windows-msi-sacrificial-executor-boundary`: the native calibration receipt
 * and the owned-launch record beside it, both unreshaped. Its inspectors are PowerShell that this
 * Linux consumer cannot run, so what is replayed here is every obligation that producer publishes -
 * the rollback and restoration state, the cleanup state, the raw callback timeline and the owned
 * process exit - rather than its `accepted` flag, which the producer computes from only three of
 * them. The receipt's own event SHA differs from its source SHA; that is the historical contract and
 * it is bound as such, not forced to the same-SHA shape a current run happens to have.
 */
import {createHash} from "node:crypto";

const SCHEMA_VERSION = 1;
const RECORD_KIND = "myspeed-windows-msi-prerequisite-evidence";
const ROLLBACK_DOCUMENT_KIND = "myspeed-msi-sacrificial-native-calibration";
const ROLLBACK_LAUNCH_KIND = "myspeed-owned-job-observed-launch";
const ROLLBACK_WORKFLOW = "windows-msi-rollback-calibration.yml";
const ROLLBACK_ARTIFACT_NAME = "windows-msi-sacrificial-executor-boundary";
const MAX_ROLLBACK_LAUNCH_BYTES = 65_536;
const MAX_CALLBACK_RECORDS = 4_096;
const CONTAINMENT_DOCUMENT_KIND = "myspeed-windows-msi-guest-containment-calibration";
const HOSTED_PRODUCER = "hosted-run-artifact";
const GUEST_PRODUCER = "in-guest-calibration";
const MAX_ROLLBACK_DOCUMENT_BYTES = 262_144;
const MAX_CONTAINMENT_DOCUMENT_BYTES = 65_536;
const AUTHENTIC_OLD_BINDING = "authentic-1.6.0-default-msi";

/*
 * The sacrificial candidate returns 1602 for the cancelled install and 1603 for the observed
 * post-`RemoveExistingProducts` write failure; `windows-msi-rollback-native.ps1` accepts exactly
 * these two. Any other return code means the calibrated failure was not the one that happened.
 */
const ACCEPTED_INSTALL_RETURN_CODES = Object.freeze([1602, 1603]);

/* `-1` is the producer's "product is absent" state; anything else is an installed product state. */
const ABSENT_PRODUCT_STATE = -1;

const SHA256 = /^[0-9a-f]{64}$/u;
const SHA1 = /^[0-9a-f]{40}$/u;
const NONCE = /^[0-9a-f]{32}$/u;
const DECIMAL = /^[1-9][0-9]{0,19}$/u;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/u;
const WORKFLOW = /^[A-Za-z0-9._-]{1,128}\.ya?ml$/u;
const ARTIFACT_NAME = /^[A-Za-z0-9._-]{1,128}$/u;
const ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const PRODUCT_CODE = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/u;
/*
 * The helper enumerates exactly `containment-launch-<nonce>-*.json`. A record named by any other run
 * is not part of this calibration's history, and would not be part of the digest the helper took.
 */
const launchRecordNamePattern = nonce =>
    new RegExp(`^containment-launch-${nonce}-[0-9A-Za-z-]{1,64}\\.json$`, "u");

export const WINDOWS_MSI_PREREQUISITE_PRODUCERS = Object.freeze([HOSTED_PRODUCER, GUEST_PRODUCER]);

export const WINDOWS_MSI_PREREQUISITE_CONTRACTS = Object.freeze({
    rollbackCalibration: Object.freeze({
        prerequisiteId: "msi-api-rollback-controller",
        documentKind: ROLLBACK_DOCUMENT_KIND,
        launchKind: ROLLBACK_LAUNCH_KIND,
        workflow: ROLLBACK_WORKFLOW,
        artifactName: ROLLBACK_ARTIFACT_NAME,
        producer: HOSTED_PRODUCER,
        maximumBytes: MAX_ROLLBACK_DOCUMENT_BYTES,
        maximumLaunchBytes: MAX_ROLLBACK_LAUNCH_BYTES,
        digestField: "rollbackCalibrationSha256"
    }),
    oldContainment: Object.freeze({
        prerequisiteId: "authentic-old-ifeo-containment",
        documentKind: CONTAINMENT_DOCUMENT_KIND,
        producer: GUEST_PRODUCER,
        maximumBytes: MAX_CONTAINMENT_DOCUMENT_BYTES,
        digestField: "oldContainmentSha256"
    })
});

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

const exactKeys = (value, expected, label) => {
    if (!isObject(value)) throw new TypeError(`${label} differs`);
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
        throw new TypeError(`${label} differs`);
    return value;
};

const exactString = (value, label, pattern) => {
    if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} differs`);
    return value;
};

const bool = (value, expected, label) => {
    if (typeof value !== "boolean" || value !== expected) throw new Error(`${label} differs`);
    return value;
};

const emptyArray = (value, label) => {
    if (!Array.isArray(value) || value.length !== 0) throw new Error(`${label} differs`);
    return value;
};

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

/*
 * Base64 decoding is lenient enough to accept text that never encoded these bytes, so the decoded
 * buffer is re-encoded and compared before anything else is believed about it. The length and the
 * digest are then recomputed from that buffer rather than read from the record.
 */
const decodeDocument = (value, maximumBytes, label) => {
    exactKeys(value, ["bytes", "sha256", "bytesBase64"], `${label} document identity`);
    exactString(value.sha256, `${label} document identity`, SHA256);
    exactString(value.bytes, `${label} document identity`, /^[0-9]{1,10}$/u);
    if (typeof value.bytesBase64 !== "string" || value.bytesBase64.length > maximumBytes * 2)
        throw new TypeError(`${label} document identity differs`);
    const bytes = Buffer.from(value.bytesBase64, "base64");
    if (bytes.toString("base64") !== value.bytesBase64)
        throw new Error(`${label} document identity differs`);
    if (bytes.length < 1 || bytes.length > maximumBytes)
        throw new Error(`${label} document identity exceeded its bound`);
    if (String(bytes.length) !== value.bytes || sha256(bytes) !== value.sha256)
        throw new Error(`${label} document identity differs`);
    let parsed;
    try { parsed = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)); }
    catch { throw new Error(`${label} document identity differs`); }
    if (!isObject(parsed)) throw new Error(`${label} document identity differs`);
    return {bytes, parsed, sha256: value.sha256};
};

const assertExecutionContext = value => {
    exactKeys(value, ["repository", "sourceSha", "eventSha", "runId", "runAttempt", "nonce"],
        "Prerequisite execution context");
    exactString(value.repository, "Prerequisite execution context repository", REPOSITORY);
    exactString(value.sourceSha, "Prerequisite execution context source SHA-1", SHA1);
    exactString(value.eventSha, "Prerequisite execution context event SHA-1", SHA1);
    exactString(value.runId, "Prerequisite execution context run", DECIMAL);
    exactString(value.runAttempt, "Prerequisite execution context attempt", /^[1-9][0-9]{0,9}$/u);
    exactString(value.nonce, "Prerequisite execution context nonce", NONCE);
    return value;
};

/*
 * A hosted producer ran before this one, at its own commit. Requiring its run to equal the execution
 * run would make every prerequisite unsatisfiable; requiring nothing would accept an artifact from
 * any repository. What is required is the repository, a pinned artifact identity and the authenticated
 * archive digest the platform reported for it.
 */
const assertHostedProvenance = (value, context, contract, label) => {
    exactKeys(value, ["repository", "workflow", "runId", "runAttempt", "sourceSha", "eventSha",
        "artifactId", "artifactName", "artifactBytes", "artifactDigest", "officialArtifactDigest"],
    `${label} provenance`);
    if (value.repository !== context.repository)
        throw new Error(`${label} provenance repository differs`);
    exactString(value.workflow, `${label} provenance workflow`, WORKFLOW);
    if (value.workflow !== contract.workflow)
        throw new Error(`${label} provenance names a different producing workflow`);
    exactString(value.runId, `${label} provenance run`, DECIMAL);
    exactString(value.runAttempt, `${label} provenance attempt`, /^[1-9][0-9]{0,9}$/u);
    exactString(value.sourceSha, `${label} provenance source SHA-1`, SHA1);
    /*
     * The historical producer's event SHA is its own; it is bound, never required to equal its source
     * SHA and never replaced by this run's.
     */
    exactString(value.eventSha, `${label} provenance event SHA-1`, SHA1);
    exactString(value.artifactId, `${label} provenance artifact`, DECIMAL);
    exactString(value.artifactName, `${label} provenance artifact name`, ARTIFACT_NAME);
    if (value.artifactName !== contract.artifactName)
        throw new Error(`${label} provenance names a different producer artifact`);
    exactString(value.artifactBytes, `${label} provenance artifact size`, DECIMAL);
    exactString(value.artifactDigest, `${label} provenance artifact digest`, ARTIFACT_DIGEST);
    /*
     * A pin the dispatch supplied cannot authenticate itself. The acquisition step records what the
     * platform reported for this artifact, and the two have to be the same value.
     */
    exactString(value.officialArtifactDigest, `${label} provenance official artifact digest`,
        ARTIFACT_DIGEST);
    if (value.officialArtifactDigest !== value.artifactDigest)
        throw new Error(`${label} provenance artifact digest differs from the platform digest`);
    return value;
};

const assertGuestProvenance = (value, context, label) => {
    exactKeys(value, ["repository", "sourceSha", "eventSha", "runId", "runAttempt", "nonce",
        "guestSerial"], `${label} provenance`);
    exactString(value.guestSerial, `${label} provenance guest serial`, NONCE);
    for (const name of ["repository", "sourceSha", "eventSha", "runId", "runAttempt", "nonce"])
        if (value[name] !== context[name])
            throw new Error(`${label} provenance differs from the execution context`);
    return value;
};

const integerIn = (value, label, accepted) => {
    if (!Number.isInteger(value) || !accepted.includes(value)) throw new Error(`${label} differs`);
    return value;
};

const integerAtLeast = (value, label, minimum) => {
    if (!Number.isInteger(value) || value < minimum) throw new Error(`${label} differs`);
    return value;
};

/*
 * The producer's own callback timeline. Every obligation below is one `windows-msi-rollback-native.ps1`
 * records while MSI is running the rollback, and the raw `Records` array travels with the document so
 * a consumer can read the timeline rather than take this summary's word for it.
 */
const replayCallbackTimeline = (callback, label) => {
    if (!isObject(callback)) throw new Error(`${label} callback evidence differs`);
    for (const name of ["Failure", "FailureStage", "FailureNativeErrorCode", "CleanupFailure",
        "CleanupFailureStage", "CleanupFailureNativeErrorCode"])
        if (callback[name] !== null) throw new Error(`${label} callback ${name} differs`);
    for (const name of ["RemovalStartSeen", "RemovalProductSeen", "InstallFilesSeen",
        "DenyInjectionAttempted", "InstallDataSeen", "ErrorSeen", "SecurityRestoredBeforeCancel",
        "InstallContextBalanced"])
        bool(callback[name], true, `${label} callback ${name}`);
    integerAtLeast(callback.InstallFilesStartCount, `${label} callback install-files starts`, 1);
    integerAtLeast(callback.DenyReproofCount, `${label} callback deny reproofs`, 1);
    integerAtLeast(callback.ErrorResponse, `${label} callback error response`, 0);
    integerAtLeast(callback.ErrorCode, `${label} callback error code`, 0);
    if (callback.ErrorSystemCode !== 0) throw new Error(`${label} callback system error differs`);
    if (!Array.isArray(callback.Records) || callback.Records.length < 1
        || callback.Records.length > MAX_CALLBACK_RECORDS)
        throw new Error(`${label} callback record timeline differs`);
    return callback.Records.length;
};

/*
 * The rollback and restoration state. `accepted` is only "no primary failure, no cleanup failure,
 * security restored", so it is checked and then set aside: what proves a rollback happened is the
 * predecessor surviving, the candidate being gone, the sentinel intact and the security descriptor
 * hashing the same before and after.
 */
const replayNativeRollbackState = (state, label) => {
    if (!isObject(state)) throw new Error(`${label} native state differs`);
    bool(state.accepted, true, `${label} acceptance`);
    bool(state.securityRestored, true, `${label} security restoration`);
    if (state.primaryFailure !== null) throw new Error(`${label} primary failure differs`);
    emptyArray(state.cleanupFailures, `${label} cleanup failures`);
    integerIn(state.CandidateInstallReturn, `${label} candidate install return`,
        ACCEPTED_INSTALL_RETURN_CODES);
    for (const name of ["PredecessorInstallReturn", "PredecessorUninstallReturn",
        "CandidateUninstallReturn"])
        integerIn(state[name], `${label} ${name}`, [0]);
    /* The rollback left the authentic predecessor installed and the sacrificial candidate absent. */
    if (!Number.isInteger(state.PredecessorAfterRollback)
        || state.PredecessorAfterRollback === ABSENT_PRODUCT_STATE)
        throw new Error(`${label} predecessor state after rollback differs`);
    integerIn(state.CandidateAfterRollback, `${label} candidate state after rollback`,
        [ABSENT_PRODUCT_STATE]);
    /* Cleanup removed both, so the guest is left with neither product. */
    for (const name of ["PredecessorAfterCleanup", "CandidateAfterCleanup"])
        integerIn(state[name], `${label} ${name}`, [ABSENT_PRODUCT_STATE]);
    for (const name of ["postReturnStateObserved", "predecessorPayloadRestored", "candidateAbsent",
        "sentinelPreserved", "sentinelBytesPreserved"])
        bool(state[name], true, `${label} ${name}`);
    exactString(state.predecessorPayloadSha256, `${label} predecessor payload digest`, SHA256);
    exactString(state.securityDescriptorBeforeSha256, `${label} security descriptor before`, SHA256);
    exactString(state.securityDescriptorAfterSha256, `${label} security descriptor after`, SHA256);
    if (state.securityDescriptorBeforeSha256 !== state.securityDescriptorAfterSha256)
        throw new Error(`${label} security descriptor changed across the calibration`);
    return {callbackRecordCount: replayCallbackTimeline(state.Callback, label),
        securityRestoredBeforeCancel: true};
};

/*
 * The launch record beside the receipt. The producing workflow refuses a calibration whose process
 * was not assigned, resumed and held to a proven tree exit, so the consumer replays exactly that
 * rather than accepting a receipt no owned process is known to have written.
 */
const replayOwnedLaunch = (parsed, label) => {
    if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.kind !== ROLLBACK_LAUNCH_KIND
        || parsed.status !== "completed")
        throw new Error(`${label} owned launch identity differs`);
    bool(parsed.authorizesTransfer, false, `${label} owned launch transfer authority`);
    bool(parsed.timedOut, false, `${label} owned launch timeout`);
    bool(parsed.forced, false, `${label} owned launch termination`);
    bool(parsed.processTreeExitProven, true, `${label} owned launch process tree exit`);
    integerIn(parsed.exitCode, `${label} owned launch exit code`, [0]);
    if (parsed.failure !== null) throw new Error(`${label} owned launch failure differs`);
    if (!isObject(parsed.process)) throw new Error(`${label} owned launch process differs`);
    for (const name of ["assignedBeforeResume", "resumed", "retainedHandleThroughExit"])
        bool(parsed.process[name], true, `${label} owned launch ${name}`);
    if (!isObject(parsed.handles)) throw new Error(`${label} owned launch handles differ`);
    for (const name of ["job", "process", "thread"])
        if (parsed.handles[name] !== "closed")
            throw new Error(`${label} owned launch ${name} handle differs`);
    if (!isObject(parsed.executable)) throw new Error(`${label} owned launch executable differs`);
    for (const name of ["expectedSha256", "beforeSha256", "afterSha256"])
        exactString(parsed.executable[name], `${label} owned launch executable ${name}`, SHA256);
    if (parsed.executable.beforeSha256 !== parsed.executable.expectedSha256
        || parsed.executable.afterSha256 !== parsed.executable.expectedSha256)
        throw new Error(`${label} owned launch executable changed across the calibration`);
    return {exitCode: parsed.exitCode, processTreeExitProven: true,
        launched: replayLaunchVector(parsed.arguments, label)};
};

/*
 * The vector the producer was actually started with. The document it names is where the producer
 * wrote down its own execution context, so it is a second, independent statement of the run this
 * evidence belongs to - and the one place the event SHA exists at all, since the run API reports
 * only the head. Exactly one input document may be named, or which one ran is not established.
 */
const replayLaunchVector = (values, label) => {
    if (!Array.isArray(values)
        || values.filter(value => value === LAUNCH_INPUT_FLAG).length !== 1)
        throw new Error(`${label} launch vector does not name exactly one input document`);
    const document = values[values.indexOf(LAUNCH_INPUT_FLAG) + 1];
    if (typeof document !== "string" || document.length < 1 || document.length > MAX_ROLLBACK_LAUNCH_BYTES)
        throw new Error(`${label} launch vector does not name exactly one input document`);
    let launched;
    try { launched = JSON.parse(document); }
    catch { throw new Error(`${label} launch vector input document differs`); }
    if (!isObject(launched)) throw new Error(`${label} launch vector input document differs`);
    return launched;
};

const replayRollbackCalibration = (parsed, provenance, launch) => {
    const label = "Rollback calibration";
    if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.kind !== ROLLBACK_DOCUMENT_KIND
        || parsed.status !== "observed")
        throw new Error(`${label} evidence identity differs`);
    bool(parsed.qualifying, false, `${label} qualifying flag`);
    bool(parsed.nativeExecutionAttempted, true, `${label} native execution`);
    if (parsed.failureCategory !== null) throw new Error(`${label} failure category differs`);
    emptyArray(parsed.releaseGatesCleared, `${label} cleared gates`);
    exactString(parsed.nonce, `${label} producer nonce`, NONCE);
    /* The receipt has to be the one this provenance names, field for field. */
    for (const name of ["sourceSha", "eventSha", "runId", "runAttempt"])
        if (parsed[name] !== provenance[name])
            throw new Error(`${label} producer ${name} differs from its provenance`);
    const state = replayNativeRollbackState(parsed.result, label);
    const owned = replayOwnedLaunch(launch, label);
    /*
     * The receipt and the launch record are two documents the producer retained side by side. A
     * receipt whose run, attempt or either SHA differs from the vector that started the producer is
     * not the receipt of that launch, however well formed each document is on its own.
     */
    for (const name of ["sourceSha", "eventSha", "runId", "runAttempt", "nonce"])
        if (parsed[name] !== owned.launched[name])
            throw new Error(`${label} launch vector ${name} differs from its receipt`);
    return {accepted: true, nativeExecutionAttempted: true,
        candidateInstallReturn: parsed.result.CandidateInstallReturn,
        predecessorPayloadRestored: true, candidateAbsent: true, sentinelPreserved: true,
        securityRestored: true,
        securityDescriptorSha256: parsed.result.securityDescriptorAfterSha256,
        predecessorPayloadSha256: parsed.result.predecessorPayloadSha256,
        callbackRecordCount: state.callbackRecordCount,
        securityRestoredBeforeCancel: state.securityRestoredBeforeCancel,
        installContextBalanced: true, ownedLaunchExitCode: owned.exitCode,
        processTreeExitProven: owned.processTreeExitProven};
};

const LAUNCH_INPUT_FLAG = "-InputJson";
const CONTAINMENT_LAUNCH_KIND = "myspeed-windows-msi-guest-containment-launch";
const MAX_CONTAINMENT_LAUNCH_RECORDS = 256;

/*
 * The launch history the containment helper's inventory digest is taken over. Each entry is the
 * identity of a retained record - its name, its length and its digest - not its bytes.
 *
 * Every `containment-launch-*.json` record is written by the IFEO *stub*: the stub ran in place of
 * the old payload and exited, so each record is a launch attempt that was blocked. That is the
 * opposite of an execution, and the count of these records must never be written into
 * `oldPayloadExecutionCount` - doing so would report a perfectly contained run as an uncontained
 * one. They are counted separately and returned as their own number.
 *
 * The history has to be present even when it is empty: a hardcoded zero with no retained records
 * behind it is a claim, not a history. A record that says it was not intercepted is the old payload
 * having run, and is refused.
 */
const replayContainmentLaunchHistory = (records, nonce, label) => {
    if (!Array.isArray(records) || records.length > MAX_CONTAINMENT_LAUNCH_RECORDS)
        throw new Error(`${label} launch history differs`);
    const namePattern = launchRecordNamePattern(nonce);
    const seen = new Set();
    for (const record of records) {
        exactKeys(record, ["schemaVersion", "kind", "name", "bytes", "sha256", "processId",
            "intercepted"], `${label} launch record`);
        if (record.schemaVersion !== SCHEMA_VERSION || record.kind !== CONTAINMENT_LAUNCH_KIND)
            throw new Error(`${label} launch record identity differs`);
        exactString(record.name, `${label} launch record name`, namePattern);
        exactString(record.bytes, `${label} launch record size`, DECIMAL);
        exactString(record.sha256, `${label} launch record digest`, SHA256);
        if (!Number.isInteger(record.processId) || record.processId < 1)
            throw new Error(`${label} launch record process differs`);
        bool(record.intercepted, true, `${label} launch record interception`);
        if (seen.has(record.name)) throw new Error(`${label} launch record is duplicated`);
        seen.add(record.name);
    }
    return records.length;
};

/*
 * Containment is only worth anything if the old payload never ran. The calibration retains the
 * helper's own Install and Remove results: the interception must have been active while the
 * authentic predecessor was installed, nothing may have executed under it, and the owned registry
 * state must be gone again afterwards.
 */
const replayContainmentCalibration = (parsed, provenance) => {
    const label = "Containment calibration";
    if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.kind !== CONTAINMENT_DOCUMENT_KIND)
        throw new Error(`${label} evidence identity differs`);
    bool(parsed.qualifying, false, `${label} qualifying flag`);
    emptyArray(parsed.releaseGatesCleared, `${label} cleared gates`);
    if (parsed.bindingId !== AUTHENTIC_OLD_BINDING) throw new Error(`${label} binding differs`);
    exactString(parsed.productCode, `${label} product code`, PRODUCT_CODE);
    exactString(parsed.msiSha256, `${label} MSI SHA-256`, SHA256);
    exactString(parsed.helperSha256, `${label} helper SHA-256`, SHA256);
    /*
     * The calibration names the guest that produced it and the run it belongs to, and both have to
     * be the ones this record's provenance was already pinned to.
     */
    for (const name of ["guestSerial", "nonce"]) {
        exactString(parsed[name], `${label} ${name}`, NONCE);
        if (parsed[name] !== provenance[name])
            throw new Error(`${label} ${name} differs from its provenance`);
    }
    const interceptedLaunchCount = replayContainmentLaunchHistory(parsed.launchRecords,
        parsed.nonce, label);
    const proof = (value, mode, ifeoActive, registryRestored) => {
        exactKeys(value, ["status", "mode", "productCode", "ifeoActive", "oldPayloadExecutionCount",
            "registryRestored", "launchInventorySha256"], `${label} ${mode.toLowerCase()} proof`);
        if (value.status !== "completed" || value.mode !== mode || value.productCode !== parsed.productCode)
            throw new Error(`${label} ${mode.toLowerCase()} proof differs`);
        bool(value.ifeoActive, ifeoActive, `${label} ${mode.toLowerCase()} interception`);
        bool(value.registryRestored, registryRestored, `${label} ${mode.toLowerCase()} registry state`);
        if (value.oldPayloadExecutionCount !== 0)
            throw new Error(`${label} ${mode.toLowerCase()} payload execution differs`);
        exactString(value.launchInventorySha256, `${label} ${mode.toLowerCase()} launch inventory`, SHA256);
        return value;
    };
    const install = proof(parsed.install, "Install", true, false);
    const remove = proof(parsed.remove, "Remove", false, true);
    if (install.launchInventorySha256 !== remove.launchInventorySha256)
        throw new Error(`${label} launch inventory changed while contained`);
    /*
     * The helper reported that digest over its own listing; the calibration retains what it claims
     * that listing was. Accepting the two proofs because they agree with each other binds neither to
     * the retained history, so the digest is recomputed here in the helper's canonical form.
     */
    if (remove.launchInventorySha256 !== sha256(Buffer.from(JSON.stringify(
        parsed.launchRecords.map(record =>
            ({name: record.name, bytes: Number(record.bytes), sha256: record.sha256}))), "utf8")))
        throw new Error(`${label} launch inventory differs from the retained records`);
    return {bindingId: parsed.bindingId, productCode: parsed.productCode, msiSha256: parsed.msiSha256,
        oldPayloadExecutionCount: 0, interceptedLaunchCount, ifeoInstalled: true, ifeoRemoved: true,
        registryRestored: true, launchInventorySha256: remove.launchInventorySha256};
};

const REPLAY = Object.freeze({
    rollbackCalibration: ({parsed, record, launch}) =>
        replayRollbackCalibration(parsed, record.provenance, launch),
    oldContainment: ({parsed, record}) => replayContainmentCalibration(parsed, record.provenance)
});

export const inspectWindowsMsiPrerequisiteEvidence = ({name, value, context}) => {
    const contract = Object.hasOwn(WINDOWS_MSI_PREREQUISITE_CONTRACTS, name)
        ? WINDOWS_MSI_PREREQUISITE_CONTRACTS[name] : null;
    if (contract === null) throw new TypeError(`Unknown MSI prerequisite ${JSON.stringify(name)}`);
    const expected = assertExecutionContext(context);
    const label = `MSI ${name} prerequisite evidence`;
    exactKeys(value, contract.launchKind === undefined
        ? ["schemaVersion", "kind", "prerequisiteId", "producer", "provenance", "document"]
        : ["schemaVersion", "kind", "prerequisiteId", "producer", "provenance", "document", "launch"],
    label);
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== RECORD_KIND)
        throw new TypeError(`${label} differs`);
    if (value.prerequisiteId !== contract.prerequisiteId)
        throw new Error(`${label} names a different prerequisite`);
    if (!WINDOWS_MSI_PREREQUISITE_PRODUCERS.includes(value.producer))
        throw new Error(`${label} producer is not an execution producer`);
    if (value.producer !== contract.producer)
        throw new Error(`${label} producer differs from the prerequisite producer`);
    if (value.producer === HOSTED_PRODUCER)
        assertHostedProvenance(value.provenance, expected, contract, label);
    else assertGuestProvenance(value.provenance, expected, label);
    const decoded = decodeDocument(value.document, contract.maximumBytes, label);
    const launch = contract.launchKind === undefined ? null
        : decodeDocument(value.launch, contract.maximumLaunchBytes, `${label} launch`);
    const semantics = REPLAY[name]({parsed: decoded.parsed, record: value,
        launch: launch === null ? null : launch.parsed});
    return {prerequisiteId: contract.prerequisiteId, producer: value.producer,
        digestField: contract.digestField, sha256: decoded.sha256,
        launchSha256: launch === null ? null : launch.sha256, semantics};
};

export const bindWindowsMsiPrerequisiteEvidence = ({rollbackCalibration, oldContainment, context}) => {
    const supplied = {rollbackCalibration, oldContainment};
    const records = {};
    const digests = {};
    for (const name of Object.keys(WINDOWS_MSI_PREREQUISITE_CONTRACTS)) {
        const inspected = inspectWindowsMsiPrerequisiteEvidence({name, value: supplied[name], context});
        records[name] = structuredClone(supplied[name]);
        digests[inspected.digestField] = inspected.sha256;
    }
    if (digests.rollbackCalibrationSha256 === digests.oldContainmentSha256)
        throw new Error("MSI prerequisite evidence reuses one document for both prerequisites");
    return {...digests, records: Object.freeze(records)};
};
