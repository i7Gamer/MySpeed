import assert from "node:assert/strict";
import crypto from "node:crypto";
import {describe, it} from "node:test";

import {
    extractGuestReceiptDiagnostic,
    parseGuestOutput,
    receiptRejectionCode
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";
import {
    RECEIPT_MALFORMED_REASONS,
    RECEIPT_REJECTION_CODES,
    WINDOWS_SYSTEM_TOOL_PATHS,
    validateReceiptDiagnostic
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";
import {
    buildWindowsMsiSetupCompleteActivation,
    getCompletedWindowsMsiActivationEvidence
} from "../../scripts/qualification/windows-msi-post-setup-activation.mjs";

/*
 * Run 35198002285 retained a receipt diagnostic that said only `schema-invalid`: a complete read of
 * valid JSON that the host refused, with no way to tell which of roughly a dozen unrelated checks
 * refused it - or even whether the refusal came from the success parser or the failure parser. These
 * tests pin a closed vocabulary onto the check regions that already exist. They assert the PUBLISHED
 * diagnostic rather than the thrown message, because the message is the thing that may never be
 * published, and they assert that every mutation still fails calibration.
 */

const NONCE = "3f9a1c7d5e2b48a6b0c4d8e2f6a1b3c5";
const OTHER_NONCE = "11111111111111111111111111111111";
const ILLEGAL_INSTRUCTION_EXIT = 3_221_225_501;
const SECRET = "SyntheticGuestSecret-7f3a9c1e4b";
const HISTORICAL_MALFORMED_REASONS =
    Object.freeze(["json-syntax-error", "nonce-mismatch", "schema-invalid", "partial-read", "read-cap-exceeded"]);
const MALFORMED_DIAGNOSTIC_KEYS = Object.freeze(["bytes", "reason", "schemaVersion", "sha256", "source", "status"]);

const encode = value => Buffer.from(`${JSON.stringify(value)}\n`).toString("base64");
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function cpuidRecord() {
    return {
        schemaVersion: 1, kind: "cpuid", maxBasicLeaf: 7,
        leaf1: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00900000", edx: "0x00000000"},
        leaf7Subleaf0: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00000000", edx: "0x00000000"},
        xcr0: null, features: {sse42: true, popcnt: true, osxsave: false, avx: false, avx2: false}
    };
}

const CONTROL_RESULTS = Object.freeze({"known-good": 42, "known-bad": 13, sse42: 2_276_049_685, popcnt: 32});

/* The representative success fixture: what a guest that finished its work actually writes. */
function successReceipt() {
    const runs = [
        {role: "cpuid", exitCode: 0, stdoutBase64: encode(cpuidRecord()), stderrBase64: ""},
        ...Object.keys(CONTROL_RESULTS).map(role => ({
            role,
            exitCode: role === "known-bad" ? 19 : 0,
            stdoutBase64: encode({schemaVersion: 1, kind: role, result: CONTROL_RESULTS[role]}),
            stderrBase64: ""
        })),
        ...["illegal", "avx", "avx2"].map(role => ({
            role, exitCode: ILLEGAL_INSTRUCTION_EXIT, stdoutBase64: "", stderrBase64: ""
        }))
    ];
    const activation = getCompletedWindowsMsiActivationEvidence(buildWindowsMsiSetupCompleteActivation({
        repository: "i7Gamer/MySpeed", sourceSha: "a".repeat(40), eventSha: "b".repeat(40),
        runId: "123", runAttempt: "1", nonce: NONCE
    }));
    const systemTools = WINDOWS_SYSTEM_TOOL_PATHS.map((tool, index) => ({
        ...tool, bytes: String(index + 1), sha256: String(index + 1).repeat(64)
    }));
    return structuredClone({
        schemaVersion: 1, nonce: NONCE, runs,
        network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0},
        activation, systemTools
    });
}

const cpuidRun = receipt => receipt.runs.find(run => run.role === "cpuid");

/* Exactly one mutation per category, each one landing inside a different existing check region. */
const MUTATIONS = Object.freeze({
    "result-header-invalid": receipt => { receipt.schemaVersion = 2; },
    "probe-run-invalid": receipt => { cpuidRun(receipt).exitCode = -1; },
    "cpuid-run-failed": receipt => { cpuidRun(receipt).exitCode = 1; },
    "cpuid-output-invalid": receipt => {
        const cpuid = cpuidRecord();
        cpuid.leaf1.eax = "0xZZZZZZZZ";
        cpuidRun(receipt).stdoutBase64 = encode(cpuid);
    },
    "cpu-floor-unmet": receipt => {
        const cpuid = cpuidRecord();
        cpuid.leaf1.ecx = "0x10900000";
        cpuid.features.avx = true;
        cpuidRun(receipt).stdoutBase64 = encode(cpuid);
    },
    "control-probe-mismatch": receipt => {
        receipt.runs.find(run => run.role === "known-good").stdoutBase64 =
            encode({schemaVersion: 1, kind: "known-good", result: 41});
    },
    "fault-probe-not-illegal": receipt => { receipt.runs.find(run => run.role === "avx").exitCode = 0; },
    "network-not-isolated": receipt => { receipt.network.nonLoopbackRoutes = 1; },
    "activation-invalid": receipt => { receipt.activation.setupCompleted = false; },
    "system-tools-invalid": receipt => { receipt.systemTools[0].sha256 = "z".repeat(64); }
});

function mutated(code) {
    const receipt = successReceipt();
    MUTATIONS[code](receipt);
    return Buffer.from(JSON.stringify(receipt), "utf8");
}

function rejection(bytes, expectedNonce = NONCE) {
    try {
        parseGuestOutput(bytes, expectedNonce);
    } catch (error) {
        assert.ok(error instanceof TypeError, "the rejection must stay a TypeError");
        return error;
    }
    return assert.fail("parseGuestOutput accepted a fixture it must reject");
}

const OK_EXTRACTION_PROCESS = Object.freeze({
    exitCode: 0, signal: null, timedOut: false, stdoutOverflow: false, stderrOverflow: false,
    cleanupProven: true, errorObserved: false
});
const MISSING_EXTRACTION_PROCESS = Object.freeze({...OK_EXTRACTION_PROCESS, exitCode: 1});
const UNEXPECTED_FALLBACK = Buffer.from("the fallback name must not be consulted");

function receiptInput() {
    return {
        paths: {root: `/tmp/root-${NONCE}`, outputDisk: `/tmp/root-${NONCE}/output.img`},
        toolchain: {
            runtime: {loader: {path: "/tmp/loader"}, libraryPath: ["/tmp/lib"]},
            mcopy: {path: "/usr/bin/mtools", invocationPath: "/usr/bin/mcopy"}
        }
    };
}

/* Real extraction, real publication, then the retained core validator - no shortcut in between. */
async function retain(bytes, {expectedNonce = NONCE, fallback = UNEXPECTED_FALLBACK, primaryFound = true} = {}) {
    const names = [];
    const io = {
        validateOutputDisk() {},
        monotonicMilliseconds: () => 0,
        runOwned: async (_command, argv) => {
            const isFallback = argv.includes("::bootstrap-failure.json");
            names.push(isFallback ? "bootstrap-failure.json" : "result.json");
            if (!isFallback && !primaryFound)
                return {process: MISSING_EXTRACTION_PROCESS, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)};
            return {process: OK_EXTRACTION_PROCESS, stdout: isFallback ? fallback : bytes, stderr: Buffer.alloc(0)};
        }
    };
    const extracted = await extractGuestReceiptDiagnostic(io, receiptInput(), {nonce: expectedNonce},
        {process: {cleanupProven: true, treeGone: true}}, null, {dev: 1n});
    return {...extracted, names, validated: validateReceiptDiagnostic(extracted.diagnostic, expectedNonce)};
}

