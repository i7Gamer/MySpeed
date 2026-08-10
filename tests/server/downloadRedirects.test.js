import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadToFile, MAX_DOWNLOAD_REDIRECTS } from "../../server/util/providers/downloadHelper.js";

/**
 * The provider CLIs are fetched from release URLs that answer with a redirect
 * to a CDN, so redirects have to be followed - but the follower recursed with
 * no bound at all, so a release URL that loops (or a chain long enough) would
 * recurse until memory ran out instead of failing with a reason.
 *
 * The client is injectable, so these run against a scripted one rather than
 * the network.
 */
let directory;

before(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-dl-"));
});

after(() => {
    fs.rmSync(directory, {recursive: true, force: true});
});

const request = {on() { return this; }};

const redirectTo = (location) => ({statusCode: 302, headers: {location}, resume() {}, on() {}});

const success = (body) => ({
    statusCode: 200, headers: {},
    on() {},
    resume() {},
    pipe(writeStream) { writeStream.end(body); }
});

describe("downloadToFile", () => {
    it("follows a short redirect chain to the file", async () => {
        const destination = path.join(directory, "binary");
        let hops = 0;
        const client = (url, callback) => {
            callback(hops++ < 2 ? redirectTo(`${url}/next`) : success("the binary"));
            return request;
        };

        await downloadToFile("https://release.invalid/v1", destination, {client});

        assert.equal(fs.readFileSync(destination, "utf8"), "the binary");
        assert.equal(hops, 3);
    });

    it("gives up on a redirect loop with the reason named", async () => {
        let hops = 0;
        const client = (url, callback) => {
            // Bounded well above the cap, so a follower without one fails the
            // message assertion instead of recursing until the test times out.
            callback(hops++ < MAX_DOWNLOAD_REDIRECTS * 3 ? redirectTo(url) : success(""));
            return request;
        };

        await assert.rejects(
            () => downloadToFile("https://release.invalid/loop", path.join(directory, "loop"), {client}),
            (error) => {
                assert.match(error.message, /redirect/i);
                return true;
            });

        assert.ok(hops <= MAX_DOWNLOAD_REDIRECTS + 1,
            `followed ${hops} redirects before giving up`);
    });

    it("still rejects a plain failure status", async () => {
        const client = (url, callback) => {
            callback({statusCode: 404, headers: {}, resume() {}, on() {}});
            return request;
        };

        await assert.rejects(
            () => downloadToFile("https://release.invalid/gone", path.join(directory, "gone"), {client}),
            /404/);
    });
});
