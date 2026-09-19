/*
 * The composer is the only producer of the envelope Stage 3 parses, so every rejection it can make
 * is a run that fails inside the guest with a named reason instead of an hour later as a key error
 * on the host. Each branch is covered here; the accepted shape is proven against the real validator
 * in baselineGuestHostContract.test.js rather than re-asserted by hand.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {describe, it} from "node:test";

import {composeWindowsBaselineGuestResult, WINDOWS_BASELINE_GUEST_COMPOSER_CONSTANTS} from
    "../../scripts/qualification/windows-baseline-guest-composer.mjs";

const {MAX_CPUID_BYTES, MAX_EMBEDDED_EVIDENCE_BYTES} = WINDOWS_BASELINE_GUEST_COMPOSER_CONSTANTS;
const SHA = character => character.repeat(64);
const CANDIDATE_SOURCE_SHA = "4".repeat(40);
const HARNESS_SOURCE_SHA = "1".repeat(40);

const rawCpuid = (overrides = {}) => ({schemaVersion: 1, kind: "cpuid", maxBasicLeaf: 7,
    leaf1: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00900000", edx: "0x00000000"},
    leaf7Subleaf0: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00000000", edx: "0x00000000"},
    xcr0: null, features: {sse42: true, popcnt: true, osxsave: false, avx: false, avx2: false}, ...overrides});
const encode = value => Buffer.from(`${JSON.stringify(value)}\n`, "utf8");

const summary = () => ({status: "passed", exit: 0, mode: "full", sourceSha: CANDIDATE_SOURCE_SHA,
    artifactSha256: SHA("d"), platform: "win32", architecture: "x64",
    command: ["C:\\task\\MySpeed.exe"], processes: [], databaseChecks: [], openGraphChecks: [],
    networkIsolation: {kind: "qemu-nic-none-windows-guest", hardwareNics: 0,
        enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}, shutdownProofs: []});

const input = (overrides = {}) => ({
    cpuidBytes: encode(rawCpuid()),
    execution: {cpuModel: "Westmere-v2", cpuidProbe: {path: "D:\\cpuid.exe", bytes: "16384", sha256: SHA("9")}},
    request: {context: {schemaVersion: 1, sourceSha: HARNESS_SOURCE_SHA},
        candidate: {artifactName: "MySpeed-windows-x64-baseline.exe", sha256: SHA("d"),
            sourceSha: CANDIDATE_SOURCE_SHA}},
    result: {schemaVersion: 1, status: "observed", profile: "baseline-cpu", cleanupProven: true, summary: summary()},
    ...overrides});

const rejects = (overrides, pattern) =>
    assert.throws(() => composeWindowsBaselineGuestResult(input(overrides)), pattern);

describe("Windows baseline guest composer", () => {
    it("carries the probe output verbatim rather than re-serializing it", () => {
        /* Padded with spaces the probe would not print, to prove nothing re-encodes the JSON. */
        const printed = Buffer.from(`${JSON.stringify(rawCpuid(), null, 1)}\n`, "utf8");
        const composed = composeWindowsBaselineGuestResult(input({cpuidBytes: printed}));
        assert.deepEqual(Buffer.from(composed.cpu.cpuidBytesBase64, "base64"), printed);
        assert.equal(composed.cpu.cpuidSha256, crypto.createHash("sha256").update(printed).digest("hex"));
    });

    it("binds the summary bytes to the summary object it publishes", () => {
        const composed = composeWindowsBaselineGuestResult(input());
        const bytes = Buffer.from(composed.verifier.summaryBytesBase64, "base64");
        assert.deepEqual(JSON.parse(bytes.toString("utf8")), composed.verifier.summary);
        assert.equal(composed.verifier.summarySha256, crypto.createHash("sha256").update(bytes).digest("hex"));
    });

    it("projects the three network counters and drops the summary's mechanism label", () => {
        const composed = composeWindowsBaselineGuestResult(input());
        assert.deepEqual(composed.network,
            {enabledNonLoopbackInterfaces: 0, hardwareNics: 0, nonLoopbackRoutes: 0});
        assert.equal(composed.verifier.summary.networkIsolation.kind, "qemu-nic-none-windows-guest");
    });

    it("takes the candidate SHA from the candidate and the context from the request", () => {
        const composed = composeWindowsBaselineGuestResult(input());
        assert.equal(composed.candidate.sourceSha, CANDIDATE_SOURCE_SHA);
        assert.equal(composed.context.sourceSha, HARNESS_SOURCE_SHA);
        assert.notEqual(composed.candidate.sourceSha, composed.context.sourceSha);
    });

    it("does not alias the caller's objects into the published envelope", () => {
        const value = input();
        const composed = composeWindowsBaselineGuestResult(value);
        value.request.context.sourceSha = "0".repeat(40);
        value.result.summary.status = "tampered";
        assert.equal(composed.context.sourceSha, HARNESS_SOURCE_SHA);
        assert.equal(composed.verifier.summary.status, "passed");
    });

    /*
     * A string XCR0 means OSXSAVE was readable, which this floor forbids. The composer carries it
     * rather than judging it: the host owns that policy and rejects it as a CPU floor failure, which
     * is the accurate diagnosis. Swallowing it here would turn a real finding into a schema error.
     */
    it("carries an unexpected XCR0 through for the host to reject", () => {
        const composed = composeWindowsBaselineGuestResult(
            input({cpuidBytes: encode(rawCpuid({xcr0: "0x00000007"}))}));
        assert.equal(composed.cpu.xcr0, "0x00000007");
    });

    it("rejects an input whose keys differ", () => {
        assert.throws(() => composeWindowsBaselineGuestResult({}), /composition input schema differs/u);
        assert.throws(() => composeWindowsBaselineGuestResult({...input(), extra: 1}),
            /composition input schema differs/u);
    });

    it("rejects an execution manifest without a usable CPU model", () => {
        for (const execution of [null, {}, {cpuModel: ""}, {cpuModel: 7}])
            rejects({execution}, /execution CPU model differs/u);
    });

    it("rejects a request missing its context or candidate", () => {
        for (const request of [null, {}, {context: {}}, {candidate: {}}, {context: null, candidate: {}}])
            rejects({request}, /composition request differs/u);
    });

    it("rejects a result that is not an observed, cleaned-up run with a summary", () => {
        for (const result of [null, {status: "failed", cleanupProven: true, summary: {}},
            {status: "observed", cleanupProven: false, summary: {}},
            {status: "observed", cleanupProven: true, summary: null},
            {status: "observed", cleanupProven: true}])
            rejects({result}, /composition result differs/u);
    });

    it("rejects probe output that is not a bounded buffer", () => {
        for (const cpuidBytes of [null, "{}", Buffer.alloc(1), Buffer.alloc(MAX_CPUID_BYTES + 1)])
            rejects({cpuidBytes}, /CPUID probe output size differs/u);
    });

    it("rejects probe output that is not valid UTF-8 JSON", () => {
        for (const cpuidBytes of [Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from("not json", "utf8")])
            rejects({cpuidBytes}, /CPUID probe output is not valid UTF-8 JSON/u);
    });

    it("rejects probe output whose keys differ", () => {
        const {xcr0, ...missing} = rawCpuid();
        assert.equal(xcr0, null);
        rejects({cpuidBytes: encode(missing)}, /CPUID probe output schema differs/u);
        rejects({cpuidBytes: encode({...rawCpuid(), extra: 1})}, /CPUID probe output schema differs/u);
    });

    it("rejects probe output from a different schema or kind", () => {
        rejects({cpuidBytes: encode(rawCpuid({schemaVersion: 2}))}, /CPUID probe output header differs/u);
        rejects({cpuidBytes: encode(rawCpuid({kind: "sse42"}))}, /CPUID probe output header differs/u);
    });

    it("rejects probe features that are absent or not boolean", () => {
        const {avx, ...partial} = rawCpuid().features;
        assert.equal(avx, false);
        rejects({cpuidBytes: encode(rawCpuid({features: partial}))}, /CPUID probe features schema differs/u);
        rejects({cpuidBytes: encode(rawCpuid({features: {...rawCpuid().features, avx: "false"}}))},
            /CPUID probe feature avx differs/u);
    });

    it("rejects an XCR0 that is neither absent nor a string", () => {
        for (const xcr0 of [7, {}, true])
            rejects({cpuidBytes: encode(rawCpuid({xcr0}))}, /CPUID probe XCR0 differs/u);
    });

    it("rejects a summary without the network observation the top level is projected from", () => {
        const withoutNetwork = summary(); delete withoutNetwork.networkIsolation;
        rejects({result: {status: "observed", cleanupProven: true, summary: withoutNetwork}},
            /composition network differs/u);
    });

    it("rejects a network counter that is not an integer", () => {
        for (const [name, value] of [["hardwareNics", "0"], ["nonLoopbackRoutes", 1.5],
            ["enabledNonLoopbackInterfaces", null]]) {
            const changed = summary(); changed.networkIsolation[name] = value;
            rejects({result: {status: "observed", cleanupProven: true, summary: changed}},
                new RegExp(`composition network ${name} differs`, "u"));
        }
    });

    /*
     * Unreachable from the real runner, whose summary is a few kilobytes of bounded strings, but the
     * bound is the host's and belongs on the side that builds the blob. Without it the only report
     * is the envelope's own size check, which cannot say which piece grew.
     */
    it("rejects a summary too large for the host to embed", () => {
        const oversized = summary();
        oversized.command = ["x".repeat(MAX_EMBEDDED_EVIDENCE_BYTES)];
        rejects({result: {status: "observed", cleanupProven: true, summary: oversized}},
            /verifier summary evidence is too large/u);
    });
});
