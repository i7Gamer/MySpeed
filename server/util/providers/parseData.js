// The placeholder a failed run stores in every measurement column, taken from
// the module that owns the judgement rather than written out as -1 here: what
// this file produces has to be what isFailedTest recognises.
import { FAILED_TEST, REQUIRED_MEASUREMENTS } from '../testOutcome.js';
import { metricValue } from '../metricValue.js';

// The inverse of the split the runner already made, taken from the module that
// owns both halves rather than spelled out here as `${host}:${port}` - which is
// how an IPv6 target's address came to be stored as a different IPv6 address.
import { joinEndpoint } from './registry.js';

// Exported so the live progress readout reports a transfer in the same unit,
// rounded the same way, as the figure eventually stored for it.
export const roundSpeed = (bandwidth) => {
    return Math.round(bandwidth / 1250) / 100;
};

/**
 * What separates a rate stated in bits from the bytes roundSpeed takes.
 *
 * roundSpeed is written for the Ookla CLI, whose `bandwidth` is bytes per
 * second. iperf3 states bits per second, and passing one to the other reports
 * eight times the line's actual speed - in the right column, as a plausible
 * number, where nothing downstream can tell.
 */
export const BITS_PER_BYTE = 8;

/**
 * What each parser records as its rows' provenance.
 *
 * Written onto the row rather than read from the setting: the setting says what
 * runs next, so a history spanning a change of provider would otherwise
 * attribute every older row to whichever one happens to be selected now. The
 * three do not measure the same thing, and the column is what lets a reader tell
 * a line that reported no packet loss from a provider that never measures it.
 */
export const OOKLA = "ookla";
export const LIBRE = "libre";
export const CLOUDFLARE = "cloudflare";
export const IPERF3 = "iperf3";

// Only ookla measures these, and a provider that did not measure something must
// say so: left undefined they would store as NULL and read as a flawless line
// rather than as an unmeasured one. The connection's identity is no longer in
// here - the other two do report parts of it, when their backend knows it.
const NO_QUALITY_FIGURES = {packetLoss: null, downloadLatency: null, uploadLatency: null};

const MS_PER_SECOND = 1000;

// What the `time` column holds when the CLI reported no duration: its own
// default, not null. The column is INTEGER with a default of 0 and every
// reader takes it as a number - and NaN, which an absent elapsed used to
// become, is refused by the insert and takes the whole measurement with it.
const MISSING_DURATION = 0;

const durationSeconds = (elapsedMs) =>
    Number.isFinite(elapsedMs) ? Math.round(elapsedMs / MS_PER_SECOND) : MISSING_DURATION;

// The same guard for a provider that already reports seconds.
const wholeSeconds = (seconds) => Number.isFinite(seconds) ? Math.round(seconds) : MISSING_DURATION;

const round = (value) => value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : parseFloat(Number(value).toFixed(2));

/**
 * A string the provider actually answered with, or null.
 *
 * The LibreSpeed backends that carry no GeoIP database return every client field
 * as an empty string rather than omitting it, and cfspeedtest can print a
 * metadata block with blank members. Storing those would sit a row that knows
 * nothing about its connection beside one that does, both looking equally
 * measured.
 */
const text = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/**
 * A count of bytes, or null when the provider reported none.
 *
 * Zero is kept: a direction that moved nothing is a fact about the run, where
 * null says nothing counted it.
 */
const byteCount = (value) => {
    if (value === null || value === undefined) return null;

    const bytes = Number(value);

    return Number.isFinite(bytes) && bytes >= 0 ? Math.round(bytes) : null;
};

/**
 * The interquartile mean of the latency measured while that direction was
 * saturated - what the line does under load, as opposed to the idle ping. The
 * mean is taken rather than the peak because a single outlier should not
 * describe the connection.
 */
const loadedLatency = (direction) => round(direction?.latency?.iqm);

