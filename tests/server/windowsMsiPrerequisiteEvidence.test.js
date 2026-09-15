import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, it} from "node:test";

import {bindWindowsMsiPrerequisiteEvidence, inspectWindowsMsiPrerequisiteEvidence,
    WINDOWS_MSI_PREREQUISITE_CONTRACTS, WINDOWS_MSI_PREREQUISITE_PRODUCERS} from
    "../../scripts/qualification/windows-msi-prerequisite-evidence.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const PRODUCT_CODE = "{0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0}";
const MSI_SHA = "a".repeat(64);
const FORGED_INVENTORY_SHA = "b".repeat(64);
const HELPER_SHA = "c".repeat(64);

const CONTEXT = Object.freeze({repository: "i7Gamer/MySpeed", sourceSha: "1".repeat(40),
    eventSha: "2".repeat(40), runId: "34900000001", runAttempt: "1", nonce: "9".repeat(32)});

const retained = value => {
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    return {bytes: String(bytes.length), sha256: sha256(bytes), bytesBase64: bytes.toString("base64")};
};

/*
 * The authentic producer shape. `windows-msi-rollback-calibration.yml` retains exactly two files,
 * and every field below is the one the inspected artifact of run 34817703654 attempt 1 carries. Its
 * event SHA genuinely differs from its source SHA, so the fixture keeps them different.
 */
const ROLLBACK_SOURCE_SHA = "92f0ff3eab126271548684a5384c7b2ff2213655";
const ROLLBACK_EVENT_SHA = "0a85c86194d74164b50f9a64bcd3a4213f6b60da";
const ROLLBACK_RUN_ID = "34817703654";
const ROLLBACK_NONCE = "4c4d25645801462792f17a660934e138";
const SECURITY_DESCRIPTOR_SHA = "d8085e6ae4eb507bd388f4387d85b4403ba985fed7754cb3bc8f540bf4b9242a";
const PAYLOAD_SHA = "d3007b3e85e42d36018e4a1231a6eff90fa4b7fbb898d215fadf2fdd809081de";
const POWERSHELL_SHA = "f1f0ba58b157a1e4509d67f49266be9c94c463636c76d368e375a235cbaeee1d";

const callbackState = (overrides = {}) => ({Failure: null, FailureStage: null,
    FailureNativeErrorCode: null, CleanupFailure: null, CleanupFailureStage: null,
    CleanupFailureNativeErrorCode: null, RemovalStartSeen: true, RemovalProductSeen: true,
    InstallFilesSeen: true, DenyInjectionAttempted: true, InstallDataSeen: true, ErrorSeen: true,
    InstallFilesStartCount: 2, DenyReproofCount: 1, SecurityRestoredBeforeCancel: true,
    ErrorResponse: 2, ErrorCode: 1310, ErrorSystemCode: 0, InstallContextBalanced: true,
    Records: [{MessageTypeCode: 134217728, Fields: ["INSTALL", "", ""], Field1Integer: null},
        {MessageTypeCode: 436207616, Fields: ["MySpeed rollback sacrificial candidate"],
            Field1Integer: null}], ...overrides});

const nativeState = (overrides = {}) => ({PredecessorInstallReturn: 0, CandidateInstallReturn: 1603,
    PredecessorUninstallReturn: 0, CandidateUninstallReturn: 0, PredecessorAfterRollback: 5,
    CandidateAfterRollback: -1, PredecessorAfterCleanup: -1, CandidateAfterCleanup: -1,
    postReturnStateObserved: true, predecessorPayloadRestored: true, candidateAbsent: true,
    sentinelPreserved: true, sentinelBytesPreserved: true, securityRestored: true, accepted: true,
    predecessorPayloadSha256: PAYLOAD_SHA, directoryIdentity: "d6f2a281:000a0000000466a1",
    directoryFinalPath: `C:\\ProgramData\\MyspeedRollback-${ROLLBACK_NONCE}`,
    securityDescriptorBeforeSha256: SECURITY_DESCRIPTOR_SHA,
    securityDescriptorAfterSha256: SECURITY_DESCRIPTOR_SHA, primaryFailure: null, cleanupFailures: [],
    Callback: callbackState(), ...overrides});

