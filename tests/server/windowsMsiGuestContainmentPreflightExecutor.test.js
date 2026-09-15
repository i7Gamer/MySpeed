import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, it} from "node:test";

import {canonicalizeWindowsMsiGuestLaunchInventory, createWindowsMsiGuestPreflightArguments,
    executeWindowsMsiGuestPreflightEnvelope,
    validateWindowsMsiGuestPreflightEnvelope, validateWindowsMsiGuestPreflightRequest,
    WINDOWS_MSI_GUEST_PREFLIGHT_CONSTANTS} from
    "../../scripts/qualification/windows-msi-guest-containment-preflight-executor.mjs";

const NONCE = "9".repeat(32);
const SERIAL = "7".repeat(32);
const PRODUCT_CODE = "{0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0}";
const MSI_SHA = "a".repeat(64);
const HELPER_SHA = "c".repeat(64);
const SEED_ROOT = "C:\\myspeed-seed";
const OUTPUT_ROOT = "D:\\myspeed-out";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const digestOf = value => sha256(Buffer.from(JSON.stringify(value), "utf8"));

const request = (overrides = {}) => ({schemaVersion: 1,
    kind: "myspeed-windows-msi-guest-containment-preflight-request", qualifying: false,
    sourceSha: "1".repeat(40), eventSha: "2".repeat(40), runId: "34900000001", runAttempt: "1",
    nonce: NONCE, bindingId: "authentic-1.6.0-default-msi",
    guest: {serial: SERIAL, cpuEvidenceSha256: "d".repeat(64), qemuLaunchSha256: "e".repeat(64),
        seedRoot: SEED_ROOT, outputRoot: OUTPUT_ROOT},
    msi: {path: `${SEED_ROOT}\\MySpeed-1.6.0.msi`, bytes: 4_194_304, sha256: MSI_SHA,
        productCode: PRODUCT_CODE},
    helper: {path: `${SEED_ROOT}\\windows-msi-guest-containment.ps1`, bytes: 20_480, sha256: HELPER_SHA},
    tools: {powershell: {path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        sha256: "f".repeat(64)}},
    limits: {launchRecords: 256, resultBytes: 65_536},
    releaseGatesCleared: [], ...overrides});

const envelope = (overrides = {}) => {
    const value = overrides.requestValue ?? request();
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    const {requestValue: _ignored, ...rest} = overrides;
    return {envelope: {schemaVersion: 1,
        kind: "myspeed-windows-msi-guest-containment-preflight-envelope", qualifying: false,
        sourceSha: value.sourceSha, eventSha: value.eventSha, runId: value.runId,
        runAttempt: value.runAttempt, nonce: value.nonce, seedRoot: SEED_ROOT, outputRoot: OUTPUT_ROOT,
        preflightRequest: {path: `${SEED_ROOT}\\preflight-request.json`, bytes: bytes.length,
            sha256: sha256(bytes)},
        resultPath: `${OUTPUT_ROOT}\\result.json`,
        limits: {inputBytes: 1_048_576, resultBytes: 65_536}, ...rest}, bytes, value};
};

const proof = (mode, overrides = {}, records = DEFAULT_RECORDS) =>
    ({status: "completed", mode, productCode: PRODUCT_CODE,
        ifeoActive: mode === "Install", oldPayloadExecutionCount: 0,
        registryRestored: mode === "Remove", launchInventorySha256: inventoryOf(records), ...overrides});

/* The helper enumerates this run's nonce, so a record of this run is named with it. */
const recordName = processId => `containment-launch-${NONCE}-${processId}.json`;

const launchRecordBytes = processId => Buffer.from(JSON.stringify({schemaVersion: 1,
    kind: "myspeed-windows-msi-guest-containment-launch", nonce: NONCE, processId, intercepted: true}),
"utf8");

const listed = (...processIds) => processIds.map(processId =>
    ({name: recordName(processId), bytes: launchRecordBytes(processId)}));

/*
 * The helper's canonical form, written out here independently of the module under test: the ordered
 * {name,bytes,sha256} tuples, `ConvertTo-Json -Compress`, UTF-8 without a BOM. A digest both helper
 * calls merely agree on proves nothing, so every proof in these tests is derived from the records
 * the guest actually reads.
 */
const inventoryOf = records => sha256(Buffer.from(JSON.stringify(records.map(record =>
    ({name: record.name, bytes: record.bytes.length, sha256: sha256(record.bytes)}))), "utf8"));

const DEFAULT_RECORDS = listed(2140);

