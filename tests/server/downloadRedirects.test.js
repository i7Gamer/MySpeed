import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadToFile, MAX_DOWNLOAD_REDIRECTS, DOWNLOAD_IDLE_TIMEOUT } from "../../server/util/providers/downloadHelper.js";

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

/**
 * Where a redirect actually points.
 *
 * The Location header was handed straight back to the client as though it were
 * a URL. It need not be one: RFC 9110 allows a relative reference, and a CDN
 * that answers `Location: /bin/cli.tgz` produced ERR_INVALID_URL - a failure
 * that names neither the download nor the redirect, on the boot path that
 * installs the speedtest CLI.
 */
describe("a redirect that is not an absolute https URL", () => {
    const answering = (location) => (url, callback) => {
        callback(location === null ? success("the binary") : redirectTo(location));
        return request;
    };

    it("resolves a relative location against the URL it came from", async () => {
        const destination = path.join(directory, "relative");
        const seen = [];
        const client = (url, callback) => {
            seen.push(url);
            callback(seen.length === 1 ? redirectTo("/bin/cli.tgz") : success("the binary"));
            return request;
        };

        await downloadToFile("https://release.invalid/v1/download", destination, {client});

        assert.equal(seen[1], "https://release.invalid/bin/cli.tgz",
            "the relative location was not resolved against the URL that sent it");
        assert.equal(fs.readFileSync(destination, "utf8"), "the binary");
    });

    it("keeps following an absolute location as it always did", async () => {
        const destination = path.join(directory, "absolute");
        const seen = [];
        const client = (url, callback) => {
            seen.push(url);
            callback(seen.length === 1 ? redirectTo("https://cdn.invalid/cli.tgz") : success("the binary"));
            return request;
        };

        await downloadToFile("https://release.invalid/v1", destination, {client});

        assert.equal(seen[1], "https://cdn.invalid/cli.tgz");
    });

    /**
     * This downloads an executable the server then runs. A redirect onto plain
     * HTTP is a downgrade that hands anyone on the path the contents of that
     * file, so it is refused rather than followed - and refused with a reason,
     * where before it reached https.get as an http:// URL and died on
     * ERR_INVALID_PROTOCOL saying nothing about a redirect.
     */
    it("refuses a downgrade to plain http", async () => {
        await assert.rejects(
            () => downloadToFile("https://release.invalid/v1", path.join(directory, "downgrade"),
                {client: answering("http://cdn.invalid/cli.tgz")}),
            (error) => {
                assert.match(error.message, /https/i);
                return true;
            });
    });

    it("refuses a location that is not a URL at all", async () => {
        await assert.rejects(
            () => downloadToFile("https://release.invalid/v1", path.join(directory, "junk"),
                {client: answering(":::")}),
            (error) => {
                assert.match(error.message, /redirect/i);
                return true;
            });
    });
});

/**
 * A server that accepts the connection and then says nothing.
 *
 * `get` arms no timer of its own, so the promise never settled and neither did
 * the boot that awaits it: the CLI never installed and the process sat there,
 * with no error and nothing in the log to say what it was waiting for.
 */
describe("a download that stalls", () => {
    // Records what the timeout was armed with and lets the test fire it, which
    // is what a socket going quiet does.
    const stallingRequest = () => {
        const handlers = {};

        return {
            armedFor: null,
            on(event, handler) {
                handlers[event] = handler;
                return this;
            },
            setTimeout(ms, onIdle) {
                this.armedFor = ms;
                this.fire = onIdle;
                return this;
            },
            destroy(error) {
                handlers.error?.(error);
            }
        };
    };

    it("gives up with a reason once the socket goes quiet", async () => {
        const stalled = stallingRequest();
        const client = () => stalled;

        const pending = downloadToFile("https://release.invalid/v1", path.join(directory, "stalled"), {client});

        assert.equal(stalled.armedFor, DOWNLOAD_IDLE_TIMEOUT, "no idle timeout was armed on the request");
        stalled.fire();

        await assert.rejects(() => pending, (error) => {
            assert.match(error.message, /release\.invalid/, "the failure does not name the download");
            return true;
        });
    });

    it("has a default long enough for a slow but working transfer", () => {
        assert.ok(DOWNLOAD_IDLE_TIMEOUT >= 30000,
            "the idle timeout would abandon a download that is merely slow");
    });
});
