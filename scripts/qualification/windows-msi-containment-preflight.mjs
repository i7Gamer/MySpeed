/*
 * The in-guest containment preflight: the producer for `authentic-old-ifeo-containment`.
 *
 * Rows eleven to fourteen of the matrix name this prerequisite, and the containment helper that
 * satisfies it only ever ran *inside* those rows - which is to say, it never ran before the rows that
 * need it. This runs it once, first, on a throwaway overlay of the installed base: the helper's
 * Install puts the IFEO interception in place against the authentic 1.6.0 default MSI, its Remove
 * takes the owned registry state away again, and both results plus the raw launch history are
 * retained as one `myspeed-windows-msi-guest-containment-calibration` document bound to this run and
 * this guest.
 *
 * Two things the guest is not allowed to decide. The MSI digest comes from the observed preparation
 * artifact and the helper digest comes from the sealed execution closure, so both are supplied here
 * from evidence produced elsewhere and the guest's document has to agree with them; a calibration
 * that carries SHA-shaped strings of its own choosing proves nothing about which MSI was contained.
 *
 * Two things this is careful never to conflate. A `containment-launch-*.json` record is the IFEO
 * *stub* having run in place of the old payload - a blocked launch attempt. It is never an execution,
 * and the count of them is never written into `oldPayloadExecutionCount`. That distinction lives in
 * the prerequisite inspector, which this hands its result to unchanged.
 *
 * Nothing here executes anything: every operation arrives injected, exactly as the matrix host's do.
 */
import {createHash} from "node:crypto";

import {inspectWindowsMsiPrerequisiteEvidence} from "./windows-msi-prerequisite-evidence.mjs";

const SCHEMA_VERSION = 1;
const REQUEST_KIND = "myspeed-windows-msi-containment-preflight-request";
const CALIBRATION_KIND = "myspeed-windows-msi-guest-containment-calibration";
const RECORD_KIND = "myspeed-windows-msi-prerequisite-evidence";
const PREREQUISITE_ID = "authentic-old-ifeo-containment";
const BINDING_ID = "authentic-1.6.0-default-msi";
const PRODUCER = "in-guest-calibration";

/* The preflight's own subtree of the task root; the reusable base is never written inside it. */
const PREFLIGHT_DIRECTORY = "containment-preflight";
const MAX_CALIBRATION_BYTES = 65_536;

/*
 * Where each expected identity had to come from. The guest may not supply either, and a request that
 * names any other origin is refused before a disposable guest is started.
 */
const MSI_SOURCE = "observed-preparation";
const HELPER_SOURCE = "sealed-closure";

const SHA256 = /^[0-9a-f]{64}$/u;
const NONCE = /^[0-9a-f]{32}$/u;
const DECIMAL = /^[1-9][0-9]{0,19}$/u;
const PRODUCT_CODE = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/u;
const POSIX_PATH = /^\/[^\0]{1,1024}$/u;
const CLOSURE_PATH = /^scripts\/(?:qualification|release)\/[A-Za-z0-9._-]{1,128}$/u;

export const WINDOWS_MSI_CONTAINMENT_PREFLIGHT = Object.freeze({
    prerequisiteId: PREREQUISITE_ID,
    bindingId: BINDING_ID,
    producer: PRODUCER,
    requestKind: REQUEST_KIND,
    calibrationKind: CALIBRATION_KIND,
    directory: PREFLIGHT_DIRECTORY,
    maximumCalibrationBytes: MAX_CALIBRATION_BYTES
});

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

const exactKeys = (value, keys, label) => {
    if (!isObject(value)) throw new TypeError(`${label} differs`);
    const actual = Object.keys(value).sort();
    const wanted = [...keys].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
        throw new TypeError(`${label} differs`);
    return value;
};

