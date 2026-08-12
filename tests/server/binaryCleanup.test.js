import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadAndExtract, downloadToFile } from "../../server/util/providers/downloadHelper.js";

/**
 * What the CLI downloads leave behind.
 *
 * Each of the three loaders wrote the release archive to a uniquely named file
 * in os.tmpdir(), extracted the binary out of it, and returned - so every
 * download left a .tgz or .zip of some tens of megabytes in the temp directory
 * for good. A container that does not persist ./bin re-downloads on every
 * start, which turns "once per install" into "once per restart".
 *
 * The failure path was worse: a download that errored mid-stream left the write
 * stream open and a partial file on disk, with nothing to close either.
 */
let directory;

before(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-clean-"));
});

after(() => {
    fs.rmSync(directory, {recursive: true, force: true});
});

let archivePath;

beforeEach(() => {
    archivePath = path.join(directory, `archive-${Math.floor(Math.random() * 1e9)}.tgz`);
});

const request = {on() { return this; }};

const success = (body) => ({
    statusCode: 200, headers: {},
    on() {},
    resume() {},
    pipe(writeStream) { writeStream.end(body); }
});

/** A response that starts arriving and then fails. */
const failsMidStream = () => ({
    statusCode: 200, headers: {},
    resume() {},
    on(event, handler) {
        if (event === "error") setTimeout(() => handler(new Error("connection reset")), 5);
    },
    pipe(writeStream) { writeStream.write("partial"); }
});

const clientFor = (response) => (url, cb) => { cb(response); return request; };

describe("downloadAndExtract", () => {
    const options = (extra) => ({
        outputDir: directory,
        binaryRegex: /binary/,
        outputName: "binary",
        tmp: () => archivePath,
        ...extra
    });

    it("extracts from the archive it downloaded", async () => {
        let extractedFrom = null;

        await downloadAndExtract("https://example.test/cli.tgz", options({
            client: clientFor(success("archive bytes")),
            extract: (from) => { extractedFrom = from; }
        }));

        assert.equal(extractedFrom, archivePath);
    });

    it("removes the archive once the binary is out of it", async () => {
        await downloadAndExtract("https://example.test/cli.tgz", options({
            client: clientFor(success("archive bytes")),
            extract: () => {}
        }));

        assert.equal(fs.existsSync(archivePath), false,
            "the release archive was left in the temp directory for good");
    });

    it("removes the archive even when extraction fails", async () => {
        await assert.rejects(() => downloadAndExtract("https://example.test/cli.tgz", options({
            client: clientFor(success("not really an archive")),
            extract: () => { throw new Error("not a tarball"); }
        })), /not a tarball/);

        assert.equal(fs.existsSync(archivePath), false,
            "a failed extraction leaves its archive behind on every retry");
    });

    it("reports a failed download rather than extracting nothing", async () => {
        await assert.rejects(() => downloadAndExtract("https://example.test/cli.tgz", options({
            client: clientFor({statusCode: 404, headers: {}, resume() {}, on() {}}),
            extract: () => assert.fail("extraction was attempted on a failed download")
        })), /404/);
    });
});

describe("a download that fails part way through", () => {
    it("leaves no partial file behind", async () => {
        await assert.rejects(() => downloadToFile("https://example.test/cli.tgz", archivePath,
            {client: clientFor(failsMidStream())}), /connection reset/);

        assert.equal(fs.existsSync(archivePath), false,
            "a half-written archive was left on disk, and a retry would extract from it");
    });

    it("still writes the file when the download succeeds", async () => {
        await downloadToFile("https://example.test/cli.tgz", archivePath,
            {client: clientFor(success("archive bytes"))});

        assert.equal(fs.readFileSync(archivePath, "utf8"), "archive bytes");
    });
});
