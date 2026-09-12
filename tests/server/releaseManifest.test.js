import {afterEach, beforeEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import tarStream from "tar-stream";
import {createQualificationManifest, readSealedQualificationManifest, validateQualificationManifest}
    from "../../scripts/release/qualification-manifest.mjs";
import {validateQualificationInputs} from "../../scripts/release/validate-inputs.mjs";
import {inspectOciLayout} from "../../scripts/release/inspect-oci.mjs";
import {inspectCombinedOciArchive} from "../../scripts/release/inspect-oci-archive.mjs";
import {combineOciLayouts} from "../../scripts/release/combine-oci-layouts.mjs";
import {readSource} from "../helpers/source.js";

const SHA = "a".repeat(40);
const VERSION = "1.6.1";
const WINDOWS_STAMP = "1.6.1.4321";
const RUN_ID = 123456;
const RUN_ATTEMPT = 1;
const REPOSITORY = "i7Gamer/MySpeed";
const ARCHIVE_DIGEST = `sha256:${"b".repeat(64)}`;
const SUCCESS_EVIDENCE = {tests: "success", binaries: "success", msi: "success",
    docker: "success", dockerIndex: "success", ice: "success"};
const FULL_MODE = "full";
const RESET_MODE = "listener-free-reset";

const artifacts = [
    ["MySpeed-windows-x64.exe", "MySpeed.exe"],
    ["MySpeed-windows-x64-baseline.exe", "MySpeed.exe"],
    ["MySpeed-linux-x64", "MySpeed-linux-x64"],
    ["MySpeed-linux-x64-baseline", "MySpeed-linux-x64-baseline"],
    ["MySpeed-linux-arm64", "MySpeed-linux-arm64"],
    ["MySpeed-macos-x64", "MySpeed-macos-x64"],
    ["MySpeed-macos-arm64", "MySpeed-macos-arm64"],
    ["MySpeed.zip", "MySpeed.zip"],
    ["release-msi-MySpeed-installer.msi", "MySpeed-installer.msi"],
    ["release-msi-MySpeed-installer-baseline.msi", "MySpeed-installer.msi"],
    ["release-static", "install.sh"],
    ["release-static", "docker-install.sh"],
    ["release-static", "chooser.sh"],
    ["qualified-oci-amd64", "myspeed-amd64.oci.tar"],
    ["qualified-oci-arm64", "myspeed-arm64.oci.tar"],
    ["qualified-oci-index", "myspeed-multiarch.oci.tar"]
];

const digest = (contents) => createHash("sha256").update(contents).digest("hex");
const ociDigest = (contents) => `sha256:${digest(contents)}`;

const tarBytes = async (entries) => {
    const pack = tarStream.pack();
    for (const [name, contents] of entries)
        pack.entry({name, size: contents.length, mode: 0o644}, contents);
    pack.finalize();
    const chunks = [];
    for await (const chunk of pack) chunks.push(chunk);
    return Buffer.concat(chunks);
};

const platformOciFixture = async (architecture) => {
    const config = Buffer.from(JSON.stringify({architecture, os: "linux"}));
    const layer = Buffer.from(`layer-${architecture}`);
    const configDigest = ociDigest(config);
    const layerDigest = ociDigest(layer);
    const manifest = Buffer.from(JSON.stringify({schemaVersion: 2,
        config: {digest: configDigest, size: config.length},
        layers: [{digest: layerDigest, size: layer.length}]}));
    const manifestDigest = ociDigest(manifest);
    const descriptor = {mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: manifestDigest, size: manifest.length, platform: {os: "linux", architecture}};
    const index = Buffer.from(JSON.stringify({schemaVersion: 2, manifests: [descriptor]}));
    const entries = [
        ["oci-layout", Buffer.from('{"imageLayoutVersion":"1.0.0"}')],
        ["index.json", index],
        [`blobs/sha256/${configDigest.slice(7)}`, config],
        [`blobs/sha256/${layerDigest.slice(7)}`, layer],
        [`blobs/sha256/${manifestDigest.slice(7)}`, manifest]
    ];
    return {archive: await tarBytes(entries), descriptor, entries,
        provenance: {sourceSha: SHA, version: VERSION, platform: `linux/${architecture}`,
            verification: "success", indexDigest: ociDigest(index), manifestDigest,
            configDigest, layerDigests: [layerDigest]}};
};

const writeCheckedFile = (directory, file, contents) => {
    const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    fs.writeFileSync(path.join(directory, file), bytes);
    fs.writeFileSync(path.join(directory, `${file}.sha256`), `${digest(bytes)}\n`);
};

describe("qualification manifest", () => {
    let root;
    let output;
    let artifactMetadata;

    beforeEach(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-release-manifest-"));
        output = path.join(root, "summary");
        const names = [...new Set(artifacts.map(([name]) => name))];
        artifactMetadata = {artifacts: names.map((name, index) => ({
            id: index + 1, name, digest: ARCHIVE_DIGEST, expired: false, size_in_bytes: 1024
        }))};

        for (const [artifact, file] of artifacts) {
            const directory = path.join(root, artifact);
            fs.mkdirSync(directory, {recursive: true});
            const contents = Buffer.from(`${artifact}:${file}`);
            writeCheckedFile(directory, file, contents);
        }
        const binaryEvidence = [
            ["MySpeed-windows-x64.exe", "win32", "x64", RESET_MODE],
            ["MySpeed-windows-x64-baseline.exe", "win32", "x64", RESET_MODE],
            ["MySpeed-linux-x64", "linux", "x64", FULL_MODE],
            ["MySpeed-linux-x64-baseline", "linux", "x64", FULL_MODE],
            ["MySpeed-linux-arm64", "linux", "arm64", FULL_MODE],
            ["MySpeed-macos-x64", "darwin", "x64", RESET_MODE],
            ["MySpeed-macos-arm64", "darwin", "arm64", RESET_MODE]
        ];
        for (const [artifact, platform, architecture, mode] of binaryEvidence) {
            const [payload] = artifacts.filter(([name]) => name === artifact).map(([, file]) => file);
            const payloadDigest = digest(fs.readFileSync(path.join(root, artifact, payload)));
            writeCheckedFile(path.join(root, artifact), "qualification-summary.json", JSON.stringify({
                status: "passed", exit: 0, mode, sourceSha: SHA, commit: SHA, platform, architecture,
                artifactSha256: payloadDigest, command: [`/${payload}`], processes: mode === FULL_MODE
                    ? [{scenario: "populated-first-boot"}, {scenario: "populated-restart"},
                        {scenario: "fresh-no-config-reset"}]
                    : [{scenario: "listener-free-reset"}]
            }));
            if (platform === "win32") writeCheckedFile(path.join(root, artifact),
                "windows-version.json", JSON.stringify({fileVersion: WINDOWS_STAMP,
                    productVersion: WINDOWS_STAMP, windowsStamp: WINDOWS_STAMP,
                    artifactSha256: payloadDigest}));
        }
        for (const runtime of ["node", "bun"]) {
            writeCheckedFile(path.join(root, "MySpeed.zip"), `qualification-${runtime}-summary.json`,
                JSON.stringify({status: "passed", exit: 0, mode: FULL_MODE, sourceSha: SHA, commit: null,
                    platform: "linux", architecture: "x64", artifactSha256: "2".repeat(64),
                    command: [`/usr/local/bin/${runtime}`, "/source/server/index.js"],
                    processes: [{scenario: "populated-first-boot"}, {scenario: "populated-restart"},
                        {scenario: "fresh-no-config-reset"}]}));
        }
        const platformFixtures = [];
        for (const architecture of ["amd64", "arm64"]) {
            const directory = path.join(root, `qualified-oci-${architecture}`);
            const fixture = await platformOciFixture(architecture);
            platformFixtures.push(fixture);
            writeCheckedFile(directory, `myspeed-${architecture}.oci.tar`, fixture.archive);
            const inspection = JSON.stringify([{
                Id: "c".repeat(64), Image: fixture.provenance.configDigest,
            }]);
            writeCheckedFile(directory, "container-inspect.json", inspection);
            fixture.provenance.runtimeDocker = {
                containerId: "c".repeat(64),
                image: fixture.provenance.configDigest,
                inspectionPath: "container-inspect.json",
                inspectionSha256: digest(Buffer.from(inspection)),
                inspectionSize: Buffer.byteLength(inspection)
            };
            fs.writeFileSync(path.join(directory, "oci-provenance.json"),
                JSON.stringify(fixture.provenance));
            writeCheckedFile(directory, "qualification-summary.json", JSON.stringify({
                status: "passed", exit: 0, mode: FULL_MODE, sourceSha: SHA, commit: null, platform: "linux",
                architecture: architecture === "amd64" ? "x64" : architecture,
                artifactSha256: "3".repeat(64),
                command: ["/usr/local/bin/docker-entrypoint.sh", "bun", "run", "server/index.js"],
                processes: [{scenario: "populated-first-boot"}, {scenario: "populated-restart"},
                    {scenario: "fresh-no-config-reset"}]
            }));
        }
        for (const artifact of ["release-msi-MySpeed-installer.msi",
            "release-msi-MySpeed-installer-baseline.msi"])
            writeCheckedFile(path.join(root, artifact), "ice-validation.log", "ICE validation passed\n");
        for (const [artifact, binaryArtifact] of [
            ["release-msi-MySpeed-installer.msi", "MySpeed-windows-x64.exe"],
            ["release-msi-MySpeed-installer-baseline.msi", "MySpeed-windows-x64-baseline.exe"]
        ]) {
            const directory = path.join(root, artifact);
            const binary = path.join(root, binaryArtifact, "MySpeed.exe");
            const installer = path.join(directory, "MySpeed-installer.msi");
            const ice = path.join(directory, "ice-validation.log");
            writeCheckedFile(directory, "msi-build-provenance.json", JSON.stringify({
                sourceSha: SHA, version: VERSION, windowsStamp: WINDOWS_STAMP,
                binarySha256: digest(fs.readFileSync(binary)),
                installerSha256: digest(fs.readFileSync(installer)), iceSha256: digest(fs.readFileSync(ice))
            }));
        }
        const descriptors = platformFixtures.map(({descriptor}) => descriptor)
            .sort((left, right) => left.platform.architecture.localeCompare(right.platform.architecture));
        const imageIndex = Buffer.from(JSON.stringify({schemaVersion: 2,
            mediaType: "application/vnd.oci.image.index.v1+json", manifests: descriptors}));
        const indexDigest = ociDigest(imageIndex);
        const layoutIndex = Buffer.from(JSON.stringify({schemaVersion: 2, manifests: [{
            mediaType: "application/vnd.oci.image.index.v1+json", digest: indexDigest,
            size: imageIndex.length, annotations: {"org.opencontainers.image.ref.name": "myspeed"}
        }]}));
        const combinedEntries = [["oci-layout", Buffer.from('{"imageLayoutVersion":"1.0.0"}')],
            ["index.json", layoutIndex], [`blobs/sha256/${indexDigest.slice(7)}`, imageIndex]];
        for (const fixture of platformFixtures)
            for (const entry of fixture.entries.slice(2))
                if (!combinedEntries.some(([name]) => name === entry[0])) combinedEntries.push(entry);
        const indexDirectory = path.join(root, "qualified-oci-index");
        writeCheckedFile(indexDirectory, "myspeed-multiarch.oci.tar", await tarBytes(combinedEntries));
        fs.writeFileSync(path.join(indexDirectory, "oci-index-provenance.json"),
            JSON.stringify({sourceSha: SHA, version: VERSION, indexDigest,
                reference: "myspeed", platforms: ["linux/amd64", "linux/arm64"]}));
    });

    afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

    const options = (overrides = {}) => ({root, output, artifactMetadata, candidateSha: SHA,
        version: VERSION, windowsStamp: WINDOWS_STAMP, runId: RUN_ID, runAttempt: RUN_ATTEMPT,
        repository: REPOSITORY, evidence: SUCCESS_EVIDENCE, ...overrides});

    it("records immutable run, source, artifact IDs, hashes and OCI content digests", async () => {
        const manifest = await createQualificationManifest(options());
        assert.deepEqual(manifest.source, {repository: REPOSITORY, sha: SHA, version: VERSION,
            windowsStamp: WINDOWS_STAMP});
        assert.deepEqual(manifest.run, {id: RUN_ID, attempt: RUN_ATTEMPT});
        assert.equal(manifest.promotion.eligible, false);
        assert.deepEqual(manifest.promotion.evidence, {
            macosNative: null, msiLifecycle: null, windowsCpuFloor: null, windowsNative: null
        });
        assert.equal(manifest.promotion.blockers.length, 4);
        assert.equal(manifest.runtimeVerification.linux.length, 3);
        assert.equal(manifest.runtimeVerification.windows.length, 2);
        assert.equal(manifest.runtimeVerification.macos.length, 2);
        assert.equal(manifest.runtimeVerification.docker.length, 2);
        assert.ok(manifest.runtimeVerification.docker.every(({runtimeDocker}) =>
            manifest.containers.some(({configDigest}) => configDigest === runtimeDocker.image)
            && runtimeDocker.inspectionPath === "container-inspect.json"
            && /^[a-f0-9]{64}$/.test(runtimeDocker.containerId)
            && /^[a-f0-9]{64}$/.test(runtimeDocker.inspectionSha256)));
        assert.deepEqual(Object.keys(manifest.runtimeVerification.source).sort(), ["bun", "node"]);
        assert.equal(manifest.runtimeVerification.wixIce.length, 2);
        assert.ok(manifest.runtimeVerification.linux.every(({mode, summarySha256}) =>
            mode === FULL_MODE && /^[a-f0-9]{64}$/.test(summarySha256)));
        assert.ok(manifest.runtimeVerification.windows.every(({mode}) => mode === RESET_MODE));
        assert.ok(manifest.runtimeVerification.windows.every(({versionEvidenceSha256}) =>
            /^[a-f0-9]{64}$/.test(versionEvidenceSha256)));
        assert.equal(manifest.actionsArtifacts.length, artifactMetadata.artifacts.length);
        assert.equal(manifest.releaseAssets.length, 13);
        assert.equal(manifest.containers.length, 2);
        assert.ok(manifest.actionsArtifacts.every(({id, archiveDigest}) => id > 0 && archiveDigest === ARCHIVE_DIGEST));
        assert.ok(fs.existsSync(path.join(output, "SHA256SUMS")));
        assert.ok(fs.existsSync(path.join(output, "qualification-manifest.json.sha256")));
        await assert.doesNotReject(readSealedQualificationManifest(output));
        await assert.doesNotReject(validateQualificationManifest({...options(), manifest,
            summaryDirectory: output}));
    });

    it("rejects an altered sealed manifest", async () => {
        await createQualificationManifest(options());
        fs.appendFileSync(path.join(output, "qualification-manifest.json"), " ");
        await assert.rejects(readSealedQualificationManifest(output), /digest/i);
    });

    for (const defect of ["missing", "empty", "non-file", "wrong-digest", "missing-digest"]) {
        it(`fails closed for a ${defect} release payload`, async () => {
            const file = path.join(root, "MySpeed-linux-arm64", "MySpeed-linux-arm64");
            if (defect === "missing") fs.unlinkSync(file);
            if (defect === "empty") fs.writeFileSync(file, "");
            if (defect === "non-file") {
                fs.unlinkSync(file);
                fs.mkdirSync(file);
            }
            if (defect === "wrong-digest") fs.writeFileSync(file, "changed");
            if (defect === "missing-digest") fs.unlinkSync(`${file}.sha256`);
            await assert.rejects(createQualificationManifest(options()), /missing|empty|file|digest|sha256/i);
        });
    }

    it("fails for missing, expired or duplicate Actions artifacts", async () => {
        for (const mutate of [
            (items) => items.filter(({name}) => name !== "MySpeed.zip"),
            (items) => items.map((item) => item.name === "MySpeed.zip" ? {...item, expired: true} : item),
            (items) => items.map((item) => item.name === "MySpeed.zip"
                ? {...item, size_in_bytes: Number.MAX_SAFE_INTEGER} : item),
            (items) => [...items, {...items[0], id: 999}]
        ]) await assert.rejects(createQualificationManifest(options({
            artifactMetadata: {artifacts: mutate(artifactMetadata.artifacts)}
        })), /artifact|expired|duplicate/i);
    });

    it("fails when any mandatory qualification evidence failed or was skipped", async () => {
        for (const result of ["failure", "skipped", "cancelled", ""])
            await assert.rejects(createQualificationManifest(options({
                evidence: {...SUCCESS_EVIDENCE, ice: result}
            })), /evidence|ice|success/i);
    });

    for (const defect of ["missing", "tampered-sidecar", "failed", "wrong-mode", "wrong-artifact-hash"]) {
        it(`rejects ${defect} retained verifier evidence`, async () => {
            const artifact = "MySpeed-linux-x64";
            const summaryPath = path.join(root, artifact, "qualification-summary.json");
            if (defect === "missing") fs.unlinkSync(summaryPath);
            if (defect === "tampered-sidecar") fs.writeFileSync(`${summaryPath}.sha256`, `${"0".repeat(64)}\n`);
            if (["failed", "wrong-mode", "wrong-artifact-hash"].includes(defect)) {
                const summary = JSON.parse(fs.readFileSync(summaryPath));
                if (defect === "failed") summary.status = "failed";
                if (defect === "wrong-mode") summary.mode = RESET_MODE;
                if (defect === "wrong-artifact-hash") summary.artifactSha256 = "0".repeat(64);
                writeCheckedFile(path.dirname(summaryPath), path.basename(summaryPath), JSON.stringify(summary));
            }
            await assert.rejects(createQualificationManifest(options()),
                /evidence|summary|digest|mode|status|artifact/i);
        });
    }

    it("rejects missing or tampered ICE evidence", async () => {
        const log = path.join(root, "release-msi-MySpeed-installer.msi", "ice-validation.log");
        fs.unlinkSync(`${log}.sha256`);
        await assert.rejects(createQualificationManifest(options()), /ice|sha256|missing/i);
    });

    it("rejects MSI evidence not bound to the frozen executable stamp", async () => {
        const directory = path.join(root, "release-msi-MySpeed-installer.msi");
        const file = "msi-build-provenance.json";
        const provenance = JSON.parse(fs.readFileSync(path.join(directory, file)));
        provenance.windowsStamp = "1.6.1.4322";
        writeCheckedFile(directory, file, JSON.stringify(provenance));
        await assert.rejects(createQualificationManifest(options()), /MSI|stamp|provenance/i);
    });

    it("rejects Windows resource evidence not bound to the executable bytes and frozen stamp", async () => {
        const directory = path.join(root, "MySpeed-windows-x64.exe");
        const file = "windows-version.json";
        const versionEvidence = JSON.parse(fs.readFileSync(path.join(directory, file)));
        versionEvidence.productVersion = "1.6.1.4322";
        writeCheckedFile(directory, file, JSON.stringify(versionEvidence));
        await assert.rejects(createQualificationManifest(options()), /Windows|version|stamp/i);
    });

    it("rejects fabricated OCI provenance that is not derived from archive bytes", async () => {
        const directory = path.join(root, "qualified-oci-amd64");
        const provenancePath = path.join(directory, "oci-provenance.json");
        const provenance = JSON.parse(fs.readFileSync(provenancePath));
        provenance.manifestDigest = `sha256:${"9".repeat(64)}`;
        fs.writeFileSync(provenancePath, JSON.stringify(provenance));
        await assert.rejects(createQualificationManifest(options()), /OCI|archive|digest|provenance/i);
    });

    for (const defect of ["wrong-image", "missing-id", "empty", "multiple", "missing-proof"])
        it(`rejects unbound Docker runtime evidence: ${defect}`, async () => {
            const directory = path.join(root, "qualified-oci-amd64");
            const file = "container-inspect.json";
            const inspection = JSON.parse(fs.readFileSync(path.join(directory, file)));
            if (defect === "wrong-image") inspection[0].Image = `sha256:${"9".repeat(64)}`;
            if (defect === "missing-id") delete inspection[0].Id;
            if (defect === "empty") inspection.length = 0;
            if (defect === "multiple") inspection.push({...inspection[0]});
            writeCheckedFile(directory, file, JSON.stringify(inspection));
            if (defect === "missing-proof") fs.unlinkSync(path.join(directory, file));
            await assert.rejects(createQualificationManifest(options()), /container|runtime|image/i);
        });

    it("rejects stale or substituted source, version, stamp, run and repository metadata", async () => {
        const manifest = await createQualificationManifest(options());
        for (const changed of [
            {candidateSha: "b".repeat(40)}, {version: "1.6.2"}, {windowsStamp: "1.6.1.4322"},
            {runId: RUN_ID + 1}, {runAttempt: RUN_ATTEMPT + 1}, {repository: "fork/MySpeed"}
        ]) await assert.rejects(validateQualificationManifest({...options(changed), manifest,
            summaryDirectory: output}),
            /source|version|stamp|run|repository|mismatch/i);
    });

    it("rejects a substituted release checksum list", async () => {
        const manifest = await createQualificationManifest(options());
        fs.writeFileSync(path.join(output, "SHA256SUMS"), `${"0".repeat(64)}  MySpeed.zip\n`);
        await assert.rejects(validateQualificationManifest({...options(), manifest,
            summaryDirectory: output}), /checksum|SHA256SUMS/i);
    });

    it("rejects path traversal in artifact metadata before reading payloads", async () => {
        const poisoned = structuredClone(artifactMetadata);
        poisoned.artifacts[0].name = "../outside";
        await assert.rejects(createQualificationManifest(options({artifactMetadata: poisoned})),
            /unsafe|artifact|path/i);
    });

    it("allows only the two compatibility alias digest collisions", async () => {
        const left = path.join(root, "MySpeed-linux-x64", "MySpeed-linux-x64");
        const right = path.join(root, "MySpeed-linux-x64-baseline", "MySpeed-linux-x64-baseline");
        fs.copyFileSync(left, right);
        fs.copyFileSync(`${left}.sha256`, `${right}.sha256`);
        const summaryFile = path.join(root, "MySpeed-linux-x64-baseline", "qualification-summary.json");
        const summary = JSON.parse(fs.readFileSync(summaryFile));
        summary.artifactSha256 = digest(fs.readFileSync(right));
        writeCheckedFile(path.dirname(summaryFile), path.basename(summaryFile), JSON.stringify(summary));
        await assert.doesNotReject(createQualificationManifest(options()));

        const unrelated = path.join(root, "MySpeed-linux-arm64", "MySpeed-linux-arm64");
        fs.copyFileSync(left, unrelated);
        fs.copyFileSync(`${left}.sha256`, `${unrelated}.sha256`);
        await assert.rejects(createQualificationManifest(options()), /duplicate|collision/i);
    });
});

