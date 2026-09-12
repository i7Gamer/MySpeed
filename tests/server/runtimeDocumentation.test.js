import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {parse} from "yaml";
import {QUALIFIED_BUN_VERSION} from "../../scripts/build-binary.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = file => fs.readFileSync(path.join(ROOT, file), "utf8");

describe("Bun runtime guidance", () => {
    it("labels the retained baseline MSI as an alias without changing installer identity", () => {
        const source = read(".github/workflows/build-msi.yml");
        const workflow = parse(source);
        const variants = workflow.jobs["build-msi"].strategy.matrix.include;
        const baseline = variants.find(variant => variant.label === "x64-baseline");

        assert.equal(baseline.product_name, "MySpeed (baseline alias)");
        assert.equal(baseline.artifact, "MySpeed-windows-x64-baseline.exe");
        assert.equal(baseline.asset_name, "MySpeed-installer-baseline.msi");
        assert.match(source, /UpgradeCode="A1B2C3D4-5E6F-7890-ABCD-EF1234567890"/);
        assert.doesNotMatch(source, /no AVX2/);
    });

    it("keeps German runtime and CPU guidance aligned", () => {
        const readme = read("README.de.md");
        assert.ok(readme.includes("1.4.2"), "German source instructions omit the Bun floor");
        assert.ok(readme.includes("22.19.0"), "German Node instructions omit the Node floor");
        assert.ok(/Kompatibilitätsalias/.test(readme));
        assert.ok(!/Standard-Ziel von Bun \(benötigt \*\*AVX2\*\*\)/.test(readme));
    });

    it("generates release notes with the current CPU and source-runtime contract", async () => {
        const workflow = parse(read(".github/workflows/finalize-release.yml"));
        const step = workflow.jobs.finalize.steps.find(step => step.name === "Generate notes and publish the existing draft");
        const version = JSON.parse(read("package.json")).version;
        const sourceSha = "a".repeat(40);
        const updates = [];
        await vm.runInNewContext(`(async () => {${step.with.script}})()`, {
            process: {env: {VERSION: version, SOURCE_SHA: sourceSha, RELEASE_ID: "1"}},
            context: {repo: {owner: "fixture", repo: "myspeed"}},
            console: {log() {}},
            github: {rest: {git: {getRef: async () => ({data: {object: {type: "commit", sha: sourceSha}}})}, repos: {
                getRelease: async () => ({data: {draft: true, tag_name: `v${version}`, target_commitish: "fixture"}}),
                generateReleaseNotes: async () => ({data: {body: "generated"}}),
                updateRelease: async value => { updates.push(value); }
            }}}
        });
        assert.equal(updates.length, 1);
        const {body} = updates[0];
        assert.ok(body.includes("Bun 1.4.2 or newer"));
        assert.ok(body.includes("Nehalem/SSE4.2"));
        assert.ok(body.includes("compatibility alias"));
        assert.ok(!/no AVX2/i.test(body));
    });

    it("documents the verified source and Node development minimums", () => {
        const readme = read("README.md");

        assert.match(readme, /Bun[\s\S]*?1\.4\.2[\s\S]*?before[\s\S]*?install/i,
            "source users are not told to upgrade Bun before installing dependencies");
        assert.match(readme, /Node(?:\.js)?[\s\S]*?22\.19\.0[\s\S]*?(?:development|test)/i,
            "Node development/test minimum is not documented");
    });

    it("distinguishes the source-runtime minimum from the exact standalone compiler", () => {
        const english = read("README.md");
        const german = read("README.de.md");
        const version = QUALIFIED_BUN_VERSION.replaceAll(".", "\\.");

        assert.match(english, new RegExp(`Bun[\\s\\S]*?${version} or newer`, "i"));
        assert.match(german, new RegExp(`Bun[\\s\\S]*?${version} oder neuer`, "i"));
        assert.match(english, new RegExp(`standalone compilation[\\s\\S]*?exactly ${version}`, "i"));
        assert.match(german, new RegExp(`eigenst.ndige Kompilierung[\\s\\S]*?genau ${version}`, "i"));
    });

    it("describes x64 default and baseline names as compatibility aliases", () => {
        const readme = read("README.md");
        const installer = read("scripts/install.sh");
        const combined = `${readme}\n${installer}`;

        assert.match(combined, /compatibility alias/i,
            "the retained x64 asset names are not explained as compatibility aliases");
        assert.match(combined, /Nehalem[^\n]*SSE4\.2|SSE4\.2[^\n]*Nehalem/i,
            "the Nehalem/SSE4.2 compatibility floor is not documented");
        assert.match(combined, /dispatch[^\n]*AVX[^\n]*runtime/i,
            "runtime AVX dispatch is not documented");
        assert.doesNotMatch(readme, /default Bun target \(needs \*\*AVX2\*\*\)/i,
            "README still claims the default x64 binary requires AVX2");
        assert.doesNotMatch(installer, /fallback name.*also unavailable/i,
            "the installer never checks default-asset availability in the refused fallback branch");
        assert.match(installer, /older releases.*AVX2/i,
            "explain why the historical fallback is still refused");
    });
});
