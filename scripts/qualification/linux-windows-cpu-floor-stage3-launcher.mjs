import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
    runHostedStage3Sequence,
    STAGE3_SEQUENCE_CONSTANTS
} from "./linux-windows-cpu-floor-stage3-sequence.mjs";
import {STAGE3_EXECUTION_PATHS} from "./linux-windows-cpu-floor-stage3-closure.mjs";
import {
    buildV161PostReleaseCpuFloorStage2Request,
    buildV161PostReleaseCpuFloorStage3Template,
    buildV161PostReleaseCpuFloorStage3Request,
    inspectV161PostReleaseCpuFloorEvidence
} from "../release/post-release-cpu-floor.mjs";

const SCHEMA_VERSION = 1;
const LAUNCHER_KIND = "myspeed-windows-cpu-floor-stage3-launcher";
const MAX_CLOSURE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_STREAM_BYTES = 1024 * 1024;
const MAX_FAILURE_CHARACTERS = 512;
const STAGE3_RESULT_FILE = "stage3-sequence-result.json";
const ACCEPTED_INSPECTION_FILE = "stage3-accepted-inspection.json";

export const STAGE3_LAUNCHER_CLOSURE_PATHS = STAGE3_EXECUTION_PATHS;

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

function writeBoundedCanonicalJson(target, value, maximumBytes) {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    if (bytes.length < 2 || bytes.length > maximumBytes) throw new Error("Stage 3 retained result size is out of bounds");
    fs.writeFileSync(target, bytes, {flag: "wx", mode: 0o600});
    return bytes;
}

export function readBoundedRegularFile(target, maximumBytes) {
    const lexical = fs.lstatSync(target, {bigint: true});
    if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.nlink !== 1n || lexical.size < 1n
            || lexical.size > BigInt(maximumBytes)) throw new Error("retained Stage 2 evidence identity differs");
    const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    const descriptor = fs.openSync(target, openFlags);
    try {
        const opened = fs.fstatSync(descriptor, {bigint: true});
        if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== lexical.dev || opened.ino !== lexical.ino
                || opened.size !== lexical.size || opened.mtimeNs !== lexical.mtimeNs
                || opened.ctimeNs !== lexical.ctimeNs) {
            throw new Error("retained Stage 2 evidence changed before reading");
        }

        const capacity = Number(opened.size) + 1;
        const buffer = Buffer.alloc(capacity);
        let offset = 0;
        while (offset < capacity) {
            const count = fs.readSync(descriptor, buffer, offset, capacity - offset, offset);
            if (count === 0) break;
            offset += count;
        }

        const after = fs.fstatSync(descriptor, {bigint: true});
        const finalLexical = fs.lstatSync(target, {bigint: true});
        if (offset !== Number(opened.size) || after.dev !== opened.dev || after.ino !== opened.ino
                || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
                || finalLexical.dev !== opened.dev || finalLexical.ino !== opened.ino
                || finalLexical.size !== opened.size || finalLexical.mtimeNs !== opened.mtimeNs
                || finalLexical.ctimeNs !== opened.ctimeNs || finalLexical.nlink !== 1n) {
            throw new Error("retained Stage 2 evidence changed while reading");
        }
        return buffer.subarray(0, offset);
    } finally {
        fs.closeSync(descriptor);
    }
}

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
                if (rel === "execution-closure.json") continue;
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
    if (typeof stage3ClosureRoot !== "string" || typeof stage2ClosureRoot !== "string" ||
        path.resolve(stage3ClosureRoot) !== stage3ClosureRoot || path.resolve(stage2ClosureRoot) !== stage2ClosureRoot)
        throw new TypeError("Stage 2 closure roots must be canonical absolute paths");
    const parent = path.dirname(stage2ClosureRoot);
    if (fs.realpathSync.native(parent) !== parent || fs.existsSync(stage2ClosureRoot))
        throw new Error("Stage 2 closure root is not fresh");
    fs.mkdirSync(stage2ClosureRoot, {recursive: false, mode: 0o700});
    fs.mkdirSync(path.join(stage2ClosureRoot, "scripts"), {recursive: false, mode: 0o700});
    fs.mkdirSync(path.join(stage2ClosureRoot, "scripts", "qualification"), {recursive: false, mode: 0o700});
    const files = [];
    for (const name of STAGE2_CLOSURE_NAMES) {
        const src = path.join(stage3ClosureRoot, name);
        const dest = path.join(stage2ClosureRoot, name);
        const source = fs.lstatSync(src, {bigint: true});
        if (!source.isFile() || source.isSymbolicLink() || source.nlink !== 1n ||
            fs.realpathSync.native(src) !== src || source.size < 1n || source.size > BigInt(MAX_CLOSURE_FILE_BYTES))
            throw new Error(`Stage 2 closure source is unsafe: ${name}`);
        const bytes = fs.readFileSync(src);
        if (BigInt(bytes.length) !== source.size) throw new Error(`Stage 2 closure source changed: ${name}`);
        fs.writeFileSync(dest, bytes, {flag: "wx", mode: 0o600});
        files.push({name, bytes: bytes.length, sha256: sha256(bytes)});
    }
    fs.writeFileSync(
        path.join(stage2ClosureRoot, "stage2-closure.json"),
        `${JSON.stringify({schemaVersion: 1, files})}\n`,
        {flag: "wx", mode: 0o600}
    );
    return {root: stage2ClosureRoot, files};
}