describe("qualification input validation", () => {
    let root;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-release-inputs-"));
        fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({version: VERSION}));
        fs.mkdirSync(path.join(root, "client"));
        fs.writeFileSync(path.join(root, "client", "package.json"), JSON.stringify({version: VERSION}));
    });

    afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

    it("accepts an exact checkout, package versions and frozen Windows stamp", async () => {
        await assert.doesNotReject(validateQualificationInputs({root, expectedSha: SHA, actualSha: SHA,
            version: VERSION, windowsStamp: WINDOWS_STAMP}));
    });

    it("rejects a substituted checkout, package version or Windows stamp", async () => {
        for (const overrides of [
            {actualSha: "b".repeat(40)},
            {version: "1.6.2"},
            {windowsStamp: "1.6.2.4322"}
        ]) await assert.rejects(validateQualificationInputs({root, expectedSha: SHA, actualSha: SHA,
            version: VERSION, windowsStamp: WINDOWS_STAMP, ...overrides}),
        /checked|version|stamp/i);

        fs.writeFileSync(path.join(root, "client", "package.json"), JSON.stringify({version: "1.6.2"}));
        await assert.rejects(validateQualificationInputs({root, expectedSha: SHA, actualSha: SHA,
            version: VERSION, windowsStamp: WINDOWS_STAMP}), /version/i);
    });
});

