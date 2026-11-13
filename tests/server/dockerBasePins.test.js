import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {readSource} from "../helpers/source.js";

/**
 * A tag is a name the registry owner can re-point, so a Dockerfile that names
 * its base images by tag alone builds whatever the registry serves that day -
 * the release is not reproducible and a compromised re-push ships unreviewed.
 * Each registry image is therefore pinned `image:tag@sha256:<digest>` of the
 * multi-arch index: the tag stays for readers and for Dependabot, which moves
 * tag and digest together, and the digest is what the build actually resolves.
 */
const SHA256_HEX_LENGTH = 64;
const DIGEST = new RegExp(`@sha256:[0-9a-f]{${SHA256_HEX_LENGTH}}$`);

const dockerfile = readSource("Dockerfile");
const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gim)]
    .map((match) => ({ref: match[1], stage: match[2]}));
const earlierStages = new Set();
const registryImages = [];
for (const from of froms) {
    if (!earlierStages.has(from.ref) && from.ref !== "scratch") registryImages.push(from.ref);
    if (from.stage) earlierStages.add(from.stage);
}

describe("Dockerfile base image pins", () => {
    it("finds the registry images it is meant to check", () => {
        assert.ok(registryImages.length >= 2, "FROM parsing found no registry images");
    });

    it("pins every registry image by sha256 digest", () => {
        for (const ref of registryImages)
            assert.match(ref, DIGEST, `${ref} is pinned by tag alone`);
    });

    it("keeps the tag next to the digest", () => {
        for (const ref of registryImages)
            assert.match(ref, /^[^:@\s]+(\/[^:@\s]+)*:[^@\s]+@sha256:/, `${ref} lost its readable tag`);
    });

    it("does not demand a digest of a reference to an earlier stage", () => {
        const stageRefs = froms.filter((from) => earlierStages.has(from.ref) && !registryImages.includes(from.ref));
        for (const from of stageRefs) assert.doesNotMatch(from.ref, /@/);
    });

    it("gives the stages that share an image the same digest", () => {
        const digestsByImage = new Map();
        for (const ref of registryImages) {
            const [nameAndTag, digest] = ref.split("@");
            digestsByImage.set(nameAndTag, new Set([...(digestsByImage.get(nameAndTag) ?? []), digest]));
        }
        for (const [image, digests] of digestsByImage)
            assert.equal(digests.size, 1, `${image} is pinned to different digests in different stages`);
    });
});