const driver = (overrides = {}) => {
    const calls = [];
    const {installProof, removeProof, records, ...rest} = overrides;
    const listing = records ?? DEFAULT_RECORDS;
    return {calls, dependencies: {
        readBoundFile: async binding => { calls.push(`read:${binding.path}`);
            return overrides.requestBytes ?? envelope().bytes; },
        writeCreateNew: async (target, bytes) => { calls.push(`write:${target}`);
            overrides.written?.push(bytes); },
        operationsFactory: () => ({
            boundary: async () => { calls.push("boundary"); return {serial: SERIAL}; },
            containment: async action => { calls.push(`containment:${action}`);
                if (action === "Install") return installProof ?? proof("Install", {}, listing);
                return removeProof ?? proof("Remove", {}, listing); },
            listLaunchRecords: async () => { calls.push("listLaunchRecords"); return listing; }
        }), ...rest}};
};

const run = async (overrides = {}) => {
    const built = envelope(overrides.envelope ?? {});
    const written = [];
    const {calls, dependencies} = driver({requestBytes: built.bytes, written, ...overrides.driver});
    const observed = await executeWindowsMsiGuestPreflightEnvelope(built.envelope, dependencies);
    return {observed, calls, written, built};
};

describe("Windows MSI guest containment preflight executor", () => {
    it("publishes the envelope and document kinds the seed transport binds", () => {
        assert.equal(WINDOWS_MSI_GUEST_PREFLIGHT_CONSTANTS.requestKind,
            "myspeed-windows-msi-guest-containment-preflight-request");
        assert.equal(WINDOWS_MSI_GUEST_PREFLIGHT_CONSTANTS.envelopeKind,
            "myspeed-windows-msi-guest-containment-preflight-envelope");
        assert.equal(WINDOWS_MSI_GUEST_PREFLIGHT_CONSTANTS.calibrationKind,
            "myspeed-windows-msi-guest-containment-calibration");
        assert.deepEqual(WINDOWS_MSI_GUEST_PREFLIGHT_CONSTANTS.modes, ["Install", "Remove"]);
    });

    /*
     * The helper is invoked with the parameter names it actually declares, and with the identities
     * the host bound rather than anything the guest could choose for itself.
     */
    it("invokes the containment helper with the bound identities", () => {
        const value = validateWindowsMsiGuestPreflightRequest(request());
        assert.deepEqual(createWindowsMsiGuestPreflightArguments(value, "Install"),
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", value.helper.path, "-Mode", "Install",
                "-ProductCode", PRODUCT_CODE, "-MsiPath", value.msi.path, "-MsiSha256", MSI_SHA,
                "-EvidenceRoot", OUTPUT_ROOT, "-Nonce", NONCE, "-ExpectedSerial", SERIAL,
                "-HelperSha256", HELPER_SHA]);
        assert.equal(createWindowsMsiGuestPreflightArguments(value, "Remove")[6], "Remove");
        assert.throws(() => createWindowsMsiGuestPreflightArguments(value, "ContainmentStub"), /mode/iu);
    });

    it("rejects a request whose identities are not exactly bound", () => {
        assert.deepEqual(validateWindowsMsiGuestPreflightRequest(request()), request());
        for (const overrides of [{kind: "myspeed-windows-msi-guest-matrix-envelope"},
            {qualifying: true}, {releaseGatesCleared: ["windows-msi-lifecycle"]},
            {bindingId: "authentic-1.1.0-msi-with-destination-data"}, {nonce: "not-a-nonce"},
            {msi: {path: `${SEED_ROOT}\\MySpeed-1.6.0.msi`, bytes: 0, sha256: MSI_SHA,
                productCode: PRODUCT_CODE}},
            {msi: {path: `${SEED_ROOT}\\MySpeed-1.6.0.msi`, bytes: 4_194_304, sha256: "short",
                productCode: PRODUCT_CODE}},
            {msi: {path: `${SEED_ROOT}\\MySpeed-1.6.0.msi`, bytes: 4_194_304, sha256: MSI_SHA,
                productCode: "not-a-product-code"}},
            {helper: {path: `${OUTPUT_ROOT}\\windows-msi-guest-containment.ps1`, bytes: 20_480,
                sha256: HELPER_SHA}},
            {guest: {serial: "bad", cpuEvidenceSha256: "d".repeat(64), qemuLaunchSha256: "e".repeat(64),
                seedRoot: SEED_ROOT, outputRoot: OUTPUT_ROOT}},
            {extra: 1}])
            assert.throws(() => validateWindowsMsiGuestPreflightRequest(request(overrides)),
                /preflight request/iu, JSON.stringify(overrides));
    });

    it("rejects an envelope whose bound request bytes were retyped", async () => {
        const built = envelope();
        assert.deepEqual(validateWindowsMsiGuestPreflightEnvelope(built.envelope), built.envelope);
        for (const overrides of [{kind: "myspeed-windows-msi-guest-matrix-envelope"}, {qualifying: true},
            {resultPath: `${SEED_ROOT}\\result.json`},
            {preflightRequest: {path: `${OUTPUT_ROOT}\\preflight-request.json`, bytes: 12,
                sha256: "a".repeat(64)}},
            {preflightRequest: {path: `${SEED_ROOT}\\preflight-request.json`, bytes: 0,
                sha256: "a".repeat(64)}},
            {seedRoot: OUTPUT_ROOT}])
            assert.throws(() => validateWindowsMsiGuestPreflightEnvelope(envelope(overrides).envelope),
                /preflight envelope/iu, JSON.stringify(overrides));
        /* And bytes that hash to something other than the envelope's binding are refused at read. */
        await assert.rejects(run({driver: {requestBytes: Buffer.from("{}", "utf8")}}),
            /preflight request identity/iu);
    });

    /*
     * The order is the whole point: the guest proves it is the guest, installs the interception,
     * confirms the interception is actually active before anything could start the old payload, and
     * only then takes the containment away again.
     */
    it("proves containment authority before it risks an old-payload launch", async () => {
        const {observed, calls, written} = await run();
        assert.deepEqual(calls, [`read:${SEED_ROOT}\\preflight-request.json`, "boundary",
            "containment:Install", "listLaunchRecords", "containment:Remove",
            `write:${OUTPUT_ROOT}\\result.json`]);
        assert.equal(observed.calibration.kind, "myspeed-windows-msi-guest-containment-calibration");
        assert.equal(observed.calibration.bindingId, "authentic-1.6.0-default-msi");
        assert.equal(observed.calibration.productCode, PRODUCT_CODE);
        assert.equal(observed.calibration.msiSha256, MSI_SHA);
        assert.equal(observed.calibration.helperSha256, HELPER_SHA);
        assert.equal(observed.calibration.guestSerial, SERIAL);
        assert.equal(observed.calibration.nonce, NONCE);
        assert.equal(observed.calibration.qualifying, false);
        assert.deepEqual(observed.calibration.releaseGatesCleared, []);
        assert.equal(written.length, 1);
        assert.equal(written[0].toString("utf8"), JSON.stringify(observed.calibration));
        assert.equal(observed.identity.sha256, digestOf(observed.calibration));
    });

    it("refuses to continue when the Install never made the interception active", async () => {
        const built = envelope();
        const written = [];
        const {calls, dependencies} = driver({requestBytes: built.bytes, written,
            installProof: proof("Install", {ifeoActive: false})});
        await assert.rejects(executeWindowsMsiGuestPreflightEnvelope(built.envelope, dependencies),
            /interception|containment authority/iu);
        /* Nothing was read and nothing was written: the run stopped before the history existed. */
        assert.equal(calls.includes("listLaunchRecords"), false);
        assert.equal(calls.includes("containment:Remove"), false);
        assert.deepEqual(written, []);
    });

    it("carries the raw launch history and never counts an interception as an execution", async () => {
        const {observed} = await run({driver: {records: listed(2140, 2216)}});
        assert.deepEqual(observed.calibration.launchRecords.map(record => record.processId), [2140, 2216]);
        for (const record of observed.calibration.launchRecords) {
            assert.equal(record.intercepted, true);
            assert.equal(record.kind, "myspeed-windows-msi-guest-containment-launch");
            assert.equal(record.sha256, sha256(launchRecordBytes(record.processId)));
            assert.equal(record.bytes, String(launchRecordBytes(record.processId).length));
            assert.equal(record.name, recordName(record.processId));
        }
        assert.equal(observed.calibration.install.oldPayloadExecutionCount, 0);
        assert.equal(observed.calibration.remove.oldPayloadExecutionCount, 0);
        /* An empty history is retained as an empty history, never as an absent one. */
        const empty = await run({driver: {records: []}});
        assert.deepEqual(empty.observed.calibration.launchRecords, []);
    });

    /*
     * A record that says the launch was not intercepted is the old payload having run, and a helper
     * that reports an execution is the same thing. Neither may be renamed into the other.
     */
    it("fails closed when the old payload actually executed", async () => {
        const executed = Buffer.from(JSON.stringify({schemaVersion: 1,
            kind: "myspeed-windows-msi-guest-containment-launch", nonce: NONCE, processId: 2140,
            intercepted: false}), "utf8");
        await assert.rejects(run({driver: {records: [
            {name: recordName(2140), bytes: executed}]}}), /intercept/iu);
        await assert.rejects(run({driver: {
            installProof: proof("Install", {oldPayloadExecutionCount: 1})}}), /execution/iu);
        await assert.rejects(run({driver: {
            removeProof: proof("Remove", {oldPayloadExecutionCount: 2})}}), /execution/iu);
    });

    it("fails closed on a foreign guest, a helper failure or a drifting inventory", async () => {
        await assert.rejects(run({driver: {operationsFactory: () => ({
            boundary: async () => ({serial: "5".repeat(32)}),
            containment: async () => proof("Install"), listLaunchRecords: async () => []})}}),
        /guest/iu);
        await assert.rejects(run({driver: {installProof: proof("Install", {status: "failed"})}}),
            /containment/iu);
        await assert.rejects(run({driver: {removeProof: proof("Remove", {ifeoActive: true})}}),
            /containment/iu);
        await assert.rejects(run({driver: {removeProof: proof("Remove", {registryRestored: false})}}),
            /containment/iu);
        /* The inventory digest changing between Install and Remove means something launched after. */
        await assert.rejects(run({driver: {
            removeProof: proof("Remove", {launchInventorySha256: "9".repeat(64)})}}),
        /inventory/iu);
        /* And a helper that threw is preserved, not turned into a quiet empty calibration. */
        await assert.rejects(run({driver: {operationsFactory: () => ({
            boundary: async () => ({serial: SERIAL}),
            containment: async () => { throw new Error("MSI guest containment helper failed"); },
            listLaunchRecords: async () => []})}}), /containment helper failed/u);
    });

    it("bounds the retained calibration and the launch history it carries", async () => {
        await assert.rejects(run({driver: {records: Array.from({length: 257}, (_value, index) =>
            ({name: recordName(index + 1), bytes: launchRecordBytes(index + 1)}))}}),
        /bound|history/iu);
        await assert.rejects(run({envelope: {limits: {inputBytes: 1_048_576, resultBytes: 8}}}),
            /bound|result/iu);
    });

    /*
     * The helper reports the digest it took over its own listing. Accepting two such values merely
     * because they agree with each other binds nothing: any common value passes, and the history
     * retained beside them is never checked against either. So the inventory is recomputed here from
     * the records this executor actually read, and both proofs have to equal it.
     */
    it("binds both containment proofs to the inventory of the records it read", async () => {
        const {observed} = await run();
        assert.equal(observed.calibration.install.launchInventorySha256, inventoryOf(DEFAULT_RECORDS));
        assert.equal(observed.calibration.remove.launchInventorySha256, inventoryOf(DEFAULT_RECORDS));
        assert.equal(sha256(canonicalizeWindowsMsiGuestLaunchInventory(
            observed.calibration.launchRecords)), inventoryOf(DEFAULT_RECORDS));
        /* An empty history canonicalizes to the empty array, which is what the helper hashes. */
        assert.equal(canonicalizeWindowsMsiGuestLaunchInventory([]).toString("utf8"), "[]");
        assert.equal(canonicalizeWindowsMsiGuestLaunchInventory([{name: recordName(7), bytes: "118",
            sha256: "a".repeat(64)}]).toString("utf8"),
        `[{"name":"${recordName(7)}","bytes":118,"sha256":"${"a".repeat(64)}"}]`);
    });

    it("refuses a shared proof digest that no read record produces", async () => {
        /* A single arbitrary value in both proofs used to pass; it is now refused on its own. */
        const forged = "b".repeat(64);
        await assert.rejects(run({driver: {installProof: proof("Install", {launchInventorySha256: forged}),
            removeProof: proof("Remove", {launchInventorySha256: forged})}}), /inventory/iu);
        /* Same records, different order: the helper's digest is over an ordered list. */
        await assert.rejects(run({driver: {records: listed(2216, 2140),
            installProof: proof("Install", {}, listed(2140, 2216)),
            removeProof: proof("Remove", {}, listed(2140, 2216))}}), /inventory/iu);
        /* A record of a different size, and one whose bytes hash to something else. */
        const resized = [{name: recordName(2140), bytes: Buffer.from(JSON.stringify({schemaVersion: 1,
            kind: "myspeed-windows-msi-guest-containment-launch", nonce: NONCE, processId: 21_400,
            intercepted: true}), "utf8")}];
        await assert.rejects(run({driver: {records: resized,
            installProof: proof("Install", {}, DEFAULT_RECORDS),
            removeProof: proof("Remove", {}, DEFAULT_RECORDS)}}), /inventory/iu);
        await assert.rejects(run({driver: {records: DEFAULT_RECORDS,
            installProof: proof("Install", {}, listed(2141)),
            removeProof: proof("Remove", {}, listed(2141))}}), /inventory/iu);
    });

    it("refuses a launch record that another run's nonce named", async () => {
        await assert.rejects(run({driver: {records: [{name: "containment-launch-2140.json",
            bytes: launchRecordBytes(2140)}]}}), /launch record name/iu);
        await assert.rejects(run({driver: {records: [
            {name: `containment-launch-${"1".repeat(32)}-2140.json`, bytes: launchRecordBytes(2140)}]}}),
        /launch record name/iu);
    });
});