const calculateJitter = (latencyMeasurements) => {
    if (!latencyMeasurements || latencyMeasurements.length < 2) return null;
    let totalDiff = 0;
    for (let i = 1; i < latencyMeasurements.length; i++) {
        totalDiff += Math.abs(latencyMeasurements[i] - latencyMeasurements[i - 1]);
    }
    return parseFloat((totalDiff / (latencyMeasurements.length - 1)).toFixed(2));
};

export const parseOokla = (test) => {
    /*
     * The three blocks every reading below comes out of, checked once.
     *
     * The top of this function read them straight - `test.ping.latency`,
     * `test.download.bandwidth` - while everything from the server name down
     * was optional-chained, so the two halves disagreed about whether the CLI's
     * output could be trusted. A result missing any of them threw a TypeError
     * naming a JavaScript property, and that string is what gets stored in the
     * failed test's error column, where an operator reads it.
     *
     * Refused rather than parsed around. Letting the figures come back null
     * instead would store a row isFailedTest does not recognise as a failure,
     * so a test that measured nothing would be averaged in as though it had.
     */
    if (!test?.ping || !test?.download || !test?.upload)
        throw new Error("the ookla result reported no ping, download or upload block");

    // round() to two decimals, not Math.round() to whole milliseconds: the
    // column holds a double now, and on a fibre or local line the whole reading
    // lives below the millisecond. Same treatment as the jitter beside it.
    let ping = round(test.ping.latency);
    // round(), not a truthiness check: a jitter of exactly zero is a
    // measurement - a perfectly steady line - and must not store as null.
    let jitter = round(test.ping.jitter);
    let download = roundSpeed(test.download.bandwidth);
    let upload = roundSpeed(test.upload.bandwidth);
    let time = durationSeconds(test.download.elapsed + test.upload.elapsed);
    // text(), like the location below: an empty name used to pass through
    // unchanged, so a server answering {"name":"","location":"Glattbrugg"}
    // stored "" where every consumer of an absent value expects null. The
    // detail pane dedupes its two server lines these days and no longer trips
    // over it, but the row is read by more than one consumer - the CSV export,
    // the notification payload, prometheus - and "" is a value each of them
    // has to know to disbelieve, where null already reads as absent.
    let serverName = text(test.server?.name);
    let serverHost = text(test.server?.host);
    // Where the server is, as opposed to who runs it. The CLI keeps the two
    // apart - {"name":"Salt Mobile SA","location":"Glattbrugg"} - and writes
    // them as a pair in its own CSV. Only the sponsor was kept, so a history
    // could say which company answered but not from where, and two tests could
    // not be compared for whether the traffic had moved city.
    let serverLocation = text(test.server?.location);

    return {ping, jitter, download, upload, time, resultId: text(test.result?.id), serverName, serverHost,
        serverLocation,
        provider: OOKLA,
        packetLoss: round(test.packetLoss),
        downloadLatency: loadedLatency(test.download),
        uploadLatency: loadedLatency(test.upload),
        // Who the connection was, as the provider saw it: a changed address or
        // provider explains a step in the numbers that otherwise reads as the
        // line itself degrading.
        isp: text(test.isp),
        externalIp: text(test.interface?.externalIp),
        // What the run cost in traffic. A single test here moved over two
        // gigabytes, which is the sort of thing worth knowing before scheduling
        // one every fifteen minutes on a metered line.
        bytesDownloaded: byteCount(test.download?.bytes),
        bytesUploaded: byteCount(test.upload?.bytes)};
};

/**
 * The network the backend named, spelled the way ookla spells one.
 *
 * LibreSpeed passes ipinfo.io's organisation through verbatim - "AS3320 Deutsche
 * Telekom AG" - where ookla reports the plain name. Both write into the one
 * column and the interface compares them as strings to mark a changed
 * connection, so the same network has to read the same from either provider.
 */
const AS_PREFIX = /^AS\d+\s+/;

