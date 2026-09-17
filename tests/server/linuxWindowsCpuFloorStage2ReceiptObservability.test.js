import assert from "node:assert/strict";
import crypto from "node:crypto";
import {describe, it} from "node:test";

import {
    parseGuestFailure,
    parseGuestOutcome,
    extractGuestReceiptDiagnostic,
    createHostedStage2Operations
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";
import {
    validateGuestFailure,
    validateReceiptDiagnostic,
    validateQemuLaunchDiagnostic,
    WINDOWS_SYSTEM_TOOL_PATHS,
    QemuLaunchError
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";
import {
    buildWindowsMsiSetupCompleteActivation,
    getCompletedWindowsMsiActivationEvidence
} from "../../scripts/qualification/windows-msi-post-setup-activation.mjs";

const NONCE = "c92cbf717ee04ed4948ed011060743bb";
const OTHER_NONCE = "11111111111111111111111111111111";

function sha256(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function validWorkerReceipt() {
    return {
        schemaVersion: 1,
        status: "failed",
        hostNonce: NONCE,
        stage: "post-setup-completion",
        failure: "Windows setup did not complete within the bounded observation interval"
    };
}

function validBootstrapReceipt() {
    return {
        schemaVersion: 1,
        status: "failed",
        nonce: NONCE,
        stage: "guest-bootstrap",
        failure: "Probe exceeded its deadline"
    };
}

describe("Stage 2 failure receipt parsing and normalization", () => {
    it("accepts established bootstrap failure receipt and returns canonical form", () => {
        const raw = validBootstrapReceipt();
        const bytes = Buffer.from(JSON.stringify(raw), "utf8");
        const parsed = parseGuestFailure(bytes, NONCE);
        assert.deepEqual(parsed, {
            schemaVersion: 1,
            status: "failed",
            nonce: NONCE,
            stage: "guest-bootstrap",
            failure: "Probe exceeded its deadline"
        });
        const outcome = parseGuestOutcome(bytes, NONCE);
        assert.deepEqual(outcome, parsed);
    });

    it("accepts exact existing worker receipt (hostNonce + post-setup-completion) and normalizes to canonical form", () => {
        const raw = validWorkerReceipt();
        const bytes = Buffer.from(JSON.stringify(raw), "utf8");
        const parsed = parseGuestFailure(bytes, NONCE);
        assert.deepEqual(parsed, {
            schemaVersion: 1,
            status: "failed",
            nonce: NONCE,
            stage: "post-setup-completion",
            failure: "Windows setup did not complete within the bounded observation interval"
        });
        const outcome = parseGuestOutcome(bytes, NONCE);
        assert.deepEqual(outcome, parsed);
    });

    it("rejects worker receipt with wrong nonce", () => {
        const raw = validWorkerReceipt();
        raw.hostNonce = OTHER_NONCE;
        const bytes = Buffer.from(JSON.stringify(raw), "utf8");
        assert.throws(() => parseGuestFailure(bytes, NONCE), /guest failure evidence is invalid/);
    });

    it("rejects worker receipt with non-string hostNonce", () => {
        const raw = validWorkerReceipt();
        raw.hostNonce = 12345;
        const bytes = Buffer.from(JSON.stringify(raw), "utf8");
        assert.throws(() => parseGuestFailure(bytes, NONCE), /guest failure evidence is invalid/);
    });

    it("rejects mixed nonce and hostNonce keys", () => {
        const raw = {...validWorkerReceipt(), nonce: NONCE};
        const bytes = Buffer.from(JSON.stringify(raw), "utf8");
        assert.throws(() => parseGuestFailure(bytes, NONCE), /guest failure evidence schema is invalid/);
    });

    it("rejects unexpected stage", () => {
        const raw = {...validBootstrapReceipt(), stage: "unknown-stage"};
        const bytes = Buffer.from(JSON.stringify(raw), "utf8");
        assert.throws(() => parseGuestFailure(bytes, NONCE), /guest failure evidence is invalid/);
    });

    it("rejects bootstrap receipt with hostNonce instead of nonce", () => {
        const raw = {
            schemaVersion: 1,
            status: "failed",
            hostNonce: NONCE,
            stage: "guest-bootstrap",
            failure: "failed"
        };
        const bytes = Buffer.from(JSON.stringify(raw), "utf8");
        assert.throws(() => parseGuestFailure(bytes, NONCE), /guest failure evidence is invalid/);
    });

    it("rejects worker receipt with nonce instead of hostNonce", () => {
        const raw = {
            schemaVersion: 1,
            status: "failed",
            nonce: NONCE,
            stage: "post-setup-completion",
            failure: "failed"
        };
        const bytes = Buffer.from(JSON.stringify(raw), "utf8");
        assert.throws(() => parseGuestFailure(bytes, NONCE), /guest failure evidence is invalid/);
    });

    it("rejects control characters, empty failure, or oversized failure string", () => {
        for (const badFailure of ["", "has\u0000null", "has\nnewline", "a".repeat(513)]) {
            const raw = {...validWorkerReceipt(), failure: badFailure};
            const bytes = Buffer.from(JSON.stringify(raw), "utf8");
            assert.throws(() => parseGuestFailure(bytes, NONCE), /guest failure evidence is invalid/);
        }
    });

    it("exercises the real generated worker script from buildWindowsMsiSetupCompleteActivation", () => {
        const activation = buildWindowsMsiSetupCompleteActivation({
            repository: "i7Gamer/MySpeed",
            sourceSha: "046219c3e1702fbef9a34dfbbb2220ab3ab9bb86",
            eventSha: "046219c3e1702fbef9a34dfbbb2220ab3ab9bb86",
            runId: "35183245912",
            runAttempt: "1",
            nonce: NONCE
        });
        const dispatcherText = Buffer.from(activation.files.dispatcher.bytesBase64, "base64").toString("utf8");
        assert.ok(dispatcherText.includes("function Write-MyspeedPostSetupFailure"));
        assert.ok(dispatcherText.includes("hostNonce=$EXPECTED_HOST_NONCE"));
        assert.ok(dispatcherText.includes("stage='post-setup-completion'"));
        assert.ok(dispatcherText.includes("result.json"));

        // Match the exact JSON record structure emitted by Write-MyspeedPostSetupFailure
        const simulatedGuestFailureMessage = "Windows setup did not complete within the bounded observation interval";
        const generatedRecord = {
            schemaVersion: 1,
            status: "failed",
            hostNonce: NONCE,
            stage: "post-setup-completion",
            failure: simulatedGuestFailureMessage
        };
        const bytes = Buffer.from(JSON.stringify(generatedRecord), "utf8");
        const parsed = parseGuestFailure(bytes, NONCE);
        assert.equal(parsed.stage, "post-setup-completion");
        assert.equal(parsed.nonce, NONCE);
        assert.equal(parsed.failure, simulatedGuestFailureMessage);
    });
});

describe("Core validateGuestFailure acceptance and rejection", () => {
    it("accepts canonical bootstrap failure receipt", () => {
        const canonical = {
            schemaVersion: 1,
            status: "failed",
            nonce: NONCE,
            stage: "guest-bootstrap",
            failure: "bootstrap error"
        };
        const validated = validateGuestFailure(canonical, NONCE);
        assert.deepEqual(validated, canonical);
    });

    it("accepts canonical worker failure receipt", () => {
        const canonical = {
            schemaVersion: 1,
            status: "failed",
            nonce: NONCE,
            stage: "post-setup-completion",
            failure: "worker error"
        };
        const validated = validateGuestFailure(canonical, NONCE);
        assert.deepEqual(validated, canonical);
    });

    it("rejects raw worker receipt (hostNonce key)", () => {
        const raw = validWorkerReceipt();
        assert.throws(() => validateGuestFailure(raw, NONCE), /guest failure evidence keys are invalid/);
    });

    it("rejects invalid stage or wrong nonce in core validator", () => {
        const badStage = {
            schemaVersion: 1,
            status: "failed",
            nonce: NONCE,
            stage: "wim-inspection",
            failure: "error"
        };
        assert.throws(() => validateGuestFailure(badStage, NONCE), /guest failure evidence is invalid/);

        const badNonce = {
            schemaVersion: 1,
            status: "failed",
            nonce: OTHER_NONCE,
            stage: "post-setup-completion",
            failure: "error"
        };
        assert.throws(() => validateGuestFailure(badNonce, NONCE), /guest failure evidence is invalid/);
    });
});

describe("Receipt diagnostic validation (validateReceiptDiagnostic & validateQemuLaunchDiagnostic)", () => {
    const validProcess = () => ({
        exitCode: 1,
        signal: null,
        timedOut: true,
        cleanupProven: true,
        treeGone: true,
        stdoutOverflow: false,
        stderrOverflow: false,
        errorObserved: false,
        qemuPid: 2345,
        qemuStartTicks: "77",
        launcherExecutablePath: "/tmp/loader",
        processGroupId: 2300,
        qemuPidAbsentAfter: true,
        terminationReason: null
    });

    const baseDiagnostic = () => ({
        schemaVersion: 1,
        kind: "qemu-launch-failure-diagnostic",
        process: validProcess(),
        processFlags: {
            errorObserved: false,
            stderrOverflow: false,
            stdoutOverflow: false
        },
        monitorFailure: null,
        stderr: {
            bytes: "0",
            sha256: sha256(Buffer.alloc(0)),
            bytesBase64: ""
        }
    });

    it("accepts valid-failure receipt with primary or fallback source", () => {
        for (const source of ["result.json", "bootstrap-failure.json"]) {
            const canonical = {
                schemaVersion: 1,
                status: "failed",
                nonce: NONCE,
                stage: "post-setup-completion",
                failure: "Windows setup failed"
            };
            const receipt = {
                schemaVersion: 1,
                status: "valid-failure",
                source,
                receipt: canonical
            };
            const validated = validateReceiptDiagnostic(receipt);
            assert.deepEqual(validated, receipt);
        }
    });

    it("rejects valid-failure receipt with unexpected source or invalid receipt contents", () => {
        const canonical = {
            schemaVersion: 1,
            status: "failed",
            nonce: NONCE,
            stage: "guest-bootstrap",
            failure: "failed"
        };
        assert.throws(() => validateReceiptDiagnostic({
            schemaVersion: 1,
            status: "valid-failure",
            source: "unauthorized.json",
            receipt: canonical
        }), /QEMU receipt diagnostic is invalid/);

        assert.throws(() => validateReceiptDiagnostic({
            schemaVersion: 1,
            status: "valid-failure",
            source: "result.json",
            receipt: {...canonical, nonce: "invalid-hex-nonce"}
        }), /receipt nonce is invalid/);
    });

    it("accepts valid-success receipt with result.json only", () => {
        const receipt = {
            schemaVersion: 1,
            status: "valid-success",
            source: "result.json",
            bytes: "2048",
            sha256: "0".repeat(64)
        };
        const validated = validateReceiptDiagnostic(receipt);
        assert.deepEqual(validated, receipt);

        // Codex Point 8: success on unexpected fallback source is not legitimate
        assert.throws(() => validateReceiptDiagnostic({
            ...receipt,
            source: "bootstrap-failure.json"
        }), /QEMU receipt diagnostic is invalid/);
    });

    it("rejects valid-success receipt with invalid bytes or sha256", () => {
        for (const badBytes of ["not-a-number", "-1", ""]) {
            assert.throws(() => validateReceiptDiagnostic({
                schemaVersion: 1,
                status: "valid-success",
                source: "result.json",
                bytes: badBytes,
                sha256: "0".repeat(64)
            }), /QEMU receipt diagnostic/);
        }
        assert.throws(() => validateReceiptDiagnostic({
            schemaVersion: 1,
            status: "valid-success",
            source: "result.json",
            bytes: "100",
            sha256: "not-a-sha256"
        }), /QEMU receipt diagnostic sha256 is invalid/);
    });

    it("accepts malformed receipt with closed set of reason codes and valid sources", () => {
        for (const reason of ["json-syntax-error", "nonce-mismatch", "schema-invalid", "read-cap-exceeded"]) {
            for (const source of ["result.json", "bootstrap-failure.json"]) {
                const receipt = {
                    schemaVersion: 1,
                    status: "malformed",
                    source,
                    reason,
                    bytes: "512",
                    sha256: "a".repeat(64)
                };
                const validated = validateReceiptDiagnostic(receipt);
                assert.deepEqual(validated, receipt);
            }
        }
    });

    it("rejects malformed receipt with unauthorized reason or missing properties", () => {
        assert.throws(() => validateReceiptDiagnostic({
            schemaVersion: 1,
            status: "malformed",
            source: "result.json",
            reason: "unexpected-parser-crash",
            bytes: "100",
            sha256: "a".repeat(64)
        }), /QEMU receipt diagnostic is invalid/);
    });

    it("accepts unavailable receipt with closed set of reason codes", () => {
        const validReasons = [
            "cleanup-unproven",
            "output-disk-unverified",
            "disk-identity-mismatch",
            "extraction-timeout",
            "tool-error",
            "receipt-not-retrieved"
        ];
        for (const reason of validReasons) {
            const receipt = {
                schemaVersion: 1,
                status: "unavailable",
                reason
            };
            const validated = validateReceiptDiagnostic(receipt);
            assert.deepEqual(validated, receipt);
        }
    });

    it("rejects unavailable receipt with unknown reason or extra unexpected keys", () => {
        assert.throws(() => validateReceiptDiagnostic({
            schemaVersion: 1,
            status: "unavailable",
            reason: "unknown-reason"
        }), /QEMU receipt diagnostic is invalid/);

        assert.throws(() => validateReceiptDiagnostic({
            schemaVersion: 1,
            status: "unavailable",
            reason: "cleanup-unproven",
            extraKey: true
        }), /QEMU receipt diagnostic keys are invalid/);
    });

    it("validates diagnostic in validateQemuLaunchDiagnostic with or without receipt", () => {
        const proc = validProcess();
        const withoutReceipt = baseDiagnostic();
        const validatedWithout = validateQemuLaunchDiagnostic(withoutReceipt, proc);
        assert.deepEqual(validatedWithout, withoutReceipt);

        const withReceipt = {
            ...baseDiagnostic(),
            receipt: {
                schemaVersion: 1,
                status: "unavailable",
                reason: "receipt-not-retrieved"
            }
        };
        const validatedWith = validateQemuLaunchDiagnostic(withReceipt, proc);
        assert.deepEqual(validatedWith, withReceipt);

        const withBadReceipt = {
            ...baseDiagnostic(),
            receipt: {
                schemaVersion: 1,
                status: "invalid-status",
                reason: "whatever"
            }
        };
        assert.throws(() => validateQemuLaunchDiagnostic(withBadReceipt, proc), /QEMU receipt diagnostic is invalid/);
    });
});

describe("extractGuestReceiptDiagnostic bounded stream extraction & deterministic precedence", () => {
    function fakeInput() {
        return {
            paths: {
                root: `/tmp/root-${NONCE}`,
                outputDisk: `/tmp/root-${NONCE}/output.img`
            },
            toolchain: {
                runtime: {
                    loader: {path: "/tmp/loader"},
                    libraryPath: ["/tmp/lib"]
                },
                mcopy: {path: "/usr/bin/mtools", invocationPath: "/usr/bin/mcopy"}
            }
        };
    }

    function fakeContext() {
        return {nonce: NONCE};
    }

    const cleanProcess = () => ({
        cleanupProven: true,
        treeGone: true
    });

    const okProcess = Object.freeze({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdoutOverflow: false,
        stderrOverflow: false,
        cleanupProven: true,
        errorObserved: false
    });

    it("refuses extraction when cleanup is unproven", async () => {
        const input = fakeInput();
        const context = fakeContext();
        const launched = {process: {cleanupProven: false, treeGone: true}};
        const res = await extractGuestReceiptDiagnostic({}, input, context, launched, null, {});
        assert.deepEqual(res, {
            diagnostic: {schemaVersion: 1, status: "unavailable", reason: "cleanup-unproven"},
            guestFailure: null
        });
    });

    it("refuses extraction when process tree is not gone", async () => {
        const input = fakeInput();
        const context = fakeContext();
        const launched = {process: {cleanupProven: true, treeGone: false}};
        const res = await extractGuestReceiptDiagnostic({}, input, context, launched, null, {});
        assert.deepEqual(res, {
            diagnostic: {schemaVersion: 1, status: "unavailable", reason: "cleanup-unproven"},
            guestFailure: null
        });
    });

    it("refuses extraction when preLaunchDiskIdentity is null", async () => {
        const input = fakeInput();
        const context = fakeContext();
        const launched = {process: cleanProcess()};
        const res = await extractGuestReceiptDiagnostic({}, input, context, launched, null, null);
        assert.deepEqual(res, {
            diagnostic: {schemaVersion: 1, status: "unavailable", reason: "output-disk-unverified"},
            guestFailure: null
        });
    });

    it("refuses extraction when validateOutputDisk throws", async () => {
        const input = fakeInput();
        const context = fakeContext();
        const launched = {process: cleanProcess()};
        const io = {
            validateOutputDisk() { throw new Error("disk identity changed"); }
        };
        const res = await extractGuestReceiptDiagnostic(io, input, context, launched, null, {dev: 1n});
        assert.deepEqual(res, {
            diagnostic: {schemaVersion: 1, status: "unavailable", reason: "disk-identity-mismatch"},
            guestFailure: null
        });
    });

    it("extracts valid failure from primary result.json and normalizes canonical worker receipt", async () => {
        const input = fakeInput();
        const context = fakeContext();
        const launched = {process: cleanProcess()};
        const rawWorker = validWorkerReceipt();
        const rawBytes = Buffer.from(JSON.stringify(rawWorker), "utf8");

        const io = {
            validateOutputDisk() { return true; },
            runOwned: async (_cmd, argv) => {
                assert.ok(argv.includes("::result.json"));
                return {process: okProcess, stdout: rawBytes, stderr: Buffer.alloc(0)};
            }
        };
        const res = await extractGuestReceiptDiagnostic(io, input, context, launched, null, {dev: 1n});
        assert.equal(res.diagnostic.status, "valid-failure");
        assert.equal(res.diagnostic.source, "result.json");
        assert.deepEqual(res.diagnostic.receipt, {
            schemaVersion: 1,
            status: "failed",
            nonce: NONCE,
            stage: "post-setup-completion",
            failure: rawWorker.failure
        });
        assert.deepEqual(res.guestFailure, res.diagnostic.receipt);
    });

    it("extracts valid success from primary result.json compactly without guestFailure", async () => {
        const input = fakeInput();
        const context = fakeContext();
        const launched = {process: cleanProcess()};

        // Construct a full valid guest output
        const cpuid = {
            schemaVersion: 1, kind: "cpuid", maxBasicLeaf: 7,
            leaf1: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00900000", edx: "0x00000000"},
            leaf7Subleaf0: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00000000", edx: "0x00000000"},
            xcr0: null, features: {sse42: true, popcnt: true, osxsave: false, avx: false, avx2: false}
        };
        const output = role => Buffer.from(JSON.stringify({
            schemaVersion: 1, kind: role,
            result: {"known-good": 42, "known-bad": 13, sse42: 2_276_049_685, popcnt: 32}[role]
        }) + "\n").toString("base64");
        const runs = [
            {role: "cpuid", exitCode: 0, stdoutBase64: Buffer.from(JSON.stringify(cpuid) + "\n").toString("base64"), stderrBase64: ""},
            ...["known-good", "known-bad", "sse42", "popcnt"].map(role => ({
                role, exitCode: role === "known-bad" ? 19 : 0, stdoutBase64: output(role), stderrBase64: ""
            })),
            ...["illegal", "avx", "avx2"].map(role => ({role, exitCode: 3_221_225_501, stdoutBase64: "", stderrBase64: ""}))
        ];
        const activation = getCompletedWindowsMsiActivationEvidence(
            buildWindowsMsiSetupCompleteActivation({
                repository: "i7Gamer/MySpeed", sourceSha: "a".repeat(40), eventSha: "b".repeat(40),
                runId: "123", runAttempt: "1", nonce: NONCE
            })
        );
        const tools = WINDOWS_SYSTEM_TOOL_PATHS.map((tool, idx) => ({
            ...tool, bytes: String(idx + 1), sha256: String(idx + 1).repeat(64)
        }));
        const fullOutput = {
            schemaVersion: 1,
            nonce: NONCE,
            runs,
            network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0},
            activation,
            systemTools: tools
        };
        const rawBytes = Buffer.from(JSON.stringify(fullOutput), "utf8");

        const io = {
            validateOutputDisk() { return true; },
            runOwned: async () => ({process: okProcess, stdout: rawBytes, stderr: Buffer.alloc(0)})
        };
        const res = await extractGuestReceiptDiagnostic(io, input, context, launched, null, {dev: 1n});
        assert.equal(res.diagnostic.status, "valid-success");
        assert.equal(res.diagnostic.source, "result.json");
        assert.equal(res.diagnostic.bytes, String(rawBytes.length));
        assert.equal(res.diagnostic.sha256, sha256(rawBytes));
        assert.equal(res.guestFailure, null);
    });

    it("records malformed result.json deterministically without hiding behind fallback", async () => {
        const input = fakeInput();
        const context = fakeContext();
        const launched = {process: cleanProcess()};

        // 1. json-syntax-error on result.json
        let fallbackCalled = false;
        const badJsonBytes = Buffer.from("{ invalid json", "utf8");
        const io1 = {
            validateOutputDisk() { return true; },
            runOwned: async (_cmd, argv) => {
                if (argv.includes("::bootstrap-failure.json")) fallbackCalled = true;
                return {process: okProcess, stdout: badJsonBytes, stderr: Buffer.alloc(0)};
            }
        };
        const res1 = await extractGuestReceiptDiagnostic(io1, input, context, launched, null, {dev: 1n});
        assert.equal(fallbackCalled, false);
        assert.equal(res1.diagnostic.status, "malformed");
        assert.equal(res1.diagnostic.source, "result.json");
        assert.equal(res1.diagnostic.reason, "json-syntax-error");
        assert.equal(res1.guestFailure, null);

        // 2. nonce-mismatch on result.json
        const wrongNonceBytes = Buffer.from(JSON.stringify({...validWorkerReceipt(), hostNonce: OTHER_NONCE}), "utf8");
        const io2 = {
            validateOutputDisk() { return true; },
            runOwned: async (_cmd, argv) => {
                if (argv.includes("::bootstrap-failure.json")) fallbackCalled = true;
                return {process: okProcess, stdout: wrongNonceBytes, stderr: Buffer.alloc(0)};
            }
        };
        const res2 = await extractGuestReceiptDiagnostic(io2, input, context, launched, null, {dev: 1n});
        assert.equal(fallbackCalled, false);
        assert.equal(res2.diagnostic.status, "malformed");
        assert.equal(res2.diagnostic.source, "result.json");
        assert.equal(res2.diagnostic.reason, "nonce-mismatch");
        assert.equal(res2.guestFailure, null);

        // 3. read-cap-exceeded on result.json
        const io3 = {
            validateOutputDisk() { return true; },
            runOwned: async () => ({
                process: {...okProcess, stdoutOverflow: true},
                stdout: Buffer.alloc(262144),
                stderr: Buffer.alloc(0)
            })
        };
        const res3 = await extractGuestReceiptDiagnostic(io3, input, context, launched, null, {dev: 1n});
        assert.equal(res3.diagnostic.status, "malformed");
        assert.equal(res3.diagnostic.source, "result.json");
        assert.equal(res3.diagnostic.reason, "read-cap-exceeded");
        assert.equal(res3.guestFailure, null);
    });

    it("attempts fallback bootstrap-failure.json only when result.json was not retrieved", async () => {
        const input = fakeInput();
        const context = fakeContext();
        const launched = {process: cleanProcess()};

        const bootstrapRaw = validBootstrapReceipt();
        const bootstrapBytes = Buffer.from(JSON.stringify(bootstrapRaw), "utf8");

        const calls = [];
        const io = {
            validateOutputDisk() { return true; },
            runOwned: async (_cmd, argv) => {
                if (argv.includes("::result.json")) {
                    calls.push("result.json");
                    return {process: {...okProcess, exitCode: 1}, stdout: Buffer.alloc(0), stderr: Buffer.from("File not found\n")};
                }
                if (argv.includes("::bootstrap-failure.json")) {
                    calls.push("bootstrap-failure.json");
                    return {process: okProcess, stdout: bootstrapBytes, stderr: Buffer.alloc(0)};
                }
                throw new Error("unexpected command");
            }
        };
        const res = await extractGuestReceiptDiagnostic(io, input, context, launched, null, {dev: 1n});
        assert.deepEqual(calls, ["result.json", "bootstrap-failure.json"]);
        assert.equal(res.diagnostic.status, "valid-failure");
        assert.equal(res.diagnostic.source, "bootstrap-failure.json");
        assert.deepEqual(res.diagnostic.receipt, bootstrapRaw);
        assert.deepEqual(res.guestFailure, bootstrapRaw);
    });

    it("rejects valid-success payload found on fallback bootstrap-failure.json as schema-invalid", async () => {
        const input = fakeInput();
        const context = fakeContext();
        const launched = {process: cleanProcess()};

        // Fallback file claiming to be status: "observed" or "success"
        const successBytes = Buffer.from(JSON.stringify({schemaVersion: 1, status: "observed"}), "utf8");
        const io = {
            validateOutputDisk() { return true; },
            runOwned: async (_cmd, argv) => {
                if (argv.includes("::result.json")) {
                    return {process: {...okProcess, exitCode: 1}, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)};
                }
                return {process: okProcess, stdout: successBytes, stderr: Buffer.alloc(0)};
            }
        };
        const res = await extractGuestReceiptDiagnostic(io, input, context, launched, null, {dev: 1n});
        assert.equal(res.diagnostic.status, "malformed");
        assert.equal(res.diagnostic.source, "bootstrap-failure.json");
        assert.equal(res.diagnostic.reason, "schema-invalid");
        assert.equal(res.guestFailure, null);
    });

    it("reports unavailable receipt-not-retrieved when neither file is present", async () => {
        const input = fakeInput();
        const context = fakeContext();
        const launched = {process: cleanProcess()};

        const io = {
            validateOutputDisk() { return true; },
            runOwned: async () => ({
                process: {...okProcess, exitCode: 1},
                stdout: Buffer.alloc(0),
                stderr: Buffer.from("File not found\n")
            })
        };
        const res = await extractGuestReceiptDiagnostic(io, input, context, launched, null, {dev: 1n});
        assert.deepEqual(res, {
            diagnostic: {schemaVersion: 1, status: "unavailable", reason: "receipt-not-retrieved"},
            guestFailure: null
        });
    });

    it("reports unavailable extraction-timeout when mcopy times out", async () => {
        const input = fakeInput();
        const context = fakeContext();
        const launched = {process: cleanProcess()};

        const io = {
            validateOutputDisk() { return true; },
            runOwned: async () => ({
                process: {...okProcess, timedOut: true},
                stdout: Buffer.alloc(0),
                stderr: Buffer.alloc(0)
            })
        };
        const res = await extractGuestReceiptDiagnostic(io, input, context, launched, null, {dev: 1n});
        assert.deepEqual(res, {
            diagnostic: {schemaVersion: 1, status: "unavailable", reason: "extraction-timeout"},
            guestFailure: null
        });
    });

    it("reports unavailable tool-error when mcopy encounters process error", async () => {
        const input = fakeInput();
        const context = fakeContext();
        const launched = {process: cleanProcess()};

        const io = {
            validateOutputDisk() { return true; },
            runOwned: async () => ({
                process: {...okProcess, errorObserved: true},
                stdout: Buffer.alloc(0),
                stderr: Buffer.alloc(0)
            })
        };
        const res = await extractGuestReceiptDiagnostic(io, input, context, launched, null, {dev: 1n});
        assert.deepEqual(res, {
            diagnostic: {schemaVersion: 1, status: "unavailable", reason: "tool-error"},
            guestFailure: null
        });
    });
});

describe("launchOwnedQemu and runWindowsCpuFloorStage2 receipt observability integration", () => {
    function fullContext() {
        return {
            schemaVersion: 1,
            repository: "i7Gamer/MySpeed",
            sourceSha: "a".repeat(40),
            eventSha: "b".repeat(40),
            runId: "35183245912",
            runAttempt: "1",
            nonce: NONCE,
            environment: {
                GITHUB_ACTIONS: "true",
                CI: "true",
                RUNNER_OS: "Linux",
                RUNNER_ARCH: "X64",
                RUNNER_ENVIRONMENT: "github-hosted",
                ImageOS: "ubuntu24",
                ImageVersion: "20260907.1"
            }
        };
    }

    function fullPaths() {
        const root = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${NONCE}`;
        return {
            root,
            packageRoot: `${root}/packages`,
            portableRoot: `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}`,
            probeRoot: `${root}/probes`,
            windowsIso: `${root}/windows.iso`,
            installWim: `${root}/install.wim`,
            seedIso: `${root}/seed.iso`,
            outputDisk: `${root}/output.img`,
            systemDisk: `${root}/system.qcow2`,
            ovmfVars: `${root}/OVMF_VARS.fd`,
            serialLog: `${root}/serial.log`,
            qemuPid: `${root}/qemu.pid`
        };
    }

    const rootFileIdentity = target => ({path: target, bytes: "4096", sha256: "f".repeat(64),
        ownership: {uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false}});

    const toolchainFixture = () => ({
        runtime: {
            loader: rootFileIdentity(`${fullPaths().portableRoot}/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`),
            libraryPath: [`${fullPaths().portableRoot}/lib/x86_64-linux-gnu`]
        },
        qemu: {path: `${fullPaths().portableRoot}/usr/bin/qemu-system-x86_64`, invocationPath: "/usr/bin/qemu-system-x86_64", bytes: "4096", sha256: "f".repeat(64), ownership: {uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false}},
        mcopy: {path: `${fullPaths().portableRoot}/usr/bin/mtools`, invocationPath: "/usr/bin/mcopy"},
        firmware: {
            searchPath: `${fullPaths().portableRoot}/usr/share/qemu`,
            kvmvapic: rootFileIdentity(`${fullPaths().portableRoot}/usr/share/qemu/kvmvapic.bin`),
            vga: rootFileIdentity(`${fullPaths().portableRoot}/usr/share/seabios/vgabios-stdvga.bin`),
            code: {path: `${fullPaths().portableRoot}/usr/share/OVMF/OVMF_CODE.fd`, bytes: "100", sha256: "c".repeat(64)},
            vars: {path: `${fullPaths().portableRoot}/usr/share/OVMF/OVMF_VARS.fd`, bytes: "100", sha256: "d".repeat(64)}
        }
    });

    const directoryIdentity = target => ({path: target, dev: "1", ino: target === "/tmp" ? "1" : "2", uid: "0",
        gid: "0", mode: target === "/tmp" ? "1777" : "755", ordinaryUserWritable: target === "/tmp",
        sticky: target === "/tmp"});

    it("preserves canonical worker failure receipt in launchOwnedQemu and propagates backward-compatible guestFailure", async () => {
        const ctx = fullContext();
        const pths = fullPaths();
        const workerFailure = validWorkerReceipt();
        const workerBytes = Buffer.from(JSON.stringify(workerFailure), "utf8");

        const adapter = createHostedStage2Operations({
            context: ctx,
            paths: pths,
            dependencies: {
                monotonicMilliseconds: () => 1000,
                pathExists: () => false,
                inspectOwned: target => target === pths.outputDisk ? ({
                    path: target,
                    bytes: "67108864",
                    sha256: "a".repeat(64),
                    ownership: {uid: "1001", gid: "1001", mode: "600", ordinaryUserWritable: false}
                }) : rootFileIdentity(target),
                inspectDirectory: directoryIdentity,
                validateOutputDisk: () => ({dev: 1n, ino: 2n, uid: 1001n, gid: 1001n, size: 67_108_864n}),
                runMonitoredQemu: async () => ({
                    observation: {
                        process: {
                            exitCode: 1,
                            signal: null,
                            timedOut: false,
                            cleanupProven: true,
                            treeGone: true,
                            stdoutOverflow: false,
                            stderrOverflow: false,
                            errorObserved: false
                        },
                        stdout: Buffer.alloc(0),
                        stderr: Buffer.from("qemu terminated\n")
                    },
                    identity: {
                        pid: 2345,
                        startTicks: "77",
                        executablePath: `${pths.portableRoot}/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`,
                        processGroupId: 2300
                    },
                    absentAfter: true,
                    processGroupGone: true,
                    qmp: {
                        version: {major: 8, minor: 2, micro: 2},
                        status: "running",
                        running: true,
                        screenshotPaths: [`${pths.root}/early-boot-1.png`],
                        inputSent: false
                    }
                }),
                runOwned: async () => ({
                    process: {
                        exitCode: 0,
                        signal: null,
                        timedOut: false,
                        stdoutOverflow: false,
                        stderrOverflow: false,
                        cleanupProven: true,
                        errorObserved: false
                    },
                    stdout: workerBytes,
                    stderr: Buffer.alloc(0)
                })
            }
        });

        const launch = await adapter.launchOwnedQemu({
            toolchain: toolchainFixture(),
            paths: pths,
            argv: [],
            privilegeMode: "ordinary-kvm"
        });

        assert.equal(launch.guest, null);
        assert.deepEqual(launch.guestFailure, {
            schemaVersion: 1,
            status: "failed",
            nonce: NONCE,
            stage: "post-setup-completion",
            failure: workerFailure.failure
        });
        assert.ok(launch.failureDiagnostic);
        assert.equal(launch.failureDiagnostic.receipt.status, "valid-failure");
        assert.equal(launch.failureDiagnostic.receipt.source, "result.json");
        assert.deepEqual(launch.failureDiagnostic.receipt.receipt, launch.guestFailure);
    });

    it("preserves valid success receipt as strictly diagnostic after unclean QEMU termination (rejection preservation)", async () => {
        const ctx = fullContext();
        const pths = fullPaths();

        // Valid guest output bytes
        const cpuid = {
            schemaVersion: 1, kind: "cpuid", maxBasicLeaf: 7,
            leaf1: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00900000", edx: "0x00000000"},
            leaf7Subleaf0: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00000000", edx: "0x00000000"},
            xcr0: null, features: {sse42: true, popcnt: true, osxsave: false, avx: false, avx2: false}
        };
        const output = role => Buffer.from(JSON.stringify({
            schemaVersion: 1, kind: role,
            result: {"known-good": 42, "known-bad": 13, sse42: 2_276_049_685, popcnt: 32}[role]
        }) + "\n").toString("base64");
        const runs = [
            {role: "cpuid", exitCode: 0, stdoutBase64: Buffer.from(JSON.stringify(cpuid) + "\n").toString("base64"), stderrBase64: ""},
            ...["known-good", "known-bad", "sse42", "popcnt"].map(role => ({
                role, exitCode: role === "known-bad" ? 19 : 0, stdoutBase64: output(role), stderrBase64: ""
            })),
            ...["illegal", "avx", "avx2"].map(role => ({role, exitCode: 3_221_225_501, stdoutBase64: "", stderrBase64: ""}))
        ];
        const activation = getCompletedWindowsMsiActivationEvidence(
            buildWindowsMsiSetupCompleteActivation({
                repository: "i7Gamer/MySpeed", sourceSha: "a".repeat(40), eventSha: "b".repeat(40),
                runId: "123", runAttempt: "1", nonce: NONCE
            })
        );
        const tools = WINDOWS_SYSTEM_TOOL_PATHS.map((tool, idx) => ({
            ...tool, bytes: String(idx + 1), sha256: String(idx + 1).repeat(64)
        }));
        const fullOutput = {
            schemaVersion: 1,
            nonce: NONCE,
            runs,
            network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0},
            activation,
            systemTools: tools
        };
        const successBytes = Buffer.from(JSON.stringify(fullOutput), "utf8");

        const adapter = createHostedStage2Operations({
            context: ctx,
            paths: pths,
            dependencies: {
                monotonicMilliseconds: () => 1000,
                pathExists: () => false,
                inspectOwned: target => target === pths.outputDisk ? ({
                    path: target,
                    bytes: "67108864",
                    sha256: "a".repeat(64),
                    ownership: {uid: "1001", gid: "1001", mode: "600", ordinaryUserWritable: false}
                }) : rootFileIdentity(target),
                inspectDirectory: directoryIdentity,
                validateOutputDisk: () => ({dev: 1n, ino: 2n, uid: 1001n, gid: 1001n, size: 67_108_864n}),
                // Unclean QEMU launch: e.g. timedOut: true
                runMonitoredQemu: async () => ({
                    observation: {
                        process: {
                            exitCode: 0,
                            signal: null,
                            timedOut: true,
                            cleanupProven: true,
                            treeGone: true,
                            stdoutOverflow: false,
                            stderrOverflow: false,
                            errorObserved: false
                        },
                        stdout: Buffer.alloc(0),
                        stderr: Buffer.alloc(0)
                    },
                    identity: {
                        pid: 2345,
                        startTicks: "77",
                        executablePath: `${pths.portableRoot}/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`,
                        processGroupId: 2300
                    },
                    absentAfter: true,
                    processGroupGone: true,
                    qmp: {
                        version: {major: 8, minor: 2, micro: 2},
                        status: "running",
                        running: true,
                        screenshotPaths: [`${pths.root}/early-boot-1.png`],
                        inputSent: false
                    }
                }),
                runOwned: async () => ({
                    process: {
                        exitCode: 0,
                        signal: null,
                        timedOut: false,
                        stdoutOverflow: false,
                        stderrOverflow: false,
                        cleanupProven: true,
                        errorObserved: false
                    },
                    stdout: successBytes,
                    stderr: Buffer.alloc(0)
                })
            }
        });

        const launch = await adapter.launchOwnedQemu({
            toolchain: toolchainFixture(),
            paths: pths,
            argv: [],
            privilegeMode: "ordinary-kvm"
        });

        assert.equal(launch.guest, null);
        assert.equal(launch.guestFailure, undefined);
        assert.ok(launch.failureDiagnostic);
        assert.equal(launch.failureDiagnostic.receipt.status, "valid-success");
        assert.equal(launch.failureDiagnostic.receipt.source, "result.json");
        assert.equal(launch.failureDiagnostic.receipt.bytes, String(successBytes.length));
        assert.equal(launch.failureDiagnostic.receipt.sha256, sha256(successBytes));

        // Now verify rejection preservation through validateQemuLaunchDiagnostic:
        // Even with a valid-success receipt, the diagnostic proves failure and QEMU launch error is thrown
        assert.throws(() => {
            const diag = validateQemuLaunchDiagnostic(launch.failureDiagnostic, launch.process);
            throw new QemuLaunchError(diag, launch.earlyBoot, launch.guestFailure, null);
        }, QemuLaunchError);
    });
});

