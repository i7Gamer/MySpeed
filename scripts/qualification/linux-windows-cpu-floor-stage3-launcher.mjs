import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {
    runHostedStage3Sequence,
    STAGE3_SEQUENCE_CONSTANTS
} from "./linux-windows-cpu-floor-stage3-sequence.mjs";
import {
    STAGE3_CONTROLLER_CONSTANTS
} from "./linux-windows-cpu-floor-stage3-controller.mjs";
import {
    STAGE3_CONSTANTS
} from "./linux-windows-cpu-floor-stage3.mjs";
import {
    createV161PostReleaseCpuFloorBinding,
    acquireV161PostReleaseCpuFloorBaselineSummary,
    buildV161PostReleaseCpuFloorStage2Request,
    buildV161PostReleaseCpuFloorStage3Request,
    inspectV161PostReleaseCpuFloorEvidence
} from "../release/post-release-cpu-floor.mjs";
import {bindV161PostReleaseTarget} from "../release/post-release-target.mjs";

const SCHEMA_VERSION = 1;
const LAUNCHER_KIND = "myspeed-windows-cpu-floor-stage3-launcher";
const MAX_CLOSURE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_STREAM_BYTES = 1024 * 1024;
const MAX_FAILURE_CHARACTERS = 512;

export const STAGE3_LAUNCHER_CLOSURE_PATHS = Object.freeze([
    "scripts/qualification/linux-windows-cpu-floor-stage3-launcher.mjs",
    ...STAGE3_SEQUENCE_CONSTANTS.SEQUENCE_CLOSURE_PATHS,
    "scripts/release/post-release-cpu-floor.mjs",
    "scripts/release/post-release-target.mjs"
]);

const STAGE2_CLOSURE_NAMES = Object.freeze([
    "scripts/qualification/linux-windows-cpu-floor-admission.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage2-controller.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage2.mjs",
    "scripts/qualification/linux-kvm-capability.mjs",
    "scripts/qualification/linux-kvm-privileged-capability.mjs",
    "scripts/qualification/windows-msi-post-setup-activation.mjs"
]);

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

export function verifyClosureFiles(closureRoot, expectedFiles) {
    if (typeof closureRoot !== "string" || !fs.existsSync(closureRoot)) {
        throw new TypeError("closureRoot is missing or does not exist");
    }
    if (!Array.isArray(expectedFiles) || expectedFiles.length !== STAGE3_LAUNCHER_CLOSURE_PATHS.length) {
        throw new TypeError("expectedFiles length differs from launcher closure");
    }

    const expectedMap = new Map();
    for (const record of expectedFiles) {
        if (!record || typeof record.name !== "string" || !STAGE3_LAUNCHER_CLOSURE_PATHS.includes(record.name)) {
            throw new TypeError(`unexpected closure member declaration: ${record?.name}`);
        }
        expectedMap.set(record.name, record);
    }

    // Verify each expected file directly from disk without importing
    const verified = [];
    for (const rel of STAGE3_LAUNCHER_CLOSURE_PATHS) {
        const expected = expectedMap.get(rel);
        if (!expected) throw new Error(`Missing expected closure file declaration: ${rel}`);
        const fullPath = path.resolve(closureRoot, rel);
        if (!fs.existsSync(fullPath)) {
            throw new Error(`Missing closure file on disk: ${rel}`);
        }
        const lexical = fs.lstatSync(fullPath);
        if (!lexical.isFile() || lexical.isSymbolicLink()) {
            throw new Error(`Closure file is not a regular file: ${rel}`);
        }
        if (lexical.size < 1n || lexical.size > BigInt(MAX_CLOSURE_FILE_BYTES)) {
            throw new Error(`Closure file size out of bounds: ${rel}`);
        }
        const bytes = fs.readFileSync(fullPath);
        if (Number(lexical.size) !== bytes.length || bytes.length !== Number(expected.bytes)) {
            throw new Error(`Closure file size differs: ${rel}`);
        }
        const digest = sha256(bytes);
        if (digest !== expected.sha256) {
            throw new Error(`Closure file sha256 differs: ${rel}`);
        }
        verified.push({name: rel, path: fullPath, bytes: String(bytes.length), sha256: digest});
    }

    // Recursively scan closureRoot to ensure no untracked/extra files exist
    function scanDir(dir) {
        const entries = fs.readdirSync(dir, {withFileTypes: true});
        for (const entry of entries) {
            const entryPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                scanDir(entryPath);
            } else if (entry.isFile()) {
                const rel = path.relative(closureRoot, entryPath).replace(/\\/g, "/");
                if (rel === "closure-manifest.json" || rel === "stage2-closure.json") continue;
                if (!expectedMap.has(rel)) {
                    throw new Error(`untracked or unexpected closure file: ${rel}`);
                }
            }
        }
    }
    scanDir(closureRoot);

    return {valid: true, files: verified};
}