describe("Stage 2 receipt rejection vocabulary", () => {
    it("is a frozen allowlist that only extends the historical malformed reasons", () => {
        assert.ok(Object.isFrozen(RECEIPT_REJECTION_CODES));
        assert.ok(Object.isFrozen(RECEIPT_MALFORMED_REASONS));
        assert.deepEqual([...new Set(RECEIPT_REJECTION_CODES)], [...RECEIPT_REJECTION_CODES]);
        for (const code of RECEIPT_REJECTION_CODES)
            assert.ok(RECEIPT_MALFORMED_REASONS.includes(code), `${code} is not a malformed reason`);
        for (const reason of HISTORICAL_MALFORMED_REASONS) {
            assert.ok(RECEIPT_MALFORMED_REASONS.includes(reason), `${reason} was dropped`);
            assert.ok(!RECEIPT_REJECTION_CODES.includes(reason), `${reason} must stay a historical reason`);
        }
        assert.deepEqual([...RECEIPT_REJECTION_CODES].sort(),
            [...Object.keys(MUTATIONS), "failure-receipt-invalid"].sort());
    });

    it("parses the representative success fixture and retains it as valid-success", async () => {
        const bytes = Buffer.from(JSON.stringify(successReceipt()), "utf8");
        const parsed = parseGuestOutput(bytes, NONCE);
        assert.deepEqual(parsed.cpu, {sse42: true, popcnt: true, osxsave: false, avx: false, avx2: false});
        assert.deepEqual(parsed.network, {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0});

        const retained = await retain(bytes);
        assert.deepEqual(retained.names, ["result.json"]);
        assert.equal(retained.diagnostic.status, "valid-success");
        assert.equal(retained.diagnostic.source, "result.json");
        assert.equal(retained.guestFailure, null);
        assert.deepEqual(retained.validated, retained.diagnostic);
    });

    it("publishes one distinct reason per existing check region, through real extraction", async () => {
        const observed = new Set();
        for (const code of Object.keys(MUTATIONS)) {
            const bytes = mutated(code);

            /* The rejection itself is unchanged: still a TypeError, still the same message. */
            assert.equal(receiptRejectionCode(rejection(bytes)), code);

            const retained = await retain(bytes);
            assert.deepEqual(retained.names, ["result.json"], code);
            assert.equal(retained.diagnostic.status, "malformed", code);
            assert.equal(retained.diagnostic.source, "result.json", code);
            assert.equal(retained.diagnostic.reason, code);
            assert.equal(retained.diagnostic.bytes, String(bytes.length), code);
            assert.equal(retained.diagnostic.sha256, sha256(bytes), code);
            assert.equal(retained.guestFailure, null, code);
            assert.deepEqual(retained.validated, retained.diagnostic, code);
            observed.add(retained.diagnostic.reason);
        }
        assert.equal(observed.size, Object.keys(MUTATIONS).length, "every category must be distinguishable");
    });

    it("separates a rejected failure dialect from a rejected success receipt", async () => {
        const bytes = Buffer.from(JSON.stringify({
            schemaVersion: 1, status: "failed", hostNonce: NONCE, stage: "unexpected-stage",
            failure: "bounded failure text"
        }), "utf8");
        const retained = await retain(bytes);
        assert.equal(retained.diagnostic.status, "malformed");
        assert.equal(retained.diagnostic.reason, "failure-receipt-invalid");
        assert.equal(retained.guestFailure, null);
        assert.deepEqual(retained.validated, retained.diagnostic);
    });

    it("still refuses a wrong nonce before any category is considered", async () => {
        const receipt = successReceipt();
        receipt.nonce = OTHER_NONCE;
        receipt.schemaVersion = 2;
        const success = await retain(Buffer.from(JSON.stringify(receipt), "utf8"));
        assert.equal(success.diagnostic.reason, "nonce-mismatch");

        const failure = await retain(Buffer.from(JSON.stringify({
            schemaVersion: 1, status: "failed", hostNonce: OTHER_NONCE, stage: "post-setup-completion",
            failure: "bounded failure text"
        }), "utf8"));
        assert.equal(failure.diagnostic.reason, "nonce-mismatch");
    });

    it("reports the first failing region when several checks would fail", async () => {
        const receipt = successReceipt();
        MUTATIONS["cpu-floor-unmet"](receipt);
        MUTATIONS["network-not-isolated"](receipt);
        MUTATIONS["system-tools-invalid"](receipt);
        const retained = await retain(Buffer.from(JSON.stringify(receipt), "utf8"));
        assert.equal(retained.diagnostic.reason, "cpu-floor-unmet");
    });

    it("keeps every semantic negative out of calibration", async () => {
        for (const code of Object.keys(MUTATIONS)) {
            const bytes = mutated(code);
            rejection(bytes);
            const retained = await retain(bytes);
            assert.notEqual(retained.diagnostic.status, "valid-success", code);
            assert.notEqual(retained.diagnostic.status, "valid-failure", code);
            assert.ok(!Object.hasOwn(retained.diagnostic, "receipt"), code);
            assert.equal(retained.guestFailure, null, code);
        }
    });
});