const calibrationResult = (overrides = {}) => ({schemaVersion: 1,
    kind: "myspeed-msi-sacrificial-native-calibration", status: "observed", qualifying: false,
    nativeExecutionAttempted: true, failureCategory: null, sourceSha: ROLLBACK_SOURCE_SHA,
    eventSha: ROLLBACK_EVENT_SHA, runId: ROLLBACK_RUN_ID, runAttempt: "1", nonce: ROLLBACK_NONCE,
    result: nativeState(), releaseGatesCleared: [], ...overrides});

const ownedLaunch = (overrides = {}) => ({schemaVersion: 1, kind: "myspeed-owned-job-observed-launch",
    status: "completed", authorizesTransfer: false,
    executable: {path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        expectedSha256: POWERSHELL_SHA, beforeSha256: POWERSHELL_SHA, afterSha256: POWERSHELL_SHA},
    process: {processId: 3008, assignedBeforeResume: true, resumed: true,
        retainedHandleThroughExit: true},
    arguments: launchArguments(),
    timedOut: false, forced: false, exitCode: 0, processTreeExitProven: true,
    handles: {job: "closed", process: "closed", thread: "closed"}, failure: null, ...overrides});

/*
 * The vector the producer was started with. The document it names is where the producer's own
 * execution context is written down, so it is the second, independent statement of the run, attempt
 * and both SHAs that the receipt beside it has to agree with.
 */
const launchArguments = (launched = {}) => ["-NoLogo", "-NoProfile", "-NonInteractive",
    "-ExecutionPolicy", "Bypass", "-File", "D:\\a\\_temp\\closure\\windows-msi-rollback-native.ps1",
    "-Mode", "InvokeHostedCalibration", "-InputJson", JSON.stringify({runId: ROLLBACK_RUN_ID,
        runAttempt: "1", eventSha: ROLLBACK_EVENT_SHA, sourceSha: ROLLBACK_SOURCE_SHA,
        nonce: ROLLBACK_NONCE, ...launched})];

const launchRecord = (processId, overrides = {}) => ({schemaVersion: 1,
    kind: "myspeed-windows-msi-guest-containment-launch",
    name: `containment-launch-${CONTEXT.nonce}-${processId}.json`,
    bytes: "118", sha256: sha256(Buffer.from(`launch-${processId}`, "utf8")), processId,
    intercepted: true, ...overrides});

/*
 * Written out independently of the module under test: the helper's own canonical form over the
 * ordered {name,bytes,sha256} tuples. Two proofs agreeing on an arbitrary digest bind nothing, so
 * the consumer has to derive this value from the records the calibration actually retained.
 */
const inventoryOf = records => sha256(Buffer.from(JSON.stringify(records.map(record =>
    ({name: record.name, bytes: Number(record.bytes), sha256: record.sha256}))), "utf8"));

const DEFAULT_LAUNCH_RECORDS = [launchRecord(2140), launchRecord(2216)];
const INVENTORY_SHA = inventoryOf(DEFAULT_LAUNCH_RECORDS);

const containmentCalibration = (overrides = {}) => {
    const launchRecords = overrides.launchRecords ?? DEFAULT_LAUNCH_RECORDS;
    /* A history that is not a list at all is left for the module itself to refuse. */
    const inventory = overrides.launchInventorySha256
        ?? (Array.isArray(launchRecords) ? inventoryOf(launchRecords) : INVENTORY_SHA);
    const {launchInventorySha256: _pinned, ...rest} = overrides;
    return {schemaVersion: 1,
        kind: "myspeed-windows-msi-guest-containment-calibration", qualifying: false,
        releaseGatesCleared: [], bindingId: "authentic-1.6.0-default-msi", productCode: PRODUCT_CODE,
        msiSha256: MSI_SHA, helperSha256: HELPER_SHA, guestSerial: "7".repeat(32),
        nonce: CONTEXT.nonce, launchRecords,
        install: {status: "completed", mode: "Install", productCode: PRODUCT_CODE, ifeoActive: true,
            oldPayloadExecutionCount: 0, registryRestored: false, launchInventorySha256: inventory},
        remove: {status: "completed", mode: "Remove", productCode: PRODUCT_CODE, ifeoActive: false,
            oldPayloadExecutionCount: 0, registryRestored: true, launchInventorySha256: inventory},
        ...rest};
};

const ARCHIVE_DIGEST = "sha256:b3cf1edcea84b084625622073e129d9f3156bb4dd9b8f6553ec7fed80d5c6fab";

