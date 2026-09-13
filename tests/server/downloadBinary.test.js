import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { downloadBinary, EXECUTABLE_MODE } from "../../server/util/providers/downloadHelper.js";

/**
 * A release asset that is the executable itself.
 *
 * The three CLIs that came before all publish archives, so every path here
 * unpacked something. iperf3's static builds are published as bare binaries -
 * `iperf3-amd64` - and the extractor's answer to one is "nothing matching
 * /iperf3/ was found", which is true and explains nothing.
 *
 * What matters is the order: the digest is checked while the file is still
 * staged, and only a file that passed is put where the runner will spawn it.
 */

const PAYLOAD = Buffer.from("#!/bin/sh\necho measured\n");
const DIGEST = createHash("sha256").update(PAYLOAD).digest("hex");

let workDir;

// A stubbed https.get: answers 200 with the payload, and records what was asked
// for. Shaped like the real one - a ClientRequest with an 'error' listener and
// setTimeout - because downloadToFile uses both.
const serving = (body = PAYLOAD, statusCode = 200) => {
    const asked = [];

    const client = (url, onResponse) => {
        asked.push(String(url));

        const response = Readable.from([body]);
        response.statusCode = statusCode;
        response.headers = {};
        // `resume` is deliberately the stream's own: pipe() calls it to start
        // the flow, so a stub that no-ops it leaves the download hanging for
        // ever with nothing to say why.

        queueMicrotask(() => onResponse(response));

        return {on: () => undefined, setTimeout: () => undefined};
    };

    return {client, asked};
};

const stagedIn = () => {
    const staged = [];

    return {
        staged,
        tmp: () => {
            const file = path.join(workDir, "staged-" + randomBytes(6).toString("hex"));
            staged.push(file);
            return file;
        }
    };
};

beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-binary-"));
});

afterEach(() => {
    fs.rmSync(workDir, {recursive: true, force: true});
});