describe("OCI provenance inspection", () => {
    let root;

    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-oci-layout-")); });
    afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

    const blob = (contents) => {
        const hash = digest(contents);
        const blobPath = path.join(root, "blobs", "sha256", hash);
        fs.mkdirSync(path.dirname(blobPath), {recursive: true});
        fs.writeFileSync(blobPath, contents);
        return `sha256:${hash}`;
    };

    it("binds verified platform config, layers and manifest bytes", async () => {
        const config = Buffer.from(JSON.stringify({os: "linux", architecture: "amd64"}));
        const configDigest = blob(config);
        const layer = Buffer.from("layer");
        const layerDigest = blob(layer);
        const manifest = Buffer.from(JSON.stringify({schemaVersion: 2,
            config: {digest: configDigest, size: config.length},
            layers: [{digest: layerDigest, size: layer.length}]}));
        const manifestDigest = blob(manifest);
        fs.writeFileSync(path.join(root, "index.json"), JSON.stringify({schemaVersion: 2, manifests: [{
            digest: manifestDigest, size: manifest.length,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            platform: {os: "linux", architecture: "amd64"}
        }]}));

        const result = await inspectOciLayout({root, platform: "linux/amd64", sourceSha: SHA,
            version: VERSION});
        assert.equal(result.manifestDigest, manifestDigest);
        assert.equal(result.configDigest, configDigest);
        assert.deepEqual(result.layerDigests, [layerDigest]);
        assert.match(result.indexDigest, /^sha256:[a-f0-9]{64}$/);
    });

    it("rejects a missing platform and altered blob", async () => {
        const manifestDigest = blob(Buffer.from(JSON.stringify({schemaVersion: 2,
            config: {digest: `sha256:${"a".repeat(64)}`}, layers: []})));
        const manifestSize = fs.statSync(path.join(root, "blobs", "sha256", manifestDigest.slice(7))).size;
        fs.writeFileSync(path.join(root, "index.json"), JSON.stringify({schemaVersion: 2, manifests: [{
            digest: manifestDigest, size: manifestSize,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            platform: {os: "linux", architecture: "arm64"}
        }]}));
        await assert.rejects(inspectOciLayout({root, platform: "linux/amd64", sourceSha: SHA,
            version: VERSION}), /platform/i);
        fs.writeFileSync(path.join(root, "blobs", "sha256", manifestDigest.slice(7)), "altered");
        await assert.rejects(inspectOciLayout({root, platform: "linux/arm64", sourceSha: SHA,
            version: VERSION}), /digest|descriptor size/i);
    });
});

