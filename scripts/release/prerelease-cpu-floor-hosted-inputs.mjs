import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {validateHostedContext} from "../qualification/linux-kvm-capability.mjs";
import {stage2ClosureFromStage3Closure, executeStage3Launcher} from
    "../qualification/linux-windows-cpu-floor-stage3-launcher.mjs";
import {WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS} from
    "../qualification/windows-baseline-guest-runtime-bundle.mjs";
import {CANDIDATE_PROVENANCE} from "../qualification/windows-cpu-floor-candidate-provenance.mjs";
/*
 * Shared with the published path despite its name. The module was pinned to v1.6.1 by one line;
 * that line is now a provenance branch, so both callers use the same guest file preparation and
 * cannot drift in what they hand the guest. The name is stale and worth a separate tidy-up: it is
 * listed in the Stage 3 execution closure, so renaming the file is a change to a sealed set.
 */
import {prepareV161PostReleaseCpuFloorGuestFiles} from "./post-release-cpu-floor-guest-preparation.mjs";
import {createPrereleaseCpuFloorBinding, acquirePrereleaseCpuFloorCandidate} from
    "./prerelease-cpu-floor.mjs";

/*
 * Assembles the hosted inputs for a branch CPU-floor run and hands them to the Stage 3 launcher.
 *
 * The published sibling reads its candidate out of an MSI preparation bundle and carries two
 * release records into the guest alongside the executable. A branch build has neither: its bundle
 * is assembled from the very commit under test, and the executable is the only candidate file
 * staged. What it keeps is the part that matters - nothing reaches the guest whose bytes were not
 * checked against an identity established before the download.
 */

const RUNTIME_INSTALLER_PATH =
    "runtime/scripts/qualification/windows-baseline-guest-runtime-installer.ps1";
const FIXTURE_MANIFEST_PATH = "fixture/transport.json";
const NODE_RUNTIME_PATH = "node.exe";
const STAGED_CANDIDATE_NAME = "MySpeed.exe";
const TEMPORARY_ROOT = "/home/runner/work/_temp";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const INPUT_KEYS = ["bundle", "candidateDeclaredSha256", "candidateExe", "closureRecords",
    "hostedContext", "observedAt", "probeArtifact", "probes", "roots", "stage3Plan", "target"];
const ROOT_KEYS = ["candidate", "closure", "envelope", "stage2Closure", "stage3", "transport"];
const BUNDLE_KEYS = ["files", "root"];

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

const exactKeys = (value, keys, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)
            || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
        throw new TypeError(`${label} schema differs`);
    }
};

/*
 * Reads a file only if what is on disk still matches the identity that was declared for it, with
 * the same open-once discipline the published path uses: the handle is stat'd before and after, the
 * path must be its own realpath, and a single extra readable byte is a failure.
 */
function readOwned(identity, label) {
    const expected = Number(identity?.bytes);
    if (!identity || typeof identity.path !== "string" || !path.isAbsolute(identity.path)
            || !Number.isSafeInteger(expected) || expected < 1 || expected > MAX_FILE_BYTES
            || !/^[0-9a-f]{64}$/u.test(identity.sha256)) {
        throw new TypeError(`${label} identity differs`);
    }
    const lexical = fs.lstatSync(identity.path, {bigint: true});
    const handle = fs.openSync(identity.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
        const before = fs.fstatSync(handle, {bigint: true});
        if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.nlink !== 1n
                || before.nlink !== 1n || before.dev !== lexical.dev || before.ino !== lexical.ino
                || before.size !== BigInt(expected)
                || fs.realpathSync.native(identity.path) !== identity.path) {
            throw new Error(`${label} physical identity differs`);
        }
        const bytes = Buffer.alloc(expected);
        let offset = 0;
        while (offset < bytes.length) {
            const count = fs.readSync(handle, bytes, offset, bytes.length - offset, offset);
            if (count < 1) throw new Error(`${label} was truncated`);
            offset += count;
        }
        const trailing = fs.readSync(handle, Buffer.alloc(1), 0, 1, bytes.length);
        const after = fs.fstatSync(handle, {bigint: true});
        const lexicalAfter = fs.lstatSync(identity.path, {bigint: true});
        if (trailing !== 0 || before.dev !== after.dev || before.ino !== after.ino
                || before.size !== after.size || before.mtimeNs !== after.mtimeNs
                || after.dev !== lexicalAfter.dev || after.ino !== lexicalAfter.ino
                || lexicalAfter.isSymbolicLink() || lexicalAfter.nlink !== 1n
                || fs.realpathSync.native(identity.path) !== identity.path
                || sha256(bytes) !== identity.sha256) {
            throw new Error(`${label} content identity differs`);
        }
        return bytes;
    } finally {
        fs.closeSync(handle);
    }
}

function writeOwned(target, bytes) {
    fs.writeFileSync(target, bytes, {flag: "wx", mode: FILE_MODE});
    if (!fs.readFileSync(target).equals(bytes)) {
        throw new Error("hosted input staging identity differs");
    }
}