describe("downloading a bare executable", () => {
    it("puts the file where it was asked to", async () => {
        const outputPath = path.join(workDir, "bin", "iperf3");
        const {client, asked} = serving();

        await downloadBinary("https://example.test/iperf3-amd64",
            {outputPath, sha256: DIGEST, client, tmp: stagedIn().tmp});

        assert.deepEqual(asked, ["https://example.test/iperf3-amd64"]);
        assert.deepEqual(fs.readFileSync(outputPath), PAYLOAD);
    });

    // ./bin does not exist on a fresh checkout, and a download that fails on
    // ENOENT for the directory reads as a download that failed.
    it("makes the directory it is writing into", async () => {
        const outputPath = path.join(workDir, "deep", "nested", "iperf3");
        const {client} = serving();

        await downloadBinary("https://example.test/iperf3", {outputPath, sha256: DIGEST, client,
            tmp: stagedIn().tmp});

        assert.ok(fs.existsSync(outputPath));
    });

    /**
     * The check is the whole point: this file is spawned by the server on a
     * schedule, so a replaced upstream asset is arbitrary code on the
     * operator's machine for as long as the instance runs. Nothing unverified
     * may ever exist at the path the runner reaches for - not even briefly.
     */
    it("refuses an asset that is not the one pinned, and leaves nothing behind", async () => {
        const outputPath = path.join(workDir, "bin", "iperf3");
        const {client} = serving(Buffer.from("something else entirely"));
        const staging = stagedIn();

        await assert.rejects(
            downloadBinary("https://example.test/iperf3", {outputPath, sha256: DIGEST, client,
                tmp: staging.tmp}),
            /EDIGESTMISMATCH|Refusing/);

        assert.equal(fs.existsSync(outputPath), false,
            "an unverified executable was put where the runner spawns it");
        for (const file of staging.staged)
            assert.equal(fs.existsSync(file), false, "the rejected download was left staged on disk");
    });

    // Fails closed, exactly as verifyDigest does for the archives: a manifest
    // entry without a digest is a platform where the check is silently off.
    it("refuses to install anything with no digest pinned for it", async () => {
        const outputPath = path.join(workDir, "bin", "iperf3");
        const {client} = serving();

        await assert.rejects(
            downloadBinary("https://example.test/iperf3", {outputPath, client, tmp: stagedIn().tmp}),
            /no sha256 is pinned/);

        assert.equal(fs.existsSync(outputPath), false);
    });

    it("takes the staging file away after a download that worked", async () => {
        const outputPath = path.join(workDir, "bin", "iperf3");
        const {client} = serving();
        const staging = stagedIn();

        await downloadBinary("https://example.test/iperf3",
            {outputPath, sha256: DIGEST, client, tmp: staging.tmp});

        for (const file of staging.staged)
            assert.equal(fs.existsSync(file), false, "every download leaves its staging copy behind");
    });

    it("handles EXDEV by copying to a fresh same-directory file before atomic publication", async () => {
        const outputPath = path.join(workDir, "bin", "iperf3");
        const {client} = serving();
        let firstRename = true;
        const rename = async (from, to) => {
            if (firstRename) {
                firstRename = false;
                const error = new Error("different filesystems");
                error.code = "EXDEV";
                throw error;
            }
            return fs.promises.rename(from, to);
        };

        await downloadBinary("https://example.test/iperf3", {
            outputPath, sha256: DIGEST, client, tmp: stagedIn().tmp, operations: {rename}
        });

        assert.deepEqual(fs.readFileSync(outputPath), PAYLOAD);
        assert.deepEqual(fs.readdirSync(path.dirname(outputPath)), ["iperf3"]);
    });

    it("refuses a pre-existing hardlink without changing its sibling", async () => {
        const outputPath = path.join(workDir, "bin", "iperf3");
        fs.mkdirSync(path.dirname(outputPath));
        const sentinel = path.join(workDir, "sentinel");
        fs.writeFileSync(sentinel, "keep");
        fs.linkSync(sentinel, outputPath);

        await assert.rejects(downloadBinary("https://example.test/iperf3", {
            outputPath, sha256: DIGEST, client: serving().client, tmp: stagedIn().tmp
        }), /hardlink|link count/i);
        assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
    });

    it("refuses a pre-existing symlink without changing its target", async (context) => {
        const outputPath = path.join(workDir, "bin", "iperf3");
        fs.mkdirSync(path.dirname(outputPath));
        const sentinel = path.join(workDir, "sentinel");
        fs.writeFileSync(sentinel, "keep");
        try {
            fs.symlinkSync(sentinel, outputPath, "file");
        } catch (error) {
            if (error.code === "EPERM") return context.skip("file symlinks require host permission");
            throw error;
        }

        await assert.rejects(downloadBinary("https://example.test/iperf3", {
            outputPath, sha256: DIGEST, client: serving().client, tmp: stagedIn().tmp
        }), /symlink/i);
        assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
    });

    it("refuses a linked parent below the canonical temporary root", async () => {
        const linkedParent = path.join(workDir, "linked-parent");
        fs.mkdirSync(linkedParent);
        const outputPath = path.join(linkedParent, "bin", "iperf3");

        await assert.rejects(downloadBinary("https://example.test/iperf3", {
            outputPath, sha256: DIGEST, client: serving().client, tmp: stagedIn().tmp,
            operations: {
                lstat: async (target) => path.basename(target) === path.basename(linkedParent)
                    ? {
                        isDirectory: () => true,
                        isFile: () => false,
                        isSymbolicLink: () => true,
                        nlink: 1,
                        size: 0,
                        mode: 0o755
                    }
                    : fs.promises.lstat(target)
            }
        }), /linked parent|output directory/i);
        assert.deepEqual(fs.readdirSync(linkedParent), []);
    });

    it("refuses a destination name that is unsafe on Windows", async () => {
        const outputPath = path.join(workDir, "bin", "NUL");
        await assert.rejects(downloadBinary("https://example.test/iperf3", {
            outputPath, sha256: DIGEST, client: serving().client, tmp: stagedIn().tmp
        }), /unsafe|Windows/i);
        assert.equal(fs.existsSync(path.dirname(outputPath)), false);
    });

    it("preserves a prior binary and cleans same-directory staging on copy failure", async () => {
        const outputPath = path.join(workDir, "bin", "iperf3");
        fs.mkdirSync(path.dirname(outputPath));
        fs.writeFileSync(outputPath, "old");
        const exdevRename = async () => {
            const error = new Error("different filesystems");
            error.code = "EXDEV";
            throw error;
        };
        const copyFile = async () => { throw new Error("injected copy failure"); };

        await assert.rejects(downloadBinary("https://example.test/iperf3", {
            outputPath, sha256: DIGEST, client: serving().client, tmp: stagedIn().tmp,
            operations: {rename: exdevRename, copyFile}
        }), /injected copy failure/);
        assert.equal(fs.readFileSync(outputPath, "utf8"), "old");
        assert.deepEqual(fs.readdirSync(path.dirname(outputPath)), ["iperf3"]);
    });

    it("preserves a prior binary and cleans staging on final rename failure", async () => {
        const outputPath = path.join(workDir, "bin", "iperf3");
        fs.mkdirSync(path.dirname(outputPath));
        fs.writeFileSync(outputPath, "old");
        const rename = async (from, to) => {
            if (path.basename(to) === path.basename(outputPath))
                throw new Error("injected publication failure");
            return fs.promises.rename(from, to);
        };

        await assert.rejects(downloadBinary("https://example.test/iperf3", {
            outputPath, sha256: DIGEST, client: serving().client, tmp: stagedIn().tmp,
            operations: {rename}
        }), /injected publication failure/);
        assert.equal(fs.readFileSync(outputPath, "utf8"), "old");
        assert.deepEqual(fs.readdirSync(path.dirname(outputPath)), ["iperf3"]);
    });

    it("refuses an empty bare executable without replacing a prior binary", async () => {
        const outputPath = path.join(workDir, "bin", "iperf3");
        fs.mkdirSync(path.dirname(outputPath));
        fs.writeFileSync(outputPath, "old");
        const emptyDigest = createHash("sha256").update("").digest("hex");
        await assert.rejects(downloadBinary("https://example.test/iperf3", {
            outputPath, sha256: emptyDigest, client: serving(Buffer.alloc(0)).client, tmp: stagedIn().tmp
        }), /nonempty/i);
        assert.equal(fs.readFileSync(outputPath, "utf8"), "old");
    });

    it("refuses privilege bits in a requested executable mode", async () => {
        const outputPath = path.join(workDir, "bin", "iperf3");
        await assert.rejects(downloadBinary("https://example.test/iperf3", {
            outputPath, sha256: DIGEST, client: serving().client, tmp: stagedIn().tmp, mode: 0o4755
        }), /mode|privilege/i);
        assert.equal(fs.existsSync(outputPath), false);
    });

    it("preserves a prior binary and cleans staging on chmod failure",
        {skip: process.platform === "win32"}, async () => {
            const outputPath = path.join(workDir, "bin", "iperf3");
            fs.mkdirSync(path.dirname(outputPath));
            fs.writeFileSync(outputPath, "old");
            const chmod = async () => { throw new Error("injected chmod failure"); };
            await assert.rejects(downloadBinary("https://example.test/iperf3", {
                outputPath, sha256: DIGEST, client: serving().client, tmp: stagedIn().tmp,
                operations: {chmod}
            }), /injected chmod failure/);
            assert.equal(fs.readFileSync(outputPath, "utf8"), "old");
            assert.deepEqual(fs.readdirSync(path.dirname(outputPath)), ["iperf3"]);
        });

    /**
     * A published bare binary arrives without an executable bit, where a tar
     * member carries its mode inside the archive. Without this the spawn fails
     * EACCES, which reads as a permissions problem with the install rather
     * than with the download.
     */
    it("makes it executable, where the platform has modes", {skip: process.platform === "win32"}, async () => {
        const outputPath = path.join(workDir, "bin", "iperf3");
        const {client} = serving();

        await downloadBinary("https://example.test/iperf3",
            {outputPath, sha256: DIGEST, client, tmp: stagedIn().tmp});

        assert.equal(fs.statSync(outputPath).mode & 0o777, EXECUTABLE_MODE);
    });
});