describe("multi-platform OCI index", () => {
    let root;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-oci-index-")); });
    afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

    const layout = (architecture) => {
        const directory = path.join(root, architecture);
        const writeBlob = (bytes) => {
            const hash = digest(bytes);
            const target = path.join(directory, "blobs", "sha256", hash);
            fs.mkdirSync(path.dirname(target), {recursive: true});
            fs.writeFileSync(target, bytes);
            return {digest: `sha256:${hash}`, size: bytes.length};
        };
        const config = writeBlob(Buffer.from(JSON.stringify({os: "linux", architecture})));
        const layer = writeBlob(Buffer.from(`layer-${architecture}`));
        const manifestBytes = Buffer.from(JSON.stringify({schemaVersion: 2, config, layers: [layer]}));
        const manifest = writeBlob(manifestBytes);
        fs.writeFileSync(path.join(directory, "index.json"), JSON.stringify({schemaVersion: 2,
            manifests: [{...manifest, mediaType: "application/vnd.oci.image.manifest.v1+json",
                platform: {os: "linux", architecture}}]}));
        return directory;
    };

    it("combines the two verified platform manifests without changing their digests", async () => {
        const output = path.join(root, "combined");
        const result = await combineOciLayouts({sources: [
            {root: layout("amd64"), platform: "linux/amd64"},
            {root: layout("arm64"), platform: "linux/arm64"}
        ], output});
        assert.deepEqual(result.platforms, ["linux/amd64", "linux/arm64"]);
        assert.match(result.indexDigest, /^sha256:[a-f0-9]{64}$/);
        assert.equal(result.reference, "myspeed");
        const layoutIndex = JSON.parse(fs.readFileSync(path.join(output, "index.json")));
        assert.equal(layoutIndex.manifests.length, 1);
        const imageIndex = JSON.parse(fs.readFileSync(path.join(output, "blobs", "sha256",
            layoutIndex.manifests[0].digest.slice("sha256:".length))));
        assert.equal(imageIndex.manifests.length, 2);
    });

    it("archives explicit OCI members without GNU tar's rejected root entry", async () => {
        const output = path.join(root, "combined");
        const amd64 = layout("amd64");
        const arm64 = layout("arm64");
        const sources = [
            {root: amd64, platform: "linux/amd64"},
            {root: arm64, platform: "linux/arm64"}
        ];
        await combineOciLayouts({sources, output});
        const platforms = sources.map(({root: sourceRoot}) => ({
            descriptor: JSON.parse(fs.readFileSync(path.join(sourceRoot, "index.json"))).manifests[0]
        }));
        const archive = path.join(root, "combined.oci.tar");
        const tar = spawnSync("tar", ["-cf", archive, "-C", output, "oci-layout", "index.json", "blobs"], {
            encoding: "utf8"
        });
        assert.equal(tar.status, 0, `${tar.stdout}\n${tar.stderr}`);
        await assert.doesNotReject(inspectCombinedOciArchive({archive, platforms}));

        const workflow = readSource(".github/workflows/qualify-release.yml");
        assert.match(workflow, /-C "\$RUNNER_TEMP\/index" oci-layout index\.json blobs/);
        assert.doesNotMatch(workflow, /-C "\$RUNNER_TEMP\/index" \./);
    });
});