const ispName = (org) => {
    const name = text(org);

    return name === null ? null : text(name.replace(AS_PREFIX, ""));
};

const libreFigures = (test) => ({...test, ...NO_QUALITY_FIGURES, provider: LIBRE,
    ping: round(test.ping),
    // round() also normalises the string jitter this CLI reports, and keeps a
    // measured zero rather than nulling it as falsy.
    jitter: round(test.jitter),
    // `elapsed` is the runner's wall clock from spawn to close, spread over the
    // CLI's own object by speedtest.js - the CLI reports no duration of its
    // own. So this `time` and Cloudflare's below are the whole run, process
    // start and latency sampling included, where Ookla's is the CLI's two
    // transfer phases and iperf3's the transfer seconds alone. Comparable
    // within one target, which is one provider; across providers the
    // statistics' "average duration" puts phase time beside wall time.
    time: durationSeconds(test.elapsed), resultId: null,
    serverName: text(test.server?.name), serverHost: text(test.server?.url),
    // Its result names the backend and its URL, and nothing about where it is.
    serverLocation: null,
    // Reported only as far as the selected backend reports it: the client block
    // is filled from that server's getIP endpoint, and one without a GeoIP
    // database answers with empty strings throughout.
    isp: ispName(test.client?.org),
    externalIp: text(test.client?.ip),
    bytesDownloaded: byteCount(test.bytes_received),
    bytesUploaded: byteCount(test.bytes_sent)});

export const parseLibre = (test) => {
    // The spread above tolerates null and the very next read does not, so an
    // empty result failed as a TypeError one line further on. Named here for
    // the reason parseOokla names its own: this message is what gets stored in
    // the failed test's error column, where an operator reads it.
    if (!test) throw new Error("the librespeed result was empty");

    return libreFigures(test);
};

/**
 * How many bytes a direction's runs moved.
 *
 * cfspeedtest reports no byte count, but it states the payload size it used and
 * how many runs at that size succeeded - and a run that succeeded moved exactly
 * that payload, so this is stated rather than estimated. Runs it skipped moved
 * nothing and are not counted.
 *
 * Null when no run stated a payload at all: that is a provider that did not
 * report, which is not the same as a direction that carried nothing.
 */
const transferred = (measurements) => {
    let total = 0;
    let counted = false;

    for (const measurement of measurements) {
        const size = Number(measurement.payload_size);
        const runs = Number(measurement.successes);

        if (!Number.isFinite(size) || !Number.isFinite(runs) || size < 0 || runs < 0) continue;

        total += size * runs;
        counted = true;
    }

    return counted ? total : null;
};

/**
 * How one entry's runs are summarised, in order of preference.
 *
 * The median first, because it is the figure that survives a single anomalous
 * run. The CLI emits all of these as null together when it collected nothing at
 * that payload size, so the fallbacks only matter for output that is not shaped
 * the way a real run's is.
 */
const REPRESENTATIVE_KEYS = ["median", "avg", "max"];

const figureOf = (measurement) => {
    for (const key of REPRESENTATIVE_KEYS) {
        const reported = measurement?.[key];
        // Compared before coercing: Number(null) is 0, so a statistic the CLI
        // reported as null would otherwise read as a measured zero and stop the
        // fallback here.
        if (reported === null || reported === undefined) continue;

        const value = Number(reported);
        if (Number.isFinite(value)) return value;
    }

    return null;
};

const payloadSizeOf = (measurement) => {
    const size = Number(measurement?.payload_size);

    return Number.isFinite(size) && size >= 0 ? size : 0;
};

