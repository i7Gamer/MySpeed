import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, seedTests, setConfig } from "./helpers/boot.js";
import { FAILED_TEST } from "../../server/util/testOutcome.js";

/**
 * GET /api/badge, the whole way through: which row it describes, what the SVG
 * says, how it is served, and who is let in. The renderer itself is pinned
 * without a server in tests/server/badge.test.js.
 */

let server;
let targets;

before(async () => {
    server = await bootServer();
    targets = await import("../../server/controller/targets.js");
});

after(async () => {
    await server?.close();
});

afterEach(async () => {
    await setConfig(server.config, "password", "none");
    await targets.removeAll();
    await seedTests(server.tests, []);
});

const hoursAgo = (hours) => new Date(Date.now() - hours * 3600000).toISOString();

const failed = (created, extra = {}) => ({
    created, ping: FAILED_TEST, download: FAILED_TEST, upload: FAILED_TEST, time: null, error: "no route to host", ...extra
});

const badge = (query = "") => api(server.baseUrl, `/badge${query}`);

describe("GET /api/badge", () => {
    it("is an SVG that may be cached for a while", async () => {
        await seedTests(server.tests, [{created: hoursAgo(1), download: 120, upload: 60, ping: 12}]);

        const {status, headers, text} = await badge();

        assert.equal(status, 200);
        assert.match(headers.get("content-type"), /^image\/svg\+xml/);
        assert.match(headers.get("cache-control"), /max-age=\d+/);
        // Public, so a README's image cache may keep it - and varying on
        // what the door reads, so a shared cache never hands the operator's
        // figures to the next stranger on a locked instance.
        assert.match(headers.get("vary"), /Cookie/);
        assert.match(headers.get("vary"), /x-password/);
        assert.match(text, /^<svg /);
    });

    it("prints the newest test's readings", async () => {
        await seedTests(server.tests, [
            {created: hoursAgo(2), download: 100, upload: 50, ping: 10},
            {created: hoursAgo(1), download: 120, upload: 60, ping: 12}
        ]);

        const {text} = await badge();

        assert.match(text, /↓ 120 ↑ 60 Mbps · 12 ms/);
        assert.doesNotMatch(text, /↓ 100 /);
    });

    it("says down when the newest test failed, whatever came before", async () => {
        await seedTests(server.tests, [
            {created: hoursAgo(2), download: 100, upload: 50, ping: 10},
            failed(hoursAgo(1))
        ]);

        const {text} = await badge();

        assert.match(text, />down</);
        assert.doesNotMatch(text, /Mbps/);
    });

    it("says no data on an empty instance", async () => {
        const {status, text} = await badge();

        assert.equal(status, 200);
        assert.match(text, />no data</);
    });

    it("describes the headline line, not the newest row of any line", async () => {
        const wan = await targets.create({name: "WAN", provider: "ookla", sortOrder: 0});
        const lan = await targets.create({name: "LAN", provider: "iperf3", endpoint: "10.0.0.5:5201", sortOrder: 1});

        await seedTests(server.tests, [
            {created: hoursAgo(2), targetId: wan.id, download: 100, upload: 50, ping: 10},
            {created: hoursAgo(1), targetId: lan.id, download: 940, upload: 930, ping: 1}
        ]);

        const {text} = await badge();

        assert.match(text, /↓ 100 /);
        assert.doesNotMatch(text, /940/);
    });

    it("prints one reading when asked for one", async () => {
        await seedTests(server.tests, [{created: hoursAgo(1), download: 120, upload: 60, ping: 12}]);

        assert.match((await badge("?metric=ping")).text, />12 ms</);
        assert.match((await badge("?metric=download")).text, />↓ 120 Mbps</);
        assert.match((await badge("?metric=nonsense")).text, /↓ 120 ↑ 60 Mbps · 12 ms/);
    });

    it("takes a label from the request and escapes it", async () => {
        await seedTests(server.tests, [{created: hoursAgo(1), download: 120, upload: 60, ping: 12}]);

        const {text} = await badge(`?label=${encodeURIComponent("Home <b>line</b>")}`);

        assert.ok(text.includes("Home &lt;b&gt;line&lt;/b&gt;"));
        assert.ok(!text.includes("<b>"));
    });

    it("marks a latency nobody measured", async () => {
        await seedTests(server.tests, [{created: hoursAgo(1), download: 120, upload: 60, ping: 0}]);

        assert.match((await badge()).text, /· N\/A ms/);
    });
});

describe("who is let in", () => {
    const PASSWORD = "Correct Horse Battery Staple 1";

    it("answers a private badge, not a refusal, when the instance is locked", async () => {
        await seedTests(server.tests, [{created: hoursAgo(1), download: 120, upload: 60, ping: 12}]);
        await setConfig(server.config, "password", PASSWORD);
        await setConfig(server.config, "passwordLevel", "none");

        const {status, headers, text} = await badge();

        assert.equal(status, 200);
        assert.match(headers.get("content-type"), /^image\/svg\+xml/);
        assert.match(text, />private</);
        assert.doesNotMatch(text, /120/, "the figures leaked through the private badge");
    });

    it("answers the figures when strangers may read", async () => {
        await seedTests(server.tests, [{created: hoursAgo(1), download: 120, upload: 60, ping: 12}]);
        await setConfig(server.config, "password", PASSWORD);
        await setConfig(server.config, "passwordLevel", "read");

        assert.match((await badge()).text, /↓ 120 /);
    });
});
