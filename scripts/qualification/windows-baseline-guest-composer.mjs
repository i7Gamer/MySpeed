/*
 * Composes the envelope Stage 3 parses out of the guest's own receipts.
 *
 * The runner proves the candidate's runtime behaviour and the CPUID probe proves the CPU floor;
 * neither on its own is what the host reads. This module joins them into the single document
 * `validateBaselineGuestResult` accepts, in Node rather than in the bootstrap's PowerShell, so the
 * key order is deterministic and the evidence bytes are hashed exactly once, where they are made.
 *
 * Nothing here decides whether the evidence is good enough - it only carries it faithfully. Every
 * value below is either measured by the guest or echoed from the documents the host seeded, and the
 * host re-derives the CPU feature projection from the raw leaves rather than trusting the booleans.
 */
import crypto from "node:crypto";

const SCHEMA_VERSION = 1;
const PROFILE = "baseline-cpu";
const CPUID_KIND = "cpuid";
const MAX_CPUID_BYTES = 64 * 1024;
/* linux-windows-cpu-floor-stage3.mjs bounds every embedded evidence blob at this size. */
const MAX_EMBEDDED_EVIDENCE_BYTES = 4 * 1024 * 1024;
const CPU_FEATURE_NAMES = Object.freeze(["avx", "avx2", "osxsave", "popcnt", "sse42"]);
const NETWORK_COUNTER_NAMES = Object.freeze(["enabledNonLoopbackInterfaces", "hardwareNics", "nonLoopbackRoutes"]);

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const exactKeys = (value, expected, label) => {
    if (!isObject(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
        throw new TypeError(`${label} schema differs`);
};

/*
 * Bounded at both ends, and the upper bound is the host's own. Oversized evidence would otherwise
 * be caught first by the envelope's size check, which can only report that the whole result was too
 * big - this names the piece that grew, in the guest, where the summary was made.
 */
function encodeEvidence(value, label) {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    if (bytes.length < 2) throw new TypeError(`${label} evidence is empty`);
    if (bytes.length > MAX_EMBEDDED_EVIDENCE_BYTES) throw new TypeError(`${label} evidence is too large`);
    return {bytes, bytesBase64: bytes.toString("base64"), sha256: sha256(bytes)};
}

/*
 * The probe's stdout is carried verbatim - base64 of exactly the bytes it printed, never of a
 * re-serialization. Re-encoding would let the parsed view and the hashed bytes drift apart, which
 * is the one thing the host's `decodeEvidence` comparison exists to catch.
 */
function readCpuid(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_CPUID_BYTES)
        throw new TypeError("baseline CPUID probe output size differs");
    let parsed;
    try { parsed = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)); }
    catch { throw new TypeError("baseline CPUID probe output is not valid UTF-8 JSON"); }
    exactKeys(parsed, ["features", "kind", "leaf1", "leaf7Subleaf0", "maxBasicLeaf", "schemaVersion", "xcr0"],
        "baseline CPUID probe output");
    if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.kind !== CPUID_KIND)
        throw new TypeError("baseline CPUID probe output header differs");
    exactKeys(parsed.features, CPU_FEATURE_NAMES, "baseline CPUID probe features");
    for (const name of CPU_FEATURE_NAMES) {
        if (typeof parsed.features[name] !== "boolean")
            throw new TypeError(`baseline CPUID probe feature ${name} differs`);
    }
    if (parsed.xcr0 !== null && typeof parsed.xcr0 !== "string")
        throw new TypeError("baseline CPUID probe XCR0 differs");
    return parsed;
}

export function composeWindowsBaselineGuestResult(input) {
    exactKeys(input, ["cpuidBytes", "execution", "request", "result"], "baseline composition input");
    const {execution, request, result} = input;
    if (!isObject(execution) || typeof execution.cpuModel !== "string" || execution.cpuModel.length < 1)
        throw new TypeError("baseline execution CPU model differs");
    if (!isObject(request) || !isObject(request.context) || !isObject(request.candidate))
        throw new TypeError("baseline composition request differs");
    if (!isObject(result) || result.status !== "observed" || result.cleanupProven !== true ||
        !isObject(result.summary)) throw new TypeError("baseline composition result differs");

    const cpuid = readCpuid(input.cpuidBytes);
    const summary = structuredClone(result.summary);
    /*
     * The host reads network isolation twice: once inside the verifier summary, where the runner
     * labels it with its mechanism, and once at the top level as three bare counters. They are the
     * same observation, so the top level is projected from the summary rather than measured again.
     */
    if (!isObject(summary.networkIsolation)) throw new TypeError("baseline composition network differs");
    const network = {};
    for (const name of NETWORK_COUNTER_NAMES) {
        if (!Number.isInteger(summary.networkIsolation[name]))
            throw new TypeError(`baseline composition network ${name} differs`);
        network[name] = summary.networkIsolation[name];
    }

    const summaryEvidence = encodeEvidence(summary, "baseline verifier summary");
    const cpuidBase64 = input.cpuidBytes.toString("base64");
    return {
        schemaVersion: SCHEMA_VERSION,
        status: "observed",
        profile: PROFILE,
        /*
         * Carried up from the runner so the bootstrap's result gate still sees the boolean it reads,
         * and so the host gains one more proof rather than losing one to the new envelope.
         */
        cleanupProven: true,
        context: structuredClone(request.context),
        candidate: {artifactName: request.candidate.artifactName, sha256: request.candidate.sha256,
            sourceSha: request.candidate.sourceSha},
        cpu: {model: execution.cpuModel, cpuidBytesBase64: cpuidBase64, cpuidSha256: sha256(input.cpuidBytes),
            sse42: cpuid.features.sse42, popcnt: cpuid.features.popcnt, avx: cpuid.features.avx,
            avx2: cpuid.features.avx2, osxsave: cpuid.features.osxsave, xcr0: cpuid.xcr0},
        network,
        verifier: {summary, summaryBytesBase64: summaryEvidence.bytesBase64, summarySha256: summaryEvidence.sha256},
        releaseGatesCleared: []
    };
}

export const WINDOWS_BASELINE_GUEST_COMPOSER_CONSTANTS = Object.freeze({CPUID_KIND, CPU_FEATURE_NAMES,
    MAX_CPUID_BYTES, MAX_EMBEDDED_EVIDENCE_BYTES, NETWORK_COUNTER_NAMES, PROFILE, SCHEMA_VERSION});