/**
 * Whether the CLI actually completed a run at this payload size.
 *
 * A size it collected nothing at is reported with its statistics zeroed rather
 * than nulled - {"payload_size":25000000,"successes":0,"skipped":10,"max":0} -
 * so the figure alone cannot tell a line that delivered nothing from a size
 * that was never measured. Taken as the largest payload's answer, that zero
 * became the speed for the whole direction on a healthy connection, and a zero
 * is stored as a genuine measurement rather than the -1 a failure carries: it
 * drags every average and chart built on the row, and the alert gate reads it
 * as measured and raises an outage that never happened.
 *
 * `successes` is what transferred() above already reads to decide the same
 * question, so the two no longer disagree about whether an entry ran.
 *
 * An entry stating no count at all is trusted rather than discarded: output not
 * shaped the way a real run's is should still answer with what it does report.
 */
const ranAnything = (measurement) => {
    const runs = Number(measurement?.successes);

    return !Number.isFinite(runs) || runs > 0;
};

/**
 * The one figure that stands for a direction, out of the CLI's statistics.
 *
 * `speed_measurements` carries one entry per payload size per direction, and
 * that entry's min/median/max describe the individual runs at *that* size. The
 * figure taken used to be `Math.max` over every entry's own `max`, i.e. the
 * single fastest run observed anywhere in the test: the extreme upper tail of
 * whichever payload happened to flatter the line most. On a connection where a
 * small payload completes faster than the link can carry it - served out of a
 * buffer, a proxy or a cache - that reads as orders of magnitude more than the
 * line does, which is the four- and six-figure Mbit readings people compared
 * against a sane LibreSpeed run on the same connection.
 *
 * The largest payload that actually ran is the only one long enough to have
 * left TCP slow start behind, so it alone is asked. Smaller payloads are
 * excluded rather than folded in: they systematically under-report on a fast
 * line, which is what made maximising across sizes look reasonable in the first
 * place.
 */
const directionSpeed = (measurements) => {
    let best = null;

    for (const measurement of measurements) {
        if (!ranAnything(measurement)) continue;

        const figure = figureOf(measurement);
        if (figure === null) continue;

        const size = payloadSizeOf(measurement);

        // A larger payload always wins. Between entries of the same size -
        // which real output never has, but a payload-less one is all ties - the
        // higher figure does, so such a run still answers with its best.
        if (best === null || size > best.size || (size === best.size && figure > best.figure))
            best = {size, figure};
    }

    /*
     * Null, not zero, when nothing ran.
     *
     * A fabricated zero is indistinguishable from the reading it imitates once
     * it is in the column, and the two mean opposite things: a direction that
     * ran and moved nothing is a real measurement - it is what an outage looks
     * like - while a direction that never ran is the absence of one. Answering 0
     * for the second published a malfunction as a line delivering nothing, which
     * is the fault the comment below parseCloudflare's success branch describes
     * having fixed for the case where the blocks are missing altogether.
     *
     * `ranAnything` above is what keeps the distinction: an entry the CLI
     * skipped is not counted, and one that succeeded is - whatever figure it
     * reports, zero included.
     */
    return best === null ? null : round(best.figure);
};

/**
 * A cloudflare run that measured nothing, with whatever it did establish kept.
 *
 * Both callers below reach this - the run whose measurement blocks never
 * arrived, and the run whose blocks arrived empty - and they are the same
 * outcome, so they answer with the same row rather than two spellings of it.
 *
 * It used to answer zeros, which carry no error, and isFailedTest reads the
 * placeholders only when all three agree on -1 - so a row of zeros was a
 * success. A run that measured nothing therefore counted toward the success
 * total and pulled every download, upload and ping average toward zero: a
 * malfunction published as a line delivering nothing.
 *
 * The placeholders rather than a throw, because both of the things this does are
 * worth keeping. The parser stays total - a CLI that prints something unusable
 * is not an exception - and the identity survives: the attempt reached an edge
 * and came from an address, and that is true of the attempt even when the
 * measurement is not.
 */
const unmeasurableRun = (identity) => ({
    ping: FAILED_TEST, jitter: null, download: FAILED_TEST, upload: FAILED_TEST, time: null,
    resultId: null, ...identity, bytesDownloaded: null, bytesUploaded: null
});

