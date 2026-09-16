/*
 * The Stage 2 request the MSI lifecycle job hands to the CPU-floor controller.
 *
 * The MSI lifecycle has to calibrate its base image through Stage 2, in the same job, before it can
 * seal an installed base. Stage 2 is frozen and its `validateStage2ControllerRequest` is exact: the
 * closure is eight named files in one order, rooted at `myspeed-stage2-closure-<nonce>`, and every
 * KVM and probe input is staged at a named path under `myspeed-stage2-input-<nonce>`. The MSI
 * closure and the MSI input root are different trees with different contents, and handing Stage 2
 * either of them is refused - correctly - by the validator.
 *
 * So the two closures stay separate. This module builds the request against Stage 2's own roots and
 * list, and it exists as a module rather than as workflow text so a pure test can feed the request
 * it really produces to the real validator. A regex over the workflow could not have caught the
 * mismatch that made this necessary.
 *
 * Nothing here loosens a Stage 2 check, reads a file or executes anything: file identities arrive
 * through an injected `identity`, which is what the workflow's own bounded reader supplies.
 */

import {INSTALLER_BOOT_CONFIRMATION} from "./linux-windows-cpu-floor-stage2-qmp.mjs";

export {INSTALLER_BOOT_CONFIRMATION};

/* Pinned by `validateStage2Paths`, which requires exactly this hosted temp root. */
const RUNNER_TEMP = "/home/runner/work/_temp";
const CLOSURE_PREFIX = `${RUNNER_TEMP}/myspeed-stage2-closure-`;
const INPUT_PREFIX = `${RUNNER_TEMP}/myspeed-stage2-input-`;
const STAGE2_PATHS_PREFIX = `${RUNNER_TEMP}/myspeed-windows-cpu-floor-`;
const PORTABLE_PREFIX = "/tmp/myspeed-windows-cpu-floor-tools-";

const SCHEMA_VERSION = 1;
const CONFIRMATION = "RUN-CANDIDATE-NEUTRAL-STAGE2";
const SCOPE = "candidate-neutral-cpu-calibration";
const PROBE_ARTIFACT_NAME = "windows-cpu-readiness-evidence";
const NONCE = /^[0-9a-f]{32}$/u;

/*
 * The exact list `validateStage2ControllerRequest` compares against, in its order. Changing either
 * side without the other fails the round-trip test rather than a hosted job with no checkout.
 */
export const WINDOWS_MSI_STAGE2_CLOSURE = Object.freeze([
    "scripts/qualification/linux-windows-cpu-floor-admission.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage2-controller.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage2.mjs",
    "scripts/qualification/linux-kvm-capability.mjs",
    "scripts/qualification/linux-kvm-privileged-capability.mjs",
    "scripts/qualification/windows-msi-post-setup-activation.mjs"
]);

export const WINDOWS_MSI_STAGE2_PROBE_ROLES = Object.freeze(["avx", "avx2", "cpuid", "illegal",
    "known-bad", "known-good", "popcnt", "sse42"]);

export const WINDOWS_MSI_STAGE2_ROOTS = Object.freeze({
    closurePrefix: CLOSURE_PREFIX,
    inputPrefix: INPUT_PREFIX,
    stage2Prefix: STAGE2_PATHS_PREFIX,
    portablePrefix: PORTABLE_PREFIX
});

export const WINDOWS_MSI_STAGE2_INPUT_NAMES = Object.freeze(["ordinary.json", "combined.json",
    "artifact.zip", "result.json",
    ...WINDOWS_MSI_STAGE2_PROBE_ROLES.map(role => `${role.replaceAll("-", "_")}.exe`)]);

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

export const windowsMsiStage2Roots = nonce => {
    if (typeof nonce !== "string" || !NONCE.test(nonce))
        throw new TypeError("Stage 2 request context nonce differs");
    return {closureRoot: `${CLOSURE_PREFIX}${nonce}`, inputRoot: `${INPUT_PREFIX}${nonce}`};
};

export const windowsMsiStage2Paths = nonce => {
    const root = `${STAGE2_PATHS_PREFIX}${nonce}`;
    return {root, packageRoot: `${root}/packages`, portableRoot: `${PORTABLE_PREFIX}${nonce}`,
        probeRoot: `${root}/probes`, windowsIso: `${root}/windows.iso`,
        installWim: `${root}/install.wim`, seedIso: `${root}/seed.iso`,
        outputDisk: `${root}/output.img`, systemDisk: `${root}/system.qcow2`,
        ovmfVars: `${root}/OVMF_VARS.fd`, serialLog: `${root}/serial.log`,
        qemuPid: `${root}/qemu.pid`};
};

export const buildWindowsMsiStage2Request = ({context, probe, identity, bootConfirmation}) => {
    if (!isObject(context)) throw new TypeError("Stage 2 request context differs");
    if (typeof identity !== "function") throw new TypeError("Stage 2 request needs a file identity");
    if (!isObject(probe)) throw new TypeError("Stage 2 request probe artifact differs");
    const {closureRoot, inputRoot} = windowsMsiStage2Roots(context.nonce);
    if (!Array.isArray(probe.files) || probe.files.length !== WINDOWS_MSI_STAGE2_PROBE_ROLES.length)
        throw new TypeError("Stage 2 request probe role set differs");
    probe.files.forEach((file, index) => {
        if (!isObject(file) || file.role !== WINDOWS_MSI_STAGE2_PROBE_ROLES[index]
            || file.name !== `${WINDOWS_MSI_STAGE2_PROBE_ROLES[index].replaceAll("-", "_")}.exe`)
            throw new TypeError("Stage 2 request probe role differs");
    });
    return {schemaVersion: SCHEMA_VERSION, context: structuredClone(context),
        closure: {root: closureRoot,
            files: WINDOWS_MSI_STAGE2_CLOSURE.map(name => identity(`${closureRoot}/${name}`))},
        authorization: {confirmation: CONFIRMATION, media: true, qemu: true, scope: SCOPE,
            ...(bootConfirmation === undefined ? {} : {bootConfirmation})},
        paths: windowsMsiStage2Paths(context.nonce),
        kvm: {ordinary: identity(`${inputRoot}/ordinary.json`),
            combined: identity(`${inputRoot}/combined.json`)},
        probeArtifact: {schemaVersion: SCHEMA_VERSION, repository: context.repository,
            sourceSha: probe.sourceSha, runId: probe.runId, runAttempt: probe.runAttempt,
            artifactId: probe.artifactId, artifactName: PROBE_ARTIFACT_NAME,
            archive: {bytes: probe.archiveBytes, sha256: probe.archiveSha256},
            innerManifest: (() => { const observed = identity(`${inputRoot}/result.json`);
                return {name: "result.json", bytes: String(observed.bytes), sha256: observed.sha256}; })(),
            files: probe.files.map(file => ({role: file.role, name: file.name, bytes: file.bytes,
                sha256: file.sha256}))},
        probeStage: {archive: identity(`${inputRoot}/artifact.zip`),
            result: identity(`${inputRoot}/result.json`),
            files: probe.files.map(file => identity(`${inputRoot}/${file.name}`))}};
};
