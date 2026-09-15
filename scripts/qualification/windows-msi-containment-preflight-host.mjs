/*
 * The concrete host operations for the containment preflight.
 *
 * The matrix host's own factory cannot serve here: `validateWindowsMsiLifecycleHostRequest` requires
 * exactly fourteen rows, and a one-row matrix invented to slip past it would be a lie about what ran.
 * So this drives the same primitives directly - the same QEMU vector with the same forbidden-backend
 * guard, the same file inspector, the same owned-command runner, the same monitored launcher - for a
 * single disposable overlay that is not a row and does not pretend to be one.
 *
 * What the preflight is for is the order. The containment helper that rows eleven to fourteen depend
 * on has only ever run inside those rows, which is to say never before the rows that need it. This
 * boots one throwaway overlay of the sealed installed base, lets the helper install the IFEO
 * interception against the authentic 1.6.0 default MSI and take it away again, and brings back the
 * calibration the rows name as their prerequisite.
 *
 * Nothing here executes anything: the filesystem, the owned-command runner and the QEMU launcher all
 * arrive injected, exactly as the matrix host's do.
 */
import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {assertSuccessfulWindowsMsiHostProcess, composeWindowsMsiHostQemuArguments,
    createWindowsMsiHostFileInspector, parseWindowsMsiHostJson} from
    "./linux-windows-msi-lifecycle-host.mjs";
import {createHostedQemuProcessLauncher, runHostedOwnedProcess} from
    "./linux-windows-cpu-floor-stage2-hosted.mjs";
import {renderWindowsMsiGuestBootstrap, WINDOWS_MSI_GUEST_BOOTSTRAP_STAGES} from
    "./windows-msi-guest-bootstrap.mjs";
import {WINDOWS_MSI_GUEST_PREFLIGHT_SEED_FILE_NAMES} from "./windows-msi-guest-seed-documents.mjs";
import {WINDOWS_MSI_CONTAINMENT_PREFLIGHT} from "./windows-msi-containment-preflight.mjs";

const SCHEMA_VERSION = 1;
const GUEST_REQUEST_KIND = "myspeed-windows-msi-guest-containment-preflight-request";
const SEED_MANIFEST_NAME = "seed-manifest.json";
const BOOTSTRAP_NAME = "bootstrap.ps1";
const SEED_VOLUME_LABEL = "MYSPEEDSEED";
const OUTPUT_VOLUME_LABEL = "MYSPEEDOUT";
const GUEST_SEED_PREFIX = "C:\\Windows\\Temp\\myspeed-msi-input-";
const GUEST_OUTPUT_PREFIX = "C:\\Windows\\Temp\\myspeed-msi-output-";
const GUEST_NONCE_LABEL = "containment-preflight";
const NONCE_CHARACTERS = 32;
const COMMAND_MILLISECONDS = 120_000;
const MAX_COMMAND_STREAM_BYTES = 65_536;
const MAX_GUEST_RESULT_BYTES = 65_536;
const MAX_LAUNCH_RECORDS = 64;
const RESERVATION_MEMBERS = Object.freeze(["reserve", "commandMilliseconds",
    "cleanupCommandMilliseconds", "admitLaunch"]);
const FILE_WRITE_BITS = 0o222;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

const SHA256 = /^[0-9a-f]{64}$/u;
const NONCE = /^[0-9a-f]{32}$/u;
const DECIMAL = /^[1-9][0-9]{0,19}$/u;
const SEED_FILE_NAME = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

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

/*
 * The preflight guest is not this job's own nonce and is not any row's. It is derived from this run's
 * nonce so it is reproducible from the request alone, and it is what the guest's BIOS serial is
 * stamped with and checked against.
 */
const deriveGuestNonce = nonce => sha256(Buffer.from(
    `${exactString(nonce, "MSI containment preflight host nonce", NONCE)}\0${GUEST_NONCE_LABEL}`,
    "utf8")).slice(0, NONCE_CHARACTERS);

export const WINDOWS_MSI_CONTAINMENT_PREFLIGHT_HOST = Object.freeze({
    deriveGuestNonce,
    guestRequestKind: GUEST_REQUEST_KIND,
    seedManifestName: SEED_MANIFEST_NAME,
    seedManifestKind: WINDOWS_MSI_GUEST_BOOTSTRAP_STAGES.preflightSeedKind,
    bootstrapName: BOOTSTRAP_NAME,
    maximumGuestResultBytes: MAX_GUEST_RESULT_BYTES,
    maximumLaunchRecords: MAX_LAUNCH_RECORDS
});