export function stage2ClosureFromStage3Closure(stage3ClosureRoot, stage2ClosureRoot) {
    fs.mkdirSync(path.join(stage2ClosureRoot, "scripts", "qualification"), {recursive: true, mode: 0o700});
    const files = [];
    for (const name of STAGE2_CLOSURE_NAMES) {
        const src = path.join(stage3ClosureRoot, name);
        const dest = path.join(stage2ClosureRoot, name);
        fs.mkdirSync(path.dirname(dest), {recursive: true, mode: 0o700});
        const bytes = fs.readFileSync(src);
        fs.writeFileSync(dest, bytes, {mode: 0o600});
        files.push({name, bytes: bytes.length, sha256: sha256(bytes)});
    }
    fs.writeFileSync(
        path.join(stage2ClosureRoot, "stage2-closure.json"),
        `${JSON.stringify({schemaVersion: 1, files})}\n`,
        {mode: 0o600}
    );
    return {root: stage2ClosureRoot, files};
}

export function performTaskOwnedProcessCleanup({
    stage2Root,
    stage3Root,
    spawnedPid = null,
    killFn = (pid, sig = "SIGTERM") => { try { process.kill(pid, sig); } catch {} },
    isAliveFn = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }
}) {
    const taskOwnedPids = new Set();
    if (spawnedPid !== null && /^[1-9][0-9]*$/u.test(String(spawnedPid))) {
        taskOwnedPids.add(Number(spawnedPid));
    }
    if (stage2Root) {
        const pidPath = path.join(stage2Root, "qemu.pid");
        if (fs.existsSync(pidPath)) {
            try {
                const text = fs.readFileSync(pidPath, "utf8").trim();
                if (/^[1-9][0-9]*$/u.test(text)) taskOwnedPids.add(Number(text));
            } catch {}
        }
    }
    if (stage3Root) {
        const pidPath = path.join(stage3Root, "baseline-qemu.pid");
        if (fs.existsSync(pidPath)) {
            try {
                const text = fs.readFileSync(pidPath, "utf8").trim();
                if (/^[1-9][0-9]*$/u.test(text)) taskOwnedPids.add(Number(text));
            } catch {}
        }
    }

    const cleanedPids = [];
    for (const pid of taskOwnedPids) {
        if (isAliveFn(pid)) {
            killFn(pid, "SIGTERM");
            if (isAliveFn(pid)) {
                killFn(pid, "SIGKILL");
            }
            cleanedPids.push(pid);
        }
    }
    return {cleanedPids};
}

export function writeBoundedFailureEvidence({
    evidenceRoot,
    error,
    streams = {},
    accepted = false
}) {
    fs.mkdirSync(evidenceRoot, {recursive: true, mode: 0o700});

    if (streams.stdout !== undefined) {
        const buf = Buffer.from(String(streams.stdout), "utf8").subarray(0, MAX_STREAM_BYTES);
        fs.writeFileSync(path.join(evidenceRoot, "controller.stdout"), buf, {mode: 0o600});
    }
    if (streams.stderr !== undefined) {
        const buf = Buffer.from(String(streams.stderr), "utf8").subarray(0, MAX_STREAM_BYTES);
        fs.writeFileSync(path.join(evidenceRoot, "controller.stderr"), buf, {mode: 0o600});
    }

    const errorMsg = error ? String(error.message || error).slice(0, MAX_FAILURE_CHARACTERS) : null;
    const summary = {
        schemaVersion: SCHEMA_VERSION,
        status: "failed",
        qualifying: false,
        releaseGateCleared: false,
        accepted: false,
        error: errorMsg
    };
    fs.writeFileSync(
        path.join(evidenceRoot, "transport-summary.json"),
        `${JSON.stringify(summary)}\n`,
        {mode: 0o600}
    );

    const manifest = {
        schemaVersion: SCHEMA_VERSION,
        kind: "myspeed-windows-cpu-floor-stage3-evidence",
        status: "failed",
        qualifying: false,
        releaseGatesCleared: [],
        accepted: false,
        error: errorMsg
    };
    fs.writeFileSync(
        path.join(evidenceRoot, "evidence-manifest.json"),
        `${JSON.stringify(manifest)}\n`,
        {mode: 0o600}
    );

    return summary;
}

export function buildStage3SequenceRequest({
    context,
    closureRoot,
    transportRoot,
    stage2Request,
    stage3Request,
    guestFiles = []
}) {
    const sequenceFiles = STAGE3_SEQUENCE_CONSTANTS.SEQUENCE_CLOSURE_PATHS.map(rel => {
        const fullPath = path.resolve(closureRoot, rel);
        const bytes = fs.readFileSync(fullPath);
        return {
            path: fullPath,
            bytes: String(bytes.length),
            sha256: sha256(bytes)
        };
    });

    // Strip stage2 property from stage3Request because sequence populates it after Stage 2
    const stage3Template = {...stage3Request};
    delete stage3Template.stage2;

    return {
        schemaVersion: SCHEMA_VERSION,
        kind: STAGE3_SEQUENCE_CONSTANTS.SEQUENCE_KIND,
        context: structuredClone(context),
        transportRoot,
        stage2Request,
        stage3: stage3Template,
        closure: {
            root: closureRoot,
            files: sequenceFiles
        },
        guestFiles: structuredClone(guestFiles)
    };
}

