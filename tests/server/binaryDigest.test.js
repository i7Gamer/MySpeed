import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { cloudflareList, libreList, ooklaList } from "../../server/config/binaries.js";
import { DigestMismatchError, downloadAndExtract, verifyDigest } from "../../server/util/providers/downloadHelper.js";

/**
 * The first item in the tech debt register, and the highest-rated one: the
 * speedtest CLIs are downloaded at first boot and then executed, and until now
 * nothing checked that what arrived was what was meant to arrive.
 *
 * That matters more here than it would in most places. The binary is spawned by
 * the server on a schedule, so a replaced upstream asset is arbitrary code on
 * the operator's machine, once an hour, for as long as the instance runs. The
 * install used to run it as root as well, which 1.3.5 fixed - this is the other
 * half of that.
 *
 * The digests are pinned in the repository rather than fetched beside the
 * archive. Fetching a checksum from the host that served the file protects
 * against a corrupted transfer and nothing else: whoever can change one can
 * change the other. Pinned, they are a statement about the exact bytes this
 * version of MySpeed was built against.
 *
 * What that does not do, and the comment in binaries.js says so, is verify that
 * those bytes were ever trustworthy. Two of the three publishers state their own
 * digests and the third does not, so all three ultimately rest on what was
 * served at the moment they were recorded. What pinning buys is that it cannot
 * change underneath an instance afterwards.
 */
const SHA256 = /^[a-f0-9]{64}$/;

describe("the pinned manifest", () => {
    const everyEntry = [
        ...ooklaList.map((entry) => ({provider: "ookla", ...entry})),
        ...libreList.map((entry) => ({provider: "libre", ...entry})),
        ...cloudflareList.map((entry) => ({provider: "cloudflare", ...entry}))
    ];

    it("has entries to check", () => {
        assert.ok(everyEntry.length > 20, "the platform lists are suspiciously short");
    });

    /**
     * Every one, with no exceptions. A single entry without a digest is a
     * platform on which the whole guard is off, and it would be the platform
     * nobody tests.
     */
    it("carries a digest for every platform it offers", () => {
        const missing = everyEntry
            .filter((entry) => !SHA256.test(entry.sha256 ?? ""))
            .map((entry) => `${entry.provider} ${entry.os}-${entry.arch}`);

        assert.deepEqual(missing, [], "these platforms would download and run an unverified binary");
    });

    /**
     * Two platforms sharing an archive have to share its digest - Ookla
     * publishes one universal build for both Macs, so a pair that disagreed
     * would mean at least one was wrong.
     */
    it("gives one archive one digest", () => {
        const bySuffix = new Map();

        for (const entry of everyEntry) {
            const key = `${entry.provider}|${entry.suffix}`;
            const seen = bySuffix.get(key);

            if (seen !== undefined)
                assert.equal(entry.sha256, seen, `${key} is pinned to two different digests`);

            bySuffix.set(key, entry.sha256);
        }
    });
});

describe("verifying a file", () => {
    let directory;

    const write = (name, contents) => {
        const file = path.join(directory, name);
        fs.writeFileSync(file, contents);

        return file;
    };

    const digestOf = (contents) => createHash("sha256").update(contents).digest("hex");

    before(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-digest-"));
    });

    after(() => {
        fs.rmSync(directory, {recursive: true, force: true});
    });

    it("accepts a file that hashes to what was expected", async () => {
        const file = write("good.bin", "the real archive");

        await assert.doesNotReject(() => verifyDigest(file, digestOf("the real archive")));
    });

    it("is not confused by case in the expected digest", async () => {
        const file = write("case.bin", "contents");

        await assert.doesNotReject(() => verifyDigest(file, digestOf("contents").toUpperCase()));
    });

    it("refuses a file that hashes to something else", async () => {
        const file = write("bad.bin", "not the real archive");

        await assert.rejects(() => verifyDigest(file, digestOf("the real archive")), DigestMismatchError);
    });

    /**
     * Fails closed. An expected digest that is missing or malformed is a
     * manifest that cannot say what should have arrived, and going ahead on that
     * basis is exactly the state this whole exercise ends.
     */
    it("refuses to check against nothing", async () => {
        const file = write("unpinned.bin", "contents");

        for (const expected of [undefined, null, "", "not-a-digest", 42])
            await assert.rejects(() => verifyDigest(file, expected), DigestMismatchError,
                `${JSON.stringify(expected)} was accepted as an expected digest`);
    });

    // The message is what an operator reads in the log when their install stops
    // working, so it has to name both halves rather than say "mismatch".
    it("says what it wanted and what it got", async () => {
        const file = write("named.bin", "actual");
        const expected = digestOf("expected");

        await assert.rejects(() => verifyDigest(file, expected), (error) => {
            assert.match(error.message, new RegExp(expected.slice(0, 16)));
            assert.match(error.message, new RegExp(digestOf("actual").slice(0, 16)));
            return true;
        });
    });
});

describe("a download whose digest does not match", () => {
    let directory;

    before(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-download-"));
    });

    after(() => {
        fs.rmSync(directory, {recursive: true, force: true});
    });

    /** A client that answers with whatever bytes the test wants. */
    const clientServing = (body) => (url, callback) => {
        const response = {
            statusCode: 200,
            headers: {},
            resume() {},
            destroy() {},
            on() {},
            pipe(stream) {
                stream.end(body);
            }
        };

        callback(response);

        return {on() {}, setTimeout() {}, destroy() {}};
    };

    const archivePath = () => path.join(directory, "archive.tmp");

    /**
     * Before extraction, not after. Unpacking a tampered archive writes whatever
     * it contains into ./bin, and deleting it afterwards is not the same as
     * never having written it - the file the loader is about to spawn would have
     * existed for the length of the check.
     */
    it("never reaches the extraction step", async () => {
        let extracted = false;

        await assert.rejects(() => downloadAndExtract("https://example.invalid/archive.tgz", {
            outputDir: directory,
            binaryRegex: /x/,
            outputName: "x",
            sha256: createHash("sha256").update("something else").digest("hex"),
            client: clientServing("the served archive"),
            tmp: archivePath,
            extract: async () => { extracted = true; }
        }), DigestMismatchError);

        assert.equal(extracted, false, "a tampered archive was unpacked and then complained about");
    });

    // The finally that removes the archive runs whatever happened, so a refused
    // download leaves nothing behind for a later attempt to find.
    it("leaves no archive behind", async () => {
        await downloadAndExtract("https://example.invalid/archive.tgz", {
            outputDir: directory,
            binaryRegex: /x/,
            outputName: "x",
            sha256: createHash("sha256").update("wrong").digest("hex"),
            client: clientServing("served"),
            tmp: archivePath,
            extract: async () => undefined
        }).catch(() => undefined);

        assert.equal(fs.existsSync(archivePath()), false);
    });

    it("extracts when the digest is the one that was expected", async () => {
        let extracted = false;

        await downloadAndExtract("https://example.invalid/archive.tgz", {
            outputDir: directory,
            binaryRegex: /x/,
            outputName: "x",
            sha256: createHash("sha256").update("served").digest("hex"),
            client: clientServing("served"),
            tmp: archivePath,
            extract: async () => { extracted = true; }
        });

        assert.equal(extracted, true, "a matching archive was refused");
    });
});
