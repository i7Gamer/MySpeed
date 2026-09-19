import crypto from "node:crypto";
import path from "node:path";

import {validateHostedContext} from "./linux-kvm-capability.mjs";
import {STAGE2_PROVENANCE, buildQemuArguments as buildStage2QemuArguments,
    validateEarlyBoot, validatePackageClosure, validateWindowsSystemTools} from "./linux-windows-cpu-floor-stage2.mjs";
import {parseGuestOutput as parseStage2GuestOutput} from
    "./linux-windows-cpu-floor-stage2-hosted.mjs";
import {validateInstallerBootConfirmation} from "./linux-windows-cpu-floor-stage2-qmp.mjs";
import {buildWindowsMsiSetupCompleteActivation,
    getCompletedWindowsMsiActivationEvidence} from "./windows-msi-post-setup-activation.mjs";
import {OPEN_GRAPH_QUALIFICATION_TIMEOUT_MS} from "./safety.mjs";

const SCHEMA_VERSION = 1;
const PROFILE = "baseline-cpu";
const CLASSIFICATION = "windows-baseline-cpu-floor-full-runtime-stage3-nonqualifying";
const CONFIRMATION = "RUN-WINDOWS-BASELINE-CPU-FLOOR";
const AUTHORIZATION_SCOPE = "windows-baseline-cpu-floor-full-runtime";
const CPU_MODEL = "Westmere-v2";
const CPU_VECTOR = `${CPU_MODEL},avx=off,avx2=off`;
const MACHINE_MODEL = "q35";
const GUEST_MEMORY = "6144M";
const GUEST_SMP = "2,sockets=1,cores=2,threads=1";
const OUTPUT_DISK_BYTES = "67108864";
const SYSTEM_DISK_VIRTUAL_BYTES = "51539607552";
const MAX_FAILURE_MESSAGE_CHARACTERS = 512;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/u;
const BASELINE_ARTIFACT = "MySpeed-windows-x64-baseline.exe";
const STAGED_CANDIDATE = "MySpeed.exe";
const SUMMARY_NAME = "qualification-summary.json";
const MANIFEST_NAME = "qualification-manifest.json";
const EXPECTED_PROCESS_SCENARIOS = Object.freeze(["populated-first-boot", "populated-restart",
    "fresh-no-config-reset"]);
const EXPECTED_DATABASE_SCENARIOS = Object.freeze(["preseeded-input", "after-first-shutdown",
    "after-second-shutdown", "fresh-no-config-reset"]);
const EXPECTED_OPEN_GRAPH_SCENARIOS = Object.freeze(["populated-first-boot", "populated-restart"]);
const RESET_NOTHING_TO_DO_EXIT = 113;
const SUCCESS_EXIT = 0;
const MAX_EMBEDDED_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_EMBEDDED_EVIDENCE_BASE64_CHARACTERS = 4 * Math.ceil(MAX_EMBEDDED_EVIDENCE_BYTES / 3);
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const REGISTER_PATTERN = /^0x[a-f0-9]{8}$/u;
/* Leaf 1 EBX below its top byte: everything except the initial APIC ID. See modelBitsOfLeaf1Ebx. */
const INITIAL_APIC_ID_SHIFT = 24;
const LEAF1_EBX_MODEL_MASK = (1 << INITIAL_APIC_ID_SHIFT) - 1;
const PROBE_ROLES = Object.freeze(["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good", "popcnt",
    "sse42"]);
const STAGE2_OUTPUT_DISK_BYTES = "67108864";
const STAGE2_SYSTEM_DISK_BYTES = "51539607552";
/*
 * Stage 3's own boot policy, stated here rather than inherited from Stage 2.
 *
 * Device boot indexes, never '-boot order=/once='. The '-boot' byte travels through the RTC CMOS
 * that SeaBIOS reads and OVMF never looks at, so an order declared that way is invisible to the
 * firmware this stage actually runs; 'bootindex=' travels through the fw_cfg 'bootorder' file that
 * OVMF's QemuBootOrderLib does read. Stage 3 starts from a blank system disk, so on the first boot
 * the installer is the only entry that exists and on the second the installed boot manager wins.
 *
 * Keypress authority is denied unless the request itself binds a Stage 3 confirmation. Whether a
 * blank disk raises the firmware's "press any key" prompt is unobserved, so the denial is the
 * default and the opt-in is explicit and request-bound - never copied from a Stage 2 result.
 */
const STAGE3_SYSTEM_DISK_BOOT_INDEX = 0;
const STAGE3_INSTALL_MEDIA_BOOT_INDEX = 1;
const STAGE3_REQUIRED_QEMU_DEVICES = Object.freeze(["ich9-ahci", "ide-cd", "ide-hd", "isa-serial", "VGA",
    "qemu-xhci", "usb-kbd"]);

/*
 * Stage 3's execution budget.
 *
 * One QEMU process covers both Windows boots: Setup's own boot off the installation media, and the
 * first boot of the installed system that runs the baseline. The shared launcher will otherwise give
 * that process its generic 270-minute allowance, which no hosted job can ever spend - a stalled
 * installer would run until the job itself was cancelled, taking the evidence upload with it. So the
 * request carries a wall deadline and the launch is admitted against it, never against a fresh clock.
 *
 * The deadline is the moment the sequence process must be finished, so the workflow has already
 * subtracted the retention reserve from the job ceiling before declaring it. What is subtracted here
 * is only what has to happen after the execution deadline stops QEMU: proving the process tree is
 * gone, and extracting and reading the guest result off the output disk.
 *
 * The ceiling and the minimum are planning allowances, not measurements: no native Stage 3 run has
 * completed, so neither is calibrated. The minimum is a stopping criterion rather than a promise -
 * below it a fresh Windows installation cannot plausibly finish, so refusing to start costs nothing
 * while starting would spend the whole remainder proving that.
 */
const STAGE3_RESERVATION_LABEL = "cpu-floor-stage3-baseline";
/*
 * The one termination the baseline launch may be accepted with besides a clean exit. The hosted
 * monitor produces it only after observing a valid, nonce-bound publication-complete record
 * before the execution deadline and then waiting out the exit grace, so the reason is itself the
 * provenance: an ordinary deadline kill, a signal or a timeout can never carry it. Kept as a
 * literal rather than imported, to leave this module's sealed closure alone; a test pins them.
 */
const POST_COMPLETION_TERMINATION_REASON = "post-completion-teardown-timeout";
const STAGE3_JOB_CEILING_MILLISECONDS = 90 * 60 * 1_000;
const STAGE3_RETENTION_RESERVE_MILLISECONDS = 6 * 60 * 1_000;
const STAGE3_EXECUTION_CEILING_MILLISECONDS = 55 * 60 * 1_000;
const STAGE3_MINIMUM_EXECUTION_MILLISECONDS = 20 * 60 * 1_000;
const STAGE3_LAUNCH_CLEANUP_MILLISECONDS = 2 * 60 * 1_000;
const STAGE3_COLLECTION_RESERVE_MILLISECONDS = 2 * 60 * 1_000;
const STAGE3_SEQUENCE_KILL_GRACE_MILLISECONDS = 30 * 1_000;
const STAGE3_MINIMUM_SEQUENCE_MILLISECONDS = 25 * 60 * 1_000;
const STAGE3_MAX_JOB_METADATA_ENTRIES = 100;

export const STAGE3_BUDGET_CONSTANTS = Object.freeze({
    RESERVATION_LABEL: STAGE3_RESERVATION_LABEL,
    POST_COMPLETION_TERMINATION_REASON,
    JOB_CEILING_MILLISECONDS: STAGE3_JOB_CEILING_MILLISECONDS,
    RETENTION_RESERVE_MILLISECONDS: STAGE3_RETENTION_RESERVE_MILLISECONDS,
    EXECUTION_CEILING_MILLISECONDS: STAGE3_EXECUTION_CEILING_MILLISECONDS,
    MINIMUM_EXECUTION_MILLISECONDS: STAGE3_MINIMUM_EXECUTION_MILLISECONDS,
    LAUNCH_CLEANUP_MILLISECONDS: STAGE3_LAUNCH_CLEANUP_MILLISECONDS,
    COLLECTION_RESERVE_MILLISECONDS: STAGE3_COLLECTION_RESERVE_MILLISECONDS,
    SEQUENCE_KILL_GRACE_MILLISECONDS: STAGE3_SEQUENCE_KILL_GRACE_MILLISECONDS,
    MINIMUM_SEQUENCE_MILLISECONDS: STAGE3_MINIMUM_SEQUENCE_MILLISECONDS,
    MAX_JOB_METADATA_ENTRIES: STAGE3_MAX_JOB_METADATA_ENTRIES
});

/*
 * Where the ceiling is anchored.
 *
 * GitHub charges a job's timeout-minutes from the moment the job starts, which is before any step of
 * ours runs: runner assignment and job setup happen first, and a workflow expression cannot read a
 * job's own start either. A first shell step that opens the budget from its own clock therefore
 * claims setup time it has already spent, and the further the start is delayed the more of the
 * retention reserve the claim quietly consumes.
 *
 * So the anchor is the authenticated start of this job, read once from the run attempt's own job
 * metadata and matched on run, attempt, job name, runner and in-progress status together. Anything
 * ambiguous, unavailable or unparsable refuses the run: there is no fallback to a fresh clock,
 * because a fresh clock is exactly the error being corrected. If the API's started_at were ever the
 * queued moment rather than the running one it would be earlier than the true start, which shortens
 * the budget - the run may be refused, never extended.
 *
 * Two deadlines come out of it, and they are not the same moment. The hard stop is when nothing of
 * the sequence may still be running, and it leaves the whole retention reserve for the cleanup proof
 * and the two uploads. The wall deadline is one kill grace earlier: it is when the outer timeout
 * sends TERM, so its escalation to KILL still completes by the hard stop rather than spending the
 * reserve. The wall deadline is what the sequence and the Stage 3 launch admission are given.
 */
