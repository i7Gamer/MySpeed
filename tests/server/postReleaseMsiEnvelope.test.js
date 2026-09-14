import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {createV161PostReleaseMsiEnvelope, validateV161PostReleaseMsiEnvelope} from
    "../../scripts/release/post-release-msi-envelope.mjs";
import {createPostReleaseV161HarnessContext as context,
    createPostReleaseV161Target as target, POST_RELEASE_V161_CANDIDATE_SHA as CANDIDATE_SHA,
    POST_RELEASE_V161_HARNESS_SHA as HARNESS_SHA} from
    "../helpers/post-release-v161-target-fixture.mjs";

describe("v1.6.1 post-release MSI request provenance", () => {
    it("separates the harness, original qualification, and exact published MSI/EXE identities", () => {
        const bound = target();
        const harness = context();
        const value = createV161PostReleaseMsiEnvelope(bound, harness);
        assert.equal(value.candidate.version, "1.6.1");
        assert.equal(value.candidate.sourceSha, CANDIDATE_SHA);
        assert.equal(value.harness.sourceSha, HARNESS_SHA);
        assert.notEqual(value.harness.sourceSha, value.candidate.sourceSha);
        assert.equal(value.originalQualification.archive.name, "release-qualification-manifest");
        assert.deepEqual(value.candidates.map(({bindingId}) => bindingId),
            ["candidate-default", "candidate-baseline"]);
        assert.deepEqual(value.candidates.map(({msi, exe}) => [msi.name, exe.name]), [
            ["MySpeed-installer.msi", "MySpeed-windows-x64.exe"],
            ["MySpeed-installer-baseline.msi", "MySpeed-windows-x64-baseline.exe"]]);
        assert.equal(value.legacyPresealHostCompatible, false);
        for (const forbidden of ["eligible", "qualifying", "releaseGatesCleared"])
            assert.equal(Object.hasOwn(value, forbidden), false);
        assert.ok(Object.isFrozen(value));
        assert.ok(Object.isFrozen(value.candidates[0].msi));
        harness.runId = "999";
        assert.equal(value.harness.runId, "40000000001");
        const serialized = JSON.parse(JSON.stringify(value));
        assert.equal(validateV161PostReleaseMsiEnvelope(serialized, bound, context()), true);
    });

    it("rejects mutable or foreign targets and non-distinct harness identity", () => {
        const bound = target();
        assert.throws(() => createV161PostReleaseMsiEnvelope(structuredClone(bound), context()), /immutable target/i);
        assert.throws(() => createV161PostReleaseMsiEnvelope(bound, {...context(), sourceSha: CANDIDATE_SHA}),
            /distinct|harness/i);
        assert.throws(() => createV161PostReleaseMsiEnvelope(bound, {...context(), eventSha: "f".repeat(40)}),
            /event|harness/i);
    });

    it("rejects wrong or duplicate published MSI identities, digests, and candidate version", () => {
        const bound = target();
        for (const mutate of [
            value => { value.candidates[0].msi.releaseAssetId = value.candidates[1].msi.releaseAssetId; },
            value => { value.candidates[0].msi.sha256 = "f".repeat(64); },
            value => { value.candidates[1].msi.name = value.candidates[0].msi.name; },
            value => { value.candidate.version = "1.6.2"; }
        ]) {
            const value = structuredClone(createV161PostReleaseMsiEnvelope(bound, context()));
            mutate(value);
            assert.throws(() => validateV161PostReleaseMsiEnvelope(value, bound, context()));
        }
    });

    it("binds validation to the caller's trusted run, attempt, image, and nonce", () => {
        const bound = target();
        const expected = context();
        for (const mutate of [
            value => { value.harness.runId = "40000000002"; },
            value => { value.harness.runAttempt = "2"; },
            value => { value.harness.imageVersion = "20260908.1"; },
            value => { value.harness.nonce = "f".repeat(32); }
        ]) {
            const value = JSON.parse(JSON.stringify(createV161PostReleaseMsiEnvelope(bound, expected)));
            mutate(value);
            assert.throws(() => validateV161PostReleaseMsiEnvelope(value, bound, expected),
                /serialized envelope differs/i);
        }
    });
});