/*
 * The guest's own request. Every identity in it was produced somewhere the guest has no reach into:
 * the MSI digest by the observed preparation, the helper digest by the sealed closure, the serial by
 * this host. The guest may agree with them or fail; it may not choose them.
 */
export const buildWindowsMsiContainmentPreflightGuestRequest = input => {
    exactKeys(input, ["context", "request", "powershell", "qemuLaunchSha256"],
        "MSI containment preflight guest request input");
    const {context, request} = input;
    if (!isObject(context) || !isObject(request))
        throw new TypeError("MSI containment preflight guest request input differs");
    if (request.kind !== WINDOWS_MSI_CONTAINMENT_PREFLIGHT.requestKind)
        throw new TypeError("MSI containment preflight request differs");
    exactString(input.qemuLaunchSha256, "MSI containment preflight guest QEMU launch digest", SHA256);
    exactKeys(input.powershell, ["path", "bytes", "sha256"],
        "MSI containment preflight guest PowerShell");
    exactString(input.powershell.sha256, "MSI containment preflight guest PowerShell digest", SHA256);
    const serial = exactString(request.guestSerial, "MSI containment preflight guest serial", NONCE);
    const seedRoot = `${GUEST_SEED_PREFIX}${serial}`;
    const outputRoot = `${GUEST_OUTPUT_PREFIX}${serial}`;
    return Object.freeze({schemaVersion: SCHEMA_VERSION, kind: GUEST_REQUEST_KIND, qualifying: false,
        sourceSha: context.sourceSha, eventSha: context.eventSha, runId: context.runId,
        runAttempt: context.runAttempt, nonce: context.nonce, bindingId: request.bindingId,
        guest: {serial, cpuEvidenceSha256: sha256(Buffer.from(request.bindingId, "utf8")),
            qemuLaunchSha256: input.qemuLaunchSha256, seedRoot, outputRoot},
        msi: {path: `${seedRoot}\\${request.bindingId}.msi`,
            bytes: Number(request.expected.msi.bytes), sha256: request.expected.msi.sha256,
            productCode: request.expected.productCode},
        helper: {path: `${seedRoot}\\${path.posix.basename(request.expected.helper.path)}`,
            bytes: Number(request.expected.helper.bytes), sha256: request.expected.helper.sha256},
        tools: {powershell: {path: input.powershell.path, sha256: input.powershell.sha256}},
        limits: {launchRecords: MAX_LAUNCH_RECORDS, resultBytes: MAX_GUEST_RESULT_BYTES},
        releaseGatesCleared: Object.freeze([])});
};

const validateHost = value => {
    exactKeys(value, ["context", "privilegeMode", "toolchain", "baseImage", "limits"],
        "MSI containment preflight host binding");
    exactKeys(value.baseImage, ["path", "bytes", "sha256", "ownership"],
        "MSI containment preflight base image");
    exactString(value.baseImage.sha256, "MSI containment preflight base image digest", SHA256);
    exactString(value.baseImage.bytes, "MSI containment preflight base image size", DECIMAL);
    exactKeys(value.limits, ["outputDiskBytes"], "MSI containment preflight limits");
    if (!Number.isSafeInteger(value.limits.outputDiskBytes) || value.limits.outputDiskBytes < 1)
        throw new TypeError("MSI containment preflight output disk bound differs");
    return value;
};