export function anchorStage3JobBudget(value, unixMilliseconds) {
    keys(value, ["jobName", "jobs", "runAttempt", "runId", "runnerName", "totalCount"],
        "Stage 3 job anchor request");
    const name = text => typeof text === "string" && text.length > 0 && text.length <= 255;
    if (!name(value.jobName) || !name(value.runnerName) ||
        !name(value.runId) || !DECIMAL_PATTERN.test(value.runId) ||
        !name(value.runAttempt) || !DECIMAL_PATTERN.test(value.runAttempt))
        throw new TypeError("Stage 3 job anchor request is invalid");
    if (!Array.isArray(value.jobs) || value.jobs.length > STAGE3_MAX_JOB_METADATA_ENTRIES ||
        value.jobs.some(job => !job || typeof job !== "object" || Array.isArray(job)))
        throw new TypeError("Stage 3 job metadata is invalid");
    if (!Number.isSafeInteger(value.totalCount) || value.totalCount !== value.jobs.length)
        throw new TypeError("Stage 3 job metadata is incomplete");
    const matches = value.jobs.filter(job => job.name === value.jobName &&
        String(job.run_id) === value.runId && String(job.run_attempt) === value.runAttempt &&
        job.runner_name === value.runnerName && job.status === "in_progress");
    if (matches.length !== 1)
        throw new Error(`Stage 3 job anchor is ambiguous or absent: ${matches.length} matching jobs`);
    const startedAt = typeof matches[0].started_at === "string" ? Date.parse(matches[0].started_at) : Number.NaN;
    if (!Number.isSafeInteger(startedAt) || startedAt < 1)
        throw new TypeError("Stage 3 job start is invalid");
    if (typeof unixMilliseconds !== "function") throw new TypeError("Stage 3 budget clock is invalid");
    const now = unixMilliseconds();
    if (!Number.isSafeInteger(now) || now < 1) throw new TypeError("Stage 3 budget clock is invalid");
    // A job cannot be running before it started, nor for longer than the ceiling it is cancelled at.
    if (startedAt > now || now - startedAt > STAGE3_JOB_CEILING_MILLISECONDS)
        throw new TypeError("Stage 3 job start is invalid");
    const hardStopUnixMilliseconds = startedAt + STAGE3_JOB_CEILING_MILLISECONDS -
        STAGE3_RETENTION_RESERVE_MILLISECONDS;
    const wallDeadlineUnixMilliseconds = hardStopUnixMilliseconds - STAGE3_SEQUENCE_KILL_GRACE_MILLISECONDS;
    const remainingMilliseconds = wallDeadlineUnixMilliseconds - now;
    if (remainingMilliseconds < STAGE3_MINIMUM_SEQUENCE_MILLISECONDS)
        throw new Error(`Stage 3 job budget leaves ${remainingMilliseconds}ms, below the `
            + `${STAGE3_MINIMUM_SEQUENCE_MILLISECONDS}ms a sequence requires`);
    return Object.freeze({startedAtUnixMilliseconds: startedAt, hardStopUnixMilliseconds,
        wallDeadlineUnixMilliseconds, remainingMilliseconds});
}

export function validateStage3Budget(value) {
    keys(value, ["label", "wallDeadlineUnixMilliseconds"], "Stage 3 budget");
    if (value.label !== STAGE3_RESERVATION_LABEL ||
        !Number.isSafeInteger(value.wallDeadlineUnixMilliseconds) || value.wallDeadlineUnixMilliseconds < 1)
        throw new TypeError("Stage 3 budget is invalid");
    return Object.freeze({...value});
}

/*
 * The reservation the shared launcher is handed. Its cleanup allowance travels separately rather
 * than folded into the execution bound, so the process and its group still have headroom to be
 * proven gone after the execution deadline has stopped them.
 */
export function admitStage3Reservation(budget, unixMilliseconds) {
    const checked = validateStage3Budget(budget);
    if (typeof unixMilliseconds !== "function") throw new TypeError("Stage 3 budget clock is invalid");
    const now = unixMilliseconds();
    if (!Number.isSafeInteger(now) || now < 1) throw new TypeError("Stage 3 budget clock is invalid");
    const spendable = checked.wallDeadlineUnixMilliseconds - now - STAGE3_LAUNCH_CLEANUP_MILLISECONDS -
        STAGE3_COLLECTION_RESERVE_MILLISECONDS;
    const executionMilliseconds = Math.min(STAGE3_EXECUTION_CEILING_MILLISECONDS, spendable);
    if (executionMilliseconds < STAGE3_MINIMUM_EXECUTION_MILLISECONDS)
        throw new Error(`Stage 3 execution budget of ${executionMilliseconds}ms is below the `
            + `${STAGE3_MINIMUM_EXECUTION_MILLISECONDS}ms a fresh Windows installation requires`);
    return Object.freeze({label: STAGE3_RESERVATION_LABEL, executionMilliseconds,
        cleanupMilliseconds: STAGE3_LAUNCH_CLEANUP_MILLISECONDS});
}

/* What the launcher was actually given, re-checked against the bounds the admission applied. */
export function validateStage3Reservation(value) {
    keys(value, ["cleanupMilliseconds", "executionMilliseconds", "label"], "Stage 3 reservation");
    if (value.label !== STAGE3_RESERVATION_LABEL ||
        value.cleanupMilliseconds !== STAGE3_LAUNCH_CLEANUP_MILLISECONDS ||
        !Number.isSafeInteger(value.executionMilliseconds) ||
        value.executionMilliseconds < STAGE3_MINIMUM_EXECUTION_MILLISECONDS ||
        value.executionMilliseconds > STAGE3_EXECUTION_CEILING_MILLISECONDS)
        throw new TypeError("Stage 3 reservation is invalid");
    return Object.freeze({...value});
}

function keys(value, expected, name) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
        throw new TypeError(`${name} keys are invalid`);
}

function exactString(value, pattern, name) {
    if (typeof value !== "string") throw new TypeError(`${name} is invalid`);
    const match = pattern.exec(value);
    if (!match || match[0].length !== value.length) throw new TypeError(`${name} is invalid`);
    return value;
}

function decimal(value, name, {positive = false} = {}) {
    exactString(value, DECIMAL_PATTERN, name);
    const parsed = BigInt(value);
    if (positive && parsed === 0n) throw new TypeError(`${name} is invalid`);
    return parsed;
}

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function decodeEvidence(value, expectedHash, name) {
    if (typeof value !== "string" || value.length > MAX_EMBEDDED_EVIDENCE_BASE64_CHARACTERS)
        throw new TypeError(`${name} base64 is invalid`);
    exactString(value, BASE64_PATTERN, `${name} base64`);
    exactString(expectedHash, SHA256_PATTERN, `${name} hash`);
    const bytes = Buffer.from(value, "base64");
    if (bytes.length < 2 || bytes.length > MAX_EMBEDDED_EVIDENCE_BYTES || bytes.toString("base64") !== value ||
        crypto.createHash("sha256").update(bytes).digest("hex") !== expectedHash)
        throw new TypeError(`${name} bytes differ`);
    let parsed;
    try { parsed = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)); }
    catch { throw new TypeError(`${name} JSON is invalid`); }
    return {bytes, parsed};
}

function validateCpuidBytes(value) {
    keys(value, ["features", "kind", "leaf1", "leaf7Subleaf0", "maxBasicLeaf", "schemaVersion", "xcr0"],
        "baseline raw CPUID");
    keys(value.features, ["avx", "avx2", "osxsave", "popcnt", "sse42"], "baseline raw CPUID features");
    keys(value.leaf1, ["eax", "ebx", "ecx", "edx"], "baseline raw CPUID leaf 1");
    keys(value.leaf7Subleaf0, ["eax", "ebx", "ecx", "edx"], "baseline raw CPUID leaf 7");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== "cpuid" || !Number.isInteger(value.maxBasicLeaf) ||
        value.maxBasicLeaf < 7 || value.maxBasicLeaf > 0xffff_ffff || value.xcr0 !== null ||
        [...Object.values(value.leaf1), ...Object.values(value.leaf7Subleaf0)].some(item =>
            typeof item !== "string" || !REGISTER_PATTERN.test(item)))
        throw new TypeError("baseline raw CPUID is invalid");
    const leaf1 = Number.parseInt(value.leaf1.ecx.slice(2), 16);
    const leaf7 = Number.parseInt(value.leaf7Subleaf0.ebx.slice(2), 16);
    const projection = {sse42: ((leaf1 >>> 20) & 1) === 1, popcnt: ((leaf1 >>> 23) & 1) === 1,
        osxsave: ((leaf1 >>> 27) & 1) === 1, avx: ((leaf1 >>> 28) & 1) === 1,
        avx2: ((leaf7 >>> 5) & 1) === 1, xcr0: null};
    if (Object.keys(value.features).some(name => value.features[name] !== projection[name]))
        throw new TypeError("baseline raw CPUID feature projection differs");
    return projection;
}

function validateIdentity(value, name) {
    keys(value, ["bytes", "path", "sha256"], name);
    decimal(value.bytes, `${name} bytes`, {positive: true});
    exactString(value.sha256, SHA256_PATTERN, `${name} hash`);
    if (typeof value.path !== "string" || !value.path.startsWith("/") || path.posix.normalize(value.path) !== value.path)
        throw new TypeError(`${name} path is invalid`);
    return structuredClone(value);
}

function directChild(root, candidatePath, name) {
    if (candidatePath !== `${root}/${name}`) throw new TypeError(`${name} path is invalid`);
}

function validatePaths(value, context) {
    keys(value, ["outputDisk", "ovmfVars", "qemuPid", "root", "seedIso", "serialLog", "systemDisk"],
        "Stage 3 paths");
    const expectedRoot = `/home/runner/work/_temp/myspeed-stage3-${context.nonce}`;
    if (value.root !== expectedRoot) throw new TypeError("Stage 3 root is invalid");
    const names = {systemDisk: "stage3.qcow2", seedIso: "baseline-seed.iso",
        outputDisk: "baseline-output.img", ovmfVars: "OVMF_VARS.fd", qemuPid: "baseline-qemu.pid",
        serialLog: "baseline-serial.log"};
    for (const [field, name] of Object.entries(names)) directChild(expectedRoot, value[field], name);
    return structuredClone(value);
}

function validateOwnership(value, name) {
    keys(value, ["gid", "mode", "ordinaryUserWritable", "uid"], name);
    if (value.uid !== "0" || value.gid !== "0" || value.ordinaryUserWritable !== false ||
        !/^[4567][045][045]$/u.test(value.mode)) throw new TypeError(`${name} is invalid`);
}

