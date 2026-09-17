import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import {spawnSync} from "node:child_process";
import {describe, it} from "node:test";

import {parseGuestFailure} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";
import {buildWindowsMsiSetupCompleteActivation}
    from "../../scripts/qualification/windows-msi-post-setup-activation.mjs";

/*
 * Both guest failure writers truncate to a number of CHARACTERS and then UTF-8 encode the JSON, and
 * the host parser caps the same field in UTF-16 code units. A character cap is therefore not a byte
 * cap, and the byte length of a retained receipt diagnostic says nothing about which dialect the
 * guest wrote. These fixtures measure that gap instead of assuming it: one from the real generated
 * PowerShell writer, the rest inert. Nothing here executes guest code or touches a VM.
 */

const NONCE = "3f9a1c7d5e2b48a6b0c4d8e2f6a1b3c5";
/* The length of the receipt retained by run 35198002285, used only as a reference point. */
const OBSERVED_RECEIPT_BYTES = 2809;
const WORKER_FAILURE_CHARACTERS = 256;
const PARSER_FAILURE_CHARACTERS = 512;

const FIXTURE = path.join(url.fileURLToPath(new URL("../fixtures/", import.meta.url)),
    "windows-msi-post-setup-worker", "oversized-message-result.json");
const FIXTURE_SHA256 = "5c514573b1e8169df3708b163930ec3020413e8286981ec3339bcfe39ad990cf";
const FIXTURE_BYTES = 401;

/* A plausible localized Windows failure text, repeated past the writer's own character cap. */
const BASE = "Der Vorgang konnte nicht abgeschlossen werden: Zugriff verweigert f\u00fcr " +
    "Datentr\u00e4ger \u201eMYSPEEDOUT\u201c \u2014 ";

function longMessage(characters) {
    let message = "";
    while (message.length < characters) message += BASE;
    return message.slice(0, characters);
}

function failureReceipt(failure) {
    return Buffer.from(`{"schemaVersion":1,"status":"failed","hostNonce":"${NONCE}",` +
        `"stage":"post-setup-completion","failure":"${failure}"}`, "utf8");
}

/* Everything the worker dialect costs apart from the message itself. */
const ENVELOPE_BYTES = failureReceipt("").length;

describe("Guest failure receipt serialization bounds", () => {
    it("retains the real writer's non-ASCII record, whose bytes exceed its character cap", () => {
        const bytes = fs.readFileSync(FIXTURE);
        assert.equal(bytes.length, FIXTURE_BYTES);
        assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), FIXTURE_SHA256);

        const parsed = parseGuestFailure(bytes, NONCE);
        assert.equal(parsed.stage, "post-setup-completion");
        assert.equal(parsed.failure.length, WORKER_FAILURE_CHARACTERS);
        assert.equal(parsed.failure, longMessage(PARSER_FAILURE_CHARACTERS).slice(0, WORKER_FAILURE_CHARACTERS));
        assert.ok(bytes.length > ENVELOPE_BYTES + parsed.failure.length,
            `${bytes.length} bytes must exceed the ${ENVELOPE_BYTES}-byte envelope plus ` +
            `${parsed.failure.length} characters`);
    });

    it("executes the real generated worker writer and reproduces the retained fixture", async t => {
        const powerShell = process.platform === "win32"
            ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0",
                "powershell.exe")
            : null;
        if (powerShell === null || !fs.existsSync(powerShell)) {
            t.skip("the generated worker is Windows PowerShell; the fixture it wrote is asserted above");
            return;
        }
        const writer = path.join(url.fileURLToPath(new URL("../fixtures/", import.meta.url)),
            "windows-msi-post-setup-worker", "write-worker-receipt.ps1");
        const activation = buildWindowsMsiSetupCompleteActivation({
            repository: "i7Gamer/MySpeed", sourceSha: "a".repeat(40), eventSha: "b".repeat(40),
            runId: "123", runAttempt: "1", nonce: NONCE
        });
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-failure-bounds-"));
        try {
            const dispatcher = path.join(directory, "myspeed-msi-setupcomplete.ps1");
            fs.writeFileSync(dispatcher, Buffer.from(activation.files.dispatcher.bytesBase64, "base64"));
            const output = path.join(directory, "output");
            fs.mkdirSync(output);
            /* The message travels through a UTF-8 file so no console code page can alter it. */
            const messageFile = path.join(directory, "message.txt");
            fs.writeFileSync(messageFile, Buffer.from(longMessage(PARSER_FAILURE_CHARACTERS), "utf8"));
            const runner = path.join(directory, "run.ps1");
            fs.writeFileSync(runner, Buffer.from("$ErrorActionPreference='Stop'\r\n" +
                "$text=[IO.File]::ReadAllText($args[3],[Text.UTF8Encoding]::new($false))\r\n" +
                "& $args[0] $args[1] $args[2] $text\r\n", "utf8"));
            const run = spawnSync(powerShell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy",
                "Bypass", "-File", runner, writer, dispatcher, output, messageFile], {encoding: "utf8"});
            assert.equal(run.status, 0, `worker writer failed: ${run.stderr}`);
            assert.deepEqual(fs.readFileSync(path.join(output, "result.json")), fs.readFileSync(FIXTURE));
        } finally {
            fs.rmSync(directory, {recursive: true, force: true});
        }
    });

    it("accepts a failure receipt far larger than the observed record", () => {
        const escaped = failureReceipt("\\u00e4".repeat(PARSER_FAILURE_CHARACTERS));
        assert.ok(escaped.length > OBSERVED_RECEIPT_BYTES,
            `escaped form is ${escaped.length} bytes, which must exceed ${OBSERVED_RECEIPT_BYTES}`);
        const parsed = parseGuestFailure(escaped, NONCE);
        assert.equal(parsed.failure.length, PARSER_FAILURE_CHARACTERS);

        const raw = failureReceipt("\u4e2d".repeat(PARSER_FAILURE_CHARACTERS));
        assert.equal(parseGuestFailure(raw, NONCE).failure.length, PARSER_FAILURE_CHARACTERS);
        assert.ok(raw.length > PARSER_FAILURE_CHARACTERS * 2);
    });

    it("places no byte ceiling at all on a failure receipt the parser rejects", () => {
        const rejected = failureReceipt("x".repeat(PARSER_FAILURE_CHARACTERS + 1));
        assert.throws(() => parseGuestFailure(rejected, NONCE), /guest failure evidence is invalid/u);

        const observedLength = failureReceipt("x".repeat(OBSERVED_RECEIPT_BYTES - ENVELOPE_BYTES));
        assert.equal(observedLength.length, OBSERVED_RECEIPT_BYTES);
        assert.throws(() => parseGuestFailure(observedLength, NONCE), /guest failure evidence is invalid/u);
    });
});
