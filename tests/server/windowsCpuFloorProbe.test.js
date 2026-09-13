import {describe, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SOURCE = path.resolve("scripts/qualification/windows-cpu-floor-probe.c");
const MAX_PROBE_JSON_BYTES = 4_096;
const MAX_UINT32 = 0xffff_ffff;
const LEAF_SEVEN = 7;
const SCHEMA_VERSION = 1;
const ILLEGAL_INSTRUCTION_STATUS = "0xc000001d";
const KNOWN_GOOD_RESULT = 42;
const KNOWN_BAD_RESULT = 13;
const KNOWN_BAD_EXIT_CODE = 19;
const SSE42_RESULT = 2_276_049_685;
const POPCNT_RESULT = 32;
const VECTOR_RESULT = 72;
const SSE42_SEED = 0x1234_5678;
const SHARED_INTEGER_INPUT = 0xf0f0_f0f0_0f0f_0f0fn;
const CRC32C_POLYNOMIAL = 0x82f6_3b78;
const BITS_PER_BYTE = 8;
const INPUT_BYTES = 8;
const BYTE_MASK = 0xffn;
const FLOOR_CLASSIFICATION = "windows-tcg-emulated-hyperv-contained";
const HEX_REGISTER = /^0x[a-f0-9]{8}$/;
const HEX_XCR0 = /^0x[a-f0-9]{16}$/;
const FEATURE_BITS = Object.freeze({sse42: 20, popcnt: 23, osxsave: 27, avx: 28, avx2: 5});
const XCR0_XMM_MASK = 1n << 1n;
const XCR0_YMM_MASK = 1n << 2n;
const XCR0_AVX_MASK = XCR0_XMM_MASK | XCR0_YMM_MASK;
const CONTROL_RESULTS = Object.freeze({
    "known-good": KNOWN_GOOD_RESULT,
    "known-bad": KNOWN_BAD_RESULT,
    sse42: SSE42_RESULT,
    popcnt: POPCNT_RESULT,
    avx: VECTOR_RESULT,
    avx2: VECTOR_RESULT
});

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

const crc32c64 = (seed, input) => {
    let result = seed;
    for (let byteIndex = 0; byteIndex < INPUT_BYTES; byteIndex++) {
        result ^= Number((input >> BigInt(byteIndex * BITS_PER_BYTE)) & BYTE_MASK);
        for (let bit = 0; bit < BITS_PER_BYTE; bit++)
            result = ((result >>> 1) ^ ((result & 1) ? CRC32C_POLYNOMIAL : 0)) >>> 0;
    }
    return result;
};

const requireExactKeys = (value, expected, label) => {
    assert.ok(isObject(value), `${label} must be an object`);
    assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} schema differs`);
};

export const parseProbeJson = (text, expectedKind) => {
    assert.equal(typeof text, "string");
    assert.ok(Buffer.byteLength(text, "utf8") > 0, "probe JSON is empty");
    assert.ok(Buffer.byteLength(text, "utf8") <= MAX_PROBE_JSON_BYTES, "probe JSON is oversized");
    const value = JSON.parse(text);
    if (expectedKind === "cpuid") {
        requireExactKeys(value, ["schemaVersion", "kind", "maxBasicLeaf", "leaf1", "leaf7Subleaf0", "xcr0", "features"], "CPUID");
        assert.equal(value.schemaVersion, SCHEMA_VERSION);
        assert.equal(value.kind, "cpuid");
        assert.ok(Number.isSafeInteger(value.maxBasicLeaf) && value.maxBasicLeaf >= 1 &&
            value.maxBasicLeaf <= MAX_UINT32);
        for (const [label, registers] of [["leaf1", value.leaf1], ["leaf7Subleaf0", value.leaf7Subleaf0]]) {
            requireExactKeys(registers, ["eax", "ebx", "ecx", "edx"], label);
            for (const register of Object.values(registers)) assert.match(register, HEX_REGISTER, label);
        }
        requireExactKeys(value.features, ["sse42", "popcnt", "osxsave", "avx", "avx2"], "features");
        for (const feature of Object.values(value.features)) assert.equal(typeof feature, "boolean");
        const leafOneEcx = Number.parseInt(value.leaf1.ecx.slice(2), 16);
        const leafSevenEbx = Number.parseInt(value.leaf7Subleaf0.ebx.slice(2), 16);
        if (value.maxBasicLeaf < LEAF_SEVEN)
            for (const register of Object.values(value.leaf7Subleaf0))
                assert.equal(register, "0x00000000", "leaf7 must be zero when unavailable");
        for (const name of ["sse42", "popcnt", "osxsave", "avx"]) {
            const rawValue = ((leafOneEcx >>> FEATURE_BITS[name]) & 1) === 1;
            assert.equal(value.features[name], rawValue, `cpuid-${name}-raw-bit-differed`);
        }
        const rawAvx2 = ((leafSevenEbx >>> FEATURE_BITS.avx2) & 1) === 1;
        assert.equal(value.features.avx2, rawAvx2, "cpuid-avx2-raw-bit-differed");
        if (value.features.osxsave) assert.match(value.xcr0, HEX_XCR0, "xcr0");
        else assert.equal(value.xcr0, null, "xcr0 must be null without OSXSAVE");
        return value;
    }
    assert.ok(Object.hasOwn(CONTROL_RESULTS, expectedKind), "unknown expected control");
    requireExactKeys(value, ["schemaVersion", "kind", "result"], "control");
    assert.equal(value.schemaVersion, SCHEMA_VERSION);
    assert.equal(value.kind, expectedKind);
    assert.ok(Number.isSafeInteger(value.result));
    return value;
};

const expectExit = (reasons, runs, name, exitCode, result) => {
    const observed = runs[name];
    try {
        requireExactKeys(observed, ["termination", "exitCode", "output"], `${name} run`);
        parseProbeJson(JSON.stringify(observed.output), name);
    } catch {
        reasons.push(`${name}-run-schema-malformed`);
        return;
    }
    if (observed.termination !== "exit" || observed.exitCode !== exitCode ||
        observed.output.result !== result) {
        reasons.push(`${name}-control-differed`);
    }
};

const expectIllegalInstruction = (reasons, runs, name) => {
    const observed = runs[name];
    try {
        requireExactKeys(observed, ["termination", "ntstatus", "output"], `${name} run`);
    } catch {
        reasons.push(`${name}-run-schema-malformed`);
        return;
    }
    if (observed.termination !== "exception" ||
        observed.ntstatus !== ILLEGAL_INSTRUCTION_STATUS || observed.output !== null) {
        reasons.push(`${name}-did-not-fault-with-status-illegal-instruction`);
    }
};

export const classifyCpuFloorEvidence = evidence => {
    const reasons = [];
    if (!isObject(evidence)) return {passed: false, reasons: ["evidence-is-not-an-object"]};
    if (evidence.classification !== FLOOR_CLASSIFICATION) reasons.push("assurance-classification-differed");
    let cpuidRecord = null;
    try {
        cpuidRecord = parseProbeJson(JSON.stringify(evidence.cpuid), "cpuid");
    } catch (error) {
        reasons.push(`cpuid-record-schema-malformed:${error.message}`);
    }
    const features = cpuidRecord?.features;
    if (!isObject(features) || features.sse42 !== true) reasons.push("cpuid-sse42-not-present");
    if (!isObject(features) || features.popcnt !== true) reasons.push("cpuid-popcnt-not-present");
    if (!isObject(features) || features.osxsave !== false) reasons.push("cpuid-osxsave-not-absent");
    if (!isObject(features) || features.avx !== false) reasons.push("cpuid-avx-not-absent");
    if (!isObject(features) || features.avx2 !== false) reasons.push("cpuid-avx2-not-absent");
    if (cpuidRecord?.xcr0 !== null) reasons.push("cpuid-xcr0-not-null");
    const leafOneEcx = Number.parseInt(cpuidRecord?.leaf1?.ecx?.slice?.(2), 16);
    const leafSevenEbx = Number.parseInt(cpuidRecord?.leaf7Subleaf0?.ebx?.slice?.(2), 16);
    for (const name of ["sse42", "popcnt", "osxsave", "avx"]) {
        const rawValue = Number.isSafeInteger(leafOneEcx) && ((leafOneEcx >>> FEATURE_BITS[name]) & 1) === 1;
        if (!isObject(features) || features[name] !== rawValue) reasons.push(`cpuid-${name}-raw-bit-differed`);
    }
    const rawAvx2 = Number.isSafeInteger(leafSevenEbx) && ((leafSevenEbx >>> FEATURE_BITS.avx2) & 1) === 1;
    if (!isObject(features) || features.avx2 !== rawAvx2) reasons.push("cpuid-avx2-raw-bit-differed");

    const runs = isObject(evidence.runs) ? evidence.runs : {};
    expectExit(reasons, runs, "known-good", 0, KNOWN_GOOD_RESULT);
    expectExit(reasons, runs, "known-bad", KNOWN_BAD_EXIT_CODE, KNOWN_BAD_RESULT);
    expectIllegalInstruction(reasons, runs, "illegal");
    expectExit(reasons, runs, "sse42", 0, SSE42_RESULT);
    expectExit(reasons, runs, "popcnt", 0, POPCNT_RESULT);
    expectIllegalInstruction(reasons, runs, "avx");
    expectIllegalInstruction(reasons, runs, "avx2");

    const verified = evidence.instructionVerification;
    for (const control of ["illegal", "sse42", "popcnt", "avx", "avx2"])
        if (!isObject(verified) || verified[control] !== true)
            reasons.push(`${control}-instruction-not-independently-verified`);
    return {passed: reasons.length === 0, reasons};
};

export const classifyNativeCalibrationCapabilities = value => {
    const reasons = [];
    let cpuidRecord;
    try {
        cpuidRecord = parseProbeJson(JSON.stringify(value), "cpuid");
    } catch (error) {
        return {passed: false, reasons: [`cpuid-record-schema-malformed:${error.message}`]};
    }
    for (const name of ["sse42", "popcnt", "osxsave", "avx", "avx2"])
        if (cpuidRecord.features[name] !== true) reasons.push(`cpuid-${name}-not-present`);
    if (typeof cpuidRecord.xcr0 !== "string" ||
        (BigInt(cpuidRecord.xcr0) & XCR0_AVX_MASK) !== XCR0_AVX_MASK) {
        reasons.push("xcr0-xmm-ymm-not-enabled");
    }
    return {passed: reasons.length === 0, reasons};
};

const controlOutput = kind => ({schemaVersion: SCHEMA_VERSION, kind, result: CONTROL_RESULTS[kind]});
const exited = (kind, exitCode = 0) => ({termination: "exit", exitCode, output: controlOutput(kind)});
const illegal = () => ({termination: "exception", ntstatus: ILLEGAL_INSTRUCTION_STATUS, output: null});
const cpuid = (overrides = {}, xcr0Override) => {
    const features = {sse42: true, popcnt: true, osxsave: false, avx: false, avx2: false, ...overrides};
    let leafOneEcx = 0x8000_0001;
    for (const name of ["sse42", "popcnt", "osxsave", "avx"])
        if (features[name]) leafOneEcx |= (1 << FEATURE_BITS[name]);
    const leafSevenEbx = features.avx2 ? (1 << FEATURE_BITS.avx2) : 0;
    const hex = value => `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
    return {
        schemaVersion: SCHEMA_VERSION,
        kind: "cpuid",
        maxBasicLeaf: 7,
        leaf1: {eax: "0x000106a3", ebx: "0x00000800", ecx: hex(leafOneEcx), edx: "0x078bfbfd"},
        leaf7Subleaf0: {eax: "0x00000000", ebx: hex(leafSevenEbx), ecx: "0x00000000", edx: "0x00000000"},
        xcr0: xcr0Override ?? (features.osxsave ? "0x0000000000000007" : null),
        features
    };
};
const passingEvidence = () => ({
    classification: FLOOR_CLASSIFICATION,
    cpuid: cpuid(),
    runs: {
        "known-good": exited("known-good"),
        "known-bad": exited("known-bad", KNOWN_BAD_EXIT_CODE),
        illegal: illegal(),
        sse42: exited("sse42"),
        popcnt: exited("popcnt"),
        avx: illegal(),
        avx2: illegal()
    },
    instructionVerification: {illegal: true, sse42: true, popcnt: true, avx: true, avx2: true}
});

