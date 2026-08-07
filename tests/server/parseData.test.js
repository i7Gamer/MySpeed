import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseData, parseOokla, parseLibre, parseCloudflare } from "../../server/util/providers/parseData.js";

/**
 * These functions turn raw provider CLI output into the exact numbers persisted
 * in the speedtests table, so a misparse silently corrupts every stored
 * measurement rather than failing loudly.
 */

describe("parseOokla", () => {
    const ooklaResult = {
        ping: {latency: 12.6, jitter: 3.456},
        download: {bandwidth: 12500000, elapsed: 5000},
        upload: {bandwidth: 6250000, elapsed: 5000},
        server: {name: "Frankfurt", host: "fra.example.net:8080"},
        result: {id: "abc123"}
    };

    it("converts bandwidth in bytes/s to Mbit/s", () => {
        const {download, upload} = parseOokla(ooklaResult);
        assert.equal(download, 100);
        assert.equal(upload, 50);
    });

    it("rounds the latency and fixes jitter to two decimals", () => {
        const {ping, jitter} = parseOokla(ooklaResult);
        assert.equal(ping, 13);
        assert.equal(jitter, 3.46);
    });

    it("reports the elapsed time of both directions in seconds", () => {
        assert.equal(parseOokla(ooklaResult).time, 10);
    });

    it("carries the server identity and result id through", () => {
        const {serverName, serverHost, resultId} = parseOokla(ooklaResult);
        assert.equal(serverName, "Frankfurt");
        assert.equal(serverHost, "fra.example.net:8080");
        assert.equal(resultId, "abc123");
    });

    it("nulls the server identity when the provider omits it", () => {
        const {server, result, ...withoutServer} = ooklaResult;
        const parsed = parseOokla(withoutServer);

        assert.equal(parsed.serverName, null);
        assert.equal(parsed.serverHost, null);
        assert.equal(parsed.resultId, undefined);
    });

    it("nulls a missing jitter rather than reporting NaN", () => {
        const parsed = parseOokla({...ooklaResult, ping: {latency: 12.6}});
        assert.equal(parsed.jitter, null);
    });
});

describe("parseLibre", () => {
    const libreResult = {
        ping: 12.7,
        jitter: "3.456",
        elapsed: 8000,
        download: 90.5,
        upload: 40.25,
        server: {name: "Berlin", url: "http://berlin.example.net"}
    };

    it("rounds the ping and normalises a string jitter", () => {
        const {ping, jitter} = parseLibre(libreResult);
        assert.equal(ping, 13);
        assert.equal(jitter, 3.46);
    });

    it("converts the elapsed milliseconds to seconds and has no result id", () => {
        const {time, resultId} = parseLibre(libreResult);
        assert.equal(time, 8);
        assert.equal(resultId, null);
    });

    it("passes the measured speeds through untouched", () => {
        const {download, upload} = parseLibre(libreResult);
        assert.equal(download, 90.5);
        assert.equal(upload, 40.25);
    });

    it("maps the server url to the host column", () => {
        const {serverName, serverHost} = parseLibre(libreResult);
        assert.equal(serverName, "Berlin");
        assert.equal(serverHost, "http://berlin.example.net");
    });

    it("nulls the server identity when the provider omits it", () => {
        const {server, ...withoutServer} = libreResult;
        const parsed = parseLibre(withoutServer);

        assert.equal(parsed.serverName, null);
        assert.equal(parsed.serverHost, null);
    });
});

describe("parseCloudflare", () => {
    const cloudflareResult = {
        latency_measurement: {avg_latency_ms: 23.4, latency_measurements: [10, 14, 12]},
        speed_measurements: [
            {test_type: "Download", max: 95.5, median: 90},
            {test_type: "Download", max: 100.25, median: 92},
            {test_type: "Upload", max: 48.5, median: 45}
        ],
        elapsed: 25000
    };

    it("takes the fastest measurement per direction", () => {
        const {download, upload} = parseCloudflare(cloudflareResult);
        assert.equal(download, 100.25);
        assert.equal(upload, 48.5);
    });

    it("falls back to the median when a run reports no maximum", () => {
        const parsed = parseCloudflare({
            ...cloudflareResult,
            speed_measurements: [{test_type: "Download", max: 0, median: 80}, {test_type: "Upload", max: 0, median: 30}]
        });

        assert.equal(parsed.download, 80);
        assert.equal(parsed.upload, 30);
    });

    it("derives jitter as the mean absolute difference between latency samples", () => {
        assert.equal(parseCloudflare(cloudflareResult).jitter, 3);
    });

    it("nulls jitter when there are fewer than two latency samples", () => {
        const parsed = parseCloudflare({
            ...cloudflareResult,
            latency_measurement: {avg_latency_ms: 23.4, latency_measurements: [10]}
        });

        assert.equal(parsed.jitter, null);
    });

    it("rounds the average latency", () => {
        assert.equal(parseCloudflare(cloudflareResult).ping, 23);
    });

    it("defaults the duration to 30s when the CLI omits it", () => {
        const {elapsed, ...withoutElapsed} = cloudflareResult;
        assert.equal(parseCloudflare(withoutElapsed).time, 30);
    });

    it("returns a zeroed result rather than throwing on an unusable payload", () => {
        assert.deepEqual(parseCloudflare({}), {
            ping: 0, jitter: null, download: 0, upload: 0, time: 0,
            resultId: null, serverName: null, serverHost: null
        });
    });

    it("returns a zeroed result for a null payload", () => {
        assert.equal(parseCloudflare(null).download, 0);
    });
});

describe("parseData", () => {
    it("dispatches to the provider-specific parser", () => {
        const ookla = parseData("ookla", {
            ping: {latency: 5, jitter: 1}, download: {bandwidth: 1250000, elapsed: 1000},
            upload: {bandwidth: 1250000, elapsed: 1000}
        });

        assert.equal(ookla.download, 10);
        assert.equal(parseData("cloudflare", {}).download, 0);
    });

    it("rejects an unknown provider", () => {
        assert.throws(() => parseData("nonsense", {}), (e) => e.message === "Invalid provider");
    });
});
