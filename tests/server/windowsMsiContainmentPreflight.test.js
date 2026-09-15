import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, it} from "node:test";

import {inspectWindowsMsiPrerequisiteEvidence} from
    "../../scripts/qualification/windows-msi-prerequisite-evidence.mjs";
import {buildWindowsMsiContainmentPreflightRequest, runWindowsMsiContainmentPreflight,
    WINDOWS_MSI_CONTAINMENT_PREFLIGHT} from
    "../../scripts/qualification/windows-msi-containment-preflight.mjs";
import {createWindowsMsiContainmentCalibrationDocument, createWindowsMsiContainmentLaunchRecord}
    from "../helpers/windows-msi-prerequisite-evidence-fixture.mjs";

const NONCE = "9".repeat(32);
const GUEST_SERIAL = "7".repeat(32);
const PRODUCT_CODE = "{0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0}";
const MSI_SHA = "a".repeat(64);
const HELPER_SHA = "c".repeat(64);
const TASK_ROOT = `/home/runner/work/_temp/myspeed-windows-msi-${NONCE}`;

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

const CONTEXT = Object.freeze({repository: "i7Gamer/MySpeed", sourceSha: "1".repeat(40),
    eventSha: "2".repeat(40), runId: "34900000001", runAttempt: "1", nonce: NONCE});

/*
 * The two identities the preflight is allowed to expect come from somewhere else entirely: the MSI
 * digest from the observed preparation artifact, the helper digest from the sealed execution
 * closure. Neither is a value the preflight or the guest may choose.
 */
const expected = (overrides = {}) => ({productCode: PRODUCT_CODE,
    msi: {source: "observed-preparation", path: `${TASK_ROOT}/appassets/MySpeed-1.6.0.msi`,
        bytes: "4194304", sha256: MSI_SHA},
    helper: {source: "sealed-closure",
        path: "scripts/qualification/windows-msi-guest-containment.ps1", bytes: "20480",
        sha256: HELPER_SHA},
    ...overrides});

const base = () => ({path: `${TASK_ROOT}/installed-base.qcow2`, bytes: "8589934592",
    sha256: "b".repeat(64), device: "2049", inode: "1234567"});

const request = (overrides = {}) => buildWindowsMsiContainmentPreflightRequest({context: CONTEXT,
    taskRoot: TASK_ROOT, guestSerial: GUEST_SERIAL, expected: expected(), ...overrides});

const calibration = (overrides = {}) => createWindowsMsiContainmentCalibrationDocument(
    {guestSerial: GUEST_SERIAL, nonce: NONCE, productCode: PRODUCT_CODE, msiSha256: MSI_SHA,
        helperSha256: HELPER_SHA, ...overrides});

const guestBytes = value => Buffer.from(JSON.stringify(value), "utf8");

const operations = (overrides = {}) => {
    const calls = [];
    const record = (name, value) => { calls.push(name); return value; };
    return {calls, operations: {
        inspectBase: ({phase}) => record(`inspectBase:${phase}`, base()),
        createOverlay: ({preflight}) => record("createOverlay",
            {path: preflight.overlayPath, backing: base().path, bytes: "262144",
                sha256: "e".repeat(64), receiptSha256: "f".repeat(64)}),
        prepareMedia: ({preflight}) => record("prepareMedia",
            {seedIso: preflight.seedIsoPath, outputDisk: preflight.outputDiskPath,
                seedSha256: "1".repeat(64), outputBefore: {path: preflight.outputDiskPath,
                    bytes: "1048576", sha256: "2".repeat(64)}}),
        launchPreflight: () => record("launchPreflight",
            {argvSha256: "3".repeat(64), groupZero: true, exitCode: 0, timedOut: false,
                forced: false, processTreeExitProven: true}),
        readGuestResult: () => record("readGuestResult", {bytes: guestBytes(calibration())}),
        cleanupOverlay: ({groupZero}) => record("cleanupOverlay",
            {removed: true, groupZeroBeforeRemoval: groupZero}),
        ...overrides}};
};