describe("Windows CPU-floor probe JSON", () => {
    it("pins independently recomputed positive-control results", () => {
        assert.equal(crc32c64(SSE42_SEED, SHARED_INTEGER_INPUT), SSE42_RESULT);
        assert.equal(SHARED_INTEGER_INPUT.toString(2).replaceAll("0", "").length, POPCNT_RESULT);
    });

    it("parses the bounded exact CPUID schema", () => {
        assert.deepEqual(parseProbeJson(JSON.stringify(cpuid()), "cpuid"), cpuid());
    });

    it("requires XCR0 only when raw CPUID reports OSXSAVE", () => {
        const floor = {...cpuid(), xcr0: null};
        assert.deepEqual(parseProbeJson(JSON.stringify(floor), "cpuid"), floor);
        const modern = {...cpuid({osxsave: true, avx: true, avx2: true}), xcr0: "0x0000000000000007"};
        assert.deepEqual(parseProbeJson(JSON.stringify(modern), "cpuid"), modern);
        assert.throws(() => parseProbeJson(JSON.stringify({...floor, xcr0: "0x0000000000000000"}), "cpuid"));
        assert.throws(() => parseProbeJson(JSON.stringify({...modern, xcr0: null}), "cpuid"));
        assert.throws(() => parseProbeJson(JSON.stringify({...modern, xcr0: "0x6junk"}), "cpuid"));
    });

    it("bounds maxBasicLeaf to uint32 and rejects unavailable leaf-seven data", () => {
        const maximum = {...cpuid(), maxBasicLeaf: MAX_UINT32};
        assert.deepEqual(parseProbeJson(JSON.stringify(maximum), "cpuid"), maximum);
        assert.throws(() => parseProbeJson(JSON.stringify({...cpuid(), maxBasicLeaf: MAX_UINT32 + 1}), "cpuid"));

        const beforeLeafSeven = cpuid();
        beforeLeafSeven.maxBasicLeaf = 1;
        assert.deepEqual(parseProbeJson(JSON.stringify(beforeLeafSeven), "cpuid"), beforeLeafSeven);
        const impossible = structuredClone(beforeLeafSeven);
        impossible.leaf7Subleaf0.ebx = "0x00000020";
        impossible.features.avx2 = true;
        assert.throws(() => parseProbeJson(JSON.stringify(impossible), "cpuid"), /leaf7/i);
        assert.equal(classifyNativeCalibrationCapabilities(beforeLeafSeven).passed, false);
    });

    it("parses each successful control without classifying it alone", () => {
        for (const kind of Object.keys(CONTROL_RESULTS))
            assert.deepEqual(parseProbeJson(JSON.stringify(controlOutput(kind)), kind), controlOutput(kind));
    });

    it("rejects malformed, oversized, and schema-expanded JSON", () => {
        assert.throws(() => parseProbeJson("not-json", "cpuid"));
        assert.throws(() => parseProbeJson("x".repeat(MAX_PROBE_JSON_BYTES + 1), "cpuid"), /oversized/);
        assert.throws(() => parseProbeJson(JSON.stringify({...cpuid(), unexpected: true}), "cpuid"), /schema/);
        assert.throws(() => parseProbeJson(JSON.stringify({...controlOutput("sse42"), result: 1.5}), "sse42"));
        assert.throws(() => parseProbeJson(JSON.stringify(controlOutput("popcnt")), "sse42"));
    });
});

