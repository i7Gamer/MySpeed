import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
    PRERELEASE_CPU_FLOOR_TARGET_CONSTANTS,
    bindPrereleaseCpuFloorTarget,
    buildPrereleaseWindowsExeAcquisitionPlan
} from "../../scripts/release/prerelease-cpu-floor-target.mjs";

/*
 * The published v1.6.1 target binds evidence to release assets and a sealed qualification manifest.
 * Neither exists before a release, and the manifest archive it rests on expires on a seven-day
 * retention, so that binder cannot describe a branch build at all. This one anchors the same
 * questions to the run that produced the binary: the artifact's own Actions metadata carries the
 * digest, exactly as the published asset table used to, and nothing it depends on expires on a
 * schedule shorter than the artifact under test.
 */

const HARNESS_SHA = "dce629fd50ea007221b3a9f2698c32a573bca160";
const OTHER_SHA = "4fa4dd40a89a062735f98bd85d685e0624ff46a8";
const REPOSITORY = "i7Gamer/MySpeed";
const ARTIFACT_ID = 10500000001;
const RUN_ID = 40000000001;
const RUN_ATTEMPT = 1;
const ARTIFACT_BYTES = 46649471;
const ARTIFACT_DIGEST = "sha256:280b4a99c8a1f20aca5958c065b12ecb14519125769ee0460840168963db07ed";
const CREATED_AT = "2026-09-20T09:00:00Z";
const OBSERVED_AT = "2026-09-20T09:30:00Z";
const EXPIRES_AT = "2026-12-19T09:00:00Z";

const buildArtifact = (overrides = {}) => ({
    repository: REPOSITORY, id: ARTIFACT_ID,
    name: PRERELEASE_CPU_FLOOR_TARGET_CONSTANTS.baselineArtifactName,
    size: ARTIFACT_BYTES, digest: ARTIFACT_DIGEST, expired: false,
    createdAt: CREATED_AT, updatedAt: CREATED_AT, expiresAt: EXPIRES_AT,
    runId: RUN_ID, runAttempt: RUN_ATTEMPT, headSha: HARNESS_SHA, ...overrides
});

const candidate = (overrides = {}) => ({
    repository: REPOSITORY, sourceSha: HARNESS_SHA, version: "1.6.2",
    windowsStamp: "1.6.2.1", ...overrides
});

const input = (overrides = {}) => ({
    harnessSourceSha: HARNESS_SHA, observedAt: OBSERVED_AT,
    candidate: candidate(), buildArtifact: buildArtifact(), ...overrides
});