/*
 * Every file in a branch bundle comes from the one commit under test, so unlike the published path
 * there is no harness-versus-candidate role to distinguish here - but the declared source SHA is
 * still checked, so a bundle built from anything else is refused rather than staged.
 */
function bundleIdentity(bundle, relativePath, sourceSha) {
    const file = bundle.files.find(record => record?.relativePath === relativePath);
    if (!file || file.sourceSha !== sourceSha) {
        throw new Error(`bundle file is missing or differs: ${relativePath}`);
    }
    return {path: path.join(bundle.root, ...relativePath.split("/")),
        bytes: String(file.bytes), sha256: file.sha256};
}

export async function runPrereleaseCpuFloorHostedInputs(input, dependencies = {}) {
    exactKeys(input, INPUT_KEYS, "hosted pre-release CPU-floor input");
    const {bundle, candidateDeclaredSha256, candidateExe, closureRecords, hostedContext,
        observedAt, probeArtifact, probes, roots, stage3Plan, target} = input;
    validateHostedContext(hostedContext);
    exactKeys(bundle, BUNDLE_KEYS, "guest bundle");
    if (!Array.isArray(bundle.files) || !path.isAbsolute(bundle.root)) {
        throw new TypeError("guest bundle root or file list differs");
    }

    const binding = createPrereleaseCpuFloorBinding({hostedContext, target});
    const acquired = acquirePrereleaseCpuFloorCandidate(binding,
        {file: {bytes: String(candidateExe.bytes), sha256: candidateExe.sha256},
            declaredSha256: candidateDeclaredSha256, observedAt});

    exactKeys(roots, ROOT_KEYS, "hosted CPU-floor roots");
    if (roots.stage3 !== `${TEMPORARY_ROOT}/myspeed-stage3-${hostedContext.nonce}`
            || roots.candidate !== `${roots.stage3}/candidate`
            || roots.closure !== `${TEMPORARY_ROOT}/myspeed-stage3-closure-${hostedContext.nonce}`
            || roots.stage2Closure !== `${TEMPORARY_ROOT}/myspeed-stage2-closure-${hostedContext.nonce}`
            || roots.transport !== `${TEMPORARY_ROOT}/myspeed-stage2-transport-${hostedContext.nonce}`
            || roots.envelope !== `${TEMPORARY_ROOT}/myspeed-stage3-sequence-envelope-${hostedContext.nonce}`) {
        throw new Error("hosted Stage 3 roots differ");
    }
    (dependencies.makeDirectory ?? (target_ => fs.mkdirSync(target_, {mode: DIRECTORY_MODE})))(roots.stage3);

    const {sourceSha} = binding.candidate;
    const runtimeSources = WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS
        .map(relativePath => ({relativePath,
            source: bundleIdentity(bundle, `runtime/${relativePath}`, sourceSha)}));
    const runtimeInstaller = bundleIdentity(bundle, RUNTIME_INSTALLER_PATH, sourceSha);
    const fixture = {manifest: bundleIdentity(bundle, FIXTURE_MANIFEST_PATH, sourceSha),
        populatedRoot: path.join(bundle.root, "fixture", "populated"),
        resetRoot: path.join(bundle.root, "fixture", "reset")};
    const runtimeNode = bundleIdentity(bundle, NODE_RUNTIME_PATH, sourceSha);

    const prepareGuest = dependencies.prepareGuest ?? prepareV161PostReleaseCpuFloorGuestFiles;
    const preparedGuest = prepareGuest({
        context: hostedContext,
        candidate: {
            provenance: CANDIDATE_PROVENANCE.branch,
            sourceSha, artifactName: binding.candidate.artifact.name,
            file: {name: STAGED_CANDIDATE_NAME, bytes: acquired.candidate.file.bytes,
                sha256: acquired.candidate.file.sha256}
        },
        runtimeNode, fixture, runtimeSources, runtimeInstaller,
        probes: probes.map(probe => ({...probe, bytes: String(probe.bytes)})),
        imageVersion: hostedContext.environment.ImageVersion,
        /*
         * The published run carries the digest of the manifest sealed at release time. A branch run
         * has none, so it carries the digest of the artifact this run produced - the same value the
         * binding treats as the root of its provenance. The guest only checks that it is a digest
         * and carries it through, but it should be a digest that means something.
         */
        manifestSha256: acquired.candidate.artifact.archiveDigest.slice("sha256:".length),
        outputRoot: roots.candidate
    });

    const stageFile = dependencies.stageFile ?? writeOwned;
    stageFile(path.join(roots.candidate, STAGED_CANDIDATE_NAME),
        (dependencies.readOwned ?? readOwned)(candidateExe, "candidate executable"));

    (dependencies.makeStage2Closure ?? stage2ClosureFromStage3Closure)(roots.closure, roots.stage2Closure);
    const launch = dependencies.launch ?? executeStage3Launcher;
    const result = await launch({closureRoot: roots.closure, closureRecords, transportRoot: roots.transport,
        envelopeRoot: roots.envelope, binding, acquired, plan: stage3Plan, probeArtifact,
        guestFiles: preparedGuest.files}, dependencies.launchDependencies);
    if (result?.accepted !== true) throw new Error("Stage 3 consumer did not accept the execution");
    return result;
}