describe("Stage 2 receipt rejection provenance", () => {
    it("falls back to schema-invalid for an uncoded throw", async () => {
        assert.equal(receiptRejectionCode(rejection(Buffer.alloc(0))), null);

        /* A success-shaped payload on the fallback name is never parsed, so it stays uncategorised. */
        const retained = await retain(Buffer.alloc(0),
            {primaryFound: false, fallback: Buffer.from(JSON.stringify(successReceipt()), "utf8")});
        assert.deepEqual(retained.names, ["result.json", "bootstrap-failure.json"]);
        assert.equal(retained.diagnostic.source, "bootstrap-failure.json");
        assert.equal(retained.diagnostic.reason, "schema-invalid");
    });

    it("refuses a counterfeit code that the parser did not produce", () => {
        const genuine = rejection(mutated("cpu-floor-unmet"));
        assert.equal(receiptRejectionCode(genuine), "cpu-floor-unmet");

        for (const counterfeit of [
            Object.assign(new TypeError(genuine.message), {code: "cpu-floor-unmet"}),
            Object.assign(new TypeError("x"), {reason: "cpu-floor-unmet"}),
            Object.create(Object.getPrototypeOf(genuine)),
            new TypeError(genuine.message),
            {code: "cpu-floor-unmet"},
            "cpu-floor-unmet",
            null,
            undefined
        ]) assert.equal(receiptRejectionCode(counterfeit), null);
    });

    it("carries no guest text, secret or exception message into the retained record", async () => {
        const receipt = successReceipt();
        receipt.activation.state = SECRET;
        const bytes = Buffer.from(JSON.stringify(receipt), "utf8");
        assert.ok(bytes.includes(Buffer.from(SECRET)), "the fixture must really contain the secret");
        const message = rejection(bytes).message;

        const retained = await retain(bytes);
        assert.deepEqual(Object.keys(retained.diagnostic).sort(), [...MALFORMED_DIAGNOSTIC_KEYS]);
        assert.equal(retained.diagnostic.reason, "activation-invalid");
        const published = JSON.stringify(retained.validated);
        assert.ok(!published.includes(SECRET), "no guest string may be published");
        assert.ok(!published.includes(message), "no exception message may be published");
    });
});

describe("Stage 2 receipt diagnostic replay", () => {
    const record = reason => ({
        schemaVersion: 1, status: "malformed", source: "result.json", reason,
        bytes: "2809", sha256: "67df6d315e3bacdb9e73b1c5b29731ad080573689ad19f1fd241adf9d3999037"
    });

    it("still replays a historical schema-invalid record unchanged", () => {
        const historical = record("schema-invalid");
        assert.deepEqual(validateReceiptDiagnostic(historical, NONCE), historical);
    });

    it("accepts every new reason and still refuses one outside the vocabulary", () => {
        for (const reason of RECEIPT_REJECTION_CODES)
            assert.deepEqual(validateReceiptDiagnostic(record(reason), NONCE), record(reason));
        for (const reason of ["cpu-floor-invalid", "CPU-FLOOR-UNMET", "", "tool-error"])
            assert.throws(() => validateReceiptDiagnostic(record(reason), NONCE),
                /QEMU receipt diagnostic is invalid/u);
    });
});