const validateSeed = (value, request) => {
    exactKeys(value, ["documents", "files", "request"], "MSI containment preflight seed");
    exactKeys(value.documents, ["preflightRequest", "envelope", "launcherRequest"],
        "MSI containment preflight seed documents");
    if (value.request !== request && JSON.stringify(value.request) !== JSON.stringify(request))
        throw new TypeError("MSI containment preflight seed request differs");
    if (!Array.isArray(value.files) || value.files.length < 1)
        throw new TypeError("MSI containment preflight seed files differ");
    const seen = new Set();
    for (const file of value.files) {
        exactKeys(file, ["name", "sourcePath", "bytes", "sha256"],
            "MSI containment preflight seed file");
        exactString(file.name, "MSI containment preflight seed file name", SEED_FILE_NAME);
        exactString(file.bytes, "MSI containment preflight seed file size", DECIMAL);
        exactString(file.sha256, "MSI containment preflight seed file digest", SHA256);
        if (seen.has(file.name)) throw new TypeError("MSI containment preflight seed file repeats");
        seen.add(file.name);
    }
    /* The helper and the MSI the preflight is about must actually be among the staged files. */
    for (const required of [`${request.bindingId}.msi`,
        path.posix.basename(request.expected.helper.path)])
        if (!seen.has(required))
            throw new TypeError(`MSI containment preflight seed omits ${required}`);
    return value;
};

/* The paths the preflight owns, all inside its own subtree of the task root. */
export const windowsMsiContainmentPreflightPaths = request => Object.freeze({
    root: request.root, overlayPath: request.overlayPath, seedIsoPath: request.seedIsoPath,
    outputDiskPath: request.outputDiskPath, seedRoot: `${request.root}/seed`,
    ovmfVarsPath: `${request.root}/OVMF_VARS.fd`, pidPath: `${request.root}/qemu.pid`,
    serialLogPath: `${request.root}/serial.log`,
    guestResultPath: `${request.root}/guest-result.json`});

/*
 * The digest of the vector that will carry this guest, computed before the vector exists. That is
 * only honest because the vector is a function of the toolchain and of paths the request already
 * fixes, so the value the guest is told to expect is the value the launch will produce.
 */
export const windowsMsiContainmentPreflightQemuLaunchSha256 = ({toolchain, request}) => {
    const paths = windowsMsiContainmentPreflightPaths(request);
    return sha256(Buffer.from(JSON.stringify(composeWindowsMsiHostQemuArguments({toolchain, paths,
        overlay: {path: paths.overlayPath},
        media: {seed: {path: paths.seedIsoPath}, outputBefore: {path: paths.outputDiskPath}},
        guestSerial: request.guestSerial})), "utf8"));
};

/*
 * The preflight is the one guest that boots before the matrix budget has admitted anything, so the
 * reservation is not optional: without it the shared launcher would fall through to its generic
 * per-row deadline and a six-hour job could be spent here before a row was constructed.
 */
const validateReservation = value => {
    if (!isObject(value) || RESERVATION_MEMBERS.some(name => typeof value[name] !== "function"))
        throw new TypeError("MSI containment preflight reservation differs");
    return value;
};

