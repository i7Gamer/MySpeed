import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";

import {
    parseStage3SequenceArguments,
    runHostedStage3Sequence,
    STAGE3_SEQUENCE_CONSTANTS
} from "../../scripts/qualification/linux-windows-cpu-floor-stage3-sequence.mjs";

const SOURCE_SHA = "a".repeat(40);
const EVENT_SHA = "b".repeat(40);
const NONCE = "c".repeat(32);
const CONTEXT = Object.freeze({schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: SOURCE_SHA,
    eventSha: EVENT_SHA, runId: "123", runAttempt: "2", nonce: NONCE, environment: {GITHUB_ACTIONS: "true",
        CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64", RUNNER_ENVIRONMENT: "github-hosted",
        ImageOS: "ubuntu24", ImageVersion: "20260901.1"}});
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture(root) {
    const stage2Root = path.join(root, `myspeed-windows-cpu-floor-${NONCE}`);
    const transportRoot = path.join(root, `myspeed-stage2-transport-${NONCE}`);
    const closureRoot = path.join(root, `myspeed-stage3-closure-${NONCE}`);
    fs.mkdirSync(stage2Root);
    fs.mkdirSync(transportRoot);
    fs.mkdirSync(closureRoot);

    const rawGuest = Buffer.from('{"schemaVersion":1,"nonce":"' + NONCE + '"}\n');
    fs.writeFileSync(path.join(stage2Root, "guest-result.json"), rawGuest, {flag: "wx"});

    const closureFiles = STAGE3_SEQUENCE_CONSTANTS.SEQUENCE_CLOSURE_PATHS.map((relPath, index) => {
        const fullPath = path.join(closureRoot, relPath);
        fs.mkdirSync(path.dirname(fullPath), {recursive: true});
        const content = Buffer.from(`// closure member ${index}\nexport const index = ${index};\n`);
        fs.writeFileSync(fullPath, content);
        return {path: fullPath, bytes: String(content.length), sha256: sha256(content)};
    });

    return {schemaVersion: 1, kind: "myspeed-windows-cpu-floor-stage3-sequence", context: CONTEXT,
        transportRoot, stage2Request: {context: CONTEXT, paths: {root: stage2Root}},
        stage3: {schemaVersion: 1, profile: "baseline-cpu", context: CONTEXT, authorization: {}, candidate: {},
            paths: {}},
        closure: {root: closureRoot, files: closureFiles},
        guestFiles: []};
}