function validatePortableIdentity(value, root, name, {invocationPath = null, version = false} = {}) {
    keys(value, ["bytes", ...(invocationPath === null ? [] : ["invocationPath"]), "ownership", "path", "sha256",
        ...(version ? ["version"] : [])], name);
    const id = validateIdentity({bytes: value.bytes, path: value.path, sha256: value.sha256}, name);
    if (!id.path.startsWith(`${root}/`)) throw new TypeError(`${name} path is invalid`);
    validateOwnership(value.ownership, `${name} ownership`);
    if (invocationPath !== null && value.invocationPath !== `${root}/${invocationPath}`)
        throw new TypeError(`${name} invocation path is invalid`);
}

function validateToolchain(value, context) {
    keys(value, ["capabilities", "firmware", "genisoimage", "installedFilesManifest", "licensesManifest", "mcopy", "mformat",
        "ovmfCode", "ovmfVarsTemplate", "packageClosureSha256", "qemu", "qemuImg", "runtime", "sevenZip",
        "wiminfo"], "Stage 3 toolchain");
    const root = `/tmp/myspeed-windows-cpu-floor-tools-${context.nonce}`;
    validatePortableIdentity(value.qemu, root, "QEMU tool", {invocationPath: "usr/bin/qemu-system-x86_64",
        version: true});
    validatePortableIdentity(value.ovmfCode, root, "OVMF code");
    validatePortableIdentity(value.ovmfVarsTemplate, root, "OVMF variables template");
    keys(value.firmware, ["kvmvapic", "searchPath", "vga"], "portable QEMU firmware");
    if (value.firmware.searchPath !== `${root}/usr/share/qemu`)
        throw new TypeError("portable QEMU firmware search path is invalid");
    for (const [k, expectedRel] of [["kvmvapic", "usr/share/qemu/kvmvapic.bin"],
        ["vga", "usr/share/seabios/vgabios-stdvga.bin"]]) {
        validatePortableIdentity(value.firmware[k], root, `portable QEMU ${k} firmware`);
        if (value.firmware[k].path !== `${root}/${expectedRel}`)
            throw new TypeError(`portable QEMU ${k} firmware path is invalid`);
    }
    keys(value.runtime, ["libraryPath", "loader"], "portable runtime");
    validatePortableIdentity(value.runtime.loader, root, "portable loader");
    if (!Array.isArray(value.runtime.libraryPath) || value.runtime.libraryPath.length < 1 ||
        value.runtime.libraryPath.length > 2 || new Set(value.runtime.libraryPath).size !== value.runtime.libraryPath.length ||
        value.runtime.libraryPath.some(item => typeof item !== "string" || !item.startsWith(`${root}/`) ||
            path.posix.normalize(item) !== item))
        throw new TypeError("Stage 3 toolchain path is invalid");
    keys(value.capabilities, ["accelerator", "cpuModels", "devices", "machines"], "QEMU capabilities");
    if (value.capabilities.accelerator !== "kvm" || !value.capabilities.cpuModels.includes(CPU_MODEL) ||
        !value.capabilities.machines.includes(MACHINE_MODEL) ||
        !STAGE3_REQUIRED_QEMU_DEVICES.every(item => value.capabilities.devices.includes(item)))
        throw new TypeError("Stage 3 QEMU capability set is invalid");
    if (!value.qemu.version.startsWith("QEMU emulator version 8.2.2 "))
        throw new TypeError("Stage 3 QEMU version is invalid");
    exactString(value.packageClosureSha256, SHA256_PATTERN, "package closure hash");
    return structuredClone(value);
}

function validateIso(value) {
    keys(value, ["bytes", "digestProvenance", "etag", "finalUrl", "publisherDigestMatched", "sha256"], "Stage 2 ISO");
    decimal(value.bytes, "Stage 2 ISO bytes", {positive: true});
    exactString(value.sha256, SHA256_PATTERN, "Stage 2 ISO hash");
    if (value.bytes !== STAGE2_PROVENANCE.windowsIso.bytes || value.finalUrl !== STAGE2_PROVENANCE.windowsIso.finalUrl ||
        value.etag !== STAGE2_PROVENANCE.windowsIso.strongEtag ||
        value.digestProvenance !== STAGE2_PROVENANCE.windowsIso.digestProvenance || value.publisherDigestMatched !== null)
        throw new TypeError("Stage 2 ISO provenance is invalid");
    return structuredClone(value);
}