describe("Windows MSI containment preflight", () => {
    it("publishes the prerequisite it produces and the binding it is allowed to produce it for", () => {
        assert.equal(WINDOWS_MSI_CONTAINMENT_PREFLIGHT.prerequisiteId, "authentic-old-ifeo-containment");
        assert.equal(WINDOWS_MSI_CONTAINMENT_PREFLIGHT.bindingId, "authentic-1.6.0-default-msi");
        assert.equal(WINDOWS_MSI_CONTAINMENT_PREFLIGHT.calibrationKind,
            "myspeed-windows-msi-guest-containment-calibration");
        assert.equal(WINDOWS_MSI_CONTAINMENT_PREFLIGHT.producer, "in-guest-calibration");
    });

    it("builds a disposable preflight request that never names the reusable base as its target", () => {
        const value = request();
        assert.equal(value.kind, "myspeed-windows-msi-containment-preflight-request");
        assert.equal(value.nonce, NONCE);
        assert.equal(value.guestSerial, GUEST_SERIAL);
        assert.equal(value.qualifying, false);
        assert.deepEqual(value.releaseGatesCleared, []);
        assert.equal(value.overlayPath, `${TASK_ROOT}/containment-preflight/overlay.qcow2`);
        assert.notEqual(value.overlayPath, base().path);
        assert.deepEqual(value.expected, expected());
        assert.throws(() => request({guestSerial: "not-a-serial"}), /guest serial/iu);
        assert.throws(() => request({expected: expected({msi: {...expected().msi, source: "guest"}})}),
            /independently|source/iu);
        assert.throws(() => request({expected: expected({helper: {...expected().helper,
            source: "guest"}})}), /independently|source/iu);
    });

    /*
     * The rows that need this prerequisite are rows eleven to fourteen, so the preflight has to run
     * before any of them, on its own throwaway overlay, and leave the installed base byte-identical.
     */
    it("runs the preflight on its own overlay and proves the base is untouched", async () => {
        const {calls, operations: injected} = operations();
        const observed = await runWindowsMsiContainmentPreflight({request: request()}, injected);
        assert.deepEqual(calls, ["inspectBase:before", "createOverlay", "prepareMedia",
            "launchPreflight", "readGuestResult", "cleanupOverlay", "inspectBase:after"]);
        assert.equal(observed.calibration.kind, "myspeed-windows-msi-guest-containment-calibration");
        assert.equal(observed.overlayCleanup.removed, true);
        assert.equal(observed.overlayCleanup.groupZeroBeforeRemoval, true);
        assert.deepEqual(observed.baseAfter, observed.baseBefore);
        assert.equal(observed.retained.sha256, sha256(guestBytes(calibration())));
        /* And the record it emits is one the production prerequisite inspector accepts as it stands. */
        const inspected = inspectWindowsMsiPrerequisiteEvidence({name: "oldContainment",
            value: observed.record, context: CONTEXT});
        assert.equal(inspected.sha256, observed.retained.sha256);
        assert.equal(inspected.semantics.interceptedLaunchCount, 1);
        assert.equal(inspected.semantics.oldPayloadExecutionCount, 0);
    });

    it("refuses a guest calibration that drifted from the independently bound identities", async () => {
        const cases = {
            "MSI digest the guest chose": {msiSha256: "d".repeat(64)},
            "helper digest the guest chose": {helperSha256: "d".repeat(64)},
            "product code the guest chose": {productCode: "{11111111-2222-3333-4444-555555555555}"},
            "another guest's serial": {guestSerial: "6".repeat(32)},
            "another run's nonce": {nonce: "8".repeat(32)},
            "a binding that is not the authentic 1.6.0 default MSI":
                {bindingId: "authentic-1.1.0-msi-with-destination-data"},
            "an old payload that actually ran":
                {launchRecords: [createWindowsMsiContainmentLaunchRecord(11, {intercepted: false},
                    NONCE)]}
        };
        for (const [name, overrides] of Object.entries(cases)) {
            const {operations: injected} = operations({
                readGuestResult: () => ({bytes: guestBytes(calibration(overrides))})});
            await assert.rejects(runWindowsMsiContainmentPreflight({request: request()}, injected),
                /containment/iu, name);
        }
    });

    /*
     * The preflight is a QEMU row like any other: its overlay is removed only after group zero was
     * proven, a launch that never proved it fails the preflight rather than being cleaned up
     * quietly, and a base that moved fails it even when the guest was happy.
     */
    it("fails closed on an unproven launch, a failed cleanup or a moved base", async () => {
        for (const [name, overrides] of Object.entries({
            "launch that never proved group zero": {launchPreflight: () => ({argvSha256: "3".repeat(64),
                groupZero: false, exitCode: 0, timedOut: false, forced: false,
                processTreeExitProven: true})},
            "launch that was forced": {launchPreflight: () => ({argvSha256: "3".repeat(64),
                groupZero: true, exitCode: 0, timedOut: false, forced: true,
                processTreeExitProven: true})},
            "launch that timed out": {launchPreflight: () => ({argvSha256: "3".repeat(64),
                groupZero: true, exitCode: 0, timedOut: true, forced: false,
                processTreeExitProven: true})},
            "overlay that was not removed": {cleanupOverlay: () => ({removed: false,
                groupZeroBeforeRemoval: true})},
            "cleanup that disagrees about group zero": {cleanupOverlay: () => ({removed: true,
                groupZeroBeforeRemoval: false})},
            "base that moved under the preflight": (() => { let phase = 0;
                return {inspectBase: () => { phase += 1;
                    return phase === 1 ? base() : {...base(), sha256: "9".repeat(64)}; }}; })()
        })) {
            const {operations: injected} = operations(overrides);
            await assert.rejects(runWindowsMsiContainmentPreflight({request: request()}, injected),
                /preflight|base/iu, name);
        }
    });

    it("removes the overlay even when the guest result is unusable, and reports the guest failure", async () => {
        const {calls, operations: injected} = operations({
            readGuestResult: () => { throw new Error("guest result unreadable"); }});
        await assert.rejects(runWindowsMsiContainmentPreflight({request: request()}, injected),
            /guest result unreadable/u);
        assert.ok(calls.includes("cleanupOverlay"), "the overlay was left behind");
    });
});
