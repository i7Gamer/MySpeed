import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { downloadAndExtract, downloadToFile, extractBinary } from "../../server/util/providers/downloadHelper.js";

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

/**
 * A stand-in for the IncomingMessage node hands the callback.
 *
 * destroy() is part of that interface - every readable stream has it - and
 * leaving it off the fake made the fake, not the code, decide what the code was
 * allowed to call. It records instead of no-opping so the socket release can be
 * asserted rather than assumed.
 */
const responseStub = (props) => {
    const stub = {statusCode: 200, headers: {}, destroyed: false, on() {}, resume() {}, ...props};

    stub.destroy = function () { this.destroyed = true; };
    return stub;
};

const success = (body) => responseStub({
    pipe(writeStream) { writeStream.end(body); }
});

/** A response that starts arriving and then fails. */
const failsMidStream = () => responseStub({
    on(event, handler) {
        if (event === "error") setTimeout(() => handler(new Error("connection reset")), 5);
    },
    pipe(writeStream) { writeStream.write("partial"); }
});

const clientFor = (response) => (url, cb) => { cb(response); return request; };

/**
 * The digest of what a stub is about to serve.
 *
 * downloadAndExtract verifies before it extracts and fails closed, so a case
 * about the *cleanup* still has to pin what it downloads - otherwise it is a
 * test of the digest guard wearing the name of something else.
 */
const digestOf = (body) => createHash("sha256").update(body).digest("hex");

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
            sha256: digestOf("archive bytes"),
            extract: (from) => { extractedFrom = from; }
        }));

        assert.equal(extractedFrom, archivePath);
    });

    it("removes the archive once the binary is out of it", async () => {
        await downloadAndExtract("https://example.test/cli.tgz", options({
            client: clientFor(success("archive bytes")),
            sha256: digestOf("archive bytes"),
            extract: () => {}
        }));

        assert.equal(fs.existsSync(archivePath), false,
            "the release archive was left in the temp directory for good");
    });

    it("removes the archive even when extraction fails", async () => {
        await assert.rejects(() => downloadAndExtract("https://example.test/cli.tgz", options({
            client: clientFor(success("not really an archive")),
            sha256: digestOf("not really an archive"),
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

/**
 * Extraction that extracts nothing is a failure, not a success.
 *
 * decompress resolves with an empty array rather than rejecting when no plugin
 * recognises the archive, and Promise.all([]) resolves too - so an unhandled
 * format (a FreeBSD .pkg is tar+xz, and only targz and unzip are registered), a
 * binaryRegex that matches no member, and a 200 HTML error page saved as an
 * archive were all indistinguishable from a binary successfully unpacked.
 * Nothing downstream noticed: downloadAndExtract only unlinks the archive, and
 * both downloadFile() and loadCli.load() reported success while ./bin/<cli> did
 * not exist - so the first run failed with whatever the shell says about a
 * missing file rather than with the download that never worked.
 */
describe("extractBinary", () => {
    const archive = () => {
        const file = path.join(directory, `empty-${Math.floor(Math.random() * 1e9)}.tgz`);
        fs.writeFileSync(file, "not an archive any registered plugin knows");
        return file;
    };

    it("refuses an archive nothing could be taken out of", async () => {
        await assert.rejects(() => extractBinary(archive(), directory, /binary/, "binary"),
            /nothing|no file|empty/i);
    });

    it("names the archive it could not unpack", async () => {
        const file = archive();

        await assert.rejects(() => extractBinary(file, directory, /binary/, "binary"),
            (error) => error.message.includes(file));
    });
});

describe("a download that fails part way through", () => {
    it("leaves no partial file behind", async () => {
        await assert.rejects(() => downloadToFile("https://example.test/cli.tgz", archivePath,
            {client: clientFor(failsMidStream())}), /connection reset/);

        assert.equal(fs.existsSync(archivePath), false,
            "a half-written archive was left on disk, and a retry would extract from it");
    });

    /**
     * pipe() only unpipes when the write side errors - the response stops being
     * read but stays checked out of the agent with its socket open and its body
     * buffered, until the peer times out. Releasing the write side without the
     * read side trades a file descriptor for a socket.
     */
    it("releases the response socket too", async () => {
        const response = failsMidStream();

        await assert.rejects(() => downloadToFile("https://example.test/cli.tgz", archivePath,
            {client: clientFor(response)}), /connection reset/);

        assert.equal(response.destroyed, true,
            "the response was left open, holding its socket until the peer gave up");
    });

    it("still writes the file when the download succeeds", async () => {
        await downloadToFile("https://example.test/cli.tgz", archivePath,
            {client: clientFor(success("archive bytes"))});

        assert.equal(fs.readFileSync(archivePath, "utf8"), "archive bytes");
    });
});
