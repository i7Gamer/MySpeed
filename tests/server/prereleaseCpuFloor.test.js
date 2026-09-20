import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, it} from "node:test";

import {bindPrereleaseCpuFloorTarget} from "../../scripts/release/prerelease-cpu-floor-target.mjs";
import {
    PRERELEASE_CPU_FLOOR_CONSTANTS,
    acquirePrereleaseCpuFloorCandidate,
    buildPrereleaseCpuFloorStage3Request,
    buildPrereleaseCpuFloorStage3Template,
    createPrereleaseCpuFloorBinding,
    inspectPrereleaseCpuFloorEvidence
} from "../../scripts/release/prerelease-cpu-floor.mjs";
import {validateRequest} from "../../scripts/qualification/linux-windows-cpu-floor-stage3.mjs";
import {buildAcceptedStage3Fixture} from "../helpers/windows-cpu-floor-stage3-fixture.mjs";

const SHA = character => character.repeat(64);
const HARNESS_SHA = "d".repeat(40);
const OTHER_SHA = "4".repeat(40);
const NONCE = "2".repeat(32);
const REPOSITORY = "i7Gamer/MySpeed";
const RUN_ID = 123;
const RUN_ATTEMPT = 1;
const ARTIFACT_ID = 10500000001;
const ARCHIVE_BYTES = 1048576;
const ARCHIVE_SHA = SHA("c");
const EXE_BYTES = "524288";
const EXE_SHA = SHA("d");
const OBSERVED_AT = "2026-09-20T09:30:00Z";
const STAGE2_ROOT = `/home/runner/work/_temp/myspeed-stage2-transport-${NONCE}`;
const WALL_DEADLINE_MILLISECONDS = 1789000000000;

const target = (overrides = {}) => bindPrereleaseCpuFloorTarget({
    harnessSourceSha: HARNESS_SHA, observedAt: OBSERVED_AT,
    candidate: {repository: REPOSITORY, sourceSha: HARNESS_SHA, version: "1.6.2",
        windowsStamp: "1.6.2.1", ...overrides.candidate},
    buildArtifact: {repository: REPOSITORY, id: ARTIFACT_ID,
        name: "MySpeed-windows-x64-baseline.exe", size: ARCHIVE_BYTES, digest: `sha256:${ARCHIVE_SHA}`,
        expired: false, createdAt: "2026-09-20T09:00:00Z", updatedAt: "2026-09-20T09:00:00Z",
        expiresAt: "2026-12-19T09:00:00Z", runId: RUN_ID, runAttempt: RUN_ATTEMPT,
        headSha: HARNESS_SHA, ...overrides.buildArtifact}
});

const hostedContext = (overrides = {}) => ({schemaVersion: 1, repository: REPOSITORY,
    sourceSha: HARNESS_SHA, eventSha: HARNESS_SHA, runId: String(RUN_ID),
    runAttempt: String(RUN_ATTEMPT), nonce: NONCE,
    environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
        RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260901.1"},
...overrides});

const binding = () => createPrereleaseCpuFloorBinding({hostedContext: hostedContext(), target: target()});

const acquisition = (overrides = {}) => ({file: {bytes: EXE_BYTES, sha256: EXE_SHA},
    declaredSha256: EXE_SHA, observedAt: OBSERVED_AT, ...overrides});

const acquired = () => acquirePrereleaseCpuFloorCandidate(binding(), acquisition());

const stage2Bytes = Buffer.from("{\"stage2\":true}\n", "utf8");
const stage2Receipts = () => ({
    result: {path: `${STAGE2_ROOT}/stage2-result.json`, bytes: String(stage2Bytes.length),
        sha256: createHash("sha256").update(stage2Bytes).digest("hex")},
    guestResult: {path: `${STAGE2_ROOT}/guest-result.json`, bytes: "100", sha256: SHA("8")}
});

const plan = () => ({installerConfirmation: PRERELEASE_CPU_FLOOR_CONSTANTS.STAGE3_NO_INPUT,
    wallDeadlineUnixMilliseconds: WALL_DEADLINE_MILLISECONDS});

