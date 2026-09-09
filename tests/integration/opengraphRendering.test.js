import {after, before, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {bootServer, seedTests} from "./helpers/boot.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FONT = "assets/fonts/inter-v12-latin-regular.ttf";
const LOGO = "assets/img/logo192.png";
const WIDTH = 1200, HEIGHT = 600;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const IHDR_WIDTH_OFFSET = 16, IHDR_HEIGHT_OFFSET = 20;
const CACHE_EXPIRY_ADVANCE_MS = 61_000;
let server;
const copyAsset = asset => {
    const destination = path.join(server.dataDir, "build", asset);
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.copyFileSync(path.join(ROOT, "client/public", asset), destination);
};
before(async () => {
    server = await bootServer();
    copyAsset(FONT); copyAsset(LOGO);
    await seedTests(server.tests, [{created: new Date().toISOString(), ping: 12, download: 123, upload: 45}]);
});
after(async () => server?.close());

it("renders the bundled font and logo through real satori/resvg, caches it, expires it and falls back for a missing asset", async context => {
    const originalRead = fs.promises.readFile;
    const reads = context.mock.method(fs.promises, "readFile", (...args) => originalRead(...args));
    const errors = context.mock.method(console, "error", () => {});
    const readCount = () => reads.mock.calls.filter(call => /inter-v12-latin-regular\.ttf|logo192\.png/.test(String(call.arguments[0]))).length;
    const image = async () => {
        const response = await fetch(`${server.baseUrl}/api/opengraph/image`, {redirect: "manual"});
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /^image\/png/);
        const png = Buffer.from(await response.arrayBuffer());
        assert.ok(png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE));
        assert.equal(png.readUInt32BE(IHDR_WIDTH_OFFSET), WIDTH);
        assert.equal(png.readUInt32BE(IHDR_HEIGHT_OFFSET), HEIGHT);
        return png;
    };
    const first = await image();
    const firstReads = readCount();
    assert.equal(firstReads, 2, "the renderer must read both real bundled assets");
    const repeated = await image();
    assert.ok(first.equals(repeated), "a warm cache returns the same image");
    assert.equal(readCount(), firstReads);

    fs.rmSync(path.join(server.dataDir, "build", LOGO));
    await image();
    assert.equal(readCount(), firstReads, "a warm cache does not need assets again");
    const expiredTime = Date.now() + CACHE_EXPIRY_ADVANCE_MS;
    context.mock.method(Date, "now", () => expiredTime);
    const missing = await fetch(`${server.baseUrl}/api/opengraph/image`, {redirect: "manual"});
    assert.equal(missing.status, 302);
    assert.match(missing.headers.get("location"), /^https:\/\/repository-images\.githubusercontent\.com\//);
    assert.deepEqual(errors.mock.calls, [], "missing assets use the intentional fallback without an internal error");

    copyAsset(LOGO);
    await image();
    assert.ok(readCount() > firstReads, "expiry must render from assets again; missing assets must not be cached");
});
