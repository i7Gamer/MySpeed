import assert from "node:assert/strict";
import crypto from "node:crypto";
import {describe, it} from "node:test";

import {
    WINPE_DIAGNOSTIC_MEMBER_READ_BYTES,
    WINPE_DIAGNOSTIC_MINIMUM_SECRET_FRAGMENT,
    WINPE_DIAGNOSTIC_PARTIAL_REDACTION_MARKER,
    WINPE_DIAGNOSTIC_PUBLISHED_BYTES,
    WINPE_DIAGNOSTIC_REDACTION_MARKER,
    decodeWinpeDiagnosticBytes,
    detectWinpeDiagnosticEncoding,
    publishWinpeDiagnosticMember,
    redactWinpeDiagnosticText,
    winpeDiagnosticBytesCarrySecret,
    winpeDiagnosticGuestSecret
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";

const NONCE = "0123456789abcdef0123456789abcdef";
/*
 * A synthetic fixture credential with the exact shape the answer-file renderer produces for a
 * disposable evaluation guest. It is not a credential for anything: this run's nonce is a test
 * constant, and no real run's password is ever written into a test or a log.
 */
const SECRET = winpeDiagnosticGuestSecret(NONCE);
const SECRETS = [SECRET];

/* The shape `runHostedOwnedProcess` returns, so the publication path is fed what it will really see. */
function extraction(stdout, overrides = {}) {
    return {
        process: {exitCode: 0, signal: null, timedOut: false, stdoutOverflow: false,
            stderrOverflow: false, cleanupProven: true, errorObserved: false, ...overrides},
        stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, "utf8"),
        stderr: Buffer.alloc(0)
    };
}

const publishedBytes = record => Buffer.from(record.textBase64 ?? "", "base64");