describe("pre-release CPU-floor binding", () => {
    it("binds this run's artifact to the commit that produced it", () => {
        const value = binding();
        assert.equal(value.candidate.provenance, "branch-build");
        assert.equal(value.candidate.sourceSha, HARNESS_SHA);
        assert.equal(value.harness.sourceSha, HARNESS_SHA);
        assert.equal(value.qualifying, false);
        assert.equal(value.releaseGateCleared, false);
        assert.deepEqual(value.releaseGatesCleared, []);
    });

    /*
     * The published path forbids harness and candidate being one commit. Here they must be, so the
     * refusal to test is the opposite one - an artifact carrying some other commit's work.
     */
    it("refuses a candidate that is not the harness commit", () => {
        assert.throws(() => createPrereleaseCpuFloorBinding({hostedContext: hostedContext(),
            target: target({candidate: {sourceSha: OTHER_SHA},
                buildArtifact: {headSha: OTHER_SHA}})}), /candidate source SHA/u);
    });

    /*
     * Without this an artifact left behind by any earlier run of the workflow would satisfy the
     * binding, and a green result would say nothing about the commit that was dispatched.
     */
    it("refuses an artifact that belongs to another run or attempt", () => {
        assert.throws(() => createPrereleaseCpuFloorBinding({
            hostedContext: hostedContext({runId: "124"}), target: target()}), /run ID/u);
        assert.throws(() => createPrereleaseCpuFloorBinding({
            hostedContext: hostedContext({runAttempt: "2"}), target: target()}), /run attempt/u);
    });

    it("refuses a hosted context whose event SHA is not the harness commit", () => {
        assert.throws(() => createPrereleaseCpuFloorBinding({
            hostedContext: hostedContext({eventSha: OTHER_SHA}), target: target()}),
        /harness source SHA/u);
    });

    it("refuses a forged target, including a frozen clone of a real one", () => {
        const real = target();
        for (const forged of [Object.freeze(structuredClone(real)), structuredClone(real), {...real}]) {
            assert.throws(() => createPrereleaseCpuFloorBinding({
                hostedContext: hostedContext(), target: forged}), /immutable target/u);
        }
    });
});

describe("pre-release CPU-floor candidate acquisition", () => {
    it("refuses an executable outside the qualified size bound or with a malformed digest", () => {
        for (const file of [{bytes: "0", sha256: EXE_SHA},
            {bytes: String(PRERELEASE_CPU_FLOOR_CONSTANTS.MAXIMUM_CANDIDATE_BYTES + 1), sha256: EXE_SHA},
            {bytes: EXE_BYTES, sha256: "not-a-digest"}]) {
            assert.throws(() => acquirePrereleaseCpuFloorCandidate(binding(), acquisition({file})),
                /candidate executable/u, JSON.stringify(file));
        }
    });

    /*
     * The build writes a digest sidecar beside the executable. Checking the executable against it
     * is the one consistency check a caller cannot skip; without it an executable could be swapped
     * for another inside a correctly named archive.
     */
    it("refuses an executable that is not the one the build declared", () => {
        assert.throws(() => acquirePrereleaseCpuFloorCandidate(binding(),
            acquisition({declaredSha256: SHA("a")})), /digest the build declared/u);
        assert.throws(() => acquirePrereleaseCpuFloorCandidate(binding(),
            acquisition({declaredSha256: "not-a-digest"})), /declared executable digest/u);
    });

    it("names the staged executable and keeps the binding non-qualifying", () => {
        const value = acquired();
        assert.equal(value.candidate.file.name, "MySpeed.exe");
        assert.equal(value.candidate.file.sha256, EXE_SHA);
        assert.equal(value.qualifying, false);
    });
});

