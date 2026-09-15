import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {isDeepStrictEqual} from "node:util";
import zlib from "node:zlib";

import {createWindowsMsiMatrixContract} from "../qualification/windows-msi-matrix-contract.mjs";
import {validateCompletedWindowsMsiLifecycleHostResult,
    validateWindowsMsiLifecycleHostRequest} from "../qualification/linux-windows-msi-lifecycle-host.mjs";
import {validateWindowsMsiExecutionClosureManifest} from "../qualification/windows-msi-execution-closure.mjs";

const SCHEMA_VERSION = 1;
const INSPECTION_KIND = "myspeed-v1.6.1-post-release-msi-evidence-inspection";
const ARTIFACT_NAME = "post-release-v1.6.1-msi-lifecycle-evidence";
const DEFAULT_WORKFLOW = "post-release-msi-lifecycle.yml";
const REPOSITORY = "i7Gamer/MySpeed";
const AUTHORITY = "evidence-inspection-only";

const MAX_ARCHIVE_BYTES = 67_108_864;         // 64 MiB
const MAX_MEMBER_BYTES = 16_777_216;          // 16 MiB
const MAX_AGGREGATE_EXPANDED_BYTES = 33_554_432; // 32 MiB
const MAX_TEXT_STREAM_BYTES = 1_048_576;      // 1 MiB
const MAX_METADATA_BYTES = 1_048_576;         // 1 MiB
const MIN_MEMBER_COUNT = 2;
const MAX_MEMBER_COUNT = 16;
const MAX_PATH_CHARACTERS = 1024;
const EXPECTED_SCENARIO_COUNT = 14;

const ZIP_LOCAL_HEADER_SIG = 0x04034b50;
const ZIP_CENTRAL_HEADER_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_MAX_COMMENT_LENGTH = 65535;
const ZIP_EOCD_MIN_SIZE = 22;
const ZIP64_UINT16 = 0xffff;
const ZIP64_UINT32 = 0xffffffff;
const ZIP_FLAG_DATA_DESCRIPTOR = 0x0008;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]{0,19}$/u;
const RUN_ATTEMPT_PATTERN = /^[1-9][0-9]{0,9}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const WORKFLOW_PATTERN = /^[A-Za-z0-9._-]+\.ya?ml$/u;

const REQUIRED_REQUEST_FILE = "msi-host-request.json";
const REQUIRED_RESULT_FILE = "msi-lifecycle-result.json";
const EXECUTION_CLOSURE_FILE = "msi-execution-closure.json";
const TRANSPORT_SUMMARY_FILE = "transport-summary.json";
const EVIDENCE_MANIFEST_FILE = "evidence-manifest.json";

const REQUIRED_FILES = Object.freeze([
    REQUIRED_REQUEST_FILE,
    REQUIRED_RESULT_FILE,
    "controller.stdout",
    "controller.stderr",
    TRANSPORT_SUMMARY_FILE,
    EXECUTION_CLOSURE_FILE,
    EVIDENCE_MANIFEST_FILE
]);

const ALLOWED_OPTIONAL_FILES = Object.freeze([
    "controller.stdout",
    "controller.stderr",
    TRANSPORT_SUMMARY_FILE,
    EXECUTION_CLOSURE_FILE,
    "msi-lifecycle-progress.json",
    EVIDENCE_MANIFEST_FILE
]);

const TEXT_STREAM_FILES = Object.freeze([
    "controller.stdout",
    "controller.stderr",
    "msi-lifecycle-progress.json"
]);

const ALL_ALLOWED_FILES = Object.freeze([
    ...REQUIRED_FILES,
    "msi-lifecycle-progress.json"
]);

const PRODUCER_STREAM_FILES = Object.freeze(["controller.stdout", "controller.stderr"]);
const PRODUCER_INVENTORY_FILES = Object.freeze([
    REQUIRED_REQUEST_FILE, REQUIRED_RESULT_FILE, ...PRODUCER_STREAM_FILES, TRANSPORT_SUMMARY_FILE,
    EXECUTION_CLOSURE_FILE
]);

const fail = message => {
    throw new Error(`Post-release MSI verification failed: ${message}`);
};

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

const deepFreeze = value => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
};

const exactString = (value, pattern, label) => {
    if (typeof value !== "string") fail(`${label} must be a string`);
    const match = pattern.exec(value);
    if (!match || match.index !== 0 || match[0].length !== value.length) {
        fail(`${label} differs`);
    }
    return value;
};