function stage2Paths(context) {
    const root = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${context.nonce}`;
    return {root, packageRoot: `${root}/packages`, portableRoot: `/tmp/myspeed-windows-cpu-floor-tools-${context.nonce}`,
        windowsIso: `${root}/windows.iso`, installWim: `${root}/install.wim`, seedIso: `${root}/seed.iso`,
        outputDisk: `${root}/output.img`, systemDisk: `${root}/system.qcow2`, ovmfVars: `${root}/OVMF_VARS.fd`,
        serialLog: `${root}/serial.log`, probeRoot: `${root}/probes`, qemuPid: `${root}/qemu.pid`};
}

function validateStage2ProbeArtifact(value) {
    keys(value, ["archive", "artifactId", "artifactName", "files", "innerManifest", "repository", "runAttempt",
        "runId", "schemaVersion", "sourceSha"], "Stage 2 probe artifact");
    if (value.schemaVersion !== SCHEMA_VERSION || value.repository !== "i7Gamer/MySpeed" ||
        value.artifactName !== "windows-cpu-readiness-evidence") throw new TypeError("Stage 2 probe artifact differs");
    exactString(value.sourceSha, /^[a-f0-9]{40}$/u, "Stage 2 probe source SHA");
    for (const name of ["artifactId", "runAttempt", "runId"])
        exactString(value[name], /^[1-9][0-9]{0,19}$/u, `Stage 2 probe ${name}`);
    keys(value.archive, ["bytes", "sha256"], "Stage 2 probe archive");
    decimal(value.archive.bytes, "Stage 2 probe archive bytes", {positive: true});
    exactString(value.archive.sha256, SHA256_PATTERN, "Stage 2 probe archive hash");
    keys(value.innerManifest, ["bytes", "name", "sha256"], "Stage 2 probe inner manifest");
    if (value.innerManifest.name !== "result.json") throw new TypeError("Stage 2 probe inner manifest differs");
    decimal(value.innerManifest.bytes, "Stage 2 probe inner manifest bytes", {positive: true});
    exactString(value.innerManifest.sha256, SHA256_PATTERN, "Stage 2 probe inner manifest hash");
    if (!Array.isArray(value.files) || value.files.length !== PROBE_ROLES.length)
        throw new TypeError("Stage 2 probe files differ");
    const roles = new Set();
    for (const file of value.files) {
        keys(file, ["bytes", "name", "role", "sha256"], "Stage 2 probe file");
        if (!PROBE_ROLES.includes(file.role) || roles.has(file.role) ||
            file.name !== `${file.role.replaceAll("-", "_")}.exe`) throw new TypeError("Stage 2 probe role differs");
        roles.add(file.role);
        decimal(file.bytes, "Stage 2 probe file bytes", {positive: true});
        exactString(file.sha256, SHA256_PATTERN, "Stage 2 probe file hash");
    }
    return structuredClone(value);
}

function validateStage2Probes(value, artifact, pathsValue) {
    keys(value, ["archive", "files", "innerManifest"], "Stage 2 acquired probes");
    if (!same(value.archive, artifact.archive) || !same(value.innerManifest, artifact.innerManifest) ||
        !Array.isArray(value.files) || value.files.length !== PROBE_ROLES.length)
        throw new TypeError("Stage 2 acquired probe closure differs");
    for (const expected of artifact.files) {
        const matches = value.files.filter(file => file?.role === expected.role);
        if (matches.length !== 1) throw new TypeError("Stage 2 acquired probe role differs");
        const actual = matches[0];
        keys(actual, ["bytes", "name", "path", "role", "sha256"], "Stage 2 acquired probe file");
        if (actual.name !== expected.name || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256 ||
            actual.path !== `${pathsValue.probeRoot}/${expected.name}`)
            throw new TypeError("Stage 2 acquired probe identity differs");
    }
    return structuredClone(value);
}

function validateStage2Media(value, pathsValue, toolchain) {
    keys(value, ["outputDisk", "ovmfVars", "seedIso", "systemDisk"], "Stage 2 media");
    keys(value.seedIso, ["bytes", "format", "path", "sha256", "sourceManifestSha256", "volumeLabel"],
        "Stage 2 seed ISO");
    if (value.seedIso.path !== pathsValue.seedIso || value.seedIso.format !== "iso9660" ||
        value.seedIso.volumeLabel !== "MYSPEEDSEED") throw new TypeError("Stage 2 seed ISO differs");
    decimal(value.seedIso.bytes, "Stage 2 seed ISO bytes", {positive: true});
    exactString(value.seedIso.sha256, SHA256_PATTERN, "Stage 2 seed ISO hash");
    exactString(value.seedIso.sourceManifestSha256, SHA256_PATTERN, "Stage 2 seed manifest hash");
    keys(value.outputDisk, ["bytes", "format", "path", "sha256", "volumeLabel"], "Stage 2 output disk");
    if (value.outputDisk.path !== pathsValue.outputDisk || value.outputDisk.bytes !== STAGE2_OUTPUT_DISK_BYTES ||
        value.outputDisk.format !== "raw-fat" || value.outputDisk.volumeLabel !== "MYSPEEDOUT")
        throw new TypeError("Stage 2 output disk differs");
    exactString(value.outputDisk.sha256, SHA256_PATTERN, "Stage 2 empty output hash");
    keys(value.systemDisk, ["bytes", "format", "path", "sha256", "virtualBytes"], "Stage 2 system disk");
    if (value.systemDisk.path !== pathsValue.systemDisk || value.systemDisk.format !== "qcow2" ||
        value.systemDisk.virtualBytes !== STAGE2_SYSTEM_DISK_BYTES)
        throw new TypeError("Stage 2 system disk differs");
    decimal(value.systemDisk.bytes, "Stage 2 system disk bytes", {positive: true});
    exactString(value.systemDisk.sha256, SHA256_PATTERN, "Stage 2 system disk hash");
    keys(value.ovmfVars, ["path", "sha256"], "Stage 2 OVMF variables");
    if (value.ovmfVars.path !== pathsValue.ovmfVars || value.ovmfVars.sha256 !== toolchain.ovmfVarsTemplate.sha256)
        throw new TypeError("Stage 2 OVMF variables differ");
    return structuredClone(value);
}

function validateStage2Observation(value, context) {
    const expectedKeys = ["argv", "classification", "cleanupProven", "context", "cpuCalibrationAccepted",
        "earlyBoot", "guest", "installWim", "installWimRemoval", "iso", "media", "packageClosure",
        "privilegeMode", "probeArtifact", "probes", "qemuProcess", "qualifying", "releaseGateCleared",
        "schemaVersion", "selectedImage", "stage", "status", "toolchain",
        ...(value?.bootConfirmation !== undefined ? ["bootConfirmation"] : [])];
    keys(value, expectedKeys, "Stage 2 observation");
    if (value.schemaVersion !== SCHEMA_VERSION || value.status !== "observed" || value.stage !== "complete" ||
        value.classification !== "github-hosted-windows-cpu-floor-stage2-calibration-nonqualifying" || value.qualifying !== false ||
        value.releaseGateCleared !== false || value.cpuCalibrationAccepted !== true || value.cleanupProven !== true ||
        !same(value.context, context) || !new Set(["ordinary-kvm", "reviewed-sudo-kvm"]).has(value.privilegeMode))
        throw new TypeError("Stage 2 observation is not accepted");
    keys(value.qemuProcess, ["cleanupProven", "exitCode", "launcherExecutablePath", "processGroupId", "qemuPid",
        "qemuPidAbsentAfter", "qemuStartTicks", "signal", "terminationReason", "timedOut", "treeGone"],
    "Stage 2 process");
    if (value.qemuProcess.cleanupProven !== true || value.qemuProcess.treeGone !== true ||
        value.qemuProcess.qemuPidAbsentAfter !== true || value.qemuProcess.exitCode !== 0 ||
        value.qemuProcess.signal !== null || value.qemuProcess.timedOut !== false ||
        value.qemuProcess.terminationReason !== null) throw new TypeError("Stage 2 cleanup is not proven");
    const pathsValue = stage2Paths(context);
    validateEarlyBoot(value.earlyBoot, pathsValue, value.bootConfirmation);
    keys(value.guest, ["activation", "cpu", "instructions", "network", "output", "schemaVersion", "status",
        "systemTools"], "Stage 2 guest");
    if (value.guest.schemaVersion !== SCHEMA_VERSION || value.guest.status !== "observed")
        throw new TypeError("Stage 2 guest header is invalid");
    keys(value.guest.cpu, ["avx", "avx2", "osxsave", "popcnt", "sse42", "xcr0"], "Stage 2 CPU projection");
    if (value.guest.cpu.sse42 !== true || value.guest.cpu.popcnt !== true || value.guest.cpu.avx !== false ||
        value.guest.cpu.avx2 !== false || value.guest.cpu.osxsave !== false || value.guest.cpu.xcr0 !== null)
        throw new TypeError("Stage 2 CPU floor is invalid");
    keys(value.guest.instructions, ["avx", "avx2", "popcnt", "sse42"], "Stage 2 instruction projection");
    if (!same(value.guest.instructions, {sse42: "completed", popcnt: "completed", avx: "illegal-instruction",
        avx2: "illegal-instruction"})) throw new TypeError("Stage 2 instruction floor is invalid");
    validateZeroNetwork(value.guest.network, "Stage 2 guest network");
    validateWindowsSystemTools(value.guest.systemTools);
    const expectedActivation = getCompletedWindowsMsiActivationEvidence(
        buildWindowsMsiSetupCompleteActivation({repository: context.repository, sourceSha: context.sourceSha,
            eventSha: context.eventSha, runId: context.runId, runAttempt: context.runAttempt, nonce: context.nonce}));
    if (!same(value.guest.activation, expectedActivation))
        throw new TypeError("Stage 2 guest activation evidence is invalid");
    const packageClosure = validatePackageClosure(value.packageClosure);
    const packageClosureSha256 = crypto.createHash("sha256").update(JSON.stringify(packageClosure)).digest("hex");
    const toolchain = validateToolchain(value.toolchain, context);
    if (toolchain.packageClosureSha256 !== packageClosureSha256)
        throw new TypeError("Stage 2 package closure binding differs");
    const probeArtifact = validateStage2ProbeArtifact(value.probeArtifact);
    const probes = validateStage2Probes(value.probes, probeArtifact, pathsValue);
    const expectedArgv = buildStage2QemuArguments({paths: pathsValue, toolchain});
    if (!same(value.argv, expectedArgv)) throw new TypeError("Stage 2 QEMU vector differs");
    validateProcess(value.qemuProcess, toolchain);
    const stage2Output = validateIdentity(value.guest.output, "Stage 2 guest output");
    if (stage2Output.path !== pathsValue.outputDisk ||
        stage2Output.bytes !== OUTPUT_DISK_BYTES) throw new TypeError("Stage 2 guest output binding is invalid");
    const iso = validateIso(value.iso);
    keys(value.installWim, ["bytes", "path", "sha256", "sourceIsoSha256"], "Stage 2 install WIM");
    if (value.installWim.path !== pathsValue.installWim || value.installWim.sourceIsoSha256 !== iso.sha256 ||
        decimal(value.installWim.bytes, "Stage 2 install WIM bytes", {positive: true}) >
        decimal(STAGE2_PROVENANCE.windowsIso.bytes, "Stage 2 ISO bound", {positive: true}))
        throw new TypeError("Stage 2 install WIM differs");
    exactString(value.installWim.sha256, SHA256_PATTERN, "Stage 2 install WIM hash");
    keys(value.installWimRemoval, ["path", "removed", "sha256"], "Stage 2 install WIM removal");
    if (value.installWimRemoval.path !== value.installWim.path || value.installWimRemoval.sha256 !==
        value.installWim.sha256 || value.installWimRemoval.removed !== true)
        throw new TypeError("Stage 2 install WIM removal differs");
    const media = validateStage2Media(value.media, pathsValue, toolchain);
    keys(value.selectedImage, ["architecture", "editionId", "index", "installationType", "name", "totalBytes"],
        "Stage 2 selected image");
    if (value.selectedImage.architecture !== "x64" || value.selectedImage.editionId !== "ServerStandardEval" ||
        value.selectedImage.installationType !== "Server" ||
        value.selectedImage.name !== "Windows Server 2025 SERVERSTANDARD" ||
        !Number.isInteger(value.selectedImage.index) || value.selectedImage.index < 1)
        throw new TypeError("Stage 2 selected image is invalid");
    return {...structuredClone(value), packageClosure, probeArtifact, probes, media, toolchain, iso};
}

function validateStage2GuestEvidence(value, expectedIdentity, context, projectedGuest) {
    keys(value, ["bytesBase64", "identity"], "Stage 2 raw guest evidence");
    const id = validateIdentity(value.identity, "Stage 2 raw guest identity");
    if (!same(id, expectedIdentity)) throw new TypeError("Stage 2 raw guest identity differs");
    const decoded = decodeEvidence(value.bytesBase64, id.sha256, "Stage 2 raw guest evidence");
    if (String(decoded.bytes.length) !== id.bytes) throw new TypeError("Stage 2 raw guest size differs");
    const replayed = parseStage2GuestOutput(decoded.bytes, context.nonce);
    const normalizedCpu = {
        sse42: replayed.cpu.sse42,
        popcnt: replayed.cpu.popcnt,
        osxsave: replayed.cpu.osxsave,
        avx: replayed.cpu.avx,
        avx2: replayed.cpu.avx2,
        xcr0: null
    };
    const projectedCpu = {
        sse42: projectedGuest.cpu?.sse42,
        popcnt: projectedGuest.cpu?.popcnt,
        osxsave: projectedGuest.cpu?.osxsave,
        avx: projectedGuest.cpu?.avx,
        avx2: projectedGuest.cpu?.avx2,
        xcr0: null
    };
    if (!same(normalizedCpu, projectedCpu) || !same(replayed.instructions, projectedGuest.instructions) ||
        !same(replayed.network, projectedGuest.network) ||
        !same(replayed.activation, projectedGuest.activation) ||
        !same(replayed.systemTools, projectedGuest.systemTools))
        throw new TypeError("Stage 2 raw guest projection differs");
    return {evidence: {identity: id, bytesBase64: value.bytesBase64}, cpuid: replayed.cpuid};
}

/*
 * The two guests measured the same probe binary on the same booted CPU, so their CPUID must agree.
 *
 * Each side already proves the feature floor on its own, but both prove it against the same pinned
 * booleans, so comparing those would say nothing. The raw leaves are pinned nowhere - leaf 1 EAX
 * carries the CPU signature and the remaining registers carry words no gate reads - so they are what
 * makes this a second opinion rather than a second copy. A probe swapped between the stages, or a
 * Stage 3 guest booted on a CPU Stage 2 never calibrated, disagrees here and nowhere else.
 *
 * Compared as parsed records, not as bytes: the calibration guest's copy is re-serialized through
 * PowerShell on its way out, so the two are never byte-identical even when they agree.
 *
 * This holds because linux-windows-cpu-floor-stage3-sequence.mjs runs both stages in one job, on one
 * runner, against one QEMU and one KVM, so every host-filtered bit is identical on both sides by
 * construction. Two of the compared words depend on that and would stop agreeing if the stages were
 * ever split across runners, or a retained Stage 2 result replayed on a fresh one: leaf 7 EDX, whose
 * IBRS bit Westmere-v2 requests but nested KVM here does not advertise - the observed record is all
 * zeros - and leaf 1 ECX, whose x2APIC bit comes from KVM's own defaults rather than the model.
 */
/* The record the baseline guest published, re-read from the bytes its own validator already proved. */
function baselineCpuidRecord(guest) {
    return decodeEvidence(guest.cpu.cpuidBytesBase64, guest.cpu.cpuidSha256, "baseline guest CPUID").parsed;
}

function assertCorroboratedCpuid(baseline, calibration) {
    const leaves = value => ({maxBasicLeaf: value.maxBasicLeaf,
        leaf1: {...value.leaf1, ebx: modelBitsOfLeaf1Ebx(value.leaf1.ebx)},
        leaf7Subleaf0: value.leaf7Subleaf0, xcr0: value.xcr0});
    const disagreed = disagreeingCpuidFields(leaves(baseline), leaves(calibration));
    if (disagreed.length > 0)
        throw new TypeError("baseline CPUID is not corroborated by the Stage 2 calibration guest: "
            + disagreed.join(", "));
}

/*
 * Which fields disagreed, so the refusal can say.
 *
 * Run 35447618046 reported only that corroboration had failed. Finding the single byte behind it
 * meant range-reading both records out of a 9.7 GB evidence artifact, an hour after the run began.
 * The names alone would have made that a five-minute diagnosis, and they cost nothing to carry.
 */
function disagreeingCpuidFields(baseline, calibration, prefix = "") {
    const names = [];
    for (const [name, value] of Object.entries(baseline)) {
        const other = calibration[name];
        if (value !== null && typeof value === "object")
            names.push(...disagreeingCpuidFields(value, other ?? {}, `${prefix}${name}.`));
        else if (value !== other) names.push(`${prefix}${name}`);
    }
    return names;
}

/*
 * Leaf 1 EBX without its top byte, which is the initial APIC ID: the vCPU that happened to execute
 * CPUID, not a property of the CPU.
 *
 * Both guests boot with two vCPUs, so which one runs the probe is the guest scheduler's choice and
 * the two correct measurements disagree there. Run 35447618046 read 0x00020800 in the baseline guest
 * and 0x01020800 in the calibration guest - identical in every other bit of every other register.
 *
 * Everything below that byte is still compared, because all of it describes the model rather than
 * the moment: logical processor count, CLFLUSH line size and brand index.
 */
function modelBitsOfLeaf1Ebx(register) {
    return (Number.parseInt(register.slice(2), 16) & LEAF1_EBX_MODEL_MASK) >>> 0;
}

function validateCandidate(value, context) {
    keys(value, ["archive", "artifactId", "artifactName", "file", "manifest", "qualificationSummary",
        "releaseAssetDigest", "releaseAssetId", "runAttempt", "runId", "sourceSha", "tagName"],
    "baseline candidate");
    if (value.artifactName !== BASELINE_ARTIFACT || value.sourceSha === context.sourceSha)
        throw new TypeError("baseline candidate provenance differs");
    exactString(value.sourceSha, /^[a-f0-9]{40}$/u, "baseline candidate source SHA");
    exactString(value.tagName, /^v[0-9]+\.[0-9]+\.[0-9]+$/u, "baseline candidate tag name");
    exactString(value.artifactId, /^[1-9][0-9]{0,19}$/u, "baseline artifact ID");
    exactString(value.releaseAssetId, /^[1-9][0-9]{0,19}$/u, "baseline release asset ID");
    exactString(value.releaseAssetDigest, /^sha256:[a-f0-9]{64}$/u, "baseline release asset digest");
    for (const name of ["runId", "runAttempt"])
        exactString(value[name], /^[1-9][0-9]{0,19}$/u, `baseline candidate ${name}`);
    keys(value.archive, ["bytes", "sha256"], "baseline archive");
    decimal(value.archive.bytes, "baseline archive bytes", {positive: true});
    exactString(value.archive.sha256, SHA256_PATTERN, "baseline archive hash");
    for (const [record, expectedName, label] of [[value.file, STAGED_CANDIDATE, "baseline file"],
        [value.qualificationSummary, SUMMARY_NAME, "baseline summary"], [value.manifest, MANIFEST_NAME,
            "baseline manifest"]]) {
        keys(record, ["bytes", "name", "sha256"], label);
        if (record.name !== expectedName) throw new TypeError(`${label} name differs`);
        decimal(record.bytes, `${label} bytes`, {positive: true});
        exactString(record.sha256, SHA256_PATTERN, `${label} hash`);
    }
    return structuredClone(value);
}

export function validateRequest(value) {
    keys(value, ["authorization", "budget", "candidate", "context", "paths", "profile", "schemaVersion",
        "stage2"], "Stage 3 request");
    if (value.schemaVersion !== SCHEMA_VERSION || value.profile !== PROFILE) throw new TypeError("Stage 3 profile is invalid");
    const context = validateHostedContext(value.context);
    const authorizationKeys = ["candidate", "confirmation", "qemu", "scope"];
    if (Object.hasOwn(value.authorization ?? {}, "bootConfirmation")) authorizationKeys.push("bootConfirmation");
    keys(value.authorization, authorizationKeys, "Stage 3 authorization");
    if (value.authorization.candidate !== true || value.authorization.qemu !== true ||
        value.authorization.confirmation !== CONFIRMATION || value.authorization.scope !== AUTHORIZATION_SCOPE)
        throw new TypeError("Stage 3 authorization is invalid");
    /*
     * Absent means denied. Only this request field can open the one bounded key, and it is checked
     * against the shared token rather than against anything Stage 2 observed.
     */
    const bootConfirmation = validateInstallerBootConfirmation(value.authorization.bootConfirmation);
    keys(value.stage2, ["guestResult", "result"], "Stage 2 binding");
    const stage2Result = validateIdentity(value.stage2.result, "Stage 2 result");
    const stage2GuestResult = validateIdentity(value.stage2.guestResult, "Stage 2 raw guest result");
    const transportRoot = `/home/runner/work/_temp/myspeed-stage2-transport-${context.nonce}`;
    if (stage2Result.path !== `${transportRoot}/stage2-result.json` ||
        stage2GuestResult.path !== `${transportRoot}/guest-result.json`)
        throw new TypeError("Stage 2 retained evidence paths differ");
    const paths = validatePaths(value.paths, context);
    const budget = validateStage3Budget(value.budget);
    return {context, paths, bootConfirmation, budget, candidate: validateCandidate(value.candidate, context),
        stage2Result, stage2GuestResult, request: structuredClone(value)};
}

function drive(id, file, {readOnly = false, format = "raw"} = {}) {
    return `if=none,id=${id},format=${format}${readOnly ? ",readonly=on" : ""},file=${file}`;
}

export function buildBaselineQemuArguments({paths: value, toolchain, windowsIso}) {
    const iso = validateIdentity(windowsIso, "Stage 3 Windows ISO");
    const qemu = ["-nodefaults", "-no-user-config", "-display", "none", "-qmp", "stdio",
        "-L", toolchain.firmware.searchPath, "-accel", "kvm",
        "-machine", MACHINE_MODEL, "-cpu", CPU_VECTOR, "-smp", GUEST_SMP, "-m", GUEST_MEMORY,
        "-device", `VGA,id=video0,romfile=${toolchain.firmware.vga.path}`, "-device", "qemu-xhci,id=usb0",
        "-device", "usb-kbd,bus=usb0.0", "-nic", "none",
        "-drive", `if=pflash,format=raw,readonly=on,file=${toolchain.ovmfCode.path}`,
        "-drive", `if=pflash,format=raw,file=${value.ovmfVars}`, "-device", "ich9-ahci,id=sata",
        "-drive", drive("osdisk", value.systemDisk, {format: "qcow2"}), "-device",
        `ide-hd,drive=osdisk,bus=sata.1,bootindex=${STAGE3_SYSTEM_DISK_BOOT_INDEX}`,
        "-drive", drive("install", iso.path, {readOnly: true}), "-device",
        `ide-cd,drive=install,bus=sata.2,bootindex=${STAGE3_INSTALL_MEDIA_BOOT_INDEX}`,
        "-drive", drive("seed", value.seedIso, {readOnly: true}), "-device", "ide-cd,drive=seed,bus=sata.3",
        "-drive", drive("output", value.outputDisk), "-device", "ide-hd,drive=output,bus=sata.4",
        "-chardev", `file,id=serial0,path=${value.serialLog}`, "-device", "isa-serial,chardev=serial0",
        "-pidfile", value.qemuPid];
    const forbidden = /(?:^|[,=])(?:user|tap|socket|vsock)(?:[,=]|$)|(?:fat:|nbd:|ssh:|https?:)|virtio-9p/iu;
    if (qemu.some(item => forbidden.test(item))) throw new TypeError("Stage 3 QEMU vector contains a forbidden backend");
    return Object.freeze(qemu);
}

function validateAcquiredCandidate(value, candidate, root) {
    keys(value, ["candidate", "stagedFile", "stagedManifest", "stagedSummary"], "acquired candidate");
    if (!same(value.candidate, candidate)) throw new TypeError("acquired candidate provenance differs");
    const records = [[value.stagedFile, candidate.file, "candidate/MySpeed.exe"],
        [value.stagedSummary, candidate.qualificationSummary, `candidate/${SUMMARY_NAME}`],
        [value.stagedManifest, candidate.manifest, `candidate/${MANIFEST_NAME}`]];
    for (const [actual, expected, relative] of records) {
        keys(actual, ["bytes", "name", "path", "sha256"], "staged candidate file");
        if (actual.path !== `${root}/${relative}` || actual.name !== expected.name || actual.bytes !== expected.bytes ||
            actual.sha256 !== expected.sha256) throw new TypeError("staged candidate identity differs");
    }
    return structuredClone(value);
}

function validatePreparedMedia(value, pathsValue) {
    keys(value, ["outputDisk", "ovmfVars", "seedIso", "systemDisk"], "Stage 3 media");
    const expected = [[value.seedIso, pathsValue.seedIso], [value.outputDisk, pathsValue.outputDisk],
        [value.ovmfVars, pathsValue.ovmfVars]];
    for (const [record, expectedPath] of expected) {
        validateIdentity(record, "Stage 3 media file");
        if (record.path !== expectedPath) throw new TypeError("Stage 3 media path differs");
    }
    keys(value.systemDisk, ["bytes", "path", "sha256", "virtualBytes"], "Stage 3 system disk");
    if (value.systemDisk.path !== pathsValue.systemDisk || value.systemDisk.virtualBytes !== SYSTEM_DISK_VIRTUAL_BYTES)
        throw new TypeError("Stage 3 system disk differs");
    decimal(value.systemDisk.bytes, "Stage 3 system disk bytes", {positive: true});
    exactString(value.systemDisk.sha256, SHA256_PATTERN, "Stage 3 system disk hash");
    if (value.outputDisk.bytes !== OUTPUT_DISK_BYTES) throw new TypeError("Stage 3 output disk size differs");
    return structuredClone(value);
}

function validateProcess(value, toolchain, completionTeardownAllowed = false) {
    keys(value, ["cleanupProven", "exitCode", "launcherExecutablePath", "processGroupId", "qemuPid",
        "qemuPidAbsentAfter", "qemuStartTicks", "signal", "terminationReason", "timedOut", "treeGone"],
    "Stage 3 QEMU process");
    /*
     * Either the wrapper exited cleanly by itself, or - for the baseline launch only - the host
     * tore down the group it had already verified after the guest published and asked to power
     * off. The second shape waives the exit status and nothing else: every cleanup proof below
     * still applies unchanged, and the guest receipts are strictly parsed elsewhere regardless.
     */
    const forcedAfterCompletion = completionTeardownAllowed &&
        value.terminationReason === POST_COMPLETION_TERMINATION_REASON;
    if (!forcedAfterCompletion && (value.exitCode !== 0 || value.signal !== null ||
        value.terminationReason !== null)) throw new TypeError("Stage 3 QEMU cleanup is not proven");
    if (value.timedOut !== false || value.cleanupProven !== true ||
        value.treeGone !== true || value.qemuPidAbsentAfter !== true || value.launcherExecutablePath !==
        toolchain.runtime.loader.path || !Number.isInteger(value.qemuPid) ||
        value.qemuPid < 1 || value.qemuPid > 0x7fff_ffff || !Number.isInteger(value.processGroupId) ||
        value.processGroupId < 1 || value.processGroupId > 0x7fff_ffff ||
        !/^[1-9][0-9]{0,23}$/u.test(value.qemuStartTicks)) throw new TypeError("Stage 3 QEMU cleanup is not proven");
    return structuredClone(value);
}

function validateZeroNetwork(value, name) {
    keys(value, ["enabledNonLoopbackInterfaces", "hardwareNics", "nonLoopbackRoutes"], name);
    if (value.hardwareNics !== 0 || value.enabledNonLoopbackInterfaces !== 0 || value.nonLoopbackRoutes !== 0)
        throw new TypeError(`${name} is invalid`);
}

function boundedSummaryString(value, name) {
    if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\x00-\x1f\x7f]/u.test(value))
        throw new TypeError(`${name} is invalid`);
    return value;
}

function validateFullSummary(value, requestValue) {
    keys(value, ["architecture", "artifactSha256", "command", "databaseChecks", "exit", "mode", "networkIsolation",
        "openGraphChecks", "platform", "processes", "shutdownProofs", "sourceSha", "status"], "full verifier summary");
    if (value.status !== "passed" || value.exit !== 0 || value.mode !== "full" || value.sourceSha !==
        requestValue.candidate.sourceSha || value.artifactSha256 !== requestValue.candidate.file.sha256 ||
        value.platform !== "win32" || value.architecture !== "x64" || !Array.isArray(value.command) ||
        value.command.length !== 1 || path.win32.basename(value.command[0]) !== STAGED_CANDIDATE)
        throw new TypeError("full verifier summary is invalid");
    if (!Array.isArray(value.processes) || value.processes.length !== EXPECTED_PROCESS_SCENARIOS.length)
        throw new TypeError("full verifier process receipts are incomplete");
    value.processes.forEach((record, index) => {
        keys(record, ["pid", "scenario"], "full verifier process receipt");
        if (record.scenario !== EXPECTED_PROCESS_SCENARIOS[index] || !Number.isInteger(record.pid) ||
            record.pid < 1 || record.pid > 0xffff_ffff)
            throw new TypeError("full verifier process receipt is invalid");
    });
    if (!Array.isArray(value.databaseChecks) || value.databaseChecks.length !== EXPECTED_DATABASE_SCENARIOS.length)
        throw new TypeError("full verifier database receipts are incomplete");
    let expectedPopulated = null;
    value.databaseChecks.forEach((record, index) => {
        if (index === EXPECTED_DATABASE_SCENARIOS.length - 1) {
            keys(record, ["configTable", "integrity", "scenario"], "full verifier reset database receipt");
            if (record.scenario !== EXPECTED_DATABASE_SCENARIOS[index] || record.integrity !== "ok" ||
                record.configTable !== false) throw new TypeError("full verifier reset database receipt is invalid");
            return;
        }
        keys(record, ["passwordValueSha256", "ping", "resultId", "scenario"],
            "full verifier populated database receipt");
        if (record.scenario !== EXPECTED_DATABASE_SCENARIOS[index])
            throw new TypeError("full verifier database scenario is invalid");
        const observed = {ping: boundedSummaryString(record.ping, "full verifier database ping"),
            resultId: boundedSummaryString(record.resultId, "full verifier database result ID"),
            passwordValueSha256: exactString(record.passwordValueSha256, SHA256_PATTERN,
                "full verifier database password fingerprint")};
        if (expectedPopulated === null) expectedPopulated = observed;
        else if (!same(observed, expectedPopulated))
            throw new TypeError("full verifier populated database receipts differ");
    });
    if (!Array.isArray(value.openGraphChecks) || value.openGraphChecks.length !== EXPECTED_OPEN_GRAPH_SCENARIOS.length)
        throw new TypeError("full verifier OpenGraph receipts are incomplete");
    value.openGraphChecks.forEach((record, index) => {
        keys(record, ["elapsedMs", "scenario"], "full verifier OpenGraph receipt");
        if (record.scenario !== EXPECTED_OPEN_GRAPH_SCENARIOS[index] || !Number.isInteger(record.elapsedMs) ||
            record.elapsedMs < 0 || record.elapsedMs > OPEN_GRAPH_QUALIFICATION_TIMEOUT_MS)
            throw new TypeError("full verifier OpenGraph receipt is invalid");
    });
    keys(value.networkIsolation, ["enabledNonLoopbackInterfaces", "hardwareNics", "kind", "nonLoopbackRoutes"],
        "full verifier network isolation");
    validateZeroNetwork({hardwareNics: value.networkIsolation.hardwareNics,
        enabledNonLoopbackInterfaces: value.networkIsolation.enabledNonLoopbackInterfaces,
        nonLoopbackRoutes: value.networkIsolation.nonLoopbackRoutes}, "full verifier network isolation");
    if (value.networkIsolation.kind !== "qemu-nic-none-windows-guest")
        throw new TypeError("full verifier network isolation kind is invalid");
    if (!Array.isArray(value.shutdownProofs) || value.shutdownProofs.length !== EXPECTED_PROCESS_SCENARIOS.length)
        throw new TypeError("full verifier shutdown proof set is invalid");
    for (const [index, proof] of value.shutdownProofs.entries()) {
        keys(proof, ["candidateExitCode", "candidateExited", "controllerLifecyclePassed", "forced", "handlesClosed",
            "jobActiveProcesses", "scenario"], "full verifier shutdown proof");
        const expectedExit = proof.scenario === "fresh-no-config-reset" ? RESET_NOTHING_TO_DO_EXIT : SUCCESS_EXIT;
        if (proof.scenario !== EXPECTED_PROCESS_SCENARIOS[index] || proof.controllerLifecyclePassed !== true ||
            proof.candidateExited !== true || proof.candidateExitCode !== expectedExit || proof.forced !== false ||
            proof.jobActiveProcesses !== 0 || proof.handlesClosed !== true)
            throw new TypeError("full verifier shutdown proof is invalid");
    }
}

export function validateBaselineGuestResult(value, requestValue) {
    const checked = validateRequest(requestValue);
    keys(value, ["candidate", "cleanupProven", "context", "cpu", "network", "profile", "releaseGatesCleared",
        "schemaVersion", "status", "verifier"], "baseline guest result");
    /*
     * `cleanupProven` is the guest's own teardown proof. The bootstrap already refuses to publish a
     * result whose cleanup is unproven, so requiring it here costs nothing and closes the gap where
     * a guest could report an observed run it never cleaned up after.
     */
    if (value.schemaVersion !== SCHEMA_VERSION || value.status !== "observed" || value.profile !== PROFILE ||
        value.cleanupProven !== true || !same(value.context, checked.context) ||
        !Array.isArray(value.releaseGatesCleared) ||
        value.releaseGatesCleared.length !== 0) throw new TypeError("baseline guest header is invalid");
    keys(value.candidate, ["artifactName", "sha256", "sourceSha"], "baseline guest candidate");
    if (value.candidate.artifactName !== BASELINE_ARTIFACT || value.candidate.sourceSha !== checked.candidate.sourceSha ||
        value.candidate.sha256 !== checked.candidate.file.sha256) throw new TypeError("baseline guest candidate differs");
    keys(value.cpu, ["avx", "avx2", "cpuidBytesBase64", "cpuidSha256", "model", "osxsave", "popcnt", "sse42",
        "xcr0"],
    "baseline guest CPU");
    const cpuid = decodeEvidence(value.cpu.cpuidBytesBase64, value.cpu.cpuidSha256, "baseline guest CPUID");
    const projection = validateCpuidBytes(cpuid.parsed);
    if (value.cpu.model !== CPU_MODEL || value.cpu.sse42 !== true || value.cpu.popcnt !== true ||
        value.cpu.avx !== false || value.cpu.avx2 !== false || value.cpu.osxsave !== false || value.cpu.xcr0 !== null ||
        !same(projection, {sse42: value.cpu.sse42, popcnt: value.cpu.popcnt, osxsave: value.cpu.osxsave,
            avx: value.cpu.avx, avx2: value.cpu.avx2, xcr0: value.cpu.xcr0}))
        throw new TypeError("baseline guest CPU does not prove the target floor");
    validateZeroNetwork(value.network, "baseline guest network");
    keys(value.verifier, ["summary", "summaryBytesBase64", "summarySha256"], "baseline verifier evidence");
    const summary = decodeEvidence(value.verifier.summaryBytesBase64, value.verifier.summarySha256,
        "baseline verifier summary");
    if (!same(summary.parsed, value.verifier.summary)) throw new TypeError("baseline verifier summary bytes differ");
    validateFullSummary(value.verifier.summary, checked.request);
    return structuredClone(value);
}

/*
 * The guest writes the completion marker from the very bytes it has just published, so a marker
 * that disagrees with what was extracted is not a run that went another way - it is contradictory
 * evidence about one run, and nothing may be accepted on it. Hence one direction of the rule is
 * unconditional: a marker that is present must match, however QEMU exited. The other stays
 * conditional, because a clean exit proves the workload finished without any marker at all, while a
 * forced teardown was authorized by a marker and cannot then be accepted in its absence.
 *
 * Shape and nonce are checked here rather than trusted from the parse upstream: this is the trust
 * boundary the value crosses, and everything else crossing it is revalidated on arrival.
 */
function assertCorroboratedPublication({marker, cpuReceipt, baselineIdentity, process, nonce}) {
    const forced = process?.terminationReason === POST_COMPLETION_TERMINATION_REASON;
    /*
     * Checked whenever it is present, not only when a marker turns up to be compared against it.
     * A receipt with nothing to corroborate it still reaches an accepted, retained result, and a
     * later reader of that field cannot tell a value that was checked from one that was merely
     * carried. This is the field this change introduced, so it is exact-key checked.
     */
    if (cpuReceipt !== undefined) {
        keys(cpuReceipt, ["bytes", "sha256"], "Stage 3 extracted CPU receipt identity");
        decimal(cpuReceipt.bytes, "Stage 3 extracted CPU receipt identity bytes", {positive: true});
        exactString(cpuReceipt.sha256, SHA256_PATTERN, "Stage 3 extracted CPU receipt identity hash");
    }
    if (marker === undefined) {
        if (forced) throw new TypeError(
            "Stage 3 forced teardown was accepted without the completion marker that authorized it");
        return;
    }
    if (marker === null || typeof marker !== "object" || Array.isArray(marker) ||
        !Object.hasOwn(marker, "record"))
        throw new TypeError(`Stage 3 completion marker was not usable: ${
            typeof marker?.invalid === "string" ? marker.invalid : "malformed"}`);
    keys(marker, ["record"], "Stage 3 completion marker");
    const record = marker.record;
    keys(record, ["baseline", "cpu", "nonce"], "Stage 3 completion marker record");
    if (record.nonce !== nonce)
        throw new TypeError("Stage 3 completion marker carries another run's nonce");
    if (cpuReceipt === undefined || baselineIdentity === undefined)
        throw new TypeError("Stage 3 completion marker has no extracted receipt to corroborate");
    for (const [name, claimed, extracted] of [["baseline", record.baseline, baselineIdentity],
        ["CPU", record.cpu, cpuReceipt]]) {
        /*
         * Both sides are validated before they are compared, because equality alone proves only
         * that two values agree - and two values that are both nonsense agree perfectly. A byte
         * count that is not a canonical positive decimal, or a hash that is not a lowercase
         * SHA-256, is not evidence of a publication whatever it matches.
         */
        keys(claimed, ["bytes", "sha256"], `Stage 3 completion marker ${name} identity`);
        for (const [side, identity] of [["marker", claimed], ["extracted", extracted]]) {
            decimal(identity?.bytes, `Stage 3 completion ${name} ${side} identity bytes`, {positive: true});
            exactString(identity.sha256, SHA256_PATTERN, `Stage 3 completion ${name} ${side} identity hash`);

        }
        if (claimed.bytes !== extracted.bytes || claimed.sha256 !== extracted.sha256)
            throw new TypeError(
                `Stage 3 completion marker ${name} identity differs from what was extracted`);
    }
}

function validateCollectedGuest(value, requestValue, pathsValue, expectedOutputDisk) {
    keys(value, ["bytesBase64", "identity", "result", "sourceOutputDisk"], "baseline collected guest result");
    const sourceOutputDisk = validateIdentity(value.sourceOutputDisk, "baseline guest source output disk");
    if (sourceOutputDisk.path !== pathsValue.outputDisk || !same(sourceOutputDisk, expectedOutputDisk))
        throw new TypeError("baseline guest source output disk differs");
    const id = validateIdentity(value.identity, "baseline collected guest result identity");
    directChild(pathsValue.root, id.path, "baseline-result.json");
    const decoded = decodeEvidence(value.bytesBase64, id.sha256, "baseline collected guest result");
    if (String(decoded.bytes.length) !== id.bytes || !same(decoded.parsed, value.result))
        throw new TypeError("baseline collected guest result bytes differ");
    return validateBaselineGuestResult(value.result, requestValue);
}

export function validateCompletedStage3Result(value, requestValue, retainedStage2Bytes) {
    const checked = validateRequest(requestValue);
    if (!Buffer.isBuffer(retainedStage2Bytes) || retainedStage2Bytes.length < 2 ||
        retainedStage2Bytes.length > MAX_EMBEDDED_EVIDENCE_BYTES ||
        String(retainedStage2Bytes.length) !== checked.stage2Result.bytes ||
        crypto.createHash("sha256").update(retainedStage2Bytes).digest("hex") !== checked.stage2Result.sha256)
        throw new TypeError("retained Stage 2 result bytes differ");
    let stage2Value;
    try { stage2Value = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(retainedStage2Bytes)); }
    catch { throw new TypeError("retained Stage 2 result JSON is invalid"); }
    const stage2 = validateStage2Observation(stage2Value, checked.context);
    keys(value, ["argv", "baselineFullRuntimeAccepted", "candidate", "classification", "cleanupProven", "context",
        "cpuFloorAccepted", "earlyBoot", "guest", "guestEvidence", "media", "outputDisk", "qemuProcess", "qualifying",
        "releaseGateCleared", "reservation", "schemaVersion", "stage", "stage2GuestEvidence", "stage2Result",
        "status",
        /* Present only for a run whose guest published a marker; corroborated below where present. */
        ...(value?.serialCompletion === undefined ? [] : ["serialCompletion"]),
        ...(value?.cpuReceipt === undefined ? [] : ["cpuReceipt"])], "completed Stage 3 result");
    if (value.schemaVersion !== SCHEMA_VERSION || value.status !== "observed" || value.stage !== "complete" ||
        value.classification !== CLASSIFICATION || value.qualifying !== false || value.releaseGateCleared !== false ||
        value.baselineFullRuntimeAccepted !== true || value.cpuFloorAccepted !== true || value.cleanupProven !== true ||
        !same(value.context, checked.context) || !same(value.stage2Result, checked.stage2Result))
        throw new TypeError("completed Stage 3 result is not accepted");
    const candidate = validateAcquiredCandidate(value.candidate, checked.candidate, checked.paths.root);
    const stage2Guest = validateStage2GuestEvidence(value.stage2GuestEvidence, checked.stage2GuestResult,
        checked.context, stage2.guest);
    const media = validatePreparedMedia(value.media, checked.paths);
    const windowsIso = {path: `/home/runner/work/_temp/myspeed-windows-cpu-floor-${checked.context.nonce}/windows.iso`,
        bytes: stage2.iso.bytes, sha256: stage2.iso.sha256};
    const argv = buildBaselineQemuArguments({paths: checked.paths, toolchain: stage2.toolchain, windowsIso});
    if (!same(value.argv, argv)) throw new TypeError("completed Stage 3 QEMU vector differs");
    validateEarlyBoot(value.earlyBoot, checked.paths, checked.bootConfirmation);
    validateStage3Reservation(value.reservation);
    validateProcess(value.qemuProcess, stage2.toolchain, true);
    const outputDisk = validateIdentity(value.outputDisk, "completed Stage 3 output disk");
    if (outputDisk.path !== checked.paths.outputDisk || outputDisk.bytes !== OUTPUT_DISK_BYTES)
        throw new TypeError("completed Stage 3 output disk differs");
    const guest = validateCollectedGuest(value.guestEvidence, checked.request, checked.paths, outputDisk);
    assertCorroboratedCpuid(baselineCpuidRecord(guest), stage2Guest.cpuid);
    assertCorroboratedPublication({marker: value.serialCompletion, cpuReceipt: value.cpuReceipt,
        baselineIdentity: value.guestEvidence.identity, process: value.qemuProcess,
        nonce: checked.context.nonce});
    if (!same(guest, value.guest)) throw new TypeError("completed Stage 3 guest evidence differs");
    return Object.freeze({accepted: true, stage2, candidate, media});
}

/*
 * The baseline launch's own failure evidence, retained on the failed Stage 3 result.
 *
 * Run 35340111409 booted past firmware, hung, and was killed at the execution ceiling; the launcher
 * had already built a `qemu-launch-failure-diagnostic` holding the termination reason, the serial
 * console and the guest's stderr, and `launchBaselineGuest` threw it away, leaving one sentence.
 * What is retained here is bounded on purpose: the Stage 3 controller writes the whole result under
 * its own 4 MiB cap, so a diagnostic that carried the captured PNG frames inline would push the
 * result over that cap and produce no result file at all - strictly worse than the sentence. Frame
 * identities are kept and frame bodies are dropped, because the bodies are already retained in the
 * evidence bundle while the identities are what tie the two together.
 *
 * This is evidence about a failure and nothing else. It is attached only by `failure()`, never by
 * the accepted result, and it neither sets nor relaxes any acceptance, cleanup or release flag.
 */
const LAUNCH_DIAGNOSTIC_KIND = "stage3-qemu-launch-diagnostic";
const DEADLINE_TERMINATION_REASON = "deadline";
const SHELL_FALLBACK_TERMINATION_REASON = "efi-shell-fallback";
export const STAGE3_LAUNCH_CLASSIFICATIONS = Object.freeze({
    hostExecutionDeadline: "host-execution-deadline",
    firmwareShellFallback: "firmware-shell-fallback",
    guestReportedFailure: "guest-reported-failure",
    guestResultUnavailable: "guest-result-unavailable"
});
/*
 * The one threshold that separates the two payload classes this diagnostic carries. The bounded
 * streams worth retaining inline are the 64 KiB serial console and the 64 KiB stderr capture, which
 * encode to 87 384 base64 characters each; the payloads that must not travel are the captured PNG
 * frames, which run to 1 398 104 characters for a 1 MiB frame. Anything between the two is retained,
 * and the whole-diagnostic budget below is what actually bounds the result.
 */
const MAX_INLINE_BASE64_CHARACTERS = 131_072;
const MAX_DIAGNOSTIC_CHARACTERS = 1024 * 1024;
/* The Stage 3 controller's own cap on the serialized result; the diagnostic is sized against it. */
const MAX_RESULT_CHARACTERS = 4 * 1024 * 1024;
const OMITTED_PAYLOAD_MARKER = "omitted-oversized-payload";
const OMITTED_DIAGNOSTIC_MARKER = "omitted-oversized-diagnostic";

function classifyLaunchFailure(terminationReason, guestFailureObserved) {
    if (terminationReason === DEADLINE_TERMINATION_REASON)
        return STAGE3_LAUNCH_CLASSIFICATIONS.hostExecutionDeadline;
    if (terminationReason === SHELL_FALLBACK_TERMINATION_REASON)
        return STAGE3_LAUNCH_CLASSIFICATIONS.firmwareShellFallback;
    if (guestFailureObserved) return STAGE3_LAUNCH_CLASSIFICATIONS.guestReportedFailure;
    return STAGE3_LAUNCH_CLASSIFICATIONS.guestResultUnavailable;
}

/*
 * A deep copy that drops oversized encoded payloads and keeps everything else, rather than copying
 * a fixed list of members. The launcher's diagnostic has grown a predeadline frame, mid-window
 * frames and a shutdown record over successive rounds, and an allow-list here would have silently
 * dropped each of them on the day it was added.
 */
function withoutOversizedPayloads(value) {
    if (Array.isArray(value)) return value.map(item => withoutOversizedPayloads(item));
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([name, item]) =>
        [name, typeof item === "string" && item.length > MAX_INLINE_BASE64_CHARACTERS ?
            OMITTED_PAYLOAD_MARKER : withoutOversizedPayloads(item)]));
}

export function buildStage3LaunchDiagnostic(launch) {
    if (launch === null || typeof launch !== "object" || Array.isArray(launch)) return null;
    const retained = launch.failureDiagnostic;
    const carried = retained !== null && typeof retained === "object" && !Array.isArray(retained) ?
        structuredClone(retained) : {};
    delete carried.schemaVersion;
    delete carried.kind;
    const observed = carried.process ?? launch.process ?? null;
    const terminationReason = typeof observed?.terminationReason === "string" ?
        observed.terminationReason : null;
    const guestFailure = launch.guestFailure !== null && typeof launch.guestFailure === "object" &&
        !Array.isArray(launch.guestFailure) ? structuredClone(launch.guestFailure) : null;
    return withoutOversizedPayloads({
        ...carried,
        schemaVersion: SCHEMA_VERSION,
        kind: LAUNCH_DIAGNOSTIC_KIND,
        classification: classifyLaunchFailure(terminationReason, guestFailure !== null),
        terminationReason,
        guestFailureObserved: guestFailure !== null,
        ...(observed === null ? {} : {process: structuredClone(observed)}),
        /*
         * The early-boot observation carries `inputSent`, the only proof of which boot keystrokes
         * the monitor accepted and at what offsets - the single piece of evidence that answers a
         * missed "press any key" prompt. Its screenshot bodies are dropped by the transform above.
         */
        ...(launch.earlyBoot === null || launch.earlyBoot === undefined ? {} :
            {earlyBoot: structuredClone(launch.earlyBoot)}),
        ...(guestFailure === null ? {} : {guestFailure})
    });
}

export function buildStage3LaunchFailure(message, diagnostic) {
    const error = new Error(message);
    if (diagnostic !== null && diagnostic !== undefined) error.qemuLaunchDiagnostic = diagnostic;
    return error;
}

/*
 * The last bound before the result is written. A diagnostic that is still too large after the frame
 * bodies are gone is replaced by the few members that identify the failure, so an oversized record
 * costs its own detail and never the result file that carries it.
 */
function retainedLaunchDiagnostic(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const bounded = withoutOversizedPayloads(value);
    if (JSON.stringify(bounded).length <= MAX_DIAGNOSTIC_CHARACTERS) return bounded;
    const summary = {schemaVersion: SCHEMA_VERSION, kind: LAUNCH_DIAGNOSTIC_KIND,
        classification: bounded.classification ?? STAGE3_LAUNCH_CLASSIFICATIONS.guestResultUnavailable,
        terminationReason: bounded.terminationReason ?? null,
        guestFailureObserved: bounded.guestFailureObserved === true,
        ...(bounded.process === undefined ? {} : {process: bounded.process}),
        omitted: OMITTED_DIAGNOSTIC_MARKER};
    /*
     * The guest's own receipt travels with the flag that announces it. A summary saying a receipt
     * was observed while dropping the receipt itself would be the same blackout this member exists
     * to end, one field smaller. It is dropped only if carrying it would put the summary back over
     * budget, and then the flag alone is what remains.
     */
    if (bounded.guestFailure === undefined) return summary;
    const withReceipt = {...summary, guestFailure: bounded.guestFailure};
    return JSON.stringify(withReceipt).length <= MAX_DIAGNOSTIC_CHARACTERS ? withReceipt : summary;
}

export const STAGE3_LAUNCH_DIAGNOSTIC_CONSTANTS = Object.freeze({LAUNCH_DIAGNOSTIC_KIND,
    MAX_DIAGNOSTIC_CHARACTERS, MAX_INLINE_BASE64_CHARACTERS, MAX_RESULT_CHARACTERS,
    OMITTED_DIAGNOSTIC_MARKER, OMITTED_PAYLOAD_MARKER});

function failure(context, stage, error, cleanupProven) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]+/gu, " ")
        .slice(0, MAX_FAILURE_MESSAGE_CHARACTERS);
    const qemuLaunch = retainedLaunchDiagnostic(error?.qemuLaunchDiagnostic ?? null);
    return Object.freeze({schemaVersion: SCHEMA_VERSION, status: "failed", stage, classification: CLASSIFICATION,
        qualifying: false, releaseGateCleared: false, baselineFullRuntimeAccepted: false, cpuFloorAccepted: false,
        cleanupProven, context: context ? structuredClone(context) : null, failure: message || "unspecified failure",
        ...(qemuLaunch === null ? {} : {qemuLaunch})});
}

export async function runWindowsCpuFloorStage3(input, operations) {
    let context = null;
    let stage = "request";
    let cleanupProven = true;
    try {
        const checked = validateRequest(input);
        context = checked.context;
        const required = ["acquireCandidate", "collectBaselineGuestResult", "launchBaselineGuest",
            "prepareBaselineMedia", "replayStage2"];
        if (!operations || typeof operations !== "object" || required.some(name => typeof operations[name] !== "function"))
            throw new TypeError("Stage 3 operations are incomplete");
        stage = "stage2-replay";
        const replay = await operations.replayStage2({context, identity: checked.stage2Result,
            guestIdentity: checked.stage2GuestResult});
        keys(replay, ["guestEvidence", "identity", "result"], "Stage 2 replay");
        if (!same(replay.identity, checked.stage2Result)) throw new TypeError("Stage 2 result identity differs");
        const stage2 = validateStage2Observation(replay.result, context);
        const stage2Guest = validateStage2GuestEvidence(replay.guestEvidence, checked.stage2GuestResult,
            context, stage2.guest);
        const stage2GuestEvidence = stage2Guest.evidence;
        const windowsIso = {path: `/home/runner/work/_temp/myspeed-windows-cpu-floor-${context.nonce}/windows.iso`,
            bytes: stage2.iso.bytes, sha256: stage2.iso.sha256};
        stage = "candidate";
        const candidate = validateAcquiredCandidate(await operations.acquireCandidate({context,
            candidate: checked.candidate, root: checked.paths.root}), checked.candidate, checked.paths.root);
        stage = "media";
        const media = validatePreparedMedia(await operations.prepareBaselineMedia({context, candidate,
            paths: checked.paths, stage2, toolchain: stage2.toolchain, windowsIso}), checked.paths);
        const argv = buildBaselineQemuArguments({paths: checked.paths, toolchain: stage2.toolchain, windowsIso});
        stage = "qemu-launch";
        cleanupProven = false;
        const launch = await operations.launchBaselineGuest({context, argv, budget: checked.budget, candidate,
            media, paths: checked.paths, profile: PROFILE, stage2, toolchain: stage2.toolchain, windowsIso,
            ...(checked.bootConfirmation === undefined ? {} : {bootConfirmation: checked.bootConfirmation})});
        const launchKeys = ["argv", "earlyBoot", "outputDisk", "process", "reservation"];
        /* Present only for a launch that asked for the marker; admitted here, judged below. */
        if (launch?.serialCompletion !== undefined) launchKeys.push("serialCompletion");
        if (launch?.cpuReceipt !== undefined) launchKeys.push("cpuReceipt");
        keys(launch, launchKeys, "Stage 3 launch observation");
        if (!same(launch.argv, argv)) throw new TypeError("Stage 3 observed QEMU vector differs");
        const earlyBoot = validateEarlyBoot(launch.earlyBoot, checked.paths, checked.bootConfirmation);
        const reservation = validateStage3Reservation(launch.reservation);
        try { validateProcess(launch.process, stage2.toolchain, true); }
        catch (error) { cleanupProven = false; throw error; }
        cleanupProven = true;
        const outputDisk = validateIdentity(launch.outputDisk, "Stage 3 completed output disk");
        if (outputDisk.path !== checked.paths.outputDisk || outputDisk.bytes !== OUTPUT_DISK_BYTES)
            throw new TypeError("Stage 3 output disk differs");
        stage = "guest-output";
        const guestEvidence = await operations.collectBaselineGuestResult({context, candidate,
            outputDisk, paths: checked.paths});
        const guest = validateCollectedGuest(guestEvidence, checked.request, checked.paths, outputDisk);
        assertCorroboratedCpuid(baselineCpuidRecord(guest), stage2Guest.cpuid);
        assertCorroboratedPublication({marker: launch.serialCompletion, cpuReceipt: launch.cpuReceipt,
            baselineIdentity: guestEvidence.identity, process: launch.process, nonce: context.nonce});
        return Object.freeze({schemaVersion: SCHEMA_VERSION, status: "observed", stage: "complete",
            classification: CLASSIFICATION, qualifying: false, releaseGateCleared: false,
            baselineFullRuntimeAccepted: true, cpuFloorAccepted: true, cleanupProven: true, context,
            stage2Result: checked.stage2Result, stage2GuestEvidence, candidate, media, argv,
            earlyBoot: structuredClone(earlyBoot), reservation: structuredClone(reservation),
            qemuProcess: launch.process, outputDisk,
            guestEvidence: structuredClone(guestEvidence), guest,
            ...(launch.serialCompletion === undefined ? {} :
                {serialCompletion: structuredClone(launch.serialCompletion)}),
            ...(launch.cpuReceipt === undefined ? {} : {cpuReceipt: structuredClone(launch.cpuReceipt)})});
    } catch (error) { return failure(context, stage, error, cleanupProven); }
}

export const STAGE3_CONSTANTS = Object.freeze({AUTHORIZATION_SCOPE, BASELINE_ARTIFACT, CLASSIFICATION, CONFIRMATION,
    CPU_MODEL, OUTPUT_DISK_BYTES, PROFILE, SYSTEM_DISK_VIRTUAL_BYTES});