export function writeBoundedFailureEvidence({
    evidenceRoot,
    error,
    streams = {}
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

    return {
        schemaVersion: SCHEMA_VERSION,
        kind: STAGE3_SEQUENCE_CONSTANTS.SEQUENCE_KIND,
        context: structuredClone(context),
        transportRoot,
        stage2Request,
        stage3: structuredClone(stage3Request),
        closure: {
            root: closureRoot,
            files: sequenceFiles
        },
        guestFiles: structuredClone(guestFiles)
    };
}

export function inspectCompletedStage3Sequence({binding, acquired, sequenceResult, sameExecutionStage2,
    stage2ResultBytes}, dependencies = {}) {
    const buildStage3Request = dependencies.buildStage3Request ?? buildV161PostReleaseCpuFloorStage3Request;
    const inspectEvidence = dependencies.inspectEvidence ?? inspectV161PostReleaseCpuFloorEvidence;
    const executedStage3Request = buildStage3Request(acquired, sameExecutionStage2);
    return inspectEvidence({binding, request: executedStage3Request, result: sequenceResult,
        retainedStage2Bytes: stage2ResultBytes});
}

export async function executeStage3Launcher(options, dependencies = {}) {
    const {
        closureRoot,
        transportRoot,
        envelopeRoot,
        binding,
        acquired,
        probeArtifact,
        guestFiles = []
    } = options;

    const verifyClosure = dependencies.verifyClosure ?? verifyClosureFiles;
    const runSequence = dependencies.runSequence ?? runHostedStage3Sequence;
    const inspectEvidence = dependencies.inspectEvidence ?? inspectV161PostReleaseCpuFloorEvidence;
    const buildStage2Request = dependencies.buildStage2Request ?? buildV161PostReleaseCpuFloorStage2Request;
    const buildStage3Template = dependencies.buildStage3Template ?? buildV161PostReleaseCpuFloorStage3Template;
    const buildStage3Request = dependencies.buildStage3Request ?? buildV161PostReleaseCpuFloorStage3Request;
    const cleanupProcesses = dependencies.cleanupProcesses;

    let sequenceResult = null;
    let stage2ResultBytes = null;
    try {
        // 1. Verify closure files externally
        if (!options.closureRecords) throw new Error("Stage 3 launcher closure records are missing");
        verifyClosure(closureRoot, options.closureRecords);

        // 2. Build both pre-execution requests through the real branded consumer APIs.
        const fileIdentity = dependencies.fileIdentity ?? ((targetPath) => {
            const bytes = fs.readFileSync(targetPath);
            return {path: targetPath, bytes: String(bytes.length), sha256: sha256(bytes)};
        });
        const stage2Request = buildStage2Request(binding, probeArtifact, fileIdentity);
        const stage3Template = buildStage3Template(acquired);

        // 3. Build sequence request envelope and write it
        let sequenceRequest;
        if (dependencies.buildSequenceRequest) {
            sequenceRequest = dependencies.buildSequenceRequest({context: binding.hostedContext, closureRoot,
                transportRoot, stage2Request, stage3Request: stage3Template, guestFiles});
        } else {
            sequenceRequest = buildStage3SequenceRequest({
                context: binding.hostedContext,
                closureRoot,
                transportRoot,
                stage2Request,
                stage3Request: stage3Template,
                guestFiles
            });
        }

        if (!envelopeRoot || !fs.existsSync(envelopeRoot)) throw new Error("Stage 3 launcher envelope root is missing");
        const requestPath = path.join(envelopeRoot, "request.json");
        const requestBytes = Buffer.from(`${JSON.stringify(sequenceRequest)}\n`, "utf8");
        fs.writeFileSync(requestPath, requestBytes, {flag: "wx", mode: 0o600});

        // 4. Run sequence
        sequenceResult = await runSequence(sequenceRequest);
        if (!sequenceResult || sequenceResult.status !== "observed") {
            throw new Error("Stage 3 sequence did not produce an observed result");
        }
        writeBoundedCanonicalJson(path.join(transportRoot, STAGE3_RESULT_FILE), sequenceResult,
            STAGE3_SEQUENCE_CONSTANTS.MAX_EVIDENCE_BYTES);

        const stage2Path = path.join(transportRoot, "stage2-result.json");
        const guestResultPath = path.join(transportRoot, "guest-result.json");
        stage2ResultBytes = readBoundedRegularFile(stage2Path, STAGE3_SEQUENCE_CONSTANTS.MAX_EVIDENCE_BYTES);
        const guestResultBytes = readBoundedRegularFile(guestResultPath,
            STAGE3_SEQUENCE_CONSTANTS.MAX_EVIDENCE_BYTES);
        const sameExecutionStage2 = {
            result: {path: stage2Path, bytes: String(stage2ResultBytes.length), sha256: sha256(stage2ResultBytes)},
            guestResult: {path: guestResultPath, bytes: String(guestResultBytes.length), sha256: sha256(guestResultBytes)}
        };

        // 5. Inspect evidence with consumer
        const inspection = inspectCompletedStage3Sequence({binding, acquired, sequenceResult,
            sameExecutionStage2, stage2ResultBytes}, {buildStage3Request, inspectEvidence});
        if (inspection?.accepted !== true) throw new Error("Stage 3 consumer did not accept the execution");
        writeBoundedCanonicalJson(path.join(transportRoot, ACCEPTED_INSPECTION_FILE), inspection,
            STAGE3_SEQUENCE_CONSTANTS.MAX_EVIDENCE_BYTES);

        return inspection;
    } catch (error) {
        let cleanupError = null;
        try {
            if (cleanupProcesses) await cleanupProcesses();
        } catch (failure) {
            cleanupError = failure;
        }
        const evidenceDir = fs.existsSync(transportRoot) ? transportRoot : null;
        if (evidenceDir) {
            writeBoundedFailureEvidence({
                evidenceRoot: evidenceDir,
                error,
                streams: dependencies.streams ?? {}
            });
        }
        if (cleanupError) throw new AggregateError([error, cleanupError],
            "Stage 3 launcher execution and authenticated cleanup both failed");
        throw error;
    }
}

export const STAGE3_LAUNCHER_CONSTANTS = Object.freeze({
    LAUNCHER_CLOSURE_PATHS: STAGE3_LAUNCHER_CLOSURE_PATHS,
    LAUNCHER_KIND,
    MAX_CLOSURE_FILE_BYTES,
    MAX_FAILURE_CHARACTERS,
    MAX_STREAM_BYTES,
    ACCEPTED_INSPECTION_FILE,
    SCHEMA_VERSION,
    STAGE3_RESULT_FILE,
    STAGE2_CLOSURE_NAMES
});