describe("hosted Windows CPU-floor Stage2 to Stage3 sequence", () => {
    it("accepts only the fixed hosted request and result transport vector", () => {
        const root = `/home/runner/work/_temp/myspeed-stage3-sequence-envelope-${NONCE}`;
        const argv = ["--nonce", NONCE, "--request", `${root}/request.json`, "--request-sha256", "d".repeat(64),
            "--result", `${root}/result.json`];
        assert.deepEqual(parseStage3SequenceArguments(argv), {nonce: NONCE, request: `${root}/request.json`,
            requestSha256: "d".repeat(64), result: `${root}/result.json`});
        for (const mutate of [value => value.pop(), value => { value[0] = "--other"; },
            value => { value[3] = "/tmp/copied.json"; }, value => { value[5] = `${"d".repeat(64)}\n`; }]) {
            const changed = [...argv]; mutate(changed); assert.throws(() => parseStage3SequenceArguments(changed));
        }
    });

    it("requires the complete 14-member outer sequence closure", () => {
        assert.equal(STAGE3_SEQUENCE_CONSTANTS.SEQUENCE_CLOSURE_PATHS.length, 14);
        assert.ok(STAGE3_SEQUENCE_CONSTANTS.SEQUENCE_CLOSURE_PATHS.includes(
            "scripts/qualification/linux-windows-cpu-floor-stage3-sequence.mjs"));
        assert.ok(STAGE3_SEQUENCE_CONSTANTS.SEQUENCE_CLOSURE_PATHS.includes(
            "scripts/qualification/linux-windows-cpu-floor-stage3-controller.mjs"));
        assert.ok(STAGE3_SEQUENCE_CONSTANTS.SEQUENCE_CLOSURE_PATHS.includes(
            "scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs"));
        assert.ok(STAGE3_SEQUENCE_CONSTANTS.SEQUENCE_CLOSURE_PATHS.includes(
            "scripts/qualification/windows-msi-post-setup-activation.mjs"));
        assert.ok(STAGE3_SEQUENCE_CONSTANTS.SEQUENCE_CLOSURE_PATHS.includes(
            "scripts/qualification/safety.mjs"));
    });

    it("retains exact Stage2 and raw guest bytes before invoking Stage3", async () => {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-stage3-sequence-")));
        try {
            const request = fixture(root); const events = []; let observedEnvelope;
            const stage2 = {schemaVersion: 1, status: "observed", cleanupProven: true,
                cpuCalibrationAccepted: true};
            const stage3 = {schemaVersion: 1, status: "observed"};
            const result = await runHostedStage3Sequence(request, {
                deriveActualContext: () => CONTEXT,
                runStage2: async value => { events.push("stage2"); assert.deepEqual(value, request.stage2Request);
                    return stage2; },
                runStage3: async value => { events.push("stage3"); observedEnvelope = value; return stage3; }
            });
            assert.deepEqual(events, ["stage2", "stage3"]);
            assert.equal(result, stage3);
            const stage2Bytes = fs.readFileSync(path.join(request.transportRoot, "stage2-result.json"));
            const guestBytes = fs.readFileSync(path.join(request.transportRoot, "guest-result.json"));
            assert.deepEqual(JSON.parse(stage2Bytes), stage2);
            assert.equal(observedEnvelope.stage3.stage2.result.sha256, sha256(stage2Bytes));
            assert.equal(observedEnvelope.stage3.stage2.guestResult.sha256, sha256(guestBytes));
            assert.deepEqual(observedEnvelope.context, CONTEXT);
            assert.equal(observedEnvelope.kind, "myspeed-windows-cpu-floor-stage3-controller-request");
            // Stage 3 controller receives its 13-member closure
            assert.equal(observedEnvelope.closure.files.length, 13);
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("fails closed before any operation when outer sequence closure member is removed or altered", async () => {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-stage3-closure-inert-")));
        try {
            // Test 1: Tampered file content in closure
            const root1 = fs.realpathSync.native(fs.mkdtempSync(path.join(root, "t1-")));
            const req1 = fixture(root1);
            const targetFile = req1.closure.files[0].path;
            fs.appendFileSync(targetFile, "// tampered\n");
            let stage2Called = false;
            await assert.rejects(runHostedStage3Sequence(req1, {
                deriveActualContext: () => CONTEXT,
                runStage2: async () => { stage2Called = true; }
            }), /closure/i);
            assert.equal(stage2Called, false, "Stage 2 must not be called when closure file is tampered");

            // Test 2: Missing closure member
            const root2 = fs.realpathSync.native(fs.mkdtempSync(path.join(root, "t2-")));
            const req2 = fixture(root2);
            req2.closure.files = req2.closure.files.slice(1);
            let stage2Called2 = false;
            await assert.rejects(runHostedStage3Sequence(req2, {
                deriveActualContext: () => CONTEXT,
                runStage2: async () => { stage2Called2 = true; }
            }), /closure/i);
            assert.equal(stage2Called2, false, "Stage 2 must not be called when closure member is missing");

            // Test 3: Outer sequence runner file itself omitted
            const root3 = fs.realpathSync.native(fs.mkdtempSync(path.join(root, "t3-")));
            const req3 = fixture(root3);
            req3.closure.files = req3.closure.files.filter(f =>
                !f.path.replace(/\\/g, "/").endsWith("linux-windows-cpu-floor-stage3-sequence.mjs"));
            let stage2Called3 = false;
            await assert.rejects(runHostedStage3Sequence(req3, {
                deriveActualContext: () => CONTEXT,
                runStage2: async () => { stage2Called3 = true; }
            }), /closure/i);
            assert.equal(stage2Called3, false, "Stage 2 must not be called when sequence module itself is omitted");
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("does not invoke Stage3 for rejected Stage2, copied context, stale transport, or missing raw guest", async () => {
        for (const mutate of [
            ({dependencies}) => { dependencies.runStage2 = async () => ({status: "rejected"}); },
            ({request}) => { request.context = {...CONTEXT, sourceSha: "d".repeat(40)}; },
            ({request}) => { fs.writeFileSync(path.join(request.transportRoot, "stage2-result.json"), "stale"); },
            ({request}) => { fs.unlinkSync(path.join(request.stage2Request.paths.root, "guest-result.json")); }
        ]) {
            const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-stage3-sequence-bad-")));
            try {
                const request = fixture(root); let stage3Called = false;
                const dependencies = {deriveActualContext: () => CONTEXT,
                    runStage2: async () => ({schemaVersion: 1, status: "observed", cleanupProven: true,
                        cpuCalibrationAccepted: true}), runStage3: async () => { stage3Called = true; }};
                mutate({request, dependencies});
                await assert.rejects(runHostedStage3Sequence(request, dependencies));
                assert.equal(stage3Called, false);
            } finally { fs.rmSync(root, {recursive: true, force: true}); }
        }
    });
});
