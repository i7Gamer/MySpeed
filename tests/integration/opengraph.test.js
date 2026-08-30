import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootServer, seedTests } from "./helpers/boot.js";

/**
 * The catch's fallback redirect, held to writing only while nothing has been
 * written. generateOpenGraphImage does all of its work before the first byte
 * leaves, so the ordinary failure redirects cleanly - the guard is for the one
 * that starts on the way out: send() failing mid-response, where a second write
 * dies on ERR_HTTP_HEADERS_SENT and replaces the real reason in the log.
 *
 * Read rather than run, the way shutdown.test.js reads index.js: forcing a
 * send() to fail through a real socket is not something this harness can do.
 * Resolved from this file's own URL, because bootServer has moved the working
 * directory into its throwaway data dir by the time these run.
 */
describe("the failure fallback", () => {
    const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
    const source = fs.readFileSync(path.join(root, "server", "routes", "opengraph.js"), "utf8");

    it("redirects only while the response is still unwritten", () => {
        assert.match(source, /if \(!res\.headersSent\) res\.redirect\(BANNER_URL\)/,
            "the catch redirects unconditionally, so a failed send dies again on ERR_HTTP_HEADERS_SENT");
    });
});

/**
 * Whose rows the public card averages.
 *
 * The card is reachable by anyone on a no-password or read-level instance and
 * headlines "the" speed, so it must describe one line - the same one the
 * recommendations sample - rather than blending the gigabit LAN box into the
 * WAN's average. But a line is only worth headlining while it has something
 * to say: chosen by configuration alone, a target added yesterday blanked the
 * card of an instance holding years of rows, because the scoped read came
 * back empty and the route fell through to the project banner.
 */
describe("the line the card describes", () => {
    let openGraphLine;
    let readStatistics;
    let targets;

    before(async () => {
        ({openGraphLine, readStatistics} = await import("../../server/controller/opengraph.js"));
        targets = await import("../../server/controller/targets.js");
    });

    after(async () => {
        await targets.removeAll();
        await seedTests(server.tests, []);
    });

    const hoursAgo = (hours) => new Date(Date.now() - hours * 3600000).toISOString();

    it("is the line every other instance-wide surface names", async () => {
        await targets.removeAll();
        const wan = await targets.create({name: "WAN", provider: "ookla", sortOrder: 0});
        const lan = await targets.create({name: "LAN", provider: "iperf3",
            endpoint: "10.0.0.5:5201", sortOrder: 1});

        await seedTests(server.tests, [
            {created: hoursAgo(2), targetId: wan.id, download: 100},
            {created: hoursAgo(1), targetId: lan.id, download: 940}
        ]);

        assert.equal((await openGraphLine())?.id, wan.id);
    });

    // A target added today leads the round and has measured nothing yet; the
    // instance's rows belong to the line beside it, and that is the line the
    // card can actually describe.
    it("passes over a line that has measured nothing yet", async () => {
        await targets.removeAll();
        const fresh = await targets.create({name: "Fresh", provider: "ookla", sortOrder: 0});
        const measured = await targets.create({name: "Measured", provider: "ookla", sortOrder: 1});

        await seedTests(server.tests, [{created: hoursAgo(1), targetId: measured.id, download: 250}]);

        const line = await openGraphLine();

        assert.notEqual(line?.id, fresh.id, "the card describes a line with nothing on it");
        assert.equal(line?.id, measured.id);
    });

    /**
     * And when no target has rows at all, the history that does exist belongs
     * to no line - rows an import left unattributed, or a deleted target's -
     * so there is no line to mis-name and the instance-wide read is the only
     * one that can fill the card.
     */
    it("answers no line when none of them has measured anything", async () => {
        await targets.removeAll();
        await targets.create({name: "Fresh", provider: "ookla", sortOrder: 0});

        await seedTests(server.tests, [{created: hoursAgo(1), download: 250}]);

        assert.equal(await openGraphLine(), null);
    });

    it("answers no line on an instance that has none", async () => {
        await targets.removeAll();

        assert.equal(await openGraphLine(), null);
    });

    /**
     * And "has something to say" is asked of the window the card averages, not
     * of the whole history.
     *
     * A line with rows only from last month passed the "has measured
     * something" test, took the card, and then had nothing in the two-day
     * window - so the route fell through to its single-reading fallback and
     * published a three-week-old figure stamped with today's date, while the
     * line beside it had measured an hour ago.
     */
    it("passes over a line whose rows are all older than the window", async () => {
        await targets.removeAll();
        const stale = await targets.create({name: "Stale", provider: "ookla", sortOrder: 0});
        const current = await targets.create({name: "Current", provider: "ookla", sortOrder: 1});

        const THREE_WEEKS_IN_HOURS = 21 * 24;

        await seedTests(server.tests, [
            {created: hoursAgo(THREE_WEEKS_IN_HOURS), targetId: stale.id, download: 100},
            {created: hoursAgo(1), targetId: current.id, download: 250}
        ]);

        assert.equal((await openGraphLine())?.id, current.id,
            "the card headlined a line that has measured nothing since before the window");
    });

    /**
     * And the figures it publishes are that line's alone.
     *
     * The scoping used to be held by a source scan, and replacing that with the
     * cases above left nothing asserting that the chosen line is used for
     * anything - the card could average the whole instance and every one of
     * them would still pass.
     */
    it("averages only the line it named", async () => {
        await targets.removeAll();
        const wan = await targets.create({name: "WAN", provider: "ookla", sortOrder: 0});
        const lan = await targets.create({name: "LAN", provider: "iperf3",
            endpoint: "10.0.0.5:5201", sortOrder: 1});

        await seedTests(server.tests, [
            {created: hoursAgo(2), targetId: wan.id, ping: 10, download: 100, upload: 50},
            {created: hoursAgo(1), targetId: lan.id, ping: 1, download: 940, upload: 900}
        ]);

        assert.equal((await readStatistics()).download.avg, 100,
            "the card blended the gigabit LAN box into the WAN's headline figure");
    });
});