const exactString = (value, label, pattern) => {
    if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} differs`);
    return value;
};

const bool = (value, wanted, label) => {
    if (typeof value !== "boolean" || value !== wanted) throw new Error(`${label} differs`);
    return value;
};

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

const assertExpectedIdentities = expected => {
    exactKeys(expected, ["productCode", "msi", "helper"], "Containment preflight expected identities");
    exactString(expected.productCode, "Containment preflight product code", PRODUCT_CODE);
    exactKeys(expected.msi, ["source", "path", "bytes", "sha256"], "Containment preflight MSI identity");
    if (expected.msi.source !== MSI_SOURCE)
        throw new Error("Containment preflight MSI identity must come independently from the"
            + " observed preparation");
    exactString(expected.msi.path, "Containment preflight MSI path", POSIX_PATH);
    exactString(expected.msi.bytes, "Containment preflight MSI size", DECIMAL);
    exactString(expected.msi.sha256, "Containment preflight MSI digest", SHA256);
    exactKeys(expected.helper, ["source", "path", "bytes", "sha256"],
        "Containment preflight helper identity");
    if (expected.helper.source !== HELPER_SOURCE)
        throw new Error("Containment preflight helper identity must come independently from the"
            + " sealed closure");
    exactString(expected.helper.path, "Containment preflight helper path", CLOSURE_PATH);
    exactString(expected.helper.bytes, "Containment preflight helper size", DECIMAL);
    exactString(expected.helper.sha256, "Containment preflight helper digest", SHA256);
    return structuredClone(expected);
};

export const buildWindowsMsiContainmentPreflightRequest = ({context, taskRoot, guestSerial, expected}) => {
    if (!isObject(context)) throw new TypeError("Containment preflight context differs");
    exactString(context.nonce, "Containment preflight context nonce", NONCE);
    exactString(taskRoot, "Containment preflight task root", POSIX_PATH);
    exactString(guestSerial, "Containment preflight guest serial", NONCE);
    const root = `${taskRoot}/${PREFLIGHT_DIRECTORY}`;
    return Object.freeze({schemaVersion: SCHEMA_VERSION, kind: REQUEST_KIND, qualifying: false,
        repository: context.repository, sourceSha: context.sourceSha, eventSha: context.eventSha,
        runId: context.runId, runAttempt: context.runAttempt, nonce: context.nonce, guestSerial,
        bindingId: BINDING_ID, root, overlayPath: `${root}/overlay.qcow2`,
        seedIsoPath: `${root}/seed.iso`, outputDiskPath: `${root}/output.img`,
        expected: assertExpectedIdentities(expected), releaseGatesCleared: Object.freeze([])});
};

const assertLaunch = launch => {
    exactKeys(launch, ["argvSha256", "groupZero", "exitCode", "timedOut", "forced",
        "processTreeExitProven"], "Containment preflight launch");
    exactString(launch.argvSha256, "Containment preflight launch argv", SHA256);
    bool(launch.timedOut, false, "Containment preflight launch timeout");
    bool(launch.forced, false, "Containment preflight launch termination");
    bool(launch.processTreeExitProven, true, "Containment preflight launch process tree exit");
    if (launch.exitCode !== 0) throw new Error("Containment preflight launch exit code differs");
    /*
     * Group zero is what proves the QEMU process and its whole group are gone. It is read from the
     * launch observation and never inferred from the absence of a thrown error.
     */
    bool(launch.groupZero, true, "Containment preflight launch group zero");
    return launch;
};

const decodeCalibration = bytes => {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_CALIBRATION_BYTES)
        throw new Error("Containment preflight guest result differs");
    let parsed;
    try { parsed = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)); }
    catch { throw new Error("Containment preflight guest result differs"); }
    if (!isObject(parsed) || parsed.kind !== CALIBRATION_KIND)
        throw new Error("Containment preflight guest result differs");
    return parsed;
};

/*
 * The guest returned a calibration; this is where it is held to the identities it was never allowed
 * to choose. The replay of the containment semantics themselves - the IFEO state, the registry
 * restoration, the launch history and the execution count - belongs to the prerequisite inspector,
 * so the record is handed to it rather than re-checked here in a second, divergent copy.
 */
const bindCalibration = (parsed, request) => {
    for (const [name, wanted] of [["productCode", request.expected.productCode],
        ["msiSha256", request.expected.msi.sha256], ["helperSha256", request.expected.helper.sha256],
        ["guestSerial", request.guestSerial], ["nonce", request.nonce],
        ["bindingId", request.bindingId]])
        if (parsed[name] !== wanted)
            throw new Error(`Containment preflight calibration ${name} differs from its bound identity`);
    return parsed;
};

export const runWindowsMsiContainmentPreflight = async ({request}, operations) => {
    exactKeys(operations, ["inspectBase", "createOverlay", "prepareMedia", "launchPreflight",
        "readGuestResult", "cleanupOverlay"], "Containment preflight operations");
    const baseBefore = await operations.inspectBase({request, phase: "before"});
    let overlay = null;
    let media = null;
    let launch = null;
    let groupZero = false;
    let retainedBytes = null;
    let primaryFailure = null;
    try {
        overlay = await operations.createOverlay({request, preflight: request, base: baseBefore});
        if (!isObject(overlay) || overlay.path !== request.overlayPath)
            throw new Error("Containment preflight overlay differs");
        if (overlay.path === baseBefore?.path)
            throw new Error("Containment preflight overlay is the reusable base");
        media = await operations.prepareMedia({request, preflight: request, overlay});
        launch = assertLaunch(await operations.launchPreflight({request, preflight: request, overlay,
            media}));
        groupZero = true;
        const retained = await operations.readGuestResult({request, overlay, media, launch});
        if (!isObject(retained)) throw new Error("Containment preflight guest result differs");
        retainedBytes = retained.bytes;
    } catch (error) { primaryFailure = error; }
    /*
     * Cleanup runs whatever happened above, and its contract is checked in the same guarded region
     * so a preflight that failed before the launch reports the overlay or media error that stopped
     * it rather than a cleanup disagreement standing in for the cause.
     */
    let overlayCleanup = null;
    let cleanupFailure = null;
    try {
        overlayCleanup = await operations.cleanupOverlay({request, overlay, media, launch, groupZero});
        if (!isObject(overlayCleanup) || overlayCleanup.removed !== true
            || overlayCleanup.groupZeroBeforeRemoval !== groupZero)
            throw new Error("Containment preflight overlay cleanup differs");
    } catch (error) { cleanupFailure = error; }
    if (cleanupFailure !== null) {
        if (primaryFailure !== null)
            throw new AggregateError([primaryFailure, cleanupFailure],
                "Containment preflight and its cleanup failed");
        throw cleanupFailure;
    }
    if (primaryFailure !== null) throw primaryFailure;
    const parsed = bindCalibration(decodeCalibration(retainedBytes), request);
    const baseAfter = await operations.inspectBase({request, phase: "after"});
    if (JSON.stringify(baseAfter) !== JSON.stringify(baseBefore))
        throw new Error("Containment preflight changed the reusable base");
    const retained = {bytes: String(retainedBytes.length), sha256: sha256(retainedBytes),
        bytesBase64: retainedBytes.toString("base64")};
    const record = {schemaVersion: SCHEMA_VERSION, kind: RECORD_KIND, prerequisiteId: PREREQUISITE_ID,
        producer: PRODUCER,
        provenance: {repository: request.repository, sourceSha: request.sourceSha,
            eventSha: request.eventSha, runId: request.runId, runAttempt: request.runAttempt,
            nonce: request.nonce, guestSerial: request.guestSerial},
        document: retained};
    /*
     * The record is put through the production inspector here, so a preflight can never emit a
     * document the matrix would later refuse.
     */
    const inspected = inspectWindowsMsiPrerequisiteEvidence({name: "oldContainment", value: record,
        context: {repository: request.repository, sourceSha: request.sourceSha,
            eventSha: request.eventSha, runId: request.runId, runAttempt: request.runAttempt,
            nonce: request.nonce}});
    return Object.freeze({calibration: parsed, record, retained, semantics: inspected.semantics,
        baseBefore, baseAfter, overlay, media, launch, overlayCleanup,
        qualifying: false, releaseGatesCleared: Object.freeze([])});
};