const hostedRecord = (value, overrides = {}) => ({schemaVersion: 1,
    kind: "myspeed-windows-msi-prerequisite-evidence", prerequisiteId: "msi-api-rollback-controller",
    producer: "hosted-run-artifact",
    provenance: {repository: "i7Gamer/MySpeed", workflow: "windows-msi-rollback-calibration.yml",
        runId: ROLLBACK_RUN_ID, runAttempt: "1", sourceSha: ROLLBACK_SOURCE_SHA,
        eventSha: ROLLBACK_EVENT_SHA, artifactId: "10337212686",
        artifactName: "windows-msi-sacrificial-executor-boundary", artifactBytes: "3069",
        artifactDigest: ARCHIVE_DIGEST, officialArtifactDigest: ARCHIVE_DIGEST},
    document: retained(value), launch: retained(ownedLaunch()), ...overrides});

const guestRecord = (value, overrides = {}) => ({schemaVersion: 1,
    kind: "myspeed-windows-msi-prerequisite-evidence", prerequisiteId: "authentic-old-ifeo-containment",
    producer: "in-guest-calibration",
    provenance: {repository: CONTEXT.repository, sourceSha: CONTEXT.sourceSha, eventSha: CONTEXT.eventSha,
        runId: CONTEXT.runId, runAttempt: CONTEXT.runAttempt, nonce: CONTEXT.nonce,
        guestSerial: "7".repeat(32)},
    document: retained(value), ...overrides});

const inspect = (name, value) => inspectWindowsMsiPrerequisiteEvidence({name, value, context: CONTEXT});