describe("pre-release CPU-floor target", () => {
    it("binds a branch build to the run that produced it", () => {
        const target = bindPrereleaseCpuFloorTarget(input());
        assert.equal(target.kind, PRERELEASE_CPU_FLOOR_TARGET_CONSTANTS.targetKind);
        assert.equal(target.candidate.sourceSha, HARNESS_SHA);
        assert.equal(target.build.id, ARTIFACT_ID);
        assert.equal(target.build.provenance, "github-actions-artifact");
        assert.equal(target.observedAt, OBSERVED_AT);
    });

    /*
     * The published binder refuses a harness that equals the candidate, because there the two are
     * genuinely separate things: a frozen release and the branch testing it. Before a release they
     * are necessarily one commit, so the invariant inverts rather than disappears - an artifact
     * built from some other commit is exactly what must not be admitted here.
     */
    it("requires the candidate to be the harness commit", () => {
        assert.throws(() => bindPrereleaseCpuFloorTarget(
            input({candidate: candidate({sourceSha: OTHER_SHA})})), /harness commit/u);
    });

    it("refuses an artifact built from another commit", () => {
        assert.throws(() => bindPrereleaseCpuFloorTarget(
            input({buildArtifact: buildArtifact({headSha: OTHER_SHA})})), /head SHA/u);
    });

    /*
     * Without this an artifact from any previous run of the workflow would satisfy the binding, and
     * a green result would say nothing about the commit that was dispatched.
     */
    it("refuses an artifact whose run does not match the declared run", () => {
        const target = bindPrereleaseCpuFloorTarget(input());
        assert.equal(target.build.runId, RUN_ID);
        assert.throws(() => bindPrereleaseCpuFloorTarget(input({
            buildArtifact: buildArtifact({runAttempt: 0})})), /run attempt/u);
    });

    it("refuses an expired artifact and one whose retention had lapsed when it was observed", () => {
        assert.throws(() => bindPrereleaseCpuFloorTarget(
            input({buildArtifact: buildArtifact({expired: true})})), /expired/u);
        assert.throws(() => bindPrereleaseCpuFloorTarget(
            input({observedAt: "2026-12-20T09:00:00Z"})), /retention/u);
    });

    it("refuses an observation made before the artifact existed", () => {
        assert.throws(() => bindPrereleaseCpuFloorTarget(
            input({observedAt: "2026-09-20T08:59:59Z"})), /retention/u);
    });

    it("refuses a foreign repository on either side", () => {
        for (const broken of [
            input({candidate: candidate({repository: "someone/else"})}),
            input({buildArtifact: buildArtifact({repository: "someone/else"})})
        ]) assert.throws(() => bindPrereleaseCpuFloorTarget(broken), /repository/u);
    });

    it("refuses an artifact that is not the CPU-floor build", () => {
        assert.throws(() => bindPrereleaseCpuFloorTarget(input({
            buildArtifact: buildArtifact({name: "MySpeed-windows-x64.exe"})})), /artifact name/u);
    });

    it("refuses a digest that is not a sha256 hex digest", () => {
        for (const digest of ["sha256:nothex", ARTIFACT_DIGEST.slice("sha256:".length), "", null]) {
            assert.throws(() => bindPrereleaseCpuFloorTarget(
                input({buildArtifact: buildArtifact({digest})})), /digest/u, String(digest));
        }
    });

    it("refuses unknown and missing input keys rather than ignoring them", () => {
        assert.throws(() => bindPrereleaseCpuFloorTarget({...input(), extra: true}), /input/u);
        const {observedAt, ...missing} = input();
        assert.ok(observedAt);
        assert.throws(() => bindPrereleaseCpuFloorTarget(missing), /input/u);
    });

    /*
     * The workflow is an evidence addendum, never a gate. A target that could be read as clearing
     * one would let a branch run stand in for qualification, which is the one thing it must not do.
     */
    it("stays non-qualifying and immutable", () => {
        const target = bindPrereleaseCpuFloorTarget(input());
        assert.equal(target.qualifying, false);
        assert.equal(target.releaseGateCleared, false);
        assert.deepEqual(target.releaseGatesCleared, []);
        assert.ok(Object.isFrozen(target));
        assert.throws(() => {
            target.qualifying = true;
        }, TypeError);
    });
});

describe("pre-release Windows exe acquisition plan", () => {
    it("names the built artifact and grants acquisition only", () => {
        const plan = buildPrereleaseWindowsExeAcquisitionPlan(bindPrereleaseCpuFloorTarget(input()));
        assert.equal(plan.authority, "acquisition-only");
        assert.deepEqual(plan.permissions,
            {networkAcquisition: true, nativeExecution: false, publishing: false});
        assert.equal(plan.assets.length, 1);
        const [asset] = plan.assets;
        assert.equal(asset.role, PRERELEASE_CPU_FLOOR_TARGET_CONSTANTS.baselineAssetRole);
        assert.equal(asset.name, PRERELEASE_CPU_FLOOR_TARGET_CONSTANTS.baselineArtifactName);
        assert.equal(asset.sha256, ARTIFACT_DIGEST.slice("sha256:".length));
        assert.equal(asset.bytes, ARTIFACT_BYTES);
        assert.equal(asset.runId, RUN_ID);
    });

    /*
     * A structural clone carries every field and no brand. Freezing one is the forgery that matters:
     * an unfrozen object is turned away by the immutability check alone, so only a frozen clone
     * actually exercises the brand, and the brand is the only thing that distinguishes a target the
     * binder validated from one a caller assembled to look like it.
     */
    it("refuses anything but a target the binder returned", () => {
        const target = bindPrereleaseCpuFloorTarget(input());
        const frozenClone = Object.freeze(structuredClone(target));
        assert.ok(Object.isFrozen(frozenClone), "the forgery must survive the immutability check");
        for (const forged of [frozenClone, structuredClone(target), {...target}, null, "target"]) {
            assert.throws(() => buildPrereleaseWindowsExeAcquisitionPlan(forged),
                /immutable target/u, String(forged));
        }
    });
});
