import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {runHostedStage3Controller, STAGE3_CONTROLLER_CONSTANTS} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage3-controller.mjs";

const NONCE = "2".repeat(32);
const SOURCE_SHA = "1".repeat(40);
const SHA = character => character.repeat(64);
const CONTEXT = {schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: SOURCE_SHA,
    eventSha: "3".repeat(40), runId: "123", runAttempt: "1", nonce: NONCE, environment: {
        GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
        RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260901.1"}};

function envelope() {
    const root = `/home/runner/work/_temp/myspeed-stage3-closure-${NONCE}`;
    return {schemaVersion: 1, kind: "myspeed-windows-cpu-floor-stage3-controller-request", context: CONTEXT,
        closure: {root, files: STAGE3_CONTROLLER_CONSTANTS.CLOSURE_PATHS.map((name, index) => ({
            path: `${root}/${name}`, bytes: "4096", sha256: SHA(String((index % 9) + 1))}))},
        guestFiles: [{name: "node.exe"}],
        stage3: {context: CONTEXT, paths: {root: "/tmp/stage3"}, stage2: {result: {
            path: `/home/runner/work/_temp/myspeed-stage2-transport-${NONCE}/stage2-result.json`,
            bytes: "8192", sha256: SHA("a")}}}};
}

describe("hosted Windows CPU-floor Stage 3 controller", () => {
    it("derives actual context before closure reads and replays the final consumer on observed output", async () => {
        const calls = []; const value = envelope(); const stage2Bytes = Buffer.alloc(8192, 1);
        value.stage3.stage2.result.sha256 = (await import("node:crypto")).createHash("sha256")
            .update(stage2Bytes).digest("hex");
        const result = {status: "observed"};
        const observed = await runHostedStage3Controller(value, {
            deriveActualContext: nonce => { calls.push(["context", nonce]); return CONTEXT; },
            readVerified: target => { calls.push(["read", target]);
                if (target === value.stage3.stage2.result.path) return {bytes: stage2Bytes,
                    sha256: value.stage3.stage2.result.sha256};
                const member = value.closure.files.find(file => file.path === target);
                return {bytes: Buffer.alloc(Number(member.bytes)), sha256: member.sha256}; },
            createOperations: input => { calls.push(["operations", input]); return {actual: true}; },
            runStage3: async (request, operations) => { calls.push(["run", request, operations]); return result; },
            validateCompleted: (output, request, bytes) => { calls.push(["validate", output, request, bytes]);
                return {accepted: true}; }
        });
        assert.equal(observed, result);
        assert.equal(calls[0][0], "context");
        assert.equal(STAGE3_CONTROLLER_CONSTANTS.CLOSURE_PATHS.length, 13);
        assert.equal(calls.filter(call => call[0] === "read").length,
            STAGE3_CONTROLLER_CONSTANTS.CLOSURE_PATHS.length + 1);
        assert.equal(calls.at(-1)[0], "validate");
        assert.equal(calls.at(-1)[3], stage2Bytes);
    });

    it("rejects copied context and altered closure bytes before operations construction", async () => {
        for (const change of [
            value => { value.context = {...value.context, runAttempt: "2"}; },
            value => { value.closure.files[0].sha256 = SHA("f"); }
        ]) {
            const value = envelope(); change(value); let created = false;
            await assert.rejects(runHostedStage3Controller(value, {deriveActualContext: () => CONTEXT,
                readVerified: target => { const member = value.closure.files.find(file => file.path === target);
                    return {bytes: Buffer.alloc(Number(member.bytes)), sha256: SHA("1")}; },
                createOperations: () => { created = true; return {}; }}), /context|content/u);
            assert.equal(created, false);
        }
    });

    it("does not report an observed result without independent retained Stage 2 replay", async () => {
        const value = envelope();
        await assert.rejects(runHostedStage3Controller(value, {deriveActualContext: () => CONTEXT,
            readVerified: target => { const member = value.closure.files.find(file => file.path === target);
                if (member) return {bytes: Buffer.alloc(Number(member.bytes)), sha256: member.sha256};
                return {bytes: Buffer.alloc(1), sha256: SHA("a")}; }, operations: {},
            runStage3: async () => ({status: "observed"})}), /retained Stage 2 result/u);
    });
});
