import {afterEach, beforeEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import tarStream from "tar-stream";
import {inspectOciLayout} from "../../scripts/release/inspect-oci.mjs";
import {inspectCombinedOciArchive, inspectOciArchive}
    from "../../scripts/release/inspect-oci-archive.mjs";
import {combineOciLayouts} from "../../scripts/release/combine-oci-layouts.mjs";

const SOURCE_SHA = "a".repeat(40);
const VERSION = "1.6.1";
const PLATFORM = "linux/amd64";
const INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json";
const MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const CONFIG_MEDIA_TYPE = "application/vnd.oci.image.config.v1+json";
const EMPTY_MEDIA_TYPE = "application/vnd.oci.empty.v1+json";
const ATTESTATION_MEDIA_TYPE = "application/vnd.docker.attestation.manifest.v1+json";
const IN_TOTO_MEDIA_TYPE = "application/vnd.in-toto+json";
const MEBIBYTE = 1024 * 1024;
const JSON_LIMIT_BYTES = 10 * MEBIBYTE;
const MAX_IMAGE_LAYERS = 64;

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const fixture = ({architecture = "amd64", configArchitecture = architecture,
    attestationReference, attestationSubjectDigest, attestationArtifactType = ATTESTATION_MEDIA_TYPE,
    attestationConfigMediaType = EMPTY_MEDIA_TYPE, attestationConfigData = "e30=",
    attestationLayerMediaType = IN_TOTO_MEDIA_TYPE, omitAttestationLayers = false,
    configSizeOffset = 0, layerSizeOffset = 0, imageLayerCount = 1, mutate} = {}) => {
    const blobs = new Map();
    const addBlob = (value) => {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
        const descriptor = {digest: sha256(bytes), size: bytes.length};
        blobs.set(descriptor.digest, bytes);
        return descriptor;
    };
    const config = addBlob({os: "linux", architecture: configArchitecture});
    const layer = addBlob("synthetic application layer");
    const manifest = addBlob({schemaVersion: 2, mediaType: MANIFEST_MEDIA_TYPE,
        config: {...config, size: config.size + configSizeOffset, mediaType: CONFIG_MEDIA_TYPE},
        layers: Array.from({length: imageLayerCount}, () => ({...layer,
            size: layer.size + layerSizeOffset,
            mediaType: "application/vnd.oci.image.layer.v1.tar+gzip"}))});
    const runnable = {...manifest, mediaType: MANIFEST_MEDIA_TYPE,
        platform: {os: "linux", architecture}};

    const emptyConfig = addBlob({});
    const statement = addBlob({_type: "https://in-toto.io/Statement/v1"});
    const attestationManifest = addBlob({schemaVersion: 2, mediaType: MANIFEST_MEDIA_TYPE,
        artifactType: attestationArtifactType,
        config: {...emptyConfig, mediaType: attestationConfigMediaType, data: attestationConfigData},
        layers: omitAttestationLayers ? [] : [{...statement, mediaType: attestationLayerMediaType}],
        subject: {mediaType: runnable.mediaType, digest: attestationSubjectDigest ?? runnable.digest,
            size: runnable.size}});
    const attestation = {...attestationManifest, mediaType: MANIFEST_MEDIA_TYPE,
        annotations: {"vnd.docker.reference.digest": attestationReference ?? runnable.digest,
            "vnd.docker.reference.type": "attestation-manifest"},
        platform: {os: "unknown", architecture: "unknown"}};
    const imageIndex = addBlob({schemaVersion: 2, mediaType: INDEX_MEDIA_TYPE,
        manifests: [runnable, attestation]});
    const rootIndex = {schemaVersion: 2, mediaType: INDEX_MEDIA_TYPE,
        manifests: [{...imageIndex, mediaType: INDEX_MEDIA_TYPE}]};
    const state = {blobs, rootIndex, runnable, attestation, imageIndex, config, layer, statement};
    mutate?.(state);
    return state;
};

const tarBytes = async (state) => {
    const pack = tarStream.pack();
    const entries = [["oci-layout", Buffer.from('{"imageLayoutVersion":"1.0.0"}')],
        ["index.json", Buffer.from(JSON.stringify(state.rootIndex))],
        ...[...state.blobs].map(([digest, bytes]) => [`blobs/sha256/${digest.slice(7)}`, bytes])];
    for (const [name, bytes] of entries) pack.entry({name, size: bytes.length}, bytes);
    pack.finalize();
    const chunks = [];
    for await (const chunk of pack) chunks.push(chunk);
    return Buffer.concat(chunks);
};

describe("nested BuildKit OCI indexes", () => {
    let root;
    let sequence;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-oci-nested-"));
        sequence = 0;
    });
    afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

    const writeLayout = (state) => {
        const fixtureRoot = path.join(root, `fixture-${sequence++}`);
        fs.mkdirSync(path.join(fixtureRoot, "blobs", "sha256"), {recursive: true});
        fs.writeFileSync(path.join(fixtureRoot, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');
        fs.writeFileSync(path.join(fixtureRoot, "index.json"), JSON.stringify(state.rootIndex));
        for (const [blobDigest, bytes] of state.blobs)
            fs.writeFileSync(path.join(fixtureRoot, "blobs", "sha256", blobDigest.slice(7)), bytes);
        return fixtureRoot;
    };

    const archiveLayout = async (fixtureRoot, archive) => {
        const pack = tarStream.pack();
        for (const name of ["oci-layout", "index.json"]) {
            const bytes = fs.readFileSync(path.join(fixtureRoot, name));
            pack.entry({name, size: bytes.length}, bytes);
        }
        for (const name of fs.readdirSync(path.join(fixtureRoot, "blobs", "sha256"))) {
            const bytes = fs.readFileSync(path.join(fixtureRoot, "blobs", "sha256", name));
            pack.entry({name: `blobs/sha256/${name}`, size: bytes.length}, bytes);
        }
        pack.finalize();
        const chunks = [];
        for await (const chunk of pack) chunks.push(chunk);
        fs.writeFileSync(archive, Buffer.concat(chunks));
    };

    const inspectBoth = async (state, platform = PLATFORM) => {
        const fixtureRoot = writeLayout(state);
        const archive = path.join(fixtureRoot, "fixture.oci.tar");
        fs.writeFileSync(archive, await tarBytes(state));
        return Promise.all([
            inspectOciLayout({root: fixtureRoot, platform, sourceSha: SOURCE_SHA, version: VERSION}),
            inspectOciArchive({archive, platform, sourceSha: SOURCE_SHA, version: VERSION})
        ]);
    };

    it("resolves a real BuildKit nested index and validates its OCI attestation", async () => {
        const state = fixture();
        const [layout, archive] = await inspectBoth(state);
        for (const result of [layout, archive]) {
            assert.equal(result.manifestDigest, state.runnable.digest);
            assert.equal(result.configDigest, JSON.parse(state.blobs.get(state.runnable.digest)).config.digest);
            assert.deepEqual(result.layerDigests,
                JSON.parse(state.blobs.get(state.runnable.digest)).layers.map(({digest}) => digest));
        }
        assert.deepEqual(archive.descriptor, state.runnable);
    });

    it("rejects a selected image whose config declares another architecture", async () => {
        await assert.rejects(inspectBoth(fixture({configArchitecture: "arm64"})), /config platform/i);
    });

    it("does not ignore an unknown-platform manifest with a forged attestation reference", async () => {
        await assert.rejects(inspectBoth(fixture({attestationReference: `sha256:${"f".repeat(64)}`})),
            /attestation reference/i);
    });

    it("rejects annotation-shaped entries whose resolved manifest is not the bound OCI attestation", async () => {
        for (const state of [
            fixture({attestationSubjectDigest: `sha256:${"e".repeat(64)}`}),
            fixture({attestationArtifactType: "application/vnd.example.untrusted"})
        ]) await assert.rejects(inspectBoth(state), /attestation subject/i);
    });

    it("rejects invalid attestation config and layer structures", async () => {
        for (const state of [
            fixture({attestationConfigMediaType: "application/vnd.example.config"}),
            fixture({attestationConfigData: "e30K"}),
            fixture({attestationLayerMediaType: "application/json"}),
            fixture({omitAttestationLayers: true})
        ]) await assert.rejects(inspectBoth(state), /attestation/i);
    });

    it("rejects malformed, oversized, duplicate and ambiguous indexes", async () => {
        const fixtureRoot = writeLayout(fixture());
        fs.writeFileSync(path.join(fixtureRoot, "index.json"), "{");
        await assert.rejects(inspectOciLayout({root: fixtureRoot, platform: PLATFORM,
            sourceSha: SOURCE_SHA, version: VERSION}), /invalid.*index.*JSON/i);
        fs.writeFileSync(path.join(fixtureRoot, "index.json"), Buffer.alloc(JSON_LIMIT_BYTES + 1));
        await assert.rejects(inspectOciLayout({root: fixtureRoot, platform: PLATFORM,
            sourceSha: SOURCE_SHA, version: VERSION}), /bounded/i);

        await assert.rejects(inspectBoth(fixture({mutate: ({rootIndex, runnable}) => {
            rootIndex.manifests = [runnable, runnable];
        }})), /duplicate|exactly one/i);
        await assert.rejects(inspectBoth(fixture({mutate: ({rootIndex, runnable, imageIndex}) => {
            rootIndex.manifests = [runnable, {...imageIndex, mediaType: INDEX_MEDIA_TYPE}];
        }})), /ambiguous/i);
    });

    it("validates config and layer size, digest, presence and the image layer bound", async () => {
        for (const state of [fixture({configSizeOffset: 1}), fixture({layerSizeOffset: 1}),
            fixture({mutate: ({blobs, layer}) => blobs.delete(layer.digest)}),
            fixture({mutate: ({blobs, layer}) => blobs.set(layer.digest, Buffer.alloc(layer.size, 120))}),
            fixture({imageLayerCount: MAX_IMAGE_LAYERS + 1})
        ]) await assert.rejects(inspectBoth(state), /config|layer|digest|bounded/i);
        await assert.doesNotReject(inspectBoth(fixture({imageLayerCount: MAX_IMAGE_LAYERS})));
    });

    it("rejects a nested-index descriptor size mismatch", async () => {
        await assert.rejects(inspectBoth(fixture({mutate: ({rootIndex}) => {
            rootIndex.manifests[0].size += 1;
        }})), /descriptor size/i);
    });

    it("rejects index nesting beyond the one BuildKit wrapper level", async () => {
        await assert.rejects(inspectBoth(fixture({mutate: ({blobs, rootIndex, imageIndex}) => {
            const bytes = Buffer.from(JSON.stringify({schemaVersion: 2, mediaType: INDEX_MEDIA_TYPE,
                manifests: [{...imageIndex, mediaType: INDEX_MEDIA_TYPE}]}));
            const digest = sha256(bytes);
            blobs.set(digest, bytes);
            rootIndex.manifests = [{digest, size: bytes.length, mediaType: INDEX_MEDIA_TYPE}];
        }})), /nesting|platform descriptor/i);
    });

    it("combines two nested exports without dropping their attestation descriptors", async () => {
        const sourceStates = [fixture({architecture: "amd64"}), fixture({architecture: "arm64"})];
        const sources = sourceStates.map((state, index) => ({root: writeLayout(state),
            platform: `linux/${index === 0 ? "amd64" : "arm64"}`}));
        const inspectedPlatforms = [];
        for (const source of sources) {
            const archive = path.join(source.root, "source.oci.tar");
            await archiveLayout(source.root, archive);
            inspectedPlatforms.push(await inspectOciArchive({archive, platform: source.platform,
                sourceSha: SOURCE_SHA, version: VERSION}));
        }
        const output = path.join(root, "combined");
        const result = await combineOciLayouts({sources, output});
        assert.deepEqual(result.platforms, ["linux/amd64", "linux/arm64"]);
        const rootIndex = JSON.parse(fs.readFileSync(path.join(output, "index.json")));
        const combinedIndex = JSON.parse(fs.readFileSync(path.join(output, "blobs", "sha256",
            rootIndex.manifests[0].digest.slice(7))));
        assert.equal(combinedIndex.manifests.length, 4);
        assert.deepEqual(combinedIndex.manifests.map(({platform}) => platform.architecture),
            ["amd64", "unknown", "arm64", "unknown"]);

        const archive = path.join(root, "combined.oci.tar");
        await archiveLayout(output, archive);
        await assert.doesNotReject(inspectCombinedOciArchive({archive, platforms: inspectedPlatforms}));

        const attestationLayer = sourceStates[0].statement;
        const attestationLayerPath = path.join(output, "blobs", "sha256",
            attestationLayer.digest.slice(7));
        fs.rmSync(attestationLayerPath);
        const missingAttestationArchive = path.join(root, "combined-missing-attestation.oci.tar");
        await archiveLayout(output, missingAttestationArchive);
        await assert.rejects(inspectCombinedOciArchive({archive: missingAttestationArchive,
            platforms: inspectedPlatforms}), /missing OCI attestation layer blob/i);
        fs.writeFileSync(attestationLayerPath, sourceStates[0].blobs.get(attestationLayer.digest));

        fs.rmSync(path.join(output, "blobs", "sha256", inspectedPlatforms[0].configDigest.slice(7)));
        const incompleteArchive = path.join(root, "combined-incomplete.oci.tar");
        await archiveLayout(output, incompleteArchive);
        await assert.rejects(inspectCombinedOciArchive({archive: incompleteArchive,
            platforms: inspectedPlatforms}), /missing OCI config blob/i);
    });

    it("rejects invalid combined outer and inner index declarations", async () => {
        const sourceStates = [fixture({architecture: "amd64"}), fixture({architecture: "arm64"})];
        const sources = sourceStates.map((state, index) => ({root: writeLayout(state),
            platform: `linux/${index === 0 ? "amd64" : "arm64"}`}));
        const inspectedPlatforms = [];
        for (const source of sources) {
            const archive = path.join(source.root, "source.oci.tar");
            await archiveLayout(source.root, archive);
            inspectedPlatforms.push(await inspectOciArchive({archive, platform: source.platform,
                sourceSha: SOURCE_SHA, version: VERSION}));
        }
        const output = path.join(root, "combined-invalid-index");
        await combineOciLayouts({sources, output});
        const rootPath = path.join(output, "index.json");
        const validRoot = fs.readFileSync(rootPath);
        const invalidRoot = JSON.parse(validRoot);
        invalidRoot.schemaVersion = 1;
        fs.writeFileSync(rootPath, JSON.stringify(invalidRoot));
        const invalidRootArchive = path.join(root, "combined-invalid-root.oci.tar");
        await archiveLayout(output, invalidRootArchive);
        await assert.rejects(inspectCombinedOciArchive({archive: invalidRootArchive,
            platforms: inspectedPlatforms}), /invalid combined OCI layout index/i);

        fs.writeFileSync(rootPath, validRoot);
        const rootIndex = JSON.parse(validRoot);
        const innerPath = path.join(output, "blobs", "sha256", rootIndex.manifests[0].digest.slice(7));
        const inner = JSON.parse(fs.readFileSync(innerPath));
        inner.mediaType = "application/vnd.example.index";
        const invalidInnerBytes = Buffer.from(JSON.stringify(inner));
        const invalidInnerDigest = sha256(invalidInnerBytes);
        fs.writeFileSync(path.join(output, "blobs", "sha256", invalidInnerDigest.slice(7)),
            invalidInnerBytes);
        rootIndex.manifests[0].digest = invalidInnerDigest;
        rootIndex.manifests[0].size = invalidInnerBytes.length;
        fs.writeFileSync(rootPath, JSON.stringify(rootIndex));
        const invalidInnerArchive = path.join(root, "combined-invalid-inner.oci.tar");
        await archiveLayout(output, invalidInnerArchive);
        await assert.rejects(inspectCombinedOciArchive({archive: invalidInnerArchive,
            platforms: inspectedPlatforms}), /invalid combined OCI image index/i);
    });
});
