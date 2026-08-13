// Exported so the live progress readout reports a transfer in the same unit,
// rounded the same way, as the figure eventually stored for it.
export const roundSpeed = (bandwidth) => {
    return Math.round(bandwidth / 1250) / 100;
};

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

// Only ookla measures these, and a provider that did not measure something must
// say so: left undefined they would store as NULL and read as a flawless line
// rather than as an unmeasured one. The connection's identity is no longer in
// here - the other two do report parts of it, when their backend knows it.
const NO_QUALITY_FIGURES = {packetLoss: null, downloadLatency: null, uploadLatency: null};

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
    // round() to two decimals, not Math.round() to whole milliseconds: the
    // column holds a double now, and on a fibre or local line the whole reading
    // lives below the millisecond. Same treatment as the jitter beside it.
    let ping = round(test.ping.latency);
    // round(), not a truthiness check: a jitter of exactly zero is a
    // measurement - a perfectly steady line - and must not store as null.
    let jitter = round(test.ping.jitter);
    let download = roundSpeed(test.download.bandwidth);
    let upload = roundSpeed(test.upload.bandwidth);
    let time = Math.round((test.download.elapsed + test.upload.elapsed) / 1000);
    let serverName = test.server?.name ?? null;
    let serverHost = test.server?.host ?? null;
    // Where the server is, as opposed to who runs it. The CLI keeps the two
    // apart - {"name":"Salt Mobile SA","location":"Glattbrugg"} - and writes
    // them as a pair in its own CSV. Only the sponsor was kept, so a history
    // could say which company answered but not from where, and two tests could
    // not be compared for whether the traffic had moved city.
    let serverLocation = text(test.server?.location);

    return {ping, jitter, download, upload, time, resultId: test.result?.id, serverName, serverHost,
        serverLocation,
        provider: OOKLA,
        packetLoss: round(test.packetLoss),
        downloadLatency: loadedLatency(test.download),
        uploadLatency: loadedLatency(test.upload),
        // Who the connection was, as the provider saw it: a changed address or
        // provider explains a step in the numbers that otherwise reads as the
        // line itself degrading.
        isp: test.isp ?? null,
        externalIp: test.interface?.externalIp ?? null,
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

export const parseLibre = (test) => ({...test, ...NO_QUALITY_FIGURES, provider: LIBRE,
    ping: round(test.ping),
    // round() also normalises the string jitter this CLI reports, and keeps a
    // measured zero rather than nulling it as falsy.
    jitter: round(test.jitter),
    time: Math.round(test.elapsed / 1000), resultId: null,
    serverName: test.server?.name ?? null, serverHost: test.server?.url ?? null,
    // Its result names the backend and its URL, and nothing about where it is.
    serverLocation: null,
    // Reported only as far as the selected backend reports it: the client block
    // is filled from that server's getIP endpoint, and one without a GeoIP
    // database answers with empty strings throughout.
    isp: ispName(test.client?.org),
    externalIp: text(test.client?.ip),
    bytesDownloaded: byteCount(test.bytes_received),
    bytesUploaded: byteCount(test.bytes_sent)});

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

    return best === null ? 0 : parseFloat(best.figure.toFixed(2));
};

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

    if (test && test.latency_measurement && test.speed_measurements) {
        const downloadTests = test.speed_measurements.filter(t => t.test_type === "Download");
        const uploadTests = test.speed_measurements.filter(t => t.test_type === "Upload");

        const download = directionSpeed(downloadTests);
        const upload = directionSpeed(uploadTests);

        const ping = round(test.latency_measurement.avg_latency_ms) ?? 0;
        const jitter = calculateJitter(test.latency_measurement.latency_measurements);

        const time = Math.round((test.elapsed || 30000) / 1000);
        
        return {ping, jitter, download, upload, time, resultId: null, ...identity,
            bytesDownloaded: transferred(downloadTests),
            bytesUploaded: transferred(uploadTests)};
    }

    return {ping: 0, jitter: null, download: 0, upload: 0, time: 0, resultId: null, ...identity,
        bytesDownloaded: null, bytesUploaded: null};
};

export const parseData = (provider, data) => {
    switch (provider) {
        case OOKLA:
            return parseOokla(data);
        case LIBRE:
            return parseLibre(data);
        case CLOUDFLARE:
            return parseCloudflare(data);
        default:
            throw {message: "Invalid provider"};
    }
};