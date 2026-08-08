const roundSpeed = (bandwidth) => {
    return Math.round(bandwidth / 1250) / 100;
};

// Neither librespeed nor cloudflare reports these, and a provider that did not
// measure something must say so: left undefined they would store as NULL and
// read as a flawless line rather than as an unmeasured one.
const NO_QUALITY_FIGURES = {packetLoss: null, downloadLatency: null, uploadLatency: null};

const round = (value) => value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : parseFloat(Number(value).toFixed(2));

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
    let jitter = test.ping.jitter ? parseFloat(test.ping.jitter.toFixed(2)) : null;
    let download = roundSpeed(test.download.bandwidth);
    let upload = roundSpeed(test.upload.bandwidth);
    let time = Math.round((test.download.elapsed + test.upload.elapsed) / 1000);
    let serverName = test.server?.name ?? null;
    let serverHost = test.server?.host ?? null;

    return {ping, jitter, download, upload, time, resultId: test.result?.id, serverName, serverHost,
        packetLoss: round(test.packetLoss),
        downloadLatency: loadedLatency(test.download),
        uploadLatency: loadedLatency(test.upload)};
};

export const parseLibre = (test) => ({...test, ...NO_QUALITY_FIGURES, ping: Math.round(test.ping),
    jitter: test.jitter ? parseFloat(parseFloat(test.jitter).toFixed(2)) : null,
    time: Math.round(test.elapsed / 1000), resultId: null,
    serverName: test.server?.name ?? null, serverHost: test.server?.url ?? null});

export const parseCloudflare = (test) => {
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
            upload: parseFloat(upload.toFixed(2)), time, resultId: null,
            serverName: null, serverHost: null, ...NO_QUALITY_FIGURES};
    }

    return {ping: 0, jitter: null, download: 0, upload: 0, time: 0, resultId: null,
        serverName: null, serverHost: null, ...NO_QUALITY_FIGURES};
};

export const parseData = (provider, data) => {
    switch (provider) {
        case "ookla":
            return parseOokla(data);
        case "libre":
            return parseLibre(data);
        case "cloudflare":
            return parseCloudflare(data);
        default:
            throw {message: "Invalid provider"};
    }
};