export const createWindowsMsiContainmentPreflightOperations = ({request, host: hostInput, seed: seedInput,
    reservation: reservationInput, dependencies = {}}) => {
    if (!isObject(request) || request.kind !== WINDOWS_MSI_CONTAINMENT_PREFLIGHT.requestKind)
        throw new TypeError("MSI containment preflight request differs");
    const reservation = validateReservation(reservationInput);
    const host = validateHost(hostInput);
    const seed = validateSeed(seedInput, request);
    const paths = windowsMsiContainmentPreflightPaths(request);
    const filesystem = dependencies.filesystem ?? fs;
    const runOwned = dependencies.runOwned ?? runHostedOwnedProcess;
    const inspectFile = dependencies.inspectFile ?? createWindowsMsiHostFileInspector(filesystem);
    const renderBootstrap = dependencies.renderBootstrap ?? renderWindowsMsiGuestBootstrap;
    /*
     * A hosted QEMU launcher stamps its execution budget when it is constructed, so it is built for
     * the launch rather than shared, exactly as each matrix row builds its own.
     */
    const createLauncher = () => dependencies.runQemu
        ?? createHostedQemuProcessLauncher({context: host.context,
            dependencies: dependencies.qemuDependencies});
    let owned = false;
    let launchAttempted = false;
    let monitored = null;
    /*
     * Everything before the launch is charged to the preflight's own allowance; everything after it
     * to the cleanup margin, which is what proving the group gone and reading its output is for. A
     * command is never given longer than whichever of those two still has time to give.
     */
    const invoke = (tool, argv, requested = COMMAND_MILLISECONDS) =>
        runOwned(host.toolchain.runtimeLoader.path,
            ["--library-path", host.toolchain.libraryPath.join(":"), tool.path, ...argv],
            {timeoutMs: launchAttempted ? reservation.cleanupCommandMilliseconds(requested)
                : reservation.commandMilliseconds(requested),
            maxStreamBytes: MAX_COMMAND_STREAM_BYTES});
    const checkTool = async (tool, label) => {
        const observed = await inspectFile(tool.path);
        if (observed.bytes !== tool.bytes || observed.sha256 !== tool.sha256
            || JSON.stringify(observed.ownership) !== JSON.stringify(tool.ownership))
            throw new Error(`MSI containment preflight ${label} identity changed`);
    };
    const writeExclusive = (target, bytes) => {
        const handle = filesystem.openSync(target, "wx", FILE_MODE);
        try { filesystem.writeFileSync(handle, bytes); filesystem.fsyncSync(handle); }
        finally { filesystem.closeSync(handle); }
    };
    const inspectExact = async expected => {
        const observed = await inspectFile(expected.path);
        if (observed.bytes !== String(expected.bytes) || observed.sha256 !== expected.sha256)
            throw new Error("MSI containment preflight copied file identity differs");
        return observed;
    };
    /*
     * Group zero: the QEMU process and its whole group are gone. It is read from the launch
     * observation, never inferred from the absence of a thrown error, and it is what separates
     * reading an output disk from reading one a live QEMU may still be writing.
     */
    const groupZeroObserved = () => monitored?.executionSucceeded === true
        && monitored.process?.treeGone === true && monitored.process.qemuPidAbsentAfter === true;
    return {
        async inspectBase() {
            const observed = await inspectExact(host.baseImage);
            if ((observed.mode & FILE_WRITE_BITS) !== 0)
                throw new Error("MSI containment preflight base image is writable");
            await checkTool(host.toolchain.qemuImg, "qemu-img");
            const info = parseWindowsMsiHostJson(assertSuccessfulWindowsMsiHostProcess(
                await invoke(host.toolchain.qemuImg, ["info", "--output=json", host.baseImage.path]),
                "MSI containment preflight base inspection").stdout,
            "MSI containment preflight base metadata");
            if (info.format !== "qcow2" || !Number.isSafeInteger(info["virtual-size"])
                || info["virtual-size"] < 1)
                throw new Error("MSI containment preflight base metadata differs");
            return {path: observed.path, bytes: observed.bytes, sha256: observed.sha256,
                format: "qcow2", ownership: observed.ownership,
                virtualBytes: String(info["virtual-size"]), sealedReadOnly: true};
        },
        async createOverlay() {
            if (filesystem.existsSync(paths.root))
                throw new Error("MSI containment preflight root already exists");
            filesystem.mkdirSync(paths.root, {recursive: false, mode: DIRECTORY_MODE});
            owned = true;
            await checkTool(host.toolchain.qemuImg, "qemu-img");
            assertSuccessfulWindowsMsiHostProcess(await invoke(host.toolchain.qemuImg,
                ["create", "-f", "qcow2", "-F", "qcow2", "-b", host.baseImage.path, paths.overlayPath]),
            "MSI containment preflight overlay creation");
            const info = parseWindowsMsiHostJson(assertSuccessfulWindowsMsiHostProcess(
                await invoke(host.toolchain.qemuImg, ["info", "--output=json", paths.overlayPath]),
                "MSI containment preflight overlay inspection").stdout,
            "MSI containment preflight overlay metadata");
            if (info.format !== "qcow2" || info["backing-filename"] !== host.baseImage.path)
                throw new Error("MSI containment preflight overlay metadata differs");
            const receipt = Buffer.from(JSON.stringify({path: paths.overlayPath, format: info.format,
                backingFilename: info["backing-filename"], backingBaseSha256: host.baseImage.sha256}),
            "utf8");
            return {path: paths.overlayPath, format: "qcow2",
                backingBaseSha256: host.baseImage.sha256, createNew: true,
                receiptSha256: sha256(receipt)};
        },
        async prepareMedia() {
            /*
             * Reserved before a byte of media is written, so a preflight the matrix could not have
             * followed costs the check rather than a seed ISO, an output disk and a booted guest.
             */
            reservation.reserve();
            if (!owned || filesystem.existsSync(paths.seedRoot))
                throw new Error("MSI containment preflight seed root ownership differs");
            filesystem.mkdirSync(paths.seedRoot, {recursive: false, mode: DIRECTORY_MODE});
            const copied = [];
            for (const document of [seed.documents.preflightRequest, seed.documents.envelope,
                seed.documents.launcherRequest]) {
                const target = `${paths.seedRoot}/${document.name}`;
                writeExclusive(target, Buffer.from(document.bytesBase64, "base64"));
                const observed = await inspectExact({path: target, bytes: document.bytes,
                    sha256: document.sha256});
                copied.push({name: document.name, bytes: Number(observed.bytes),
                    sha256: observed.sha256});
            }
            for (const source of seed.files) {
                await inspectExact({path: source.sourcePath, bytes: source.bytes,
                    sha256: source.sha256});
                const target = `${paths.seedRoot}/${source.name}`;
                const parent = path.posix.dirname(target);
                if (parent !== paths.seedRoot)
                    filesystem.mkdirSync(parent, {recursive: true, mode: DIRECTORY_MODE});
                filesystem.copyFileSync(source.sourcePath, target, filesystem.constants.COPYFILE_EXCL);
                const observed = await inspectExact({path: target, bytes: source.bytes,
                    sha256: source.sha256});
                copied.push({name: source.name, bytes: Number(observed.bytes),
                    sha256: observed.sha256});
            }
            /*
             * The preflight's own seed manifest. It is not a row seed and says so: there is no
             * scenario it could name, and the bootstrap it ships with accepts only this kind.
             */
            const manifestBytes = Buffer.from(JSON.stringify({schemaVersion: SCHEMA_VERSION,
                kind: WINDOWS_MSI_GUEST_BOOTSTRAP_STAGES.preflightSeedKind,
                sourceSha: request.sourceSha, eventSha: request.eventSha, runId: request.runId,
                runAttempt: request.runAttempt, hostNonce: request.nonce,
                guestNonce: request.guestSerial,
                preflightRequestSha256: seed.documents.preflightRequest.sha256,
                envelopeSha256: seed.documents.envelope.sha256, files: copied}), "utf8");
            writeExclusive(`${paths.seedRoot}/${SEED_MANIFEST_NAME}`, manifestBytes);
            const bootstrapBytes = renderBootstrap({
                stage: WINDOWS_MSI_GUEST_BOOTSTRAP_STAGES.containmentPreflight,
                nonce: request.guestSerial, hostNonce: request.nonce, sourceSha: request.sourceSha,
                eventSha: request.eventSha, runId: request.runId, runAttempt: request.runAttempt,
                seedManifestSha256: sha256(manifestBytes),
                launcherRequestSha256: seed.documents.launcherRequest.sha256,
                preflightRequestSha256: seed.documents.preflightRequest.sha256,
                envelopeSha256: seed.documents.envelope.sha256});
            writeExclusive(`${paths.seedRoot}/${BOOTSTRAP_NAME}`, bootstrapBytes);
            for (const tool of [host.toolchain.genisoimage, host.toolchain.mformat])
                await checkTool(tool, path.posix.basename(tool.path));
            assertSuccessfulWindowsMsiHostProcess(await invoke(host.toolchain.genisoimage,
                ["-quiet", "-J", "-r", "-V", SEED_VOLUME_LABEL, "-o", paths.seedIsoPath,
                    paths.seedRoot]), "MSI containment preflight seed ISO creation");
            const outputHandle = filesystem.openSync(paths.outputDiskPath, "wx", FILE_MODE);
            try {
                filesystem.ftruncateSync(outputHandle, host.limits.outputDiskBytes);
                filesystem.fsyncSync(outputHandle);
            } finally { filesystem.closeSync(outputHandle); }
            assertSuccessfulWindowsMsiHostProcess(await invoke(host.toolchain.mformat,
                ["-i", paths.outputDiskPath, "-v", OUTPUT_VOLUME_LABEL, "::"]),
            "MSI containment preflight output disk creation");
            filesystem.copyFileSync(host.toolchain.ovmfVarsTemplate.path, paths.ovmfVarsPath,
                filesystem.constants.COPYFILE_EXCL);
            const seedIso = await inspectFile(paths.seedIsoPath);
            const output = await inspectFile(paths.outputDiskPath);
            const variables = await inspectExact({path: paths.ovmfVarsPath,
                bytes: host.toolchain.ovmfVarsTemplate.bytes,
                sha256: host.toolchain.ovmfVarsTemplate.sha256});
            return {seed: {path: seedIso.path, bytes: seedIso.bytes, sha256: seedIso.sha256,
                manifestSha256: sha256(manifestBytes), readOnly: true,
                volumeLabel: SEED_VOLUME_LABEL},
            outputBefore: {path: output.path, bytes: output.bytes, sha256: output.sha256,
                createNew: true, volumeLabel: OUTPUT_VOLUME_LABEL},
            ovmfVarsSha256: variables.sha256};
        },
        async launchPreflight({overlay, media}) {
            for (const tool of [host.toolchain.runtimeLoader, host.toolchain.qemu])
                await checkTool(tool, path.posix.basename(tool.path));
            const argv = composeWindowsMsiHostQemuArguments({toolchain: host.toolchain, paths, overlay,
                media, guestSerial: request.guestSerial});
            /*
             * The last check before anything boots, and the deadlines the launcher is bound by. The
             * reservation is not part of the vector, so the launch digest the guest was told to
             * expect is unaffected by how much time the preflight has left.
             */
            const admitted = reservation.admitLaunch();
            const runQemu = createLauncher();
            launchAttempted = true;
            monitored = await runQemu({paths: {root: paths.root,
                portableRoot: host.toolchain.portableRoot, qemuPid: paths.pidPath,
                outputDisk: paths.outputDiskPath},
            toolchain: {runtime: {loader: host.toolchain.runtimeLoader,
                libraryPath: host.toolchain.libraryPath},
            qemu: {...host.toolchain.qemu, invocationPath: host.toolchain.qemu.path},
            firmware: host.toolchain.firmware},
            privilegeMode: host.privilegeMode, argv,
            reservation: {label: admitted.label,
                executionMilliseconds: admitted.executionMilliseconds,
                cleanupMilliseconds: admitted.cleanupMilliseconds}});
            const observed = monitored?.process ?? {};
            return {argvSha256: sha256(Buffer.from(JSON.stringify(argv), "utf8")),
                groupZero: groupZeroObserved(), exitCode: observed.exitCode,
                timedOut: observed.timedOut, forced: observed.terminationReason !== null
                    && observed.terminationReason !== undefined,
                processTreeExitProven: groupZeroObserved()};
        },
        async readGuestResult() {
            if (!groupZeroObserved())
                throw new Error("MSI containment preflight output read preceded QEMU group zero");
            await checkTool(host.toolchain.mcopy, "mcopy");
            assertSuccessfulWindowsMsiHostProcess(await invoke(host.toolchain.mcopy,
                ["-i", paths.outputDiskPath, `::${WINDOWS_MSI_GUEST_PREFLIGHT_SEED_FILE_NAMES.semanticResult}`,
                    paths.guestResultPath]), "MSI containment preflight guest result extraction");
            const result = await inspectFile(paths.guestResultPath, MAX_GUEST_RESULT_BYTES);
            const bytes = filesystem.readFileSync(result.path);
            if (bytes.length !== Number(result.bytes) || sha256(bytes) !== result.sha256)
                throw new Error("MSI containment preflight guest result read differs");
            const outputAfter = await inspectFile(paths.outputDiskPath);
            return {bytes, outputAfter: {path: outputAfter.path, bytes: outputAfter.bytes,
                sha256: outputAfter.sha256}};
        },
        async cleanupOverlay({groupZero}) {
            if (!owned) return {groupZeroBeforeRemoval: groupZero === true, removed: false};
            /*
             * An overlay is only safe to remove once nothing can still be holding it: either the
             * group was proven gone, or no QEMU was ever started against it. Anything else leaves it
             * in place, and the preflight fails on the unproven cleanup rather than on its absence.
             */
            if (!(groupZero === true || groupZeroObserved() || !launchAttempted))
                return {groupZeroBeforeRemoval: false, removed: false};
            filesystem.rmSync(paths.root, {recursive: true, force: false});
            if (filesystem.existsSync(paths.root))
                throw new Error("MSI containment preflight cleanup failed");
            owned = false;
            return {groupZeroBeforeRemoval: groupZero === true, removed: true};
        }
    };
};