let server;

/** Every outbound request the server makes while a test runs. */
let outbound = [];
const realFetch = globalThis.fetch;

const HOSTILE_HOST = "attacker.invalid:1";

before(async () => {
    server = await bootServer();

    globalThis.fetch = (...args) => {
        outbound.push(String(args[0]?.url ?? args[0]));
        return realFetch(...args);
    };
});

after(async () => {
    globalThis.fetch = realFetch;
    await server?.close();
});

beforeEach(async () => {
    // readStatistics looks at yesterday..today and the image is only rendered
    // when that window has usable averages, so the route has to get past this
    // to reach the asset loader at all.
    const now = new Date();
    await seedTests(server.tests, [
        {created: new Date(now.getTime() - 3600000).toISOString(), ping: 10, download: 100, upload: 50},
        {created: now.toISOString(), ping: 12, download: 120, upload: 60}
    ]);

    outbound = [];
});

/**
 * Issues the request over node:http rather than fetch, for two reasons: fetch
 * refuses to send a forged Host header (it is a forbidden header name), and
 * routing the test's own traffic around the patched global keeps `outbound`
 * holding only what the *server* requested.
 */
const rawRequest = (path, headers = {}) => new Promise((resolve, reject) => {
    const {hostname, port} = new URL(server.baseUrl);
    const request = http.request({hostname, port, path, method: "GET", headers}, (res) => {
        res.resume();
        res.on("end", () => resolve({status: res.statusCode, headers: res.headers}));
    });

    request.on("error", reject);
    request.end();
});

describe("GET /api/opengraph/image", () => {
    it("answers without erroring", async () => {
        const {status} = await rawRequest("/api/opengraph/image");
        assert.ok([200, 302].includes(status), `unexpected status ${status}`);
    });

    it("sends the forged host through to the server", async () => {
        // Guards the test itself: if the Host header stopped arriving, the
        // regression tests below would pass for the wrong reason.
        const {status} = await rawRequest("/api/opengraph/image", {host: HOSTILE_HOST});
        assert.ok(status >= 200, "the request never reached the server");
    });

    /**
     * Regression: the asset loader fell back to fetching the font and logo from
     * `${req.protocol}://${req.headers.host}${path}`. The Host header is chosen
     * by the caller and this route is reachable without a password, so anyone
     * could make the server issue a request to a host of their naming - a blind
     * SSRF into whatever the instance can reach.
     */
    it("never calls out to the host named in the request", async () => {
        await rawRequest("/api/opengraph/image", {host: HOSTILE_HOST});

        const reached = outbound.filter((url) => url.includes("attacker.invalid"));
        assert.deepEqual(reached, [], `server called out to ${reached.join(", ")}`);
    });

    it("makes no outbound request at all while rendering", async () => {
        await rawRequest("/api/opengraph/image");
        assert.deepEqual(outbound, [], `server issued ${outbound.join(", ")}`);
    });

    it("makes no outbound request even when the host is forged", async () => {
        await rawRequest("/api/opengraph/image", {host: HOSTILE_HOST});
        assert.deepEqual(outbound, [], `server issued ${outbound.join(", ")}`);
    });

    it("falls back to the banner rather than failing when assets are unavailable", async () => {
        // The throwaway working directory has no build/ or client/public/, so
        // the assets cannot be loaded and the route redirects instead.
        const {status, headers} = await rawRequest("/api/opengraph/image");

        if (status === 302) assert.match(headers.location, /^https:\/\//);
    });

    /**
     * Regression: only the font was checked before use. With a font bundled
     * but the logo missing, `logo.toString("base64")` threw inside the
     * renderer - the route's catch still answered with the banner, but every
     * request burned a render attempt and logged an internal TypeError for a
     * situation the loader documents as ordinary.
     */
    it("treats a missing logo like a missing font: banner, quietly", async () => {
        const fontPath = path.join(process.cwd(), "build", "assets", "fonts",
            "inter-v12-latin-regular.ttf");
        fs.mkdirSync(path.dirname(fontPath), {recursive: true});
        // Content is irrelevant: the logo check has to fire before anything
        // tries to shape text with this.
        fs.writeFileSync(fontPath, "not a real font");

        const logged = [];
        const original = console.error;
        console.error = (...parts) => logged.push(parts.join(" "));

        try {
            const {status, headers} = await rawRequest("/api/opengraph/image");

            assert.equal(status, 302);
            assert.match(headers.location, /^https:\/\//);
            assert.deepEqual(logged.filter((line) => /Could not generate/.test(line)), [],
                "the missing logo was handled as an internal error rather than a known absence");
        } finally {
            console.error = original;
            fs.rmSync(path.join(process.cwd(), "build"), {recursive: true, force: true});
        }
    });
});
