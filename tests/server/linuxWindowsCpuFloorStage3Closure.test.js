import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {describe, it} from "node:test";
import {build} from "esbuild";
import {STAGE3_EXECUTION_PATHS, sealStage3ExecutionClosure, verifyStage3ExecutionClosure,
    loadVerifiedStage3Launcher} from "../../scripts/qualification/linux-windows-cpu-floor-stage3-closure.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONTEXT = Object.freeze({repository: "i7Gamer/MySpeed", sourceSha: "a".repeat(40),
    runId: "123", runAttempt: "1", nonce: "b".repeat(32)});
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fixture = t => {
    const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-stage3-closure-test-")));
    t.after(() => fs.rmSync(parent, {recursive: true, force: true}));
    const outputRoot = path.join(parent, `myspeed-stage3-closure-${CONTEXT.nonce}`);
    const sealed = sealStage3ExecutionClosure({sourceRoot: ROOT, outputRoot, context: CONTEXT});
    return {root: outputRoot, manifestSha256: sealed.manifestSha256, context: CONTEXT};
};

describe("Stage 3 external execution closure", () => {
    it("contains the actual transitive module graph, including the request builder", async () => {
        const bundled = await build({absWorkingDir: ROOT,
            entryPoints: ["scripts/qualification/linux-windows-cpu-floor-stage3-launcher.mjs",
                "scripts/release/cpu-floor-guest-preparation.mjs",
                "scripts/release/post-release-cpu-floor-hosted-inputs.mjs",
                "scripts/release/post-release-msi-linux-controller.mjs",
                "scripts/release/prerelease-cpu-floor-hosted-inputs.mjs"],
            outdir: "unused", bundle: true, write: false, metafile: true, platform: "node", format: "esm", logLevel: "silent"});
        for (const member of Object.keys(bundled.metafile.inputs))
            assert.ok(STAGE3_EXECUTION_PATHS.includes(member.replaceAll("\\", "/")), `unsealed import: ${member}`);
        assert.ok(STAGE3_EXECUTION_PATHS.includes("scripts/qualification/windows-msi-stage2-request.mjs"));
    });

    it("loads the real launcher from the sealed copy with no checkout or dependencies", async t => {
        const input = fixture(t);
        const verified = verifyStage3ExecutionClosure(input);
        assert.equal(verified.files.length, STAGE3_EXECUTION_PATHS.length);
        assert.equal(typeof (await loadVerifiedStage3Launcher(input)).executeStage3Launcher, "function");
    });

    for (const member of ["scripts/qualification/linux-windows-cpu-floor-stage3-launcher.mjs",
        "scripts/release/post-release-target.mjs"]) {
        it(`rejects tampered ${member} before any top-level marker executes`, async t => {
            const input = fixture(t);
            const marker = path.join(input.root, "marker.txt");
            fs.appendFileSync(path.join(input.root, member),
                `\nimport fsMarker from 'node:fs'; fsMarker.writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);
            await assert.rejects(loadVerifiedStage3Launcher(input), /member.*differs/);
            assert.equal(fs.existsSync(marker), false);
        });
    }

    it("rejects a rewritten manifest, missing/extra members and context drift", t => {
        const input = fixture(t);
        const manifestPath = path.join(input.root, "execution-closure.json");
        const original = fs.readFileSync(manifestPath);
        fs.appendFileSync(manifestPath, " ");
        assert.throws(() => verifyStage3ExecutionClosure(input), /manifest.*digest/);
        fs.writeFileSync(manifestPath, original);
        assert.throws(() => verifyStage3ExecutionClosure({...input, context: {...CONTEXT, runAttempt: "2"}}), /context/);
        fs.writeFileSync(path.join(input.root, "extra.mjs"), "export const extra = true;\n");
        assert.throws(() => verifyStage3ExecutionClosure(input), /inventory/);
        fs.unlinkSync(path.join(input.root, "extra.mjs"));
        fs.unlinkSync(path.join(input.root, STAGE3_EXECUTION_PATHS[0]));
        assert.throws(() => verifyStage3ExecutionClosure(input), /inventory/);
    });

    it("rejects duplicate or escaping manifest members even with a new outer seal", t => {
        for (const replacement of [STAGE3_EXECUTION_PATHS[0], "../escape.mjs"]) {
            const input = fixture(t);
            const manifestPath = path.join(input.root, "execution-closure.json");
            const manifest = JSON.parse(fs.readFileSync(manifestPath));
            manifest.files[1].name = replacement;
            const bytes = Buffer.from(JSON.stringify(manifest));
            fs.writeFileSync(manifestPath, bytes);
            assert.throws(() => verifyStage3ExecutionClosure({...input, manifestSha256: sha256(bytes)}), /member/);
        }
    });
});