const apiPositiveInteger = (value, label) => {
    if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a safe integer`);
    return String(value);
};

const parseJsonSafe = (bytes, label) => {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) fail(`${label} is empty`);
    try {
        const text = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
        return JSON.parse(text);
    } catch {
        fail(`${label} JSON differs`);
    }
};

/**
 * Bounded file reader using file descriptors to prevent TOCTOU symlink races and unbounded allocation.
 * @param {string} filePath
 * @param {number} maxBytes
 * @param {string} label
 * @returns {Buffer}
 */
const readBoundedFileDescriptor = (filePath, maxBytes, label) => {
    if (typeof filePath !== "string" || filePath.length === 0) {
        fail(`${label} path is required`);
    }
    const resolvedPath = path.resolve(filePath);
    let lstat;
    try {
        lstat = fs.lstatSync(resolvedPath);
    } catch (err) {
        fail(`${label} could not be inspected: ${err?.message ?? String(err)}`);
    }
    if (lstat.isSymbolicLink()) {
        fail(`${label} must not be a symbolic link`);
    }
    if (!lstat.isFile()) {
        fail(`${label} must be a regular file`);
    }
    if (lstat.size > maxBytes) {
        fail(`${label} exceeds maximum size bound of ${maxBytes} bytes`);
    }

    let realPath;
    try {
        realPath = fs.realpathSync.native(resolvedPath);
    } catch (err) {
        fail(`${label} could not resolve: ${err?.message ?? String(err)}`);
    }
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    let fd;
    try {
        fd = fs.openSync(resolvedPath, fs.constants.O_RDONLY | noFollow);
    } catch (err) {
        fail(`${label} could not be opened: ${err?.message ?? String(err)}`);
    }
    try {
        const fstat = fs.fstatSync(fd);
        if (!fstat.isFile()) {
            fail(`${label} descriptor is not a regular file`);
        }
        if (fstat.size !== lstat.size || fstat.dev !== lstat.dev || fstat.ino !== lstat.ino) {
            fail(`${label} file identity changed during read`);
        }
        if (fstat.size > maxBytes) {
            fail(`${label} exceeds maximum size bound of ${maxBytes} bytes`);
        }

        const buffer = Buffer.alloc(fstat.size);
        let totalRead = 0;
        while (totalRead < fstat.size) {
            const bytesRead = fs.readSync(fd, buffer, totalRead, fstat.size - totalRead, totalRead);
            if (bytesRead === 0) break;
            totalRead += bytesRead;
        }
        if (totalRead !== fstat.size) {
            fail(`${label} could not be read completely`);
        }
        const after = fs.lstatSync(resolvedPath);
        const afterRealPath = fs.realpathSync.native(resolvedPath);
        if (after.isSymbolicLink() || !after.isFile() || after.size !== fstat.size
                || after.dev !== fstat.dev || after.ino !== fstat.ino || afterRealPath !== realPath) {
            fail(`${label} file identity changed after read`);
        }
        return buffer;
    } finally {
        fs.closeSync(fd);
    }
};

const validateExpectedExecution = value => {
    if (!isObject(value)) fail("expected execution context must be an object");
    const repo = exactString(value.repository, REPOSITORY_PATTERN, "expected repository");
    if (repo !== REPOSITORY) fail("expected repository differs from production repository");
    const workflow = exactString(value.workflow, WORKFLOW_PATTERN, "expected workflow");
    if (workflow !== DEFAULT_WORKFLOW) fail("expected workflow differs from lifecycle workflow");
    const runId = exactString(value.runId, POSITIVE_DECIMAL_PATTERN, "expected run ID");
    const runAttempt = exactString(value.runAttempt, RUN_ATTEMPT_PATTERN, "expected run attempt");
    const sourceSha = exactString(value.sourceSha ?? value.harnessSourceSha, COMMIT_SHA_PATTERN, "expected harness source SHA");

    const artifactId = exactString(value.artifactId, POSITIVE_DECIMAL_PATTERN, "expected artifact ID");
    if (value.artifactName !== ARTIFACT_NAME) fail("expected artifact name differs from lifecycle evidence artifact");
    const artifactName = ARTIFACT_NAME;

    let archiveDigest = null;
    if (value.archiveDigest !== undefined && value.archiveDigest !== null) {
        if (typeof value.archiveDigest !== "string" || !value.archiveDigest.startsWith("sha256:")) {
            fail("expected archive digest must start with sha256:");
        }
        exactString(value.archiveDigest.slice("sha256:".length), SHA256_PATTERN, "expected archive digest hash");
        archiveDigest = value.archiveDigest;
    }

    return {
        repository: repo,
        workflow,
        runId,
        runAttempt,
        sourceSha,
        artifactId,
        artifactName,
        archiveDigest
    };
};

const validateArtifactMetadata = (metadata, expected) => {
    if (!isObject(metadata)) fail("artifact metadata must be an object");
    if (metadata.name !== expected.artifactName) {
        fail(`artifact name must match expected artifact name: ${expected.artifactName}`);
    }
    if (metadata.expired !== false) fail("artifact must be unexpired");

    const id = apiPositiveInteger(metadata.id, "artifact ID");
    if (expected.artifactId !== null && id !== expected.artifactId) {
        fail(`artifact ID mismatch: expected ${expected.artifactId}, got ${id}`);
    }

    if (!Number.isSafeInteger(metadata.size_in_bytes) || metadata.size_in_bytes < 1
            || metadata.size_in_bytes > MAX_ARCHIVE_BYTES) {
        fail("artifact size_in_bytes differs or exceeds bounds");
    }

    if (typeof metadata.digest !== "string" || !metadata.digest.startsWith("sha256:")) {
        fail("artifact digest must start with sha256:");
    }
    const digestHash = exactString(metadata.digest.slice("sha256:".length), SHA256_PATTERN, "artifact digest hash");

    if (expected.archiveDigest !== null && metadata.digest !== expected.archiveDigest) {
        fail(`artifact digest mismatch with expected digest: ${expected.archiveDigest}`);
    }

    if (!isObject(metadata.workflow_run)) fail("artifact metadata missing workflow_run");
    const workflowRunId = apiPositiveInteger(metadata.workflow_run.id, "workflow_run id");
    const workflowHeadSha = exactString(metadata.workflow_run.head_sha, COMMIT_SHA_PATTERN, "workflow_run head_sha");

    if (workflowRunId !== expected.runId) fail("artifact workflow run ID differs from expected execution");
    if (workflowHeadSha !== expected.sourceSha) fail("artifact workflow harness head_sha differs from expected execution");

    return {
        id,
        name: metadata.name,
        size_in_bytes: metadata.size_in_bytes,
        digest: `sha256:${digestHash}`,
        digestHash,
        workflow_run: {id: workflowRunId, head_sha: workflowHeadSha}
    };
};

const validateWorkflowRunRecord = (record, expected) => {
    if (!isObject(record)) fail("workflow run record must be an object");
    const runId = apiPositiveInteger(record.id, "workflow run record id");
    if (runId !== expected.runId) fail("workflow run record id differs from expected execution");
    const attempt = apiPositiveInteger(record.run_attempt, "workflow run record attempt");
    if (attempt !== expected.runAttempt) fail("workflow run record attempt differs from expected execution");
    const headSha = exactString(record.head_sha, COMMIT_SHA_PATTERN, "workflow run record head_sha");
    if (headSha !== expected.sourceSha) fail("workflow run record head_sha differs from expected execution");
    if (!isObject(record.repository) || record.repository.full_name !== expected.repository)
        fail("workflow run record repository differs from expected execution");
    if (record.path !== `.github/workflows/${expected.workflow}`)
        fail("workflow run record path differs from expected execution");
};

const assertPathConfinement = memberPath => {
    if (typeof memberPath !== "string" || memberPath.length === 0 || memberPath.length > MAX_PATH_CHARACTERS) {
        fail("archive member path differs or exceeds length bound");
    }
    if (memberPath.startsWith("/") || memberPath.startsWith("\\") || memberPath.includes(":")) {
        fail("archive member path must be relative without root or drive prefix");
    }
    if (memberPath.includes("\0")) {
        fail("archive member path contains null byte");
    }
    const parts = memberPath.split("/");
    if (parts.some(p => p === ".." || p === "." || p === "")) {
        fail("archive member path contains traversal, relative, or empty components");
    }
    const normalized = path.posix.normalize(memberPath);
    if (normalized !== memberPath) {
        fail("archive member path is not canonical");
    }
    return memberPath;
};

/**
 * Finds End of Central Directory offset in a ZIP buffer.
 * @param {Buffer} bytes
 * @returns {number}
 */
const findEndOfCentralDirectory = bytes => {
    if (!Buffer.isBuffer(bytes) || bytes.length < ZIP_EOCD_MIN_SIZE) {
        fail("archive is too small to be a valid zip archive");
    }
    const maxSearch = Math.min(bytes.length, ZIP_EOCD_MIN_SIZE + ZIP_MAX_COMMENT_LENGTH);
    const searchStart = bytes.length - ZIP_EOCD_MIN_SIZE;
    const searchEnd = bytes.length - maxSearch;

    for (let i = searchStart; i >= searchEnd; i--) {
        if (bytes.readUInt32LE(i) === ZIP_EOCD_SIG) {
            const commentLength = bytes.readUInt16LE(i + 20);
            if (i + ZIP_EOCD_MIN_SIZE + commentLength === bytes.length) {
                return i;
            }
        }
    }
    fail("invalid zip archive: End of Central Directory record not found");
};

/**
 * Parses and verifies EOCD record.
 * @param {Buffer} bytes
 * @param {number} eocdOffset
 * @returns {{totalEntries: number, cdSize: number, cdOffset: number}}
 */
const parseEndOfCentralDirectory = (bytes, eocdOffset) => {
    const diskNumber = bytes.readUInt16LE(eocdOffset + 4);
    const cdStartDisk = bytes.readUInt16LE(eocdOffset + 6);
    const numEntriesThisDisk = bytes.readUInt16LE(eocdOffset + 8);
    const totalEntries = bytes.readUInt16LE(eocdOffset + 10);
    const cdSize = bytes.readUInt32LE(eocdOffset + 12);
    const cdOffset = bytes.readUInt32LE(eocdOffset + 16);

    if (numEntriesThisDisk === ZIP64_UINT16 || totalEntries === ZIP64_UINT16
            || cdSize === ZIP64_UINT32 || cdOffset === ZIP64_UINT32) {
        fail("ZIP64 archives are not supported");
    }

    if (diskNumber !== 0 || cdStartDisk !== 0 || numEntriesThisDisk !== totalEntries) {
        fail("spanned or multi-disk zip archives are not supported");
    }
    if (totalEntries < MIN_MEMBER_COUNT || totalEntries > MAX_MEMBER_COUNT) {
        fail(`archive member count must be between ${MIN_MEMBER_COUNT} and ${MAX_MEMBER_COUNT}`);
    }
    if (cdOffset + cdSize > eocdOffset) {
        fail("central directory overlaps with End of Central Directory or exceeds bounds");
    }
    return {totalEntries, cdSize, cdOffset};
};

/**
 * Preflights central directory entries and validates bounds/headers before decompression.
 * @param {Buffer} bytes
 * @param {number} cdOffset
 * @param {number} cdSize
 * @param {number} totalEntries
 * @returns {Array<Object>}
 */
const preflightCentralDirectory = (bytes, cdOffset, cdSize, totalEntries) => {
    let offset = cdOffset;
    const entries = [];
    const seenNames = new Set();
    let declaredAggregateBytes = 0;

    for (let i = 0; i < totalEntries; i++) {
        if (offset + 46 > cdOffset + cdSize) {
            fail("central directory is truncated");
        }
        const sig = bytes.readUInt32LE(offset);
        if (sig !== ZIP_CENTRAL_HEADER_SIG) {
            fail(`invalid central directory signature at entry ${i}`);
        }

        const externalAttr = bytes.readUInt32LE(offset + 38);
        const unixMode = (externalAttr >>> 16) & 0o170000;
        if (unixMode === 0o120000) {
            fail("archive member is a symbolic link");
        }
        if (unixMode === 0o040000) {
            fail("archive directory entries are not permitted");
        }
        if (unixMode !== 0 && unixMode !== 0o100000) {
            fail("archive member is not an ordinary file");
        }

        const flags = bytes.readUInt16LE(offset + 8);
        if ((flags & 1) !== 0) {
            fail("encrypted zip archive members are not supported");
        }

        const method = bytes.readUInt16LE(offset + 10);
        if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
            fail(`unsupported compression method: ${method}`);
        }

        const crc32 = bytes.readUInt32LE(offset + 16);
        const compressedSize = bytes.readUInt32LE(offset + 20);
        const uncompressedSize = bytes.readUInt32LE(offset + 24);
        const nameLength = bytes.readUInt16LE(offset + 28);
        const extraLength = bytes.readUInt16LE(offset + 30);
        const commentLength = bytes.readUInt16LE(offset + 32);
        const localHeaderOffset = bytes.readUInt32LE(offset + 42);

        if (compressedSize === ZIP64_UINT32 || uncompressedSize === ZIP64_UINT32
                || localHeaderOffset === ZIP64_UINT32) fail("ZIP64 archive members are not supported");

        if (uncompressedSize > MAX_MEMBER_BYTES) {
            fail("archive member declared size exceeds maximum bound");
        }
        if (compressedSize > MAX_ARCHIVE_BYTES) {
            fail("archive member declared compressed size exceeds maximum bound");
        }
        declaredAggregateBytes += uncompressedSize;
        if (declaredAggregateBytes > MAX_AGGREGATE_EXPANDED_BYTES) {
            fail("archive declared aggregate expanded size exceeds bound");
        }

        if (offset + 46 + nameLength + extraLength + commentLength > cdOffset + cdSize) {
            fail("central directory entry exceeds central directory boundary");
        }

        const nameBuffer = bytes.subarray(offset + 46, offset + 46 + nameLength);
        const memberPath = nameBuffer.toString("utf8");
        assertPathConfinement(memberPath);

        const lower = memberPath.toLowerCase();
        if (seenNames.has(lower)) {
            fail(`archive contains duplicate or collision member: ${memberPath}`);
        }
        seenNames.add(lower);

        if (!ALL_ALLOWED_FILES.includes(memberPath)) {
            fail(`unexpected archive member: ${memberPath}`);
        }

        if (localHeaderOffset + 30 > cdOffset) {
            fail(`local file header offset exceeds archive bounds for ${memberPath}`);
        }

        const extra = bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
        for (let extraOffset = 0; extraOffset < extra.length;) {
            if (extraOffset + 4 > extra.length) fail("central directory extra field is truncated");
            const extraId = extra.readUInt16LE(extraOffset);
            const extraSize = extra.readUInt16LE(extraOffset + 2);
            if (extraOffset + 4 + extraSize > extra.length) fail("central directory extra field is truncated");
            if (extraId === 0x0001) fail("ZIP64 archive members are not supported");
            extraOffset += 4 + extraSize;
        }
        entries.push({
            name: memberPath,
            method,
            flags,
            crc32,
            compressedSize,
            uncompressedSize,
            nameLength,
            localHeaderOffset
        });

        offset += 46 + nameLength + extraLength + commentLength;
    }

    if (offset !== cdOffset + cdSize) {
        fail("central directory size does not match entries read");
    }

    return entries;
};

/**
 * Decompresses preflighted entries with strict streaming/inflation bounds.
 * @param {Buffer} bytes
 * @param {Array<Object>} entries
 * @param {number} cdOffset
 * @returns {Map<string, Buffer>}
 */
const decompressPreflightedEntries = (bytes, entries, cdOffset) => {
    const membersByName = new Map();
    let totalExpandedBytes = 0;

    for (const entry of entries) {
        if (entry.localHeaderOffset + 30 > bytes.length) {
            fail(`local file header is truncated for ${entry.name}`);
        }
        const sig = bytes.readUInt32LE(entry.localHeaderOffset);
        if (sig !== ZIP_LOCAL_HEADER_SIG) {
            fail(`invalid local header signature for ${entry.name}`);
        }

        const localMethod = bytes.readUInt16LE(entry.localHeaderOffset + 8);
        if (localMethod !== entry.method) {
            fail(`local header compression method mismatch for ${entry.name}`);
        }
        const localFlags = bytes.readUInt16LE(entry.localHeaderOffset + 6);
        if (localFlags !== entry.flags) fail(`local header flags mismatch for ${entry.name}`);
        const localCrc32 = bytes.readUInt32LE(entry.localHeaderOffset + 14);
        const localCompressedSize = bytes.readUInt32LE(entry.localHeaderOffset + 18);
        const localUncompressedSize = bytes.readUInt32LE(entry.localHeaderOffset + 22);
        const usesDataDescriptor = (entry.flags & ZIP_FLAG_DATA_DESCRIPTOR) !== 0;
        if (!usesDataDescriptor && (localCrc32 !== entry.crc32 || localCompressedSize !== entry.compressedSize
                || localUncompressedSize !== entry.uncompressedSize)) {
            fail(`local header size or CRC mismatch for ${entry.name}`);
        }
        if (usesDataDescriptor && !((localCrc32 === 0 && localCompressedSize === 0 && localUncompressedSize === 0)
                || (localCrc32 === entry.crc32 && localCompressedSize === entry.compressedSize
                    && localUncompressedSize === entry.uncompressedSize))) {
            fail(`data descriptor local header differs for ${entry.name}`);
        }
        const localNameLength = bytes.readUInt16LE(entry.localHeaderOffset + 26);
        const localExtraLength = bytes.readUInt16LE(entry.localHeaderOffset + 28);

        if (localNameLength !== entry.nameLength) {
            fail(`local header filename length mismatch for ${entry.name}`);
        }
        const localName = bytes.subarray(
            entry.localHeaderOffset + 30,
            entry.localHeaderOffset + 30 + localNameLength
        ).toString("utf8");
        if (localName !== entry.name) {
            fail(`local header filename mismatch for ${entry.name}`);
        }

        const dataOffset = entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
        if (dataOffset + entry.compressedSize > cdOffset) {
            fail(`member data exceeds central directory boundary for ${entry.name}`);
        }

        const compressedChunk = bytes.subarray(dataOffset, dataOffset + entry.compressedSize);
        const dataEnd = dataOffset + entry.compressedSize;
        if (usesDataDescriptor) {
            const nextOffset = Math.min(cdOffset, ...entries.filter(candidate =>
                candidate.localHeaderOffset > entry.localHeaderOffset).map(candidate => candidate.localHeaderOffset));
            const descriptor = bytes.subarray(dataEnd, nextOffset);
            if (descriptor.length !== 12 && descriptor.length !== 16)
                fail(`data descriptor differs for ${entry.name}`);
            const descriptorOffset = descriptor.length === 16 && descriptor.readUInt32LE(0) === 0x08074b50 ? 4 : 0;
            if ((descriptorOffset === 4 && descriptor.length !== 16)
                    || (descriptorOffset === 0 && descriptor.length !== 12)
                    || descriptor.readUInt32LE(descriptorOffset) !== entry.crc32
                    || descriptor.readUInt32LE(descriptorOffset + 4) !== entry.compressedSize
                    || descriptor.readUInt32LE(descriptorOffset + 8) !== entry.uncompressedSize) {
                fail(`data descriptor differs for ${entry.name}`);
            }
        }
        let decompressed;

        if (entry.method === METHOD_STORE) {
            if (entry.compressedSize !== entry.uncompressedSize) {
                fail(`stored member size mismatch for ${entry.name}`);
            }
            decompressed = Buffer.from(compressedChunk);
        } else if (entry.method === METHOD_DEFLATE) {
            try {
                decompressed = zlib.inflateRawSync(compressedChunk, {
                    maxOutputLength: Math.min(MAX_MEMBER_BYTES, entry.uncompressedSize)
                });
            } catch (err) {
                fail(`decompression failed for ${entry.name}: ${err?.message ?? String(err)}`);
            }
        }

        if (decompressed.length !== entry.uncompressedSize) {
            fail(`decompressed byte length differs from declared uncompressed size for ${entry.name}`);
        }
        if ((zlib.crc32(decompressed) >>> 0) !== entry.crc32) {
            fail(`decompressed CRC differs for ${entry.name}`);
        }

        totalExpandedBytes += decompressed.length;
        if (totalExpandedBytes > MAX_AGGREGATE_EXPANDED_BYTES) {
            fail("archive total expanded bytes exceed maximum bound");
        }

        if (TEXT_STREAM_FILES.includes(entry.name) && decompressed.length > MAX_TEXT_STREAM_BYTES) {
            fail(`text stream member ${entry.name} exceeds 1 MiB bound`);
        }

        membersByName.set(entry.name, decompressed);
    }

    return membersByName;
};

/**
 * Safely extracts and verifies archive with preflight validation and output limits.
 * @param {Buffer} archiveBytes
 * @param {Object} artifactMetadata
 * @returns {Map<string, Buffer>}
 */
const extractAndVerifyArchive = (archiveBytes, artifactMetadata) => {
    if (!Buffer.isBuffer(archiveBytes)) fail("archive bytes must be a buffer");
    if (archiveBytes.length > MAX_ARCHIVE_BYTES) fail("archive exceeds maximum byte bound");
    if (archiveBytes.length !== artifactMetadata.size_in_bytes) {
        fail("archive size mismatch with metadata size_in_bytes");
    }
    const actualDigest = sha256(archiveBytes);
    if (actualDigest !== artifactMetadata.digestHash) {
        fail("archive SHA-256 digest mismatch with metadata digest");
    }

    const eocdOffset = findEndOfCentralDirectory(archiveBytes);
    const {totalEntries, cdSize, cdOffset} = parseEndOfCentralDirectory(archiveBytes, eocdOffset);
    const preflighted = preflightCentralDirectory(archiveBytes, cdOffset, cdSize, totalEntries);
    const membersByName = decompressPreflightedEntries(archiveBytes, preflighted, cdOffset);

    // Verify required files
    for (const required of REQUIRED_FILES) {
        if (!membersByName.has(required)) {
            fail(`successful evidence artifact members differ: missing ${required}`);
        }
    }

    return membersByName;
};

const verifyExtractedDirectoryMatch = (evidenceDir, membersByName) => {
    if (typeof evidenceDir !== "string" || !fs.existsSync(evidenceDir)) {
        fail("evidence directory must exist");
    }
    const stat = fs.lstatSync(evidenceDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail("evidence directory is not an ordinary directory");
    }

    const dirEntries = fs.readdirSync(evidenceDir, {withFileTypes: true});
    for (const entry of dirEntries) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
            fail(`evidence directory entry is not an ordinary file: ${entry.name}`);
        }
        if (!membersByName.has(entry.name)) {
            fail(`extracted directory has foreign file not present in archive: ${entry.name}`);
        }
        const fullPath = path.join(evidenceDir, entry.name);
        const content = readBoundedFileDescriptor(fullPath, MAX_MEMBER_BYTES, `extracted evidence file ${entry.name}`);
        const expected = membersByName.get(entry.name);
        if (!content.equals(expected)) {
            fail(`extracted directory member bytes differ from archive: ${entry.name}`);
        }
    }

    for (const [name] of membersByName) {
        const fullPath = path.join(evidenceDir, name);
        if (!fs.existsSync(fullPath)) {
            fail(`extracted directory is missing archive member: ${name}`);
        }
    }
};

/**
 * Validates progress evidence to ensure no contradictory failures are present.
 * @param {Map<string, Buffer>} membersByName
 */
const validateProgressEvidence = membersByName => {
    if (membersByName.has("msi-lifecycle-progress.json"))
        fail("completed evidence must not retain failure progress");
};

/**
 * Validates transport summary sidecar if present in the archive.
 * @param {Map<string, Buffer>} membersByName
 * @param {Buffer} resultBytes
 */
const validateTransportSummary = (membersByName, requestBytes, resultBytes) => {
    if (!membersByName.has(TRANSPORT_SUMMARY_FILE)) return;
    const summaryBytes = membersByName.get(TRANSPORT_SUMMARY_FILE);
    const summary = parseJsonSafe(summaryBytes, "transport summary");
    if (!isObject(summary)) fail("transport summary must be an object");
    const requiredKeys = ["schemaVersion", "kind", "status", "qualifying", "releaseGatesCleared",
        "controllerExit", "resultPresent", "result", "progressPresent", "progress", "rowsCompleted",
        "refusedScenarioIndex", "streams", "accepted", "hostRequestPresent", "hostRequest"];
    if (Object.keys(summary).sort().join("|") !== requiredKeys.sort().join("|")
            || summary.schemaVersion !== 1 || summary.kind !== "myspeed-windows-msi-lifecycle-transport-summary"
            || summary.status !== "observed") {
        fail("transport summary schema or kind differs");
    }
    if (summary.accepted !== true) {
        fail("transport summary indicates run was not accepted");
    }
    if (summary.controllerExit !== 0) {
        fail("transport summary indicates controller failure exit");
    }
    if (summary.qualifying !== false || !Array.isArray(summary.releaseGatesCleared)
            || summary.releaseGatesCleared.length !== 0) {
        fail("transport summary claims qualification or release gates");
    }
    if (summary.rowsCompleted !== EXPECTED_SCENARIO_COUNT) {
        fail("transport summary rowsCompleted differs from expected count");
    }
    if (summary.refusedScenarioIndex !== null) {
        fail("transport summary indicates a scenario was refused");
    }
    if (summary.resultPresent !== true || !summary.result || summary.result.bytes !== resultBytes.length
            || summary.result.sha256 !== sha256(resultBytes)) {
        fail("transport summary result identity does not match msi-lifecycle-result");
    }
    if (summary.hostRequestPresent !== true || !summary.hostRequest || summary.hostRequest.bytes !== requestBytes.length
            || summary.hostRequest.sha256 !== sha256(requestBytes))
        fail("transport summary host request identity does not match msi-host-request");
    if (summary.progressPresent !== false || summary.progress !== null)
        fail("transport summary progress state differs for completed evidence");
    if (!Array.isArray(summary.streams) || summary.streams.length !== PRODUCER_STREAM_FILES.length)
        fail("transport summary stream inventory differs");
    for (const [index, name] of PRODUCER_STREAM_FILES.entries()) {
        const stream = summary.streams[index];
        const actualStream = membersByName.get(name);
        if (!isObject(stream) || stream.name !== name || !Buffer.isBuffer(actualStream)
                || stream.bytes !== actualStream.length || stream.bytes > MAX_TEXT_STREAM_BYTES
                || stream.sha256 !== sha256(actualStream)) {
            fail(`transport summary stream ${name} does not match archive member`);
        }
    }
};

/**
 * Validates inner inventory manifest if present in the archive.
 * @param {Map<string, Buffer>} membersByName
 * @param {Object} expected
 */
const validateInnerManifest = (membersByName, expected, hostRequest) => {
    if (!membersByName.has(EVIDENCE_MANIFEST_FILE)) return;
    const manifestBytes = membersByName.get(EVIDENCE_MANIFEST_FILE);
    const manifest = parseJsonSafe(manifestBytes, "evidence manifest");
    if (!isObject(manifest)) fail("evidence manifest must be an object");
    const requiredKeys = ["schemaVersion", "kind", "status", "qualifying", "repository", "sourceSha",
        "runId", "runAttempt", "nonce", "files", "releaseGatesCleared"];
    if (Object.keys(manifest).sort().join("|") !== requiredKeys.sort().join("|"))
        fail("evidence manifest keys differ from producer contract");
    if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.kind !== "myspeed-windows-msi-lifecycle-evidence-manifest"
            || manifest.status !== "observed" || manifest.qualifying !== false
            || !Array.isArray(manifest.releaseGatesCleared) || manifest.releaseGatesCleared.length !== 0) {
        fail("evidence manifest header or state differs");
    }
    if (manifest.repository !== expected.repository) {
        fail("evidence manifest repository differs from expected execution");
    }
    if (String(manifest.runId) !== expected.runId || String(manifest.runAttempt) !== expected.runAttempt) {
        fail("evidence manifest run ID or attempt differs from expected execution");
    }
    if (manifest.sourceSha !== expected.sourceSha) fail("evidence manifest source SHA differs from expected execution");
    if (manifest.nonce !== hostRequest?.context?.nonce) fail("evidence manifest nonce differs from host request");
    if (!Array.isArray(manifest.files)) fail("evidence manifest files must be an array");

    if (manifest.files.length !== PRODUCER_INVENTORY_FILES.length)
        fail("evidence manifest files count does not match producer inventory");
    const seenManifestFiles = new Set();
    for (const fileEntry of manifest.files) {
        if (!isObject(fileEntry) || typeof fileEntry.name !== "string") {
            fail("invalid file entry in evidence manifest");
        }
        if (fileEntry.name === EVIDENCE_MANIFEST_FILE) {
            fail("evidence manifest must not hash itself");
        }
        if (seenManifestFiles.has(fileEntry.name)) {
            fail(`evidence manifest contains duplicate entry: ${fileEntry.name}`);
        }
        seenManifestFiles.add(fileEntry.name);

        if (!PRODUCER_INVENTORY_FILES.includes(fileEntry.name))
            fail("evidence manifest names a file outside the producer inventory");
        const actualFile = membersByName.get(fileEntry.name);
        if (!actualFile) {
            fail(`evidence manifest describes missing file: ${fileEntry.name}`);
        }
        if (!isObject(fileEntry) || !/^(?:0|[1-9][0-9]{0,9})$/u.test(fileEntry.bytes)
                || !SHA256_PATTERN.test(fileEntry.sha256)
                || String(actualFile.length) !== fileEntry.bytes || sha256(actualFile) !== fileEntry.sha256) {
            fail(`evidence manifest entry mismatch for: ${fileEntry.name}`);
        }
    }
    if (seenManifestFiles.size !== PRODUCER_INVENTORY_FILES.length
            || PRODUCER_INVENTORY_FILES.some(name => !seenManifestFiles.has(name)))
        fail("evidence manifest inventory differs from retained producer members");
};

const validateExecutionClosure = (membersByName, hostRequest) => {
    if (!membersByName.has(EXECUTION_CLOSURE_FILE)) return;
    const closure = parseJsonSafe(membersByName.get(EXECUTION_CLOSURE_FILE), "MSI execution closure");
    const context = hostRequest?.context;
    const closureContext = context && {repository: context.repository, sourceSha: context.sourceSha,
        eventSha: context.eventSha, runId: context.runId, runAttempt: context.runAttempt, nonce: context.nonce};
    try {
        validateWindowsMsiExecutionClosureManifest(closure, closureContext);
    } catch (error) {
        fail(`MSI execution closure differs: ${error?.message ?? String(error)}`);
    }
};

/**
 * Independently verifies retained v1.6.1 MSI lifecycle evidence.
 * All public entrypoints require authenticated archive and metadata inputs.
 * @param {Object} options
 * @returns {Promise<Object>}
 */
export async function verifyV161PostReleaseMsiEvidence(options = {}) {
    if (!isObject(options)) fail("options must be an object");

    // Strictly reject any caller-controlled bypass attempts
    if (options.internalTestSeam !== undefined || options.evidenceFiles !== undefined) {
        fail("internal test seams or in-memory evidence maps are not permitted for evidence verification");
    }

    const expected = validateExpectedExecution(options.expectedExecution);

    validateWorkflowRunRecord(options.workflowRunRecord, expected);

    if (!options.artifactMetadata) fail("artifact-metadata is required for production verification");
    const validatedMetadata = validateArtifactMetadata(options.artifactMetadata, expected);

    let rawArchiveBytes;
    if (Buffer.isBuffer(options.archiveBytes)) {
        rawArchiveBytes = options.archiveBytes;
    } else if (typeof options.archivePath === "string") {
        rawArchiveBytes = readBoundedFileDescriptor(options.archivePath, MAX_ARCHIVE_BYTES, "evidence archive");
    } else {
        fail("evidence-archive is required for production verification");
    }

    const membersByName = extractAndVerifyArchive(rawArchiveBytes, validatedMetadata);

    if (options.evidenceDir) {
        verifyExtractedDirectoryMatch(options.evidenceDir, membersByName);
    }

    const requestBytes = membersByName.get(REQUIRED_REQUEST_FILE);
    const resultBytes = membersByName.get(REQUIRED_RESULT_FILE);
    if (!requestBytes || !resultBytes) fail("missing core host request or result in evidence");

    const hostRequest = parseJsonSafe(requestBytes, REQUIRED_REQUEST_FILE);
    const hostResult = parseJsonSafe(resultBytes, REQUIRED_RESULT_FILE);

    // Validate optional sidecars against contradictory evidence
    validateProgressEvidence(membersByName);
    validateTransportSummary(membersByName, requestBytes, resultBytes);
    validateInnerManifest(membersByName, expected, hostRequest);

    // Replay host request through semantic inspectors
    validateWindowsMsiLifecycleHostRequest(hostRequest);
    validateExecutionClosure(membersByName, hostRequest);

    // Verify execution identity bindings against expected
    if (hostRequest.repository !== expected.repository) {
        fail("host request repository differs from expected execution");
    }
    if (hostRequest.sourceSha !== expected.sourceSha || hostRequest.eventSha !== expected.sourceSha) {
        fail("host request source or event SHA differs from expected harness source");
    }
    if (hostRequest.runId !== expected.runId || hostRequest.runAttempt !== expected.runAttempt) {
        fail("host request run ID or attempt differs from expected execution");
    }

    const provenance = hostRequest.candidateProvenance;
    if (!provenance || provenance.kind !== "myspeed-v1.6.1-published-msi-host-provenance") {
        fail("candidate provenance must be published MSI host provenance");
    }
    if (provenance.harness.sourceSha !== expected.sourceSha || provenance.harness.eventSha !== expected.sourceSha) {
        fail("candidate provenance harness source SHA differs from expected");
    }
    if (provenance.harness.runId !== expected.runId || provenance.harness.runAttempt !== expected.runAttempt) {
        fail("candidate provenance harness run ID or attempt differs from expected");
    }

    // Replay host result through semantic inspectors
    validateCompletedWindowsMsiLifecycleHostResult(hostResult, hostRequest);

    if (!isDeepStrictEqual(hostResult.candidateProvenance, hostRequest.candidateProvenance)) {
        fail("host result candidate provenance differs from host request");
    }
    if (hostResult.qualifying !== false || hostResult.releaseGatesCleared.length !== 0) {
        fail("host result asserted qualification or a release gate");
    }

    const matrixContract = createWindowsMsiMatrixContract();
    if (hostResult.hostRows.length !== EXPECTED_SCENARIO_COUNT) {
        fail(`host result row count must be ${EXPECTED_SCENARIO_COUNT}`);
    }

    const rowsSummary = hostResult.hostRows.map((hostRow, index) => {
        const scenario = matrixContract.scenarios[index];
        const guestRow = hostResult.guestEvidence.rows[index];
        const semantic = JSON.parse(Buffer.from(guestRow.semanticResult.bytesBase64, "base64"));
        return {
            scenarioIndex: hostRow.scenarioIndex,
            scenarioId: hostRow.scenarioId,
            blocking: scenario.blocking,
            passed: semantic.rowResult.rowPassed && hostRow.qemu.exitCode === 0,
            host: {
                qemuPid: hostRow.qemu.pid,
                exitCode: hostRow.qemu.exitCode,
                cleanupProven: hostRow.qemu.cleanupProven,
                treeGone: hostRow.qemu.treeGone
            },
            guest: {
                scenarioPassed: semantic.matrixPassed,
                rowPassed: semantic.rowResult.rowPassed
            }
        };
    });

    return deepFreeze({
        schemaVersion: SCHEMA_VERSION,
        kind: INSPECTION_KIND,
        status: "accepted",
        qualifying: false,
        authority: AUTHORITY,
        artifact: {
            id: validatedMetadata.id,
            name: validatedMetadata.name,
            bytes: rawArchiveBytes.length,
            sha256: sha256(rawArchiveBytes),
            digest: validatedMetadata.digest,
            runId: expected.runId,
            runAttempt: expected.runAttempt,
            headSha: expected.sourceSha
        },
        candidateSourceSha: provenance.candidate.sourceSha,
        harnessSourceSha: expected.sourceSha,
        targetHashes: {
            manifestSha256: hostRequest.expected.candidateManifestSha256,
            postReleaseTargetSha256: provenance.targetSha256
        },
        envelope: {
            sha256: provenance.envelope.sha256,
            kind: provenance.envelope.value.kind
        },
        evidence: {
            requestMember: REQUIRED_REQUEST_FILE,
            resultMember: REQUIRED_RESULT_FILE,
            hostRequestSha256: sha256(requestBytes),
            hostResultSha256: sha256(resultBytes),
            guestInspectionSha256: sha256(Buffer.from(JSON.stringify(hostResult.guestInspection)))
        },
        rows: rowsSummary,
        releaseGatesCleared: []
    });
}

const parseCliArguments = args => {
    const options = {};
    const expected = {};
    let index = 0;
    while (index < args.length) {
        const flag = args[index];
        const value = args[index + 1];
        if (!flag.startsWith("--")) fail(`unexpected argument: ${flag}`);
        if (value === undefined || value.startsWith("--")) {
            fail(`flag ${flag} requires a value`);
        }
        switch (flag) {
            case "--evidence-archive":
                options.archivePath = value;
                break;
            case "--artifact-metadata":
                options.metadataPath = value;
                break;
            case "--workflow-run":
                options.workflowRunPath = value;
                break;
            case "--evidence-dir":
                options.evidenceDir = value;
                break;
            case "--expected-harness-sha":
                expected.sourceSha = value;
                break;
            case "--expected-run-id":
                expected.runId = value;
                break;
            case "--expected-run-attempt":
                expected.runAttempt = value;
                break;
            case "--expected-repository":
                expected.repository = value;
                break;
            case "--expected-workflow":
                expected.workflow = value;
                break;
            case "--expected-artifact-id":
                expected.artifactId = value;
                break;
            case "--expected-artifact-name":
                expected.artifactName = value;
                break;
            case "--expected-archive-digest":
                expected.archiveDigest = value;
                break;
            case "--expected-execution":
                options.expectedExecutionPath = value;
                break;
            case "--output":
                options.outputPath = value;
                break;
            default:
                fail(`unknown flag: ${flag}`);
        }
        index += 2;
    }
    options.expectedCliContext = expected;
    return options;
};

/**
 * CLI runner for post-release MSI evidence verification.
 * @param {Array<string>} args
 * @returns {Promise<Object>}
 */
export async function runV161PostReleaseMsiVerificationCli(args) {
    if (!Array.isArray(args) || args.length === 0) {
        fail("Usage: post-release-msi-verification.mjs --evidence-archive <zip> --artifact-metadata <json> --expected-harness-sha <sha> --expected-run-id <id> --expected-run-attempt <attempt> [--evidence-dir <dir>] [--output <out>]");
    }

    const parsed = parseCliArguments(args);

    if (!parsed.archivePath) fail("evidence-archive is required");
    if (!parsed.metadataPath) fail("artifact-metadata is required");

    let expectedExecution;
    if (parsed.expectedExecutionPath) {
        const execBytes = readBoundedFileDescriptor(parsed.expectedExecutionPath, MAX_METADATA_BYTES, "expected execution file");
        expectedExecution = parseJsonSafe(execBytes, "expected execution file");
    } else {
        const cliCtx = parsed.expectedCliContext;
        if (!cliCtx.sourceSha || !cliCtx.runId || !cliCtx.runAttempt || !cliCtx.artifactId
                || !cliCtx.artifactName || !cliCtx.repository || !cliCtx.workflow) {
            fail("expected execution context flags including repository, workflow, artifact ID and artifact name are required");
        }
        expectedExecution = {
            repository: cliCtx.repository ?? REPOSITORY,
            workflow: cliCtx.workflow ?? DEFAULT_WORKFLOW,
            sourceSha: cliCtx.sourceSha,
            runId: cliCtx.runId,
            runAttempt: cliCtx.runAttempt,
            artifactId: cliCtx.artifactId,
            artifactName: cliCtx.artifactName,
            archiveDigest: cliCtx.archiveDigest
        };
    }

    const metaBytes = readBoundedFileDescriptor(parsed.metadataPath, MAX_METADATA_BYTES, "artifact metadata file");
    const artifactMetadata = parseJsonSafe(metaBytes, "artifact metadata file");

    if (!parsed.workflowRunPath) fail("workflow-run is required for production verification");
    const runBytes = readBoundedFileDescriptor(parsed.workflowRunPath, MAX_METADATA_BYTES, "workflow run file");
    const workflowRunRecord = parseJsonSafe(runBytes, "workflow run file");

    const inspection = await verifyV161PostReleaseMsiEvidence({
        archivePath: parsed.archivePath,
        artifactMetadata,
        workflowRunRecord,
        expectedExecution,
        evidenceDir: parsed.evidenceDir
    });

    if (parsed.outputPath) {
        const outString = `${JSON.stringify(inspection, null, 2)}\n`;
        fs.writeFileSync(path.resolve(parsed.outputPath), outString, "utf8");
    }

    return inspection;
}

const invokedDirectly = process.argv[1]
    && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
    runV161PostReleaseMsiVerificationCli(process.argv.slice(2))
        .then(result => {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        })
        .catch(error => {
            process.stderr.write(`${error?.message ?? String(error)}\n`);
            process.exitCode = 1;
        });
}

export const POST_RELEASE_MSI_VERIFICATION_CONSTANTS = Object.freeze({
    SCHEMA_VERSION,
    INSPECTION_KIND,
    ARTIFACT_NAME,
    DEFAULT_WORKFLOW,
    REPOSITORY,
    AUTHORITY,
    MAX_ARCHIVE_BYTES,
    MAX_MEMBER_BYTES,
    MAX_AGGREGATE_EXPANDED_BYTES,
    MAX_TEXT_STREAM_BYTES,
    MAX_METADATA_BYTES,
    MIN_MEMBER_COUNT,
    MAX_MEMBER_COUNT,
    EXPECTED_SCENARIO_COUNT,
    REQUIRED_REQUEST_FILE,
    REQUIRED_RESULT_FILE,
    REQUIRED_FILES,
    ALLOWED_OPTIONAL_FILES,
    TEXT_STREAM_FILES,
    ALL_ALLOWED_FILES
});
