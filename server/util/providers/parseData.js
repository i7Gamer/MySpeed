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
    let ping = Math.round(test.ping.latency);
    // round(), not a truthiness check: a jitter of exactly zero is a
    // measurement - a perfectly steady line - and must not store as null.
    let jitter = round(test.ping.jitter);
    let download = roundSpeed(test.download.bandwidth);
    let upload = roundSpeed(test.upload.bandwidth);
    let time = Math.round((test.download.elapsed + test.upload.elapsed) / 1000);
    let serverName = test.server?.name ?? null;
    let serverHost = test.server?.host ?? null;

    return {ping, jitter, download, upload, time, resultId: test.result?.id, serverName, serverHost,
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
    ping: Math.round(test.ping),
    // round() also normalises the string jitter this CLI reports, and keeps a
    // measured zero rather than nulling it as falsy.
    jitter: round(test.jitter),
    time: Math.round(test.elapsed / 1000), resultId: null,
    serverName: test.server?.name ?? null, serverHost: test.server?.url ?? null,
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
        externalIp: text(metadata.ip),
        ...NO_QUALITY_FIGURES,
        // Nothing the CLI prints names the network the client is on.
        isp: null
    };

    if (test && test.latency_measurement && test.speed_measurements) {
        const downloadTests = test.speed_measurements.filter(t => t.test_type === "Download");
        const uploadTests = test.speed_measurements.filter(t => t.test_type === "Upload");

        const downloadSpeeds = downloadTests.map(t => t.max || t.median || 0);
        const download = downloadSpeeds.length > 0 ? Math.max(...downloadSpeeds) : 0;

        const uploadSpeeds = uploadTests.map(t => t.max || t.median || 0);
        const upload = uploadSpeeds.length > 0 ? Math.max(...uploadSpeeds) : 0;

        const ping = Math.round(test.latency_measurement.avg_latency_ms || 0);
        const jitter = calculateJitter(test.latency_measurement.latency_measurements);

        const time = Math.round((test.elapsed || 30000) / 1000);
        
        return {ping, jitter, download: parseFloat(download.toFixed(2)),
            upload: parseFloat(upload.toFixed(2)), time, resultId: null, ...identity,
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