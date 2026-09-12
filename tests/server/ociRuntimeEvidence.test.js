import {afterEach, beforeEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {
    DOCKER_INSPECT_LIMIT_BYTES,
    inspectDockerRuntimeEvidence
} from "../../scripts/release/docker-runtime-evidence.mjs";

const SOURCE_SHA = "a".repeat(40);
const VERSION = "1.6.1";
const CONTAINER_ID = "c".repeat(64);
const CONFIG_DIGEST = `sha256:${"b".repeat(64)}`;
const SHA256_PREFIX = "sha256:";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ociDigest = (bytes) => `${SHA256_PREFIX}${sha256(bytes)}`;

describe("Docker runtime evidence", () => {
    let root;
    let inspectionPath;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-docker-runtime-"));
        inspectionPath = path.join(root, "container-inspect.json");
    });
    afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

    const writeInspection = (value = [{Id: CONTAINER_ID, Image: CONFIG_DIGEST}]) => {
        const bytes = Buffer.from(JSON.stringify(value));
        fs.writeFileSync(inspectionPath, bytes);
        return bytes;
    };

    it("seals and rechecks one ordinary inspection bound to the OCI config", async () => {
        const bytes = writeInspection();
        const expected = {
            containerId: CONTAINER_ID,
            image: CONFIG_DIGEST,
            inspectionPath: "container-inspect.json",
            inspectionSha256: sha256(bytes),
            inspectionSize: bytes.length
        };

        assert.deepEqual(await inspectDockerRuntimeEvidence({
            file: inspectionPath,
            expectedConfigDigest: CONFIG_DIGEST,
            sidecar: "create"
        }), expected);
        assert.equal(fs.readFileSync(`${inspectionPath}.sha256`, "utf8"), `${sha256(bytes)}\n`);
        assert.deepEqual(await inspectDockerRuntimeEvidence({
            file: inspectionPath,
            expectedConfigDigest: CONFIG_DIGEST,
            sidecar: "require"
        }), expected);
    });

    it("rejects missing, substituted, multiple and malformed inspection records", async () => {
        for (const value of [
            [],
            [{Id: CONTAINER_ID, Image: CONFIG_DIGEST}, {Id: "d".repeat(64), Image: CONFIG_DIGEST}],
            [{Image: CONFIG_DIGEST}],
            [{Id: "not-a-container-id", Image: CONFIG_DIGEST}],
            [{Id: CONTAINER_ID, Image: `sha256:${"9".repeat(64)}`}]
        ]) {
            writeInspection(value);
            await assert.rejects(inspectDockerRuntimeEvidence({
                file: inspectionPath,
                expectedConfigDigest: CONFIG_DIGEST,
                sidecar: "create"
            }), /Docker|container|inspection|image/i);
            assert.equal(fs.existsSync(`${inspectionPath}.sha256`), false);
        }

        fs.writeFileSync(inspectionPath, "not-json");
        await assert.rejects(inspectDockerRuntimeEvidence({
            file: inspectionPath,
            expectedConfigDigest: CONFIG_DIGEST,
            sidecar: "create"
        }), /JSON/i);
    });

    it("rejects missing or substituted sidecars, links and oversized inputs", async () => {
        writeInspection();
        await assert.rejects(inspectDockerRuntimeEvidence({
            file: inspectionPath,
            expectedConfigDigest: CONFIG_DIGEST,
            sidecar: "require"
        }), /sidecar|sha256/i);

        fs.writeFileSync(`${inspectionPath}.sha256`, `${"0".repeat(64)}\n`);
        await assert.rejects(inspectDockerRuntimeEvidence({
            file: inspectionPath,
            expectedConfigDigest: CONFIG_DIGEST,
            sidecar: "require"
        }), /digest|sha256/i);

        fs.rmSync(inspectionPath);
        const target = path.join(root, process.platform === "win32" ? "target" : "target.json");
        if (process.platform === "win32") fs.mkdirSync(target);
        else fs.writeFileSync(target, JSON.stringify([{Id: CONTAINER_ID, Image: CONFIG_DIGEST}]));
        fs.symlinkSync(target, inspectionPath, process.platform === "win32" ? "junction" : "file");
        await assert.rejects(inspectDockerRuntimeEvidence({
            file: inspectionPath,
            expectedConfigDigest: CONFIG_DIGEST,
            sidecar: "create"
        }), /ordinary|symbolic|link/i);

        fs.rmSync(inspectionPath);
        fs.writeFileSync(inspectionPath, "{");
        fs.truncateSync(inspectionPath, DOCKER_INSPECT_LIMIT_BYTES + 1);
        await assert.rejects(inspectDockerRuntimeEvidence({
            file: inspectionPath,
            expectedConfigDigest: CONFIG_DIGEST,
            sidecar: "create"
        }), /size|limit|bounded/i);
    });

    it("writes CLI provenance that binds Docker runtime identity to OCI config bytes", () => {
        const ociRoot = path.join(root, "oci");
        const blobs = path.join(ociRoot, "blobs", "sha256");
        fs.mkdirSync(blobs, {recursive: true});
        const writeBlob = (bytes) => {
            const digest = ociDigest(bytes);
            fs.writeFileSync(path.join(blobs, digest.slice(SHA256_PREFIX.length)), bytes);
            return {digest, size: bytes.length};
        };
        const config = writeBlob(Buffer.from('{"architecture":"amd64","os":"linux"}'));
        const layer = writeBlob(Buffer.from("layer"));
        const manifest = writeBlob(Buffer.from(JSON.stringify({schemaVersion: 2, config, layers: [layer]})));
        fs.writeFileSync(path.join(ociRoot, "index.json"), JSON.stringify({schemaVersion: 2, manifests: [{
            ...manifest,
            platform: {os: "linux", architecture: "amd64"}
        }]}));

        fs.writeFileSync(inspectionPath, JSON.stringify([{Id: CONTAINER_ID, Image: config.digest}]));
        const output = path.join(root, "oci-provenance.json");
        const result = spawnSync(process.execPath, [
            "scripts/release/inspect-oci.mjs",
            "--root", ociRoot,
            "--platform", "linux/amd64",
            "--output", output,
            "--container-inspect", inspectionPath
        ], {
            cwd: path.resolve(import.meta.dirname, "..", ".."),
            encoding: "utf8",
            env: {...process.env, SOURCE_SHA, VERSION}
        });

        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        const provenance = JSON.parse(fs.readFileSync(output));
        assert.equal(provenance.configDigest, config.digest);
        assert.equal(provenance.runtimeDocker.containerId, CONTAINER_ID);
        assert.equal(provenance.runtimeDocker.image, config.digest);
        assert.match(provenance.runtimeDocker.inspectionSha256, /^[a-f0-9]{64}$/);
        assert.equal(fs.readFileSync(`${inspectionPath}.sha256`, "utf8").trim(),
            provenance.runtimeDocker.inspectionSha256);
    });
});