describe("pre-release CPU-floor Stage 3 request", () => {
    it("refuses to build from a binding whose candidate was never acquired", () => {
        assert.throws(() => buildPrereleaseCpuFloorStage3Template(binding(), plan()),
            /acquired candidate/u);
    });

    /*
     * The point of the whole change: a request built from a branch build has to satisfy the same
     * guest contract a published one does. If this passes, the guest cannot tell the two apart.
     */
    it("produces a request the Stage 3 guest contract accepts", () => {
        const request = buildPrereleaseCpuFloorStage3Request(acquired(), stage2Receipts(), plan());
        assert.deepEqual(Object.keys(request.candidate).sort(),
            ["archive", "artifactId", "artifactName", "file", "provenance", "runAttempt", "runId",
                "sourceSha"]);
        assert.doesNotThrow(() => validateRequest(request));
    });

    it("refuses an installer confirmation policy that was never admitted", () => {
        assert.throws(() => buildPrereleaseCpuFloorStage3Request(acquired(), stage2Receipts(),
            {...plan(), installerConfirmation: "mash-every-key"}), /installer confirmation/u);
    });
});

describe("pre-release CPU-floor evidence", () => {
    /*
     * Composed from the real Stage 3 fixture rather than a status stub. The inspector re-derives the
     * whole result from the retained evidence, so a test that hands it `{status: "observed"}` proves
     * only that the string was read - which is how an inspector that validated nothing stayed green
     * through two reviews.
     */
    const composed = async (overrides = {}) => {
        const fixture = await buildAcceptedStage3Fixture({
            sourceSha: HARNESS_SHA, eventSha: HARNESS_SHA, candidateSourceSha: HARNESS_SHA,
            nonce: NONCE, runId: String(RUN_ID), runAttempt: String(RUN_ATTEMPT),
            candidate: {provenance: "branch-build", artifactId: String(ARTIFACT_ID),
                artifactName: "MySpeed-windows-x64-baseline.exe",
                archive: {bytes: String(ARCHIVE_BYTES), sha256: ARCHIVE_SHA},
                sourceSha: HARNESS_SHA, runId: String(RUN_ID), runAttempt: String(RUN_ATTEMPT),
                file: {name: "MySpeed.exe", bytes: EXE_BYTES, sha256: EXE_SHA}},
            ...overrides.fixture});
        const bound = createPrereleaseCpuFloorBinding({hostedContext: fixture.request.context,
            target: target()});
        return {fixture, binding: bound, input: {binding: bound, request: fixture.request,
            result: fixture.completedResult, retainedStage2Bytes: fixture.retainedStage2Bytes,
            ...overrides.input}};
    };

    it("accepts a real completed branch run and says what it establishes", async () => {
        const {input} = await composed();
        const evidence = inspectPrereleaseCpuFloorEvidence(input);
        /* The launcher refuses anything that does not say so explicitly. */
        assert.equal(evidence.accepted, true);
        assert.equal(evidence.establishes, "branch-build-runs-on-cpu-floor");
        assert.equal(evidence.qualifying, false);
        assert.equal(evidence.releaseGateCleared, false);
        assert.deepEqual(evidence.releaseGatesCleared, []);
        assert.equal(evidence.candidate.provenance, "branch-build");
        assert.equal(evidence.harness.sourceSha, HARNESS_SHA);
    });

    /*
     * The claim rests on the completed-result validator, not on a status field. Each of these was
     * accepted before the inspector called it.
     */
    it("refuses a result that only claims to have run", async () => {
        const {input} = await composed();
        for (const result of [{status: "observed"},
            {...structuredClone(input.result), cpuFloorAccepted: false},
            {...structuredClone(input.result), cleanupProven: false},
            {...structuredClone(input.result), qualifying: true}]) {
            assert.throws(() => inspectPrereleaseCpuFloorEvidence({...input, result}),
                /./u, JSON.stringify(Object.keys(result).slice(0, 3)));
        }
    });

    it("refuses a request executed under a different run", async () => {
        const {input, binding: bound} = await composed();
        const request = structuredClone(input.request);
        request.context = {...request.context, runId: "999"};
        assert.throws(() => inspectPrereleaseCpuFloorEvidence({...input, binding: bound, request}),
            /request context differs/u);
    });

    it("refuses Stage 2 bytes that are not the ones the request names", async () => {
        const {input} = await composed();
        assert.throws(() => inspectPrereleaseCpuFloorEvidence(
            {...input, retainedStage2Bytes: Buffer.from("different", "utf8")}), /./u);
    });
});