export const parseCloudflare = (test) => {
    const metadata = test?.metadata ?? {};

    /**
     * Who was asking and which edge took the question.
     *
     * Held apart from the measurement so it survives a run that produced no
     * usable figures: if the CLI got far enough to print the metadata block,
     * that much is still true of the attempt.
     */
    const identity = {
        provider: CLOUDFLARE,
        // Cloudflare names its edges by airport code - "ZRH". It is the only
        // server identity the CLI reports, and it was being thrown away, so
        // these rows named no server at all.
        serverName: text(metadata.colo),
        serverHost: null,
        // The colo airport code above is the only thing the CLI says about
        // where the edge is, and it is already the server's name here.
        serverLocation: null,
        externalIp: text(metadata.ip),
        ...NO_QUALITY_FIGURES,
        // Nothing the CLI prints names the network the client is on.
        isp: null
    };

    // Array.isArray rather than truthiness: the next three lines call .filter on
    // it, so an object there would throw where a missing block returns the
    // unmeasured shape below. This asks what the code actually needs.
    if (test?.latency_measurement && Array.isArray(test.speed_measurements)) {
        const downloadTests = test.speed_measurements.filter(t => t.test_type === "Download");
        const uploadTests = test.speed_measurements.filter(t => t.test_type === "Upload");

        const download = directionSpeed(downloadTests);
        const upload = directionSpeed(uploadTests);

        /*
         * The blocks being *present* is not the same as their holding anything,
         * and the condition above only asks the first question: `{}` and `[]`
         * are both truthy, so a run that measured nothing came down here and had
         * a zero invented for each direction. That is the same row of zeros the
         * failure branch below was written to stop, arriving by the other door.
         *
         * Either direction is enough to refuse the run. Both columns are NOT
         * NULL and there is no sentinel for an unmeasured throughput - unlike
         * the latency column, which can borrow zero because no connection
         * produces one - so half a result has nowhere honest to be stored.
         *
         * The ping is deliberately not part of this. Zero already means "nobody
         * measured this" there, testOutcome.js owns that convention, and a run
         * that measured its throughput is a result whether or not a latency came
         * with it.
         */
        if (download === null || upload === null) return unmeasurableRun(identity);

        const ping = round(test.latency_measurement.avg_latency_ms) ?? 0;
        const jitter = calculateJitter(test.latency_measurement.latency_measurements);

        const time = Math.round((test.elapsed || 30000) / 1000);
        
        return {ping, jitter, download, upload, time, resultId: null, ...identity,
            bytesDownloaded: transferred(downloadTests),
            bytesUploaded: transferred(uploadTests)};
    }

    return unmeasurableRun(identity);
};

/**
 * The bits-per-second one direction of an iperf3 run actually carried.
 *
 * `sum_received` rather than `sum_sent`, and the difference is not cosmetic:
 * the sender's figure counts what it handed to the kernel, retransmissions
 * included, while the receiver's counts what arrived. On a lossy path the two
 * disagree by exactly the loss, and the number a speed history is for is the
 * one that arrived.
 *
 * Falls back to the sender's when a run reports no receiver total, which is
 * what a run cut short mid-transfer looks like.
 */
const directionRate = (end) => {
    const received = end?.sum_received?.bits_per_second;
    const sent = end?.sum_sent?.bits_per_second;

    const rate = Number.isFinite(received) ? received : sent;

    /*
     * Handed back in bytes per second, because that is what roundSpeed takes.
     *
     * Not a detail: roundSpeed is written for the Ookla CLI, whose `bandwidth`
     * is bytes per second, and iperf3 states bits. Passed through as they
     * arrive, every iperf3 reading was eight times the line's actual speed -
     * a 94 Mbit/s connection stored as 752 - and nothing downstream could tell,
     * because the figure is a plausible number in the right column.
     */
    return Number.isFinite(rate) ? rate / BITS_PER_BYTE : null;
};