export async function executeStage3Launcher(options, dependencies = {}) {
    const {
        nonce,
        closureRoot,
        transportRoot,
        envelopeRoot,
        stage2Root,
        stage3Root,
        binding,
        acquired,
        probeArtifact,
        guestFiles = []
    } = options;

    const verifyClosure = dependencies.verifyClosure ?? verifyClosureFiles;
    const runSequence = dependencies.runSequence ?? runHostedStage3Sequence;
    const inspectEvidence = dependencies.inspectEvidence ?? inspectV161PostReleaseCpuFloorEvidence;
    const buildRequests = dependencies.buildRequests ?? null;

    let sequenceResult = null;
    let stage2ResultBytes = null;
    try {
        // 1. Verify closure files externally
        if (options.closureRecords) {
            verifyClosure(closureRoot, options.closureRecords);
        }

        let stage2Request, stage3Request;
        if (buildRequests) {
            // Injected for inert tests that do not have real closure files on disk
            const built = buildRequests({binding, acquired, probeArtifact, nonce, transportRoot});
            stage2Request = built.stage2Request;
            stage3Request = built.stage3Request;
        } else {
            // 2. Build Stage 2 request and Stage 3 request template using real consumer
            const fileIdentity = (targetPath) => {
                const bytes = fs.readFileSync(targetPath);
                return {path: targetPath, bytes: String(bytes.length), sha256: sha256(bytes)};
            };
            stage2Request = buildV161PostReleaseCpuFloorStage2Request(binding, probeArtifact, fileIdentity);
            const dummyStage2 = {
                result: {path: `/home/runner/work/_temp/myspeed-stage2-transport-${nonce}/stage2-result.json`, bytes: "1", sha256: "0".repeat(64)},
                guestResult: {path: `/home/runner/work/_temp/myspeed-stage2-transport-${nonce}/guest-result.json`, bytes: "1", sha256: "0".repeat(64)}
            };
            stage3Request = buildV161PostReleaseCpuFloorStage3Request(acquired, dummyStage2);
        }

        // 3. Build sequence request envelope and write it
        let sequenceRequest;
        if (dependencies.buildSequenceRequest) {
            sequenceRequest = dependencies.buildSequenceRequest({context: binding.hostedContext, closureRoot,
                transportRoot, stage2Request, stage3Request, guestFiles});
        } else {
            sequenceRequest = buildStage3SequenceRequest({
                context: binding.hostedContext,
                closureRoot,
                transportRoot,
                stage2Request,
                stage3Request,
                guestFiles
            });
        }

        if (envelopeRoot && fs.existsSync(envelopeRoot)) {
            const requestPath = path.join(envelopeRoot, "request.json");
            const requestBytes = Buffer.from(`${JSON.stringify(sequenceRequest)}\n`, "utf8");
            fs.writeFileSync(requestPath, requestBytes, {mode: 0o600});
        }

        // 4. Run sequence
        sequenceResult = await runSequence(sequenceRequest);
        if (!sequenceResult || sequenceResult.status !== "observed") {
            throw new Error("Stage 3 sequence did not produce an observed result");
        }

        const stage2Path = path.join(transportRoot, "stage2-result.json");
        if (fs.existsSync(stage2Path)) {
            stage2ResultBytes = fs.readFileSync(stage2Path);
        }

        // 5. Inspect evidence with consumer
        const executedStage3Request = {
            ...stage3Request,
            stage2: sequenceResult.stage2
        };

        const inspection = inspectEvidence({
            binding,
            request: executedStage3Request,
            result: sequenceResult,
            retainedStage2Bytes: stage2ResultBytes
        });

        return inspection;
    } catch (error) {
        performTaskOwnedProcessCleanup({stage2Root, stage3Root});
        const evidenceDir = fs.existsSync(transportRoot) ? transportRoot : null;
        if (evidenceDir) {
            writeBoundedFailureEvidence({
                evidenceRoot: evidenceDir,
                error,
                streams: dependencies.streams ?? {}
            });
        }
        throw error;
    }
}

export const STAGE3_LAUNCHER_CONSTANTS = Object.freeze({
    LAUNCHER_CLOSURE_PATHS: STAGE3_LAUNCHER_CLOSURE_PATHS,
    LAUNCHER_KIND,
    MAX_CLOSURE_FILE_BYTES,
    MAX_FAILURE_CHARACTERS,
    MAX_STREAM_BYTES,
    SCHEMA_VERSION,
    STAGE2_CLOSURE_NAMES
});
