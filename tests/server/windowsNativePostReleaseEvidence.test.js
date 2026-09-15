import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";

import {buildWindowsNativePostReleaseEvidenceInventory, runWindowsNativePostReleaseEvidenceCli} from
    "../../scripts/release/windows-native-post-release-evidence.mjs";
import {createWindowsNativeStandaloneEvidenceFixture} from
    "../helpers/windows-native-standalone-evidence-fixture.mjs";

const OVERSIZED_PROOF_REQUEST_BYTES = 2_097_153;

describe("Windows native post-release evidence inventory", () => {
    it("derives only the fixed proof and scenario leaves from the validated hash-bound request", async () => {
        const fixture = await createWindowsNativeStandaloneEvidenceFixture();
        const proof = JSON.parse(fixture.proofRequestBytes.toString("utf8"));
        const inventory = buildWindowsNativePostReleaseEvidenceInventory(proof);
        assert.equal(inventory.length, 25);
        assert.deepEqual(inventory[0], {name: "proof.result.json", path: proof.resultPath, allowEmpty: false});
        assert.deepEqual(inventory.slice(1, 5).map(({name, allowEmpty}) => ({name, allowEmpty})), [
            {name: "scenarios/default/populated-first-boot/ready.json", allowEmpty: false},
            {name: "scenarios/default/populated-first-boot/result.json", allowEmpty: false},
            {name: "scenarios/default/populated-first-boot/stdout.log", allowEmpty: true},
            {name: "scenarios/default/populated-first-boot/stderr.log", allowEmpty: true}
        ]);
        assert.equal(inventory.at(-1).name,
            "scenarios/baseline/fresh-no-config-reset/stderr.log");
        assert.ok(inventory.every(({path}) => path.startsWith("C:\\runner\\myspeed-native-")));
    });

    it("rejects altered scenario roots and arbitrary extra outputs", async () => {
        const fixture = await createWindowsNativeStandaloneEvidenceFixture();
        const proof = JSON.parse(fixture.proofRequestBytes.toString("utf8"));
        proof.candidates[0].controllerRequests[0].path = "C:\\foreign\\candidate.request.json";
        assert.throws(() => buildWindowsNativePostReleaseEvidenceInventory(proof), /escapes|owned path/u);

        const extra = JSON.parse(fixture.proofRequestBytes.toString("utf8"));
        extra.candidates[0].controllerRequests[0].arbitraryRoot = "C:\\foreign";
        assert.throws(() => buildWindowsNativePostReleaseEvidenceInventory(extra), /keys differ/u);
    });

    it("reads only a bounded stable proof request with its exact expected hash", async context => {
        const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-native-evidence-"));
        context.after(() => fs.rmSync(temporaryRoot, {recursive: true, force: true}));
        const fixture = await createWindowsNativeStandaloneEvidenceFixture();
        const proofPath = path.join(temporaryRoot, "proof.request.json");
        fs.writeFileSync(proofPath, fixture.proofRequestBytes);
        const digest = createHash("sha256").update(fixture.proofRequestBytes).digest("hex");
        assert.equal(runWindowsNativePostReleaseEvidenceCli(["--inventory", proofPath, digest]).length, 25);
        assert.throws(() => runWindowsNativePostReleaseEvidenceCli(["--inventory", proofPath, "0".repeat(64)]),
            /SHA differs/u);
        assert.throws(() => runWindowsNativePostReleaseEvidenceCli(["--inventory", proofPath]), /Usage:/u);
        assert.throws(() => runWindowsNativePostReleaseEvidenceCli(
            ["--inventory", "proof.request.json", digest]), /Usage:/u);
        fs.writeFileSync(proofPath, Buffer.alloc(OVERSIZED_PROOF_REQUEST_BYTES, 1));
        assert.throws(() => runWindowsNativePostReleaseEvidenceCli(["--inventory", proofPath, digest]), /file differs/u);
    });
});