const directionBytes = (end) => {
    const received = end?.sum_received?.bytes;
    const sent = end?.sum_sent?.bytes;

    return byteCount(Number.isFinite(received) ? received : sent);
};

/**
 * The jitter and loss one direction of a UDP run reported, or null for a TCP
 * one - which carries neither key, so their absence is the whole branch and
 * nothing about the invocation has to reach the parser for it to know which
 * kind of run it is reading.
 *
 * The receiver's figures alone, and deliberately not as a preference the way
 * directionRate reads throughput. The sender does not measure either of these:
 * `sum_sent.jitter_ms` is zero in every capture, and `sum_sent.lost_percent`
 * stayed zero through a run that lost 2789 of 17260 packets. A fallback to it
 * would not be a degraded reading, it would be a confident wrong one - a badly
 * lossy line stored as perfect.
 */
const udpQuality = (end) => {
    const received = end?.sum_received;

    const jitter = Number.isFinite(received?.jitter_ms) ? received.jitter_ms : null;
    const loss = Number.isFinite(received?.lost_percent) ? received.lost_percent : null;

    return jitter === null && loss === null ? null : {jitter, loss};
};

/**
 * The worse of the two directions, for a figure the row keeps one column for.
 *
 * Larger is worse for both of these, and a test where one way was steady and
 * the other was not is not a steady test - so the direction that suffered is
 * the one worth storing. Reported as a measurement rather than an average,
 * because a mean of two directions is a number neither of them measured.
 */
const worstOf = (readings, key) => {
    const figures = readings.map((reading) => reading[key]).filter(Number.isFinite);

    return figures.length === 0 ? null : Math.max(...figures);
};

/**
 * One iperf3 test, which is two invocations of the CLI.
 *
 * iperf3 measures a single direction at a time, so the runner performs one run
 * with -R for the download and one without for the upload and hands both over
 * keyed by direction - see runsOf. Each run's `data` is the end event of its
 * own --json-stream output.
 *
 * The latency is not iperf3's: it reports none at all, so the runner measures
 * the handshake to the same host and port and passes it in. See iperfLatency
 * for why that is the honest figure to take and what it is not comparable to.
 *
 * Nothing here reports a server's identity beyond the address that was dialled
 * - an iperf3 server is a host the operator runs, not one of a provider's
 * fleet - and none of the quality figures exist: this tool measures throughput,
 * and a column left null says "not measured" where a zero would claim a
 * flawless line.
 */
