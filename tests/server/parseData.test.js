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
        // As the CLI really spells it: `name` is the sponsor and `location` the
        // city. Its own CSV output writes the pair as "Salt Mobile SA - Glattbrugg".
        server: {name: "Salt Mobile SA", location: "Glattbrugg", host: "fra.example.net:8080"},
        result: {id: "abc123"}
    };

    it("converts bandwidth in bytes/s to Mbit/s", () => {
        const {download, upload} = parseOokla(ooklaResult);
        assert.equal(download, 100);
        assert.equal(upload, 50);
    });

    /**
     * The latency keeps its decimals, as jitter always has.
     *
     * It used to be rounded to whole milliseconds on the way in, and the
     * rounding is not recoverable afterwards - the API, the export and the
     * integrations all read the stored column. On a line whose idle latency is
     * a millisecond or two that discards most of the measurement, and it is the
     * one figure people watch for movement (upstream #1387, #999).
     *
     * Two decimals, matching every other measurement on the row: it is what the
     * providers report and further precision would be noise.
     */
    it("keeps the latency's decimals and fixes jitter to two", () => {
        const {ping, jitter} = parseOokla(ooklaResult);
        assert.equal(ping, 12.6);
        assert.equal(jitter, 3.46);
    });

    it("holds the latency to two decimals", () => {
        assert.equal(parseOokla({...ooklaResult, ping: {latency: 12.6789, jitter: 1}}).ping, 12.68);
    });

    // A sub-millisecond latency is the case the rounding destroyed outright:
    // every reading on a local or fibre line collapsed onto 0 or 1.
    it("keeps a sub-millisecond latency", () => {
        assert.equal(parseOokla({...ooklaResult, ping: {latency: 0.42, jitter: 1}}).ping, 0.42);
    });

    it("reports the elapsed time of both directions in seconds", () => {
        assert.equal(parseOokla(ooklaResult).time, 10);
    });

    it("carries the server identity and result id through", () => {
        const {serverName, serverHost, resultId} = parseOokla(ooklaResult);
        assert.equal(serverName, "Salt Mobile SA");
        assert.equal(serverHost, "fra.example.net:8080");
        assert.equal(resultId, "abc123");
    });

    /**
     * `name` and `location` are two different things, and the one people mean
     * by "which server" is usually the second.
     *
     * The CLI's own server list spells it out - {"name":"Salt Mobile SA",
     * "location":"Glattbrugg"} - and its CSV output writes the pair as "Salt
     * Mobile SA - Glattbrugg". Only the sponsor was being kept, so a history
     * could say which company answered but not from where, and comparing two
     * tests told the reader nothing about whether the traffic had moved city.
     * Upstream #1250 asks for the location by name.
     */
    it("keeps where the server is, not only who runs it", () => {
        assert.equal(parseOokla(ooklaResult).serverLocation, "Glattbrugg");
    });

    it("nulls the location when the provider omits it", () => {
        const {server, ...withoutServer} = ooklaResult;

        assert.equal(parseOokla(withoutServer).serverLocation, null);
        assert.equal(parseOokla({...ooklaResult, server: {name: "Someone"}}).serverLocation, null);
    });

    // The LibreSpeed backends with no GeoIP database answer every client field
    // as an empty string; a blank location must not sit beside a real one.
    it("treats a blank location as none at all", () => {
        assert.equal(parseOokla({...ooklaResult, server: {...ooklaResult.server, location: "   "}}).serverLocation, null);
    });

    it("nulls the server identity when the provider omits it", () => {
        const {server, result, ...withoutServer} = ooklaResult;
        const parsed = parseOokla(withoutServer);

        assert.equal(parsed.serverName, null);
        assert.equal(parsed.serverHost, null);
        // Null rather than an absent key, as the other two parsers already
        // report a run with no result page: every consumer reads the row's
        // identity fields as "reported or null", and an undefined travelled as
        // far as the webhook before anything coerced it.
        assert.equal(parsed.resultId, null);
    });

    /**
     * An empty name is not a name.
     *
     * The location beside it was normalised and the name was not, so a server
     * answering {"name":"","location":"Glattbrugg"} stored an empty string
     * where every consumer of the row's identity fields reads "reported or
     * null". The detail pane of the day tripped over it visibly - the city
     * printed twice, the host nowhere - and though the pane has since learned
     * to dedupe, the CSV export, the notification payload and prometheus all
     * still read the column as stored.
     */
    it("treats a blank server name as none at all", () => {
        assert.equal(parseOokla({...ooklaResult, server: {...ooklaResult.server, name: ""}}).serverName, null);
        assert.equal(parseOokla({...ooklaResult, server: {...ooklaResult.server, name: "   "}}).serverName, null);
    });

    it("treats a blank server host as none at all", () => {
        assert.equal(parseOokla({...ooklaResult, server: {...ooklaResult.server, host: ""}}).serverHost, null);
    });

    // An empty id links to no result page, and the interface offers the link on
    // the id being present at all.
    it("treats a blank result id as none at all", () => {
        assert.equal(parseOokla({...ooklaResult, result: {id: "  "}}).resultId, null);
    });

    it("nulls a missing jitter rather than reporting NaN", () => {
        const parsed = parseOokla({...ooklaResult, ping: {latency: 12.6}});
        assert.equal(parsed.jitter, null);
    });

    // Regression: the truthiness check treated a measured jitter of exactly
    // zero as "not measured" and stored null - a perfectly steady line was
    // recorded as one that never said.
    it("keeps a measured jitter of exactly zero", () => {
        const parsed = parseOokla({...ooklaResult, ping: {latency: 12.6, jitter: 0}});
        assert.equal(parsed.jitter, 0);
    });

    /**
     * The CLI has always reported packet loss and the latency measured while the
     * line was saturated, and all of it was dropped on the floor. Latency under
     * load is the figure that explains a call breaking up during an upload -
     * this connection idles at 4ms and reaches 44ms loaded - and it cannot be
     * recovered after the fact, so it is captured as the test is recorded.
     */
    describe("the quality figures the result already carried", () => {
        const withQuality = {
            ...ooklaResult,
            packetLoss: 0,
            download: {...ooklaResult.download, latency: {iqm: 7.503, low: 4.872, high: 11.999, jitter: 0.564}},
            upload: {...ooklaResult.upload, latency: {iqm: 43.769, low: 4.46, high: 55.8, jitter: 5.486}}
        };

        it("keeps packet loss, including a clean zero", () => {
            assert.equal(parseOokla(withQuality).packetLoss, 0);
        });

        it("takes the interquartile mean as the latency under load", () => {
            const parsed = parseOokla(withQuality);

            assert.equal(parsed.downloadLatency, 7.5);
            assert.equal(parsed.uploadLatency, 43.77);
        });

        // Absent is not zero: a provider that does not measure these must not
        // report a perfect line. Ookla itself omits packetLoss on a restricted
        // connection.
        it("nulls them when the result does not carry them", () => {
            const parsed = parseOokla(ooklaResult);

            assert.equal(parsed.packetLoss, null);
            assert.equal(parsed.downloadLatency, null);
            assert.equal(parsed.uploadLatency, null);
        });

        it("nulls the loaded latency when the phase reports no iqm", () => {
            const parsed = parseOokla({...withQuality, upload: {...ooklaResult.upload, latency: {high: 55.8}}});

            assert.equal(parsed.uploadLatency, null);
        });
    });

    /**
     * Who the connection was, as the provider saw it. A changed address or a
     * changed ISP explains a step in the numbers that otherwise reads as the
     * line degrading - a reassigned lease, a failover, a swapped router.
     */
    describe("the connection's identity", () => {
        const withIdentity = {
            ...ooklaResult,
            isp: "Salt Mobile",
            interface: {internalIp: "192.168.1.24", externalIp: "2a04:ee41:2:4256::1", isVpn: false}
        };

        it("records the provider and the address the test went out from", () => {
            const parsed = parseOokla(withIdentity);

            assert.equal(parsed.isp, "Salt Mobile");
            assert.equal(parsed.externalIp, "2a04:ee41:2:4256::1");
        });

        it("nulls them when the result does not carry them", () => {
            const parsed = parseOokla(ooklaResult);

            assert.equal(parsed.isp, null);
            assert.equal(parsed.externalIp, null);
        });

        it("nulls the address when the interface is reported without one", () => {
            const parsed = parseOokla({...withIdentity, interface: {internalIp: "192.168.1.24"}});

            assert.equal(parsed.externalIp, null);
            assert.equal(parsed.isp, "Salt Mobile");
        });

        // A field the provider printed but could not fill is not an answer, and
        // storing one would sit a row that knows nothing about its connection
        // beside one that does, both looking equally measured.
        it("treats blank identity strings as absent", () => {
            const parsed = parseOokla({...withIdentity, isp: "", interface: {externalIp: "   "}});

            assert.equal(parsed.isp, null);
            assert.equal(parsed.externalIp, null);
        });
    });

    /**
     * How much the run itself moved. One real test measured against this CLI
     * transferred 1.14 GB down and 0.92 GB up - which is worth knowing before
     * scheduling one every fifteen minutes on a line that bills by the gigabyte,
     * and the CLI has always reported it.
     */
    describe("the data the test transferred", () => {
        const withBytes = {
            ...ooklaResult,
            download: {...ooklaResult.download, bytes: 1135809960},
            upload: {...ooklaResult.upload, bytes: 917831105}
        };

        it("records the bytes each direction moved", () => {
            const parsed = parseOokla(withBytes);

            assert.equal(parsed.bytesDownloaded, 1135809960);
            assert.equal(parsed.bytesUploaded, 917831105);
        });

        it("nulls them when the result does not carry them", () => {
            const parsed = parseOokla(ooklaResult);

            assert.equal(parsed.bytesDownloaded, null);
            assert.equal(parsed.bytesUploaded, null);
        });

        // Zero is a count: a direction that moved nothing is a fact about the
        // run, where null says the provider never counted at all.
        it("keeps a counted zero", () => {
            const parsed = parseOokla({...withBytes, upload: {...ooklaResult.upload, bytes: 0}});

            assert.equal(parsed.bytesUploaded, 0);
        });
    });

    it("names itself as the row's provider", () => {
        assert.equal(parseOokla(ooklaResult).provider, "ookla");
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

    it("keeps the ping's decimals and normalises a string jitter", () => {
        const {ping, jitter} = parseLibre(libreResult);
        assert.equal(ping, 12.7);
        assert.equal(jitter, 3.46);
    });

    it("keeps a measured jitter of exactly zero, numeric or string", () => {
        assert.equal(parseLibre({...libreResult, jitter: 0}).jitter, 0);
        assert.equal(parseLibre({...libreResult, jitter: "0"}).jitter, 0);
    });

    it("nulls a missing jitter", () => {
        const {jitter: absent, ...withoutJitter} = libreResult;
        assert.equal(parseLibre(withoutJitter).jitter, null);
    });

    // Neither of the other providers measures packet loss or latency under
    // load. They have to say so rather than leave the columns undefined, which
    // would read as an unmeasured perfect result. The connection's identity is
    // a different case - it depends on the backend, see below.
    it("reports the quality figures it cannot measure as absent", () => {
        const parsed = parseLibre(libreResult);

        assert.equal(parsed.packetLoss, null);
        assert.equal(parsed.downloadLatency, null);
        assert.equal(parsed.uploadLatency, null);
    });

    /**
     * LibreSpeed does report who the connection is - but only as far as the
     * backend it selected does. The report's client block is filled from
     * whatever that server's getIP endpoint returned, and a server with no GeoIP
     * database behind it answers with every field an empty string. An empty
     * string is not an answer, and storing one would put a row that knows
     * nothing about its connection beside one that does, both looking equally
     * measured.
     */
    describe("the connection's identity", () => {
        const withClient = {
            ...libreResult,
            client: {
                ip: "203.0.113.7", hostname: "", city: "Berlin", region: "Berlin",
                country: "DE", loc: "52.52,13.40", org: "AS3320 Deutsche Telekom AG",
                postal: "10115", timezone: "Europe/Berlin"
            }
        };

        it("records the address and the network the backend named", () => {
            const parsed = parseLibre(withClient);

            assert.equal(parsed.externalIp, "203.0.113.7");
            assert.equal(parsed.isp, "Deutsche Telekom AG");
        });

        // The organisation arrives prefixed with its AS number where Ookla
        // reports a plain name. Both write into the one column, and the
        // interface compares them as strings to mark a changed connection - so
        // the two providers have to spell the same network the same way.
        it("drops the AS number so the value matches what Ookla writes", () => {
            assert.equal(parseLibre({...withClient, client: {org: "AS13335 Cloudflare, Inc."}}).isp,
                "Cloudflare, Inc.");
        });

        it("keeps an organisation that carries no AS number", () => {
            assert.equal(parseLibre({...withClient, client: {org: "Deutsche Telekom AG"}}).isp,
                "Deutsche Telekom AG");
        });

        // What an unequipped backend actually returns - measured against the
        // shipped CLI, not imagined.
        it("treats the empty strings an unequipped backend returns as absent", () => {
            const parsed = parseLibre({
                ...libreResult,
                client: {ip: "", hostname: "", city: "", region: "", country: "",
                    loc: "", org: "", postal: "", timezone: ""}
            });

            assert.equal(parsed.externalIp, null);
            assert.equal(parsed.isp, null);
        });

        it("nulls both when the report carries no client at all", () => {
            const parsed = parseLibre(libreResult);

            assert.equal(parsed.externalIp, null);
            assert.equal(parsed.isp, null);
        });
    });

    describe("the data the test transferred", () => {
        it("records the bytes the run moved in each direction", () => {
            const parsed = parseLibre({...libreResult, bytes_received: 32505856, bytes_sent: 45318144});

            assert.equal(parsed.bytesDownloaded, 32505856);
            assert.equal(parsed.bytesUploaded, 45318144);
        });

        it("nulls them when the report omits them", () => {
            const parsed = parseLibre(libreResult);

            assert.equal(parsed.bytesDownloaded, null);
            assert.equal(parsed.bytesUploaded, null);
        });
    });

    it("names itself as the row's provider", () => {
        assert.equal(parseLibre(libreResult).provider, "libre");
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

    // The backends that fill their fields from an absent database answer with
    // empty strings rather than omitting them, and the server block is no
    // different: a blank name must not reach a reader as a server that has one.
    it("treats a blank server name and url as none at all", () => {
        const parsed = parseLibre({...libreResult, server: {name: "", url: "   "}});

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

    it("reports the quality figures it cannot measure as absent", () => {
        for (const parsed of [parseCloudflare(cloudflareResult), parseCloudflare({})]) {
            assert.equal(parsed.packetLoss, null);
            assert.equal(parsed.downloadLatency, null);
            assert.equal(parsed.uploadLatency, null);
        }
    });

    /**
     * How a direction's one figure is chosen out of the CLI's statistics.
     *
     * `speed_measurements` holds one entry per payload size per direction, and
     * each entry's min/median/max describe the individual runs at *that* size.
     * Taking `Math.max` of every entry's `max` therefore reported the single
     * fastest run observed anywhere in the test - the extreme upper tail of the
     * most favourable payload - which is what produced the four- and six-figure
     * Mbit readings in upstream #1419 and #792 beside a LibreSpeed run
     * returning a plausible number on the same line.
     *
     * The largest payload that actually ran is the only one long enough to have
     * left TCP slow start behind, and the median of its runs is the figure that
     * survives one anomalous run. Small payloads are kept out of the answer
     * entirely rather than averaged in: they systematically *under*-report on a
     * fast line, which is why maximising across sizes looked defensible.
     */
    describe("the speed it reports for a direction", () => {
        const sizedResult = (measurements) => ({...cloudflareResult, speed_measurements: measurements});

        it("takes the median of the largest payload that ran", () => {
            const {download, upload} = parseCloudflare(sizedResult([
                {test_type: "Download", payload_size: 100000, min: 8, median: 22, max: 41, avg: 24, successes: 10},
                {test_type: "Download", payload_size: 1000000, min: 90, median: 140, max: 210, avg: 145, successes: 8},
                {test_type: "Download", payload_size: 10000000, min: 180, median: 197, max: 205, avg: 196, successes: 5},
                {test_type: "Upload", payload_size: 100000, min: 5, median: 12, max: 30, avg: 14, successes: 10},
                {test_type: "Upload", payload_size: 1000000, min: 34, median: 41, max: 44, avg: 40, successes: 6}
            ]));

            assert.equal(download, 197);
            assert.equal(upload, 41);
        });

        // The reported bug, in the shape it arrives in: a small payload that
        // completes faster than the line can physically carry it - served from a
        // buffer, a proxy or a cache - and whose peak run therefore reads as
        // orders of magnitude more than the connection does.
        it("ignores the burst peak of a small payload", () => {
            const {download} = parseCloudflare(sizedResult([
                {test_type: "Download", payload_size: 100000, min: 40, median: 900, max: 6000, avg: 1500, successes: 10},
                {test_type: "Download", payload_size: 25000000, min: 180, median: 197, max: 205, avg: 196, successes: 5}
            ]));

            assert.equal(download, 197);
        });

        // cfspeedtest emits the entry for a payload size it collected nothing
        // for with every statistic null, so "largest" has to mean the largest
        // that produced a figure - not simply the last one listed.
        it("skips a payload size that produced no measurements", () => {
            const {download} = parseCloudflare(sizedResult([
                {test_type: "Download", payload_size: 1000000, min: 90, median: 140, max: 210, avg: 145, successes: 8},
                {test_type: "Download", payload_size: 100000000, min: null, median: null, max: null, avg: null,
                    successes: 0, skipped: 4}
            ]));

            assert.equal(download, 140);
        });

        /**
         * A skipped payload reports zeroes, not nulls.
         *
         * The entry for a size the CLI collected nothing at is emitted as
         * {"payload_size":25000000,"successes":0,"skipped":10,"max":0} - the
         * shape the fixture further down this file already uses - so the figure
         * alone cannot tell "the line delivered nothing" from "this size was
         * never measured". Read as the largest payload's answer it reported
         * 0 Mbit for the whole direction on a perfectly healthy connection, and
         * a zero is stored as a real measurement rather than the -1 a failure
         * carries: it drags every average and chart built on the row, and the
         * alert gate reads it as measured and raises a false outage.
         *
         * `successes` is the signal, as transferred() in the same module
         * already treats it.
         */
        it("ignores a skipped payload that reports zeroes rather than nulls", () => {
            const {download} = parseCloudflare(sizedResult([
                {test_type: "Download", payload_size: 100000, successes: 10, median: 90, max: 95.5},
                {test_type: "Download", payload_size: 25000000, successes: 0, skipped: 10, max: 0}
            ]));

            assert.equal(download, 90);
        });

        // An entry stating no success count at all is trusted: output that is
        // not shaped the way a real run's is should still answer with what it
        // does report, rather than being discarded wholesale.
        it("still reads an entry that states no success count", () => {
            const {download} = parseCloudflare(sizedResult([
                {test_type: "Download", payload_size: 1000000, median: 80}
            ]));

            assert.equal(download, 80);
        });

        it("prefers the median, then the average, then the maximum", () => {
            const of = (entry) => parseCloudflare(sizedResult([{test_type: "Download", payload_size: 1000000, ...entry}])).download;

            assert.equal(of({median: 80, avg: 70, max: 200}), 80);
            assert.equal(of({median: null, avg: 70, max: 200}), 70);
            assert.equal(of({median: null, avg: null, max: 200}), 200);
        });

        // Every entry a real run emits carries one, but the parser is fed
        // whatever the CLI printed, and a direction with no size to compare on
        // must still answer with something rather than NaN.
        it("falls back to the highest figure when no entry states a payload size", () => {
            const {download, upload} = parseCloudflare(cloudflareResult);

            assert.equal(download, 92);
            assert.equal(upload, 45);
        });

        it("reports zero for a direction whose entries all measured nothing", () => {
            const {download, upload} = parseCloudflare(sizedResult([
                {test_type: "Download", payload_size: 100000, median: null, avg: null, max: null, successes: 0}
            ]));

            assert.equal(download, 0);
            assert.equal(upload, 0);
        });

        // Two decimals, the same as every other measurement on the row. This
        // pins the contract, not the wiring: round() and the inline expression
        // it replaced agree on every finite input, so no test can tell them
        // apart - which is exactly what made the swap safe.
        it("holds the direction's speed to two decimals", () => {
            const {download} = parseCloudflare(sizedResult([
                {test_type: "Download", payload_size: 1000000, median: 197.4567, successes: 5}
            ]));

            assert.equal(download, 197.46);
        });

        it("keeps a genuinely measured zero out of the fallback", () => {
            const {download} = parseCloudflare(sizedResult([
                {test_type: "Download", payload_size: 100000, median: 0, avg: 0, max: 0, successes: 3}
            ]));

            assert.equal(download, 0);
        });
    });

    it("derives jitter as the mean absolute difference between latency samples", () => {
        assert.equal(parseCloudflare(cloudflareResult).jitter, 3);
    });

    // calculateJitter rounds with its own spelled-out expression rather than
    // round() - older than the round() helper itself, and left that way on
    // purpose when directionSpeed was deduplicated. This holds the two to the
    // same answer so that divergence, not spelling, is what fails a test.
    it("holds the derived jitter to two decimals", () => {
        const parsed = parseCloudflare({
            ...cloudflareResult,
            latency_measurement: {avg_latency_ms: 23.4, latency_measurements: [10, 14.333, 12]}
        });

        assert.equal(parsed.jitter, 3.33);
    });

    it("nulls jitter when there are fewer than two latency samples", () => {
        const parsed = parseCloudflare({
            ...cloudflareResult,
            latency_measurement: {avg_latency_ms: 23.4, latency_measurements: [10]}
        });

        assert.equal(parsed.jitter, null);
    });

    it("keeps the average latency's decimals", () => {
        assert.equal(parseCloudflare(cloudflareResult).ping, 23.4);
    });

    it("defaults the duration to 30s when the CLI omits it", () => {
        const {elapsed, ...withoutElapsed} = cloudflareResult;
        assert.equal(parseCloudflare(withoutElapsed).time, 30);
    });

    it("returns a zeroed result rather than throwing on an unusable payload", () => {
        assert.deepEqual(parseCloudflare({}), {
            ping: 0, jitter: null, download: 0, upload: 0, time: 0,
            resultId: null, provider: "cloudflare", serverName: null, serverHost: null, serverLocation: null,
            packetLoss: null, downloadLatency: null, uploadLatency: null,
            isp: null, externalIp: null, bytesDownloaded: null, bytesUploaded: null
        });
    });

    it("returns a zeroed result for a null payload", () => {
        assert.equal(parseCloudflare(null).download, 0);
    });

    /**
     * The metadata block the CLI prints beside the measurements. It was
     * discarded whole, which left a Cloudflare row unable to say which edge
     * answered or what address the test went out from - both of which the CLI
     * had already reported, and neither of which can be recovered afterwards.
     */
    describe("the connection and the edge that served it", () => {
        const withMetadata = {
            ...cloudflareResult,
            metadata: {country: "CH", ip: "2a04:ee41:2:4256::1", colo: "ZRH"}
        };

        // Cloudflare names its edges by airport code. It is the only server
        // identity the CLI reports, and these rows used to name no server at all.
        it("names the edge that answered as the server", () => {
            assert.equal(parseCloudflare(withMetadata).serverName, "ZRH");
        });

        it("records the address the test went out from", () => {
            assert.equal(parseCloudflare(withMetadata).externalIp, "2a04:ee41:2:4256::1");
        });

        // Nothing the CLI prints names the network the client is on, so this one
        // column stays Ookla's alone.
        it("still reports no isp", () => {
            assert.equal(parseCloudflare(withMetadata).isp, null);
        });

        // True of the attempt even when the measurement is not: the CLI got far
        // enough to say who was asking and which edge took the question.
        it("keeps the identity when the measurements are unusable", () => {
            const parsed = parseCloudflare({metadata: withMetadata.metadata});

            assert.equal(parsed.serverName, "ZRH");
            assert.equal(parsed.externalIp, "2a04:ee41:2:4256::1");
            assert.equal(parsed.download, 0);
        });

        it("nulls the identity when no metadata was printed", () => {
            const parsed = parseCloudflare(cloudflareResult);

            assert.equal(parsed.serverName, null);
            assert.equal(parsed.externalIp, null);
        });
    });

    /**
     * The CLI reports no byte count, but it states the payload size it used and
     * how many runs at that size succeeded - and a run that succeeded moved
     * exactly that payload. The figure is stated, not estimated.
     */
    describe("the data the test transferred", () => {
        const measured = {
            ...cloudflareResult,
            speed_measurements: [
                {test_type: "Download", payload_size: 100000, successes: 10, max: 95.5},
                {test_type: "Download", payload_size: 1000000, successes: 8, skipped: 2, max: 100.25},
                {test_type: "Upload", payload_size: 100000, successes: 5, max: 48.5}
            ]
        };

        it("counts the payload of every run that succeeded", () => {
            const parsed = parseCloudflare(measured);

            assert.equal(parsed.bytesDownloaded, 100000 * 10 + 1000000 * 8);
            assert.equal(parsed.bytesUploaded, 100000 * 5);
        });

        // A skipped run moved nothing. Counting it as though it had transferred
        // its payload would report 250 MB for a phase the CLI declined to run.
        it("counts no payload for the runs that were skipped", () => {
            const parsed = parseCloudflare({
                ...cloudflareResult,
                speed_measurements: [{test_type: "Download", payload_size: 25000000, successes: 0, skipped: 10, max: 0}]
            });

            assert.equal(parsed.bytesDownloaded, 0);
        });

        it("nulls a direction whose runs never stated a payload", () => {
            const parsed = parseCloudflare(cloudflareResult);

            assert.equal(parsed.bytesDownloaded, null);
            assert.equal(parsed.bytesUploaded, null);
        });
    });

    it("names itself as the row's provider", () => {
        assert.equal(parseCloudflare(cloudflareResult).provider, "cloudflare");
        assert.equal(parseCloudflare({}).provider, "cloudflare");
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