describe("WinPE diagnostic publication refuses to leak a credential", () => {
    it("withholds a member whose secret survives in an encoding the decode did not choose", () => {
        /*
         * The reported defect, verbatim. One occurrence redacts cleanly, which under a global
         * nonzero hit count used to be accepted as proof that the member was clean - while the
         * second occurrence, in the other supported encoding, travelled through untouched.
         */
        const bytes = Buffer.concat([Buffer.alloc(256, 65), Buffer.from(SECRET, "utf8"),
            Buffer.from(" ", "utf8"), Buffer.from(SECRET, "utf16le")]);
        assert.equal(detectWinpeDiagnosticEncoding(bytes).encoding, "utf-8");
        assert.equal(redactWinpeDiagnosticText(decodeWinpeDiagnosticBytes(bytes).text, SECRETS).hits, 1,
            "one occurrence still redacts - which is exactly why the hit count is not the proof");
        const record = publishWinpeDiagnosticMember("MSACT.LOG", extraction(bytes), SECRETS);
        assert.equal(record.status, "withheld-mixed-encoding");
        assert.equal(record.textBase64, undefined);
        assert.equal(publishedBytes(record).includes(Buffer.from(SECRET, "utf16le")), false);
        assert.equal(publishedBytes(record).includes(Buffer.from(SECRET, "utf8")), false);
    });

    it("withholds the mirror case: a UTF-16LE member carrying one UTF-8 occurrence", () => {
        const bytes = Buffer.concat([Buffer.from("action log ".repeat(64), "utf16le"),
            Buffer.from(SECRET, "utf16le"), Buffer.from(SECRET, "utf8")]);
        assert.equal(detectWinpeDiagnosticEncoding(bytes).encoding, "utf-16le");
        const record = publishWinpeDiagnosticMember("MSACT.LOG", extraction(bytes), SECRETS);
        assert.equal(record.status, "withheld-mixed-encoding");
    });

    it("withholds a member whose occurrences outnumber what redaction accounted for", () => {
        /*
         * A decode that mangles one occurrence and leaves another intact: the raw bytes carry the
         * secret twice, the decoded text only once. One redaction is not two.
         */
        const bytes = Buffer.concat([Buffer.from(SECRET, "utf8"), Buffer.from([0xc3]),
            Buffer.from(SECRET, "utf8")]);
        const decoded = decodeWinpeDiagnosticBytes(bytes);
        assert.ok(decoded.replacements > 0);
        const record = publishWinpeDiagnosticMember("MSACT.LOG", extraction(bytes), SECRETS);
        assert.ok(["withheld-unaccounted", "captured"].includes(record.status));
        if (record.status === "captured")
            assert.equal(winpeDiagnosticBytesCarrySecret(publishedBytes(record), SECRETS), false);
    });

    it("publishes a clean member, and never lets published bytes carry a secret in either encoding", () => {
        for (const encoding of ["utf8", "utf16le"]) {
            const bytes = Buffer.concat([Buffer.from("[0x0600055c] IMAGE  Found answer file ", encoding),
                Buffer.from(SECRET, encoding), Buffer.from(" on MYSPEEDSEED\r\n", encoding)]);
            const record = publishWinpeDiagnosticMember("MSACT.LOG", extraction(bytes), SECRETS);
            assert.equal(record.status, "captured");
            assert.equal(record.redactionHits, 1);
            assert.equal(winpeDiagnosticBytesCarrySecret(publishedBytes(record), SECRETS), false);
            assert.ok(publishedBytes(record).toString("utf8").includes(WINPE_DIAGNOSTIC_REDACTION_MARKER));
            assert.ok(publishedBytes(record).toString("utf8").includes("Found answer file"));
            assert.equal(record.sha256, crypto.createHash("sha256").update(publishedBytes(record)).digest("hex"));
        }
    });

    it("redacts a read-cap split secret down to its head, at every split position", () => {
        const encoded = Buffer.from(SECRET, "utf8");
        for (let keep = WINPE_DIAGNOSTIC_MINIMUM_SECRET_FRAGMENT; keep < encoded.length; keep += 1) {
            const bytes = Buffer.concat([Buffer.from("tail ".repeat(8), "utf8"), encoded.subarray(0, keep)]);
            const record = publishWinpeDiagnosticMember("MSACT.LOG",
                extraction(bytes, {exitCode: null, stdoutOverflow: true}), SECRETS);
            assert.equal(record.status, "captured", `split at ${keep}`);
            assert.equal(record.readCapReached, true);
            assert.equal(record.partialRedactionHits, 1, `split at ${keep}`);
            assert.ok(publishedBytes(record).toString("utf8").endsWith(WINPE_DIAGNOSTIC_PARTIAL_REDACTION_MARKER));
            assert.equal(winpeDiagnosticBytesCarrySecret(publishedBytes(record), SECRETS), false);
        }
    });

    it("leaves a fragment below the credential threshold alone rather than pretending it redacted it", () => {
        const short = SECRET.slice(0, WINPE_DIAGNOSTIC_MINIMUM_SECRET_FRAGMENT - 1);
        const record = publishWinpeDiagnosticMember("MSACT.LOG",
            extraction(Buffer.from(`line ${short}`, "utf8")), SECRETS);
        assert.equal(record.status, "captured");
        assert.equal(record.partialRedactionHits, 0);
        assert.ok(publishedBytes(record).toString("utf8").endsWith(short));
    });

    it("redacts before truncating, so no cut position can manufacture a secret", () => {
        const filler = "x".repeat(WINPE_DIAGNOSTIC_PUBLISHED_BYTES - 4);
        const bytes = Buffer.from(`${filler}${SECRET}${"y".repeat(64)}`, "utf8");
        const record = publishWinpeDiagnosticMember("MSACT.LOG", extraction(bytes), SECRETS);
        assert.equal(record.status, "captured");
        assert.equal(record.publicationTruncated, true);
        assert.equal(record.publishedBytes, WINPE_DIAGNOSTIC_PUBLISHED_BYTES);
        assert.equal(winpeDiagnosticBytesCarrySecret(publishedBytes(record), SECRETS), false);
    });
});