export const parseIperf3 = (test) => {
    const runs = test?.runs ?? {};
    const download = runs.download?.data;
    const upload = runs.upload?.data;

    const downloadRate = directionRate(download);
    const uploadRate = directionRate(upload);

    /*
     * The address dialled, as the runner resolved it from the target.
     *
     * Not read back out of the output, which was the first attempt and does
     * not work: under --json-stream `connecting_to` is part of the *start*
     * event, and what reaches a parser is the end event alone - so every row
     * named no server at all. The runner has already split host from port to
     * aim its latency samples, and one reading of that string is one chance to
     * disagree with itself.
     */
    const host = text(test?.endpoint?.host);
    const port = Number.isInteger(test?.endpoint?.port) ? test.endpoint.port : null;

    const identity = {
        provider: IPERF3,
        /*
         * No name, deliberately.
         *
         * An iperf3 server is a host the operator runs and the CLI has no name
         * for one - only the address that was dialled. The target's own name
         * was the obvious thing to put here and would have said it twice: the
         * detail pane draws that name in its Target fact already, and its
         * server line falls back to the host when there is no name, which is
         * exactly the address below.
         */
        serverName: null,
        serverHost: joinEndpoint({host, port}),
        serverLocation: null,
        resultId: null,
        // An iperf3 server is the operator's own machine, and nothing in the
        // output names the network the client is on or the address it came
        // from.
        isp: null,
        externalIp: null,
        ...NO_QUALITY_FIGURES
    };

    /*
     * A run that measured neither direction is not a result.
     *
     * Both throughput columns are NOT NULL with no sentinel for "unmeasured",
     * so half a result has nowhere honest to be stored - the same judgement
     * parseCloudflare makes, and for the same reason.
     */
    if (downloadRate === null || uploadRate === null)
        return {ping: FAILED_TEST, jitter: null, download: FAILED_TEST, upload: FAILED_TEST,
            time: null, ...identity, bytesDownloaded: null, bytesUploaded: null};

    // The latency the runner measured, or the placeholder when every handshake
    // failed. Zero already means "nobody measured this" for the ping column -
    // testOutcome.js owns that convention - so a transfer that succeeded
    // without a latency is still a result.
    const ping = round(test?.latency?.ping) ?? 0;

    /*
     * What the transfer itself measured, when it was a UDP one.
     *
     * The runner's own jitter is timed off TCP handshakes, because a TCP
     * transfer leaves nothing else to time. A UDP transfer measures the thing
     * the test was actually for, so it displaces the handshake sample rather
     * than sitting beside it - storing the handshake's would answer a question
     * nobody asked while the real figure went in no column at all.
     */
    const udp = [udpQuality(download), udpQuality(upload)].filter((reading) => reading !== null);
    const measuredJitter = worstOf(udp, "jitter");

    return {
        ping,
        // ?? rather than ||, so a run that measured a jitter of zero keeps it
        // instead of falling back to the handshake sample.
        jitter: round(measuredJitter) ?? round(test?.latency?.jitter),
        download: roundSpeed(downloadRate),
        upload: roundSpeed(uploadRate),
        // Both transfers, in seconds, as the other providers report their own
        // total. Taken from the runs' own clocks rather than the wall time,
        // which would include the latency sampling and the process starts.
        time: wholeSeconds(Number(download?.sum_received?.seconds ?? download?.sum_sent?.seconds ?? 0)
            + Number(upload?.sum_sent?.seconds ?? upload?.sum_received?.seconds ?? 0)),
        ...identity,
        // After the spread, which carries the null a TCP run keeps: this is
        // the one provider whose packet loss depends on how the run was asked
        // for rather than on what the CLI can measure.
        packetLoss: round(worstOf(udp, "loss")),
        bytesDownloaded: directionBytes(download),
        bytesUploaded: directionBytes(upload)
    };
};

export const parseData = (provider, data) => {
    const parsed = (() => {
        switch (provider) {
            case OOKLA:
                return parseOokla(data);
            case LIBRE:
                return parseLibre(data);
            case CLOUDFLARE:
                return parseCloudflare(data);
            case IPERF3:
                return parseIperf3(data);
            default:
                throw {message: "Invalid provider"};
        }
    })();

    // A required measurement the parser could not read is the failure
    // placeholder, not NaN. roundSpeed answers NaN for an Ookla result whose
    // bandwidth block was empty, and cfspeedtest can do the same - and NaN
    // passed both write-path guards (isFailedTest wants all three placeholders;
    // impossibleMeasurement asks `< 0`), so the row was stored as a success
    // with the literal "NaN" in a NOT NULL DOUBLE, poisoning every average
    // over it. As the placeholder it takes the failed path executeTarget
    // already has: all three unreadable read as a failed run, one unreadable
    // beside good figures as an impossible measurement, retried once.
    //
    // Judged by metricValue, not a bare finite check: a numeric *string* is a
    // measurement - this very CLI family reports jitter as one - and rewriting
    // it into the placeholder would record a failed run and retry a line that
    // was fine. metricValue reads it as the number it spells, which is also
    // what gets stored; only what it refuses becomes the placeholder.
    for (const key of REQUIRED_MEASUREMENTS) {
        const reading = metricValue(parsed[key]);
        parsed[key] = reading === null ? FAILED_TEST : reading;
    }

    return parsed;
};