describe("Windows CPU-floor classification", () => {
    it("requires CPUID, positive instructions, exception controls, and independent instruction verification", () => {
        assert.deepEqual(classifyCpuFloorEvidence(passingEvidence()), {passed: true, reasons: []});
    });

    it("does not let CPUID-only evidence clear the gate", () => {
        const evidence = passingEvidence();
        evidence.runs = {};
        const result = classifyCpuFloorEvidence(evidence);
        assert.equal(result.passed, false);
        assert.match(result.reasons.join("\n"), /control|illegal-instruction|run-schema-malformed/);
    });

    it("recomputes feature claims from the retained raw CPUID registers", () => {
        const evidence = passingEvidence();
        evidence.cpuid.features.avx = true;
        const result = classifyCpuFloorEvidence(evidence);
        assert.equal(result.passed, false);
        assert.match(result.reasons.join("\n"), /raw-bit-differed/);
    });

    it("requires the CPU-floor CPUID record to omit XCR0 state", () => {
        const evidence = passingEvidence();
        evidence.cpuid.xcr0 = "0x0000000000000000";
        const result = classifyCpuFloorEvidence(evidence);
        assert.equal(result.passed, false);
        assert.match(result.reasons.join("\n"), /xcr0/);
    });

    it("rejects partial or lexically malformed records before semantic classification", () => {
        for (const mutate of [
            evidence => { delete evidence.cpuid.schemaVersion; },
            evidence => { evidence.cpuid.leaf1.ecx += "junk"; },
            evidence => { evidence.runs.sse42.output.unexpected = true; },
            evidence => { evidence.runs.illegal.unexpected = true; }
        ]) {
            const evidence = passingEvidence();
            mutate(evidence);
            const result = classifyCpuFloorEvidence(evidence);
            assert.equal(result.passed, false);
            assert.match(result.reasons.join("\n"), /schema|malformed/);
        }
    });

    it("rejects normal AVX completion and synthesized or wrong exception statuses", () => {
        for (const observed of [exited("avx"),
            {termination: "exception", ntstatus: "0xc000001d", output: controlOutput("avx")},
            {termination: "exception", ntstatus: "0xc0000005", output: null}]) {
            const evidence = passingEvidence();
            evidence.runs.avx = observed;
            assert.equal(classifyCpuFloorEvidence(evidence).passed, false);
        }
    });

    it("models a modern native host observation as non-qualifying", () => {
        const evidence = passingEvidence();
        evidence.classification = "windows-native-host-observation-nonqualifying";
        evidence.cpuid = cpuid({osxsave: true, avx: true, avx2: true});
        evidence.runs.avx = exited("avx");
        evidence.runs.avx2 = exited("avx2");
        const result = classifyCpuFloorEvidence(evidence);
        assert.equal(result.passed, false);
        assert.match(result.reasons.join("\n"), /classification|avx/);
    });

    it("gates native AVX calibration on raw feature claims and XCR0 XMM/YMM state", () => {
        const capable = {...cpuid({osxsave: true, avx: true, avx2: true}), xcr0: "0x0000000000000007"};
        assert.deepEqual(classifyNativeCalibrationCapabilities(capable), {passed: true, reasons: []});
        for (const xcr0 of ["0x0000000000000000", "0x0000000000000002", "0x0000000000000004"]) {
            const result = classifyNativeCalibrationCapabilities({...capable, xcr0});
            assert.equal(result.passed, false);
            assert.match(result.reasons.join("\n"), /xcr0-xmm-ymm-not-enabled/);
        }
        const rawMismatch = {...capable, features: {...capable.features, avx: false}};
        assert.match(classifyNativeCalibrationCapabilities(rawMismatch).reasons.join("\n"), /raw-bit-differed/);
    });

    it("rejects a wrong positive result, a missing known-bad exit, and unverified instructions", () => {
        const evidence = passingEvidence();
        evidence.runs.popcnt.output.result = POPCNT_RESULT - 1;
        evidence.runs["known-bad"].exitCode = 0;
        evidence.instructionVerification.avx2 = false;
        const result = classifyCpuFloorEvidence(evidence);
        assert.equal(result.passed, false);
        assert.match(result.reasons.join("\n"), /popcnt|known-bad|avx2/);
    });
});

describe("native MSVC instruction contract", () => {
    it("uses separate compile-time executables with unconditional instruction intrinsics", () => {
        const source = fs.readFileSync(SOURCE, "utf8");
        for (const mode of ["CPUID", "KNOWN_GOOD", "KNOWN_BAD", "ILLEGAL", "SSE42", "POPCNT", "AVX", "AVX2"])
            assert.match(source, new RegExp(`PROBE_${mode}`), mode);
        for (const intrinsic of ["__cpuidex", "__ud2", "_mm_crc32_u64", "__popcnt64", "_mm256_add_ps", "_mm256_add_epi32"])
            assert.ok(source.includes(intrinsic), intrinsic);
        assert.ok(source.includes("_xgetbv"), "_xgetbv");
        const xgetbvIndex = source.indexOf("_xgetbv(XCR_XFEATURE_ENABLED_MASK)");
        const cpuidMainStart = source.indexOf("#if defined(PROBE_CPUID)", source.indexOf("int main(void)"));
        const knownGoodMainStart = source.indexOf("#elif defined(PROBE_KNOWN_GOOD)", cpuidMainStart);
        const xgetbvGuardStart = source.lastIndexOf("if (", xgetbvIndex);
        const xgetbvGuard = source.slice(xgetbvGuardStart, xgetbvIndex);
        assert.ok(xgetbvIndex > cpuidMainStart && xgetbvIndex < knownGoodMainStart, "XGETBV must remain CPUID-only");
        assert.ok(xgetbvGuardStart >= 0, "XGETBV guard");
        assert.match(xgetbvGuard, /leaf_one_ecx[\s\S]*OSXSAVE_BIT/, "XGETBV must use the raw OSXSAVE bit");
        for (const guard of ["_MSC_VER", "_M_X64", "__AVX__", "__AVX2__"])
            assert.ok(source.includes(guard), guard);
        assert.match(source, /static volatile float avx_left\[/);
        assert.match(source, /static volatile int avx2_left\[/);
        assert.doesNotMatch(source, /__try|__except|RaiseException|ExitProcess|TerminateProcess|SetUnhandledExceptionFilter/);
        assert.doesNotMatch(source, /IsProcessorFeaturePresent|0xc000001d/i);
    });

    it("pins exact known results and never CPUID-gates an instruction control", () => {
        const source = fs.readFileSync(SOURCE, "utf8");
        for (const constant of ["KNOWN_GOOD_RESULT", "KNOWN_BAD_RESULT", "SSE42_RESULT", "SSE42_SEED",
            "POPCNT_RESULT", "VECTOR_RESULT"])
            assert.match(source, new RegExp(`${constant}\\s`), constant);
        const cpuidBranch = source.indexOf("defined(PROBE_CPUID)");
        for (const mode of ["SSE42", "POPCNT", "AVX", "AVX2"]) {
            const start = source.indexOf(`#elif defined(PROBE_${mode})`, cpuidBranch);
            const end = source.indexOf("#elif", start + 1);
            const branch = source.slice(start, end < 0 ? source.length : end);
            assert.ok(start > cpuidBranch, mode);
            assert.doesNotMatch(branch, /__cpuid|features|if\s*\(/, `${mode} must execute without a feature guard`);
        }
    });
});