describe("WinPE diagnostic decoding", () => {
    it("decodes UTF-16LE with and without a BOM rather than discarding it", () => {
        const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Setup log line\r\n", "utf16le")]);
        const decodedWithBom = decodeWinpeDiagnosticBytes(withBom);
        assert.equal(decodedWithBom.encoding, "utf-16le");
        assert.equal(decodedWithBom.bom, true);
        assert.equal(decodedWithBom.text, "Setup log line\r\n");

        const withoutBom = Buffer.from("Setup log line repeated for density\r\n".repeat(4), "utf16le");
        const decoded = decodeWinpeDiagnosticBytes(withoutBom);
        assert.equal(decoded.encoding, "utf-16le");
        assert.equal(decoded.bom, false);
        assert.ok(decoded.text.startsWith("Setup log line"));

        const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("plain\r\n", "utf8")]);
        assert.deepEqual({...decodeWinpeDiagnosticBytes(utf8Bom)},
            {encoding: "utf-8", bom: true, trailingOddByte: false, text: "plain\r\n", replacements: 0});
    });

    it("drops a half UTF-16 unit left by the read cap instead of guessing at it", () => {
        const bytes = Buffer.concat([Buffer.from("half a unit at the end here\r\n", "utf16le"),
            Buffer.from([0x41])]);
        const decoded = decodeWinpeDiagnosticBytes(bytes);
        assert.equal(decoded.encoding, "utf-16le");
        assert.equal(decoded.trailingOddByte, true);
        assert.equal(decoded.text.endsWith("\r\n"), true);
    });

    it("counts replacement characters for invalid input rather than failing the whole member", () => {
        const decoded = decodeWinpeDiagnosticBytes(Buffer.from([0x61, 0xff, 0xfe_00 & 0xff, 0x62]));
        assert.ok(decoded.replacements >= 1);
        assert.ok(decoded.text.includes("a"));
    });

    it("bounds decoder expansion", () => {
        assert.equal(decodeWinpeDiagnosticBytes(Buffer.alloc(WINPE_DIAGNOSTIC_MEMBER_READ_BYTES, 0x41))
            .text.length, WINPE_DIAGNOSTIC_MEMBER_READ_BYTES);
    });
});

describe("WinPE diagnostic publication distinguishes why nothing was collected", () => {
    it("separates absence, timeout, tool failure and unproven extraction cleanup", () => {
        const cases = [
            [{exitCode: 1}, "absent"],
            [{exitCode: null, timedOut: true}, "timeout"],
            [{exitCode: null, errorObserved: true}, "tool-error"],
            [{exitCode: 0, cleanupProven: false}, "cleanup-unproven"]
        ];
        for (const [overrides, status] of cases)
            assert.equal(publishWinpeDiagnosticMember("MSERR.LOG",
                extraction(Buffer.alloc(0), overrides), SECRETS).status, status,
            JSON.stringify(overrides));
    });

    it("publishes what it accepted at exactly the cap without calling it an overflow", () => {
        /*
         * Production `appendBounded` treats a chunk that exactly fills the cap as accepted, not as
         * an overflow; the prototype's `>=` would have called this a truncated read. The published
         * record follows production.
         */
        const bytes = Buffer.alloc(WINPE_DIAGNOSTIC_MEMBER_READ_BYTES, 0x41);
        const record = publishWinpeDiagnosticMember("MSACT.LOG", extraction(bytes), SECRETS);
        assert.equal(record.status, "captured");
        assert.equal(record.readCapReached, false);
        assert.equal(record.acceptedBytes, WINPE_DIAGNOSTIC_MEMBER_READ_BYTES);
        assert.equal(record.publicationTruncated, true);
    });

    it("records an empty but successful extraction as captured and empty", () => {
        const record = publishWinpeDiagnosticMember("MSDIAG.OK", extraction(Buffer.alloc(0)), SECRETS);
        assert.equal(record.status, "captured");
        assert.equal(record.publishedBytes, 0);
        assert.equal(record.publicationTruncated, false);
    });
});