describe("Windows MSI prerequisite evidence", () => {
    it("publishes the exact prerequisite contracts and producer roles", () => {
        assert.deepEqual(Object.keys(WINDOWS_MSI_PREREQUISITE_CONTRACTS),
            ["rollbackCalibration", "oldContainment"]);
        assert.equal(WINDOWS_MSI_PREREQUISITE_CONTRACTS.rollbackCalibration.prerequisiteId,
            "msi-api-rollback-controller");
        assert.equal(WINDOWS_MSI_PREREQUISITE_CONTRACTS.oldContainment.prerequisiteId,
            "authentic-old-ifeo-containment");
        assert.deepEqual([...WINDOWS_MSI_PREREQUISITE_PRODUCERS],
            ["hosted-run-artifact", "in-guest-calibration"]);
    });

    it("binds an accepted rollback calibration to the digest of its own retained bytes", () => {
        const value = calibrationResult();
        const record = hostedRecord(value);
        const inspected = inspect("rollbackCalibration", record);
        assert.equal(inspected.sha256, record.document.sha256);
        assert.equal(inspected.sha256, sha256(Buffer.from(JSON.stringify(value), "utf8")));
        assert.equal(inspected.prerequisiteId, "msi-api-rollback-controller");
        assert.equal(inspected.producer, "hosted-run-artifact");
        assert.deepEqual(inspected.semantics, {accepted: true, nativeExecutionAttempted: true,
            candidateInstallReturn: 1603, predecessorPayloadRestored: true, candidateAbsent: true,
            sentinelPreserved: true, securityRestored: true, securityDescriptorSha256: SECURITY_DESCRIPTOR_SHA,
            predecessorPayloadSha256: PAYLOAD_SHA, callbackRecordCount: 2,
            securityRestoredBeforeCancel: true, installContextBalanced: true,
            ownedLaunchExitCode: 0, processTreeExitProven: true});
        /*
         * The producer's own bytes reach the consumer unreshaped: the retained document is the
         * artifact's `result.json`, not a controller result rewritten to look like one.
         */
        assert.equal(JSON.parse(Buffer.from(record.document.bytesBase64, "base64").toString("utf8")).kind,
            "myspeed-msi-sacrificial-native-calibration");
        assert.equal(inspected.launchSha256, record.launch.sha256);
    });

    /*
     * The receipt and the launch record are two documents the producer retained side by side, and
     * the launch record states the context the producer was actually started with. A receipt whose
     * run, attempt or either SHA differs from that vector is not the receipt of that launch, however
     * well formed each document is on its own.
     */
    it("requires the receipt and the launch vector to name the same producer run", () => {
        const inspected = inspect("rollbackCalibration", hostedRecord(calibrationResult()));
        assert.equal(inspected.semantics.ownedLaunchExitCode, 0);
        for (const [name, launched] of Object.entries({
            "an event SHA the receipt does not carry": {eventSha: "c".repeat(40)},
            "a source SHA the receipt does not carry": {sourceSha: "d".repeat(40)},
            "another run": {runId: "34900000001"},
            "another attempt": {runAttempt: "2"},
            "another nonce": {nonce: "e".repeat(32)}}))
            assert.throws(() => inspect("rollbackCalibration", hostedRecord(calibrationResult(),
                {launch: retained(ownedLaunch({arguments: launchArguments(launched)}))})),
            /launch vector/iu, name);
    });

    it("requires the launch vector to name exactly one input document", () => {
        for (const [name, values] of Object.entries({
            "no input document": ["-NoLogo", "-Mode", "InvokeHostedCalibration"],
            "two input documents": ["-InputJson", "{}", "-InputJson", "{}"],
            "an input flag with nothing after it": ["-InputJson"],
            "an input document that is not an object": ["-InputJson", "[]"],
            "an input document that is not JSON at all": ["-InputJson", "not-json"]}))
            assert.throws(() => inspect("rollbackCalibration", hostedRecord(calibrationResult(),
                {launch: retained(ownedLaunch({arguments: values}))})),
            /launch vector/iu, name);
        assert.throws(() => inspect("rollbackCalibration", hostedRecord(calibrationResult(),
            {launch: retained(ownedLaunch({arguments: "-InputJson {}"}))})), /launch vector/iu);
    });

    it("binds an executed containment calibration to this run's guest", () => {
        const value = containmentCalibration();
        const inspected = inspect("oldContainment", guestRecord(value));
        assert.equal(inspected.sha256, sha256(Buffer.from(JSON.stringify(value), "utf8")));
        assert.deepEqual(inspected.semantics, {bindingId: "authentic-1.6.0-default-msi",
            productCode: PRODUCT_CODE, msiSha256: MSI_SHA, oldPayloadExecutionCount: 0,
            interceptedLaunchCount: 2, ifeoInstalled: true, ifeoRemoved: true, registryRestored: true,
            launchInventorySha256: INVENTORY_SHA});
        /*
         * Two launch attempts were blocked by the IFEO stub and none of them executed the old
         * payload. The counts are deliberately separate values: substituting the interception count
         * for the execution count would report a contained run as an uncontained one.
         */
        assert.notEqual(inspected.semantics.interceptedLaunchCount,
            inspected.semantics.oldPayloadExecutionCount);
    });

    /*
     * The helper reports the digest it took over its own listing, once per call. Accepting the two
     * values merely because they agree with each other binds nothing at all: any common value
     * passes, and the history retained beside them is never compared with either. So the inventory
     * is recomputed here from the retained records, and both proofs have to equal it.
     */
    it("refuses a containment inventory digest the retained records do not produce", () => {
        /* A value both proofs merely share, which no listing the helper could enumerate produces. */
        assert.throws(() => inspect("oldContainment", guestRecord(containmentCalibration(
            {launchInventorySha256: FORGED_INVENTORY_SHA}))), /inventory/iu);
        /* The digest is over an ordered list, so the same records in another order do not produce it. */
        assert.throws(() => inspect("oldContainment", guestRecord(containmentCalibration(
            {launchRecords: [launchRecord(2216), launchRecord(2140)],
                launchInventorySha256: INVENTORY_SHA}))), /inventory/iu);
        /* A retained size or digest that was edited after the helper hashed it. */
        assert.throws(() => inspect("oldContainment", guestRecord(containmentCalibration(
            {launchRecords: [launchRecord(2140, {bytes: "119"}), launchRecord(2216)],
                launchInventorySha256: INVENTORY_SHA}))), /inventory/iu);
        assert.throws(() => inspect("oldContainment", guestRecord(containmentCalibration(
            {launchRecords: [launchRecord(2140, {sha256: "e".repeat(64)}), launchRecord(2216)],
                launchInventorySha256: INVENTORY_SHA}))), /inventory/iu);
        /* And a record dropped from the history after the fact, leaving the digest behind. */
        assert.throws(() => inspect("oldContainment", guestRecord(containmentCalibration(
            {launchRecords: [launchRecord(2140)], launchInventorySha256: INVENTORY_SHA}))),
        /inventory/iu);
        /* An empty history is still a history, and canonicalizes to the empty list. */
        const empty = inspect("oldContainment", guestRecord(containmentCalibration({launchRecords: []})));
        assert.equal(empty.semantics.interceptedLaunchCount, 0);
        assert.equal(empty.semantics.launchInventorySha256, inventoryOf([]));
        assert.equal(inventoryOf([]), sha256(Buffer.from("[]", "utf8")));
    });

    it("refuses a containment launch record another run's nonce named", () => {
        for (const name of ["containment-launch-2140.json",
            `containment-launch-${"1".repeat(32)}-2140.json`])
            assert.throws(() => inspect("oldContainment", guestRecord(containmentCalibration(
                {launchRecords: [{...launchRecord(2140), name}]}))), /launch record name/iu, name);
    });

    /*
     * The whole point of the replacement: a 64-character hexadecimal string, or the SHA-256 of the
     * helper that would perform the work, says nothing about an execution having happened. Both
     * shapes have to be rejected by name so neither can be reintroduced as an equivalent input.
     */
    it("rejects a bare digest and a helper source pin in place of executed evidence", () => {
        assert.throws(() => inspect("rollbackCalibration", "e".repeat(64)), /prerequisite evidence/i);
        assert.throws(() => inspect("rollbackCalibration",
            {...hostedRecord(calibrationResult()), producer: "helper-source-pin"}), /producer/i);
        const withoutDocument = hostedRecord(calibrationResult());
        delete withoutDocument.document;
        assert.throws(() => inspect("rollbackCalibration", withoutDocument), /prerequisite evidence/i);
    });

    it("rejects retained bytes whose digest or length was not recomputed from the bytes", () => {
        const record = hostedRecord(calibrationResult());
        assert.throws(() => inspect("rollbackCalibration",
            {...record, document: {...record.document, sha256: "f".repeat(64)}}), /document identity/i);
        assert.throws(() => inspect("rollbackCalibration",
            {...record, document: {...record.document, bytes: "1"}}), /document identity/i);
        const foreign = retained(calibrationResult({installReturnCode: 1603}));
        assert.throws(() => inspect("rollbackCalibration",
            {...record, document: {...foreign, sha256: record.document.sha256}}), /document identity/i);
    });

/*
     * `accepted` is computed by the producer as "no primary failure, no cleanup failure, security
     * restored" - it says nothing about the rollback having restored the predecessor, about the
     * candidate being gone, or about the callback timeline. Each of those is replayed separately, so
     * a receipt that kept `accepted:true` while weakening one of them is still refused.
     */
    it("rejects a rollback calibration that did not actually clear its own semantics", () => {
        const cases = [{status: "failed"}, {nativeExecutionAttempted: false},
            {failureCategory: "native-calibration-rejected"}, {qualifying: true},
            {releaseGatesCleared: ["windows-msi-lifecycle"]},
            {kind: "myspeed-msi-sacrificial-calibration-controller-result"},
            {kind: "myspeed-windows-msi-guest-containment-calibration"}, {schemaVersion: 2}];
        for (const overrides of cases)
            assert.throws(() => inspect("rollbackCalibration", hostedRecord(calibrationResult(overrides))),
                /rollback calibration/i, JSON.stringify(overrides));
        const stateCases = [{accepted: false}, {primaryFailure: "install-product"},
            {cleanupFailures: ["restore-security"]}, {securityRestored: false},
            {CandidateInstallReturn: 0}, {CandidateInstallReturn: 1601},
            {PredecessorInstallReturn: 1603}, {PredecessorUninstallReturn: 1603},
            {CandidateUninstallReturn: 1603}, {PredecessorAfterCleanup: 5},
            {CandidateAfterCleanup: 5}, {CandidateAfterRollback: 5},
            {PredecessorAfterRollback: -1}, {postReturnStateObserved: false},
            {predecessorPayloadRestored: false}, {candidateAbsent: false}, {sentinelPreserved: false},
            {sentinelBytesPreserved: false},
            {securityDescriptorAfterSha256: "a".repeat(64)}];
        for (const overrides of stateCases)
            assert.throws(() => inspect("rollbackCalibration",
                hostedRecord(calibrationResult({result: nativeState(overrides)}))),
            /rollback calibration/i, JSON.stringify(overrides));
    });

    /*
     * The raw callback timeline is the proof that the rollback the receipt claims is the one MSI
     * actually ran. A receipt that dropped an obligation there, or emptied the timeline, proves
     * nothing however accepted it says it is.
     */
    it("rejects a weakened callback timeline even when the receipt says it was accepted", () => {
        const cases = [{Failure: "install-files"}, {FailureStage: "removal"},
            {FailureNativeErrorCode: 5}, {CleanupFailure: "restore-security"},
            {CleanupFailureStage: "cleanup"}, {CleanupFailureNativeErrorCode: 5},
            {RemovalStartSeen: false}, {RemovalProductSeen: false}, {InstallFilesSeen: false},
            {DenyInjectionAttempted: false}, {InstallDataSeen: false}, {ErrorSeen: false},
            {SecurityRestoredBeforeCancel: false}, {InstallContextBalanced: false},
            {InstallFilesStartCount: 0}, {DenyReproofCount: 0}, {ErrorSystemCode: 5},
            {Records: []}];
        for (const overrides of cases)
            assert.throws(() => inspect("rollbackCalibration", hostedRecord(calibrationResult(
                {result: nativeState({Callback: callbackState(overrides)})}))),
            /rollback calibration/i, JSON.stringify(overrides));
    });

    /*
     * The receipt only proves anything if the process that produced it was owned through its exit.
     * The producing workflow checks that from `launcher.json`, so the consumer replays the same
     * obligations rather than accepting a receipt with no launch proof beside it.
     */
    it("replays the owned launch beside the receipt and rejects an unproven one", () => {
        const withoutLaunch = hostedRecord(calibrationResult());
        delete withoutLaunch.launch;
        assert.throws(() => inspect("rollbackCalibration", withoutLaunch), /prerequisite evidence/i);
        const cases = [{status: "failed"}, {exitCode: 1}, {timedOut: true}, {forced: true},
            {processTreeExitProven: false}, {authorizesTransfer: true},
            {failure: "owned-launch-failed"}, {kind: "myspeed-owned-job-observed-launch-v2"},
            {process: {processId: 3008, assignedBeforeResume: false, resumed: true,
                retainedHandleThroughExit: true}},
            {process: {processId: 3008, assignedBeforeResume: true, resumed: false,
                retainedHandleThroughExit: true}},
            {process: {processId: 3008, assignedBeforeResume: true, resumed: true,
                retainedHandleThroughExit: false}},
            {handles: {job: "leaked", process: "closed", thread: "closed"}},
            {executable: {path: "C:\\Windows\\System32\\cmd.exe", expectedSha256: POWERSHELL_SHA,
                beforeSha256: POWERSHELL_SHA, afterSha256: "b".repeat(64)}}];
        for (const overrides of cases)
            assert.throws(() => inspect("rollbackCalibration",
                {...hostedRecord(calibrationResult()), launch: retained(ownedLaunch(overrides))}),
            /rollback calibration|owned launch/i, JSON.stringify(overrides));
    });

    /*
     * The pin a dispatch supplies cannot authenticate itself. The acquisition step records what the
     * platform reported for the artifact, and a record whose two digests disagree - or whose
     * identity was retyped to some other producer - is refused here rather than replayed.
     */
    it("rejects forged artifact metadata and a foreign producer identity", () => {
        const record = hostedRecord(calibrationResult());
        const cases = [{officialArtifactDigest: `sha256:${"e".repeat(64)}`},
            {artifactDigest: `sha256:${"e".repeat(64)}`},
            {artifactName: "windows-msi-rollback-calibration-evidence"},
            {workflow: "post-release-msi-lifecycle.yml"}, {artifactBytes: "0"},
            {runAttempt: "2"}, {runId: "34817703655"}, {sourceSha: "5".repeat(40)},
            {eventSha: "5".repeat(40)}];
        for (const overrides of cases)
            assert.throws(() => inspect("rollbackCalibration",
                {...record, provenance: {...record.provenance, ...overrides}}),
            /rollback calibration|provenance/i, JSON.stringify(overrides));
    });

    it("rejects a containment calibration that let the old payload run or left IFEO behind", () => {
        const base = containmentCalibration();
        const cases = [{install: {...base.install, oldPayloadExecutionCount: 1}},
            {install: {...base.install, ifeoActive: false}},
            {install: {...base.install, registryRestored: true}},
            {remove: {...base.remove, ifeoActive: true}},
            {remove: {...base.remove, registryRestored: false}},
            {remove: {...base.remove, oldPayloadExecutionCount: 2}},
            {remove: {...base.remove, status: "failed"}},
            {qualifying: true}, {releaseGatesCleared: ["windows-msi-lifecycle"]},
            {bindingId: "authentic-1.1.0-msi-with-destination-data"},
            {kind: "myspeed-msi-sacrificial-calibration-controller-result"}];
        for (const overrides of cases)
            assert.throws(() => inspect("oldContainment", guestRecord(containmentCalibration(overrides))),
                /containment calibration/i, JSON.stringify(overrides));
    });

    /*
     * `containment-launch-*.json` records are IFEO stub interceptions: the stub ran *instead of* the
     * old payload and exited. They are blocked launch attempts, not executions, so the count of them
     * must never be written into `oldPayloadExecutionCount`. A calibration with no attempts at all is
     * equally fine - it means nothing tried to start the old payload.
     */
    it("separates blocked launch attempts from actual old-payload execution", () => {
        const none = containmentCalibration({launchRecords: []});
        assert.deepEqual(inspect("oldContainment", guestRecord(none)).semantics.interceptedLaunchCount, 0);
        assert.equal(inspect("oldContainment", guestRecord(none)).semantics.oldPayloadExecutionCount, 0);
        const many = containmentCalibration({launchRecords: [launchRecord(11), launchRecord(12),
            launchRecord(13)]});
        assert.equal(inspect("oldContainment", guestRecord(many)).semantics.interceptedLaunchCount, 3);
        assert.equal(inspect("oldContainment", guestRecord(many)).semantics.oldPayloadExecutionCount, 0);
        /* A record that says the launch was not intercepted is the old payload having run. */
        assert.throws(() => inspect("oldContainment", guestRecord(containmentCalibration(
            {launchRecords: [launchRecord(11), launchRecord(12, {intercepted: false})]}))),
        /containment calibration/iu);
        /*
         * And the hardcoded zero on its own is not the proof: a calibration that claims zero
         * executions while its own retained history is missing has no history to stand on.
         */
        const withoutHistory = containmentCalibration();
        delete withoutHistory.launchRecords;
        assert.throws(() => inspect("oldContainment", guestRecord(withoutHistory)),
            /containment calibration/iu);
    });

    it("rejects a retained launch history that was retyped or duplicated", () => {
        const cases = [
            {launchRecords: [launchRecord(11), launchRecord(11)]},
            {launchRecords: [launchRecord(0)]},
            {launchRecords: [launchRecord(11, {kind: "myspeed-windows-msi-guest-matrix-semantic-result"})]},
            {launchRecords: [launchRecord(11, {sha256: "not-a-digest"})]},
            {launchRecords: [launchRecord(11, {bytes: "0"})]},
            {launchRecords: [launchRecord(11, {schemaVersion: 2})]},
            {launchRecords: {}},
            {guestSerial: "8".repeat(32)},
            {nonce: "8".repeat(32)}];
        for (const overrides of cases)
            assert.throws(() => inspect("oldContainment", guestRecord(containmentCalibration(overrides))),
                /containment calibration/iu, JSON.stringify(overrides));
    });

    /*
     * A hosted producer ran earlier, at its own commit, in its own run; that historical role must not
     * be forced to equal the execution run. An in-guest producer is the opposite: it only means
     * anything if it was produced by this run's guest, so its provenance is pinned to the context.
     */
    it("separates the historical producer run from this execution run", () => {
        const record = hostedRecord(calibrationResult());
        /*
         * The historical receipt's own event SHA differs from its source SHA. Requiring them equal
         * would reject the only authentic producer that exists, so the contract binds each to the
         * provenance and to nothing else.
         */
        assert.notEqual(ROLLBACK_SOURCE_SHA, ROLLBACK_EVENT_SHA);
        assert.equal(inspect("rollbackCalibration", record).producer, "hosted-run-artifact");
        const sameSha = calibrationResult({eventSha: ROLLBACK_SOURCE_SHA});
        assert.equal(inspect("rollbackCalibration", {...hostedRecord(sameSha,
            {launch: retained(ownedLaunch({arguments: launchArguments({eventSha: ROLLBACK_SOURCE_SHA})}))}),
        provenance: {...record.provenance, eventSha: ROLLBACK_SOURCE_SHA}}).producer,
        "hosted-run-artifact");
        for (const [name, value] of [["runId", "34900000002"], ["runAttempt", "2"],
            ["sourceSha", "6".repeat(40)], ["eventSha", "6".repeat(40)]])
            assert.throws(() => inspect("rollbackCalibration",
                hostedRecord(calibrationResult({[name]: value}))), /rollback calibration/i, name);
        /*
         * Nothing the dispatch can supply binds the producer nonce - the platform reports run,
         * attempt, SHA, artifact id, size and digest, and no nonce - so the nonce is checked for
         * shape and nothing more. Pretending to bind it would be a check that proves nothing.
         */
        assert.equal(inspect("rollbackCalibration", hostedRecord(
            calibrationResult({nonce: "5".repeat(32)}),
            {launch: retained(ownedLaunch({arguments: launchArguments({nonce: "5".repeat(32)})}))}
        )).producer, "hosted-run-artifact");
        assert.throws(() => inspect("rollbackCalibration",
            hostedRecord(calibrationResult({nonce: "not-a-nonce"}))), /rollback calibration/i);
        /* Changed in the receipt alone, it no longer matches the vector that started the producer. */
        assert.throws(() => inspect("rollbackCalibration",
            hostedRecord(calibrationResult({nonce: "5".repeat(32)}))), /launch vector/i);
        assert.throws(() => inspect("rollbackCalibration",
            {...record, provenance: {...record.provenance, repository: "attacker/MySpeed"}}), /repository/i);
        assert.throws(() => inspect("rollbackCalibration",
            {...record, provenance: {...record.provenance, artifactDigest: "d".repeat(64)}}),
        /artifact digest/i);
        const guest = guestRecord(containmentCalibration());
        for (const [name, value] of [["runId", "34900000002"], ["nonce", "8".repeat(32)],
            ["sourceSha", "4".repeat(40)], ["runAttempt", "2"]])
            assert.throws(() => inspect("oldContainment",
                {...guest, provenance: {...guest.provenance, [name]: value}}), /execution context/i);
    });

    it("refuses a record whose producer role does not fit the prerequisite", () => {
        assert.throws(() => inspect("oldContainment", hostedRecord(calibrationResult())), /prerequisite/i);
        assert.throws(() => inspect("rollbackCalibration", guestRecord(containmentCalibration())),
            /prerequisite/i);
        assert.throws(() => inspect("unknownPrerequisite", hostedRecord(calibrationResult())),
            /prerequisite/i);
    });

    it("binds both prerequisites into the digests the row request carries", () => {
        const rollback = hostedRecord(calibrationResult());
        const containment = guestRecord(containmentCalibration());
        const bound = bindWindowsMsiPrerequisiteEvidence({rollbackCalibration: rollback,
            oldContainment: containment, context: CONTEXT});
        assert.equal(bound.rollbackCalibrationSha256, rollback.document.sha256);
        assert.equal(bound.oldContainmentSha256, containment.document.sha256);
        assert.deepEqual(Object.keys(bound.records), ["rollbackCalibration", "oldContainment"]);
        assert.equal(bound.records.rollbackCalibration.document.bytesBase64,
            rollback.document.bytesBase64);
        assert.notEqual(bound.records.rollbackCalibration, rollback);
        assert.throws(() => bindWindowsMsiPrerequisiteEvidence({rollbackCalibration: rollback,
            oldContainment: rollback, context: CONTEXT}), /prerequisite/i);
    });

    it("bounds the retained prerequisite document", () => {
        const record = hostedRecord(calibrationResult());
        const oversize = Buffer.alloc(WINDOWS_MSI_PREREQUISITE_CONTRACTS.rollbackCalibration.maximumBytes + 1,
            0x20);
        assert.throws(() => inspect("rollbackCalibration", {...record, document: {
            bytes: String(oversize.length), sha256: sha256(oversize),
            bytesBase64: oversize.toString("base64")}}), /document identity|bound/i);
        assert.throws(() => inspect("rollbackCalibration", {...record, document: {
            bytes: "0", sha256: sha256(Buffer.alloc(0)), bytesBase64: ""}}), /document identity|bound/i);
    });
});
