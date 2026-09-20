import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {validateRequest} from "../../scripts/qualification/linux-windows-cpu-floor-stage3.mjs";
import {buildAcceptedStage3Fixture} from "../helpers/windows-cpu-floor-stage3-fixture.mjs";

/*
 * The Stage 3 candidate block is a tagged union. A published release carries a tag and two release
 * assets that a branch build has no equivalent of, and the two disagree about the one thing the
 * guest contract cares most about: a published candidate must not be the commit running the harness,
 * and a branch candidate must be exactly that. The discriminant is explicit so that a candidate with
 * no provenance at all fails before either branch rather than falling into whichever has fewer
 * checks.
 */

const PUBLISHED = "published-release";
const BRANCH = "branch-build";
const RELEASE_ONLY_KEYS = ["tagName", "releaseAssetId", "releaseAssetDigest",
    "qualificationSummary", "manifest"];

const requestWith = (request, candidate) => ({...structuredClone(request), candidate});

const branchCandidateFrom = (published, harnessSourceSha) => {
    const candidate = {...structuredClone(published), provenance: BRANCH,
        sourceSha: harnessSourceSha};
    for (const key of RELEASE_ONLY_KEYS) delete candidate[key];
    return candidate;
};

describe("Stage 3 candidate provenance", () => {
    it("still accepts the published candidate, and still refuses it when it is the harness commit",
        async () => {
            const {request} = await buildAcceptedStage3Fixture();
            assert.equal(request.candidate.provenance, PUBLISHED,
                "the fixture must carry the discriminant the schema now requires");
            assert.doesNotThrow(() => validateRequest(request));

            /* The published invariant: the thing under test is not the thing testing it. */
            assert.throws(() => validateRequest(requestWith(request,
                {...request.candidate, sourceSha: request.context.sourceSha})), /candidate/u);
        });

    it("accepts a branch candidate built by the commit running the harness", async () => {
        const {request} = await buildAcceptedStage3Fixture();
        const candidate = branchCandidateFrom(request.candidate, request.context.sourceSha);
        assert.doesNotThrow(() => validateRequest(requestWith(request, candidate)));
    });

    /*
     * The inverted invariant. A branch run's whole claim is that this commit's build was exercised,
     * so an artifact attributed to any other commit makes the result mean nothing.
     */
    it("refuses a branch candidate attributed to another commit", async () => {
        const {request} = await buildAcceptedStage3Fixture();
        const candidate = branchCandidateFrom(request.candidate, request.context.sourceSha);
        assert.throws(() => validateRequest(requestWith(request,
            {...candidate, sourceSha: request.candidate.sourceSha})), /candidate/u);
    });

    it("refuses release-only fields smuggled into a branch candidate", async () => {
        const {request} = await buildAcceptedStage3Fixture();
        const base = branchCandidateFrom(request.candidate, request.context.sourceSha);
        for (const key of RELEASE_ONLY_KEYS) {
            assert.throws(() => validateRequest(requestWith(request,
                {...base, [key]: structuredClone(request.candidate[key])})), /candidate/u, key);
        }
    });

    it("refuses a published candidate missing any release-only field", async () => {
        const {request} = await buildAcceptedStage3Fixture();
        for (const key of RELEASE_ONLY_KEYS) {
            const candidate = structuredClone(request.candidate);
            delete candidate[key];
            assert.throws(() => validateRequest(requestWith(request, candidate)), /candidate/u, key);
        }
    });

    /*
     * A discriminant that can be absent, empty or unrecognised is a discriminant an attacker picks.
     * None of these may reach either branch.
     */
    it("refuses a candidate whose provenance is missing, empty or unknown", async () => {
        const {request} = await buildAcceptedStage3Fixture();
        const withoutProvenance = structuredClone(request.candidate);
        delete withoutProvenance.provenance;
        const variants = [withoutProvenance,
            {...structuredClone(request.candidate), provenance: ""},
            {...structuredClone(request.candidate), provenance: "released"},
            {...structuredClone(request.candidate), provenance: null},
            {...structuredClone(request.candidate), provenance: [PUBLISHED]}];
        for (const candidate of variants) {
            assert.throws(() => validateRequest(requestWith(request, candidate)), /candidate/u,
                JSON.stringify(candidate.provenance ?? null));
        }
    });

    it("still refuses an artifact that is not the CPU-floor build, under either provenance",
        async () => {
            const {request} = await buildAcceptedStage3Fixture();
            const branch = branchCandidateFrom(request.candidate, request.context.sourceSha);
            for (const candidate of [request.candidate, branch]) {
                assert.throws(() => validateRequest(requestWith(request,
                    {...candidate, artifactName: "MySpeed-windows-x64.exe"})), /candidate/u,
                candidate.provenance);
            }
        });
});
