import express from 'express';
import * as testController from '../controller/speedtests.js';
import promClient from 'prom-client';
import * as config from '../controller/config.js';
import * as serverController from '../controller/servers.js';
import bcrypt from 'bcryptjs';
import { allowsPasswordlessAccess, clearFailedAttempts, isThrottled, recordFailedAttempt } from '../middlewares/password.js';
import { matchesSetupToken } from '../util/setupToken.js';

const app = express.Router();

const METRICS_USERNAME = "prometheus";

const unauthorized = (res) => {
    res.setHeader('WWW-Authenticate', 'Basic realm="MySpeed metrics"');
    return res.status(401).end('Unauthorized');
};

/**
 * Splits a Basic credential into its two halves.
 *
 * A value with no colon yields an undefined password, which bcrypt throws on -
 * answering a malformed header with a 500 and a stack trace instead of the 401
 * it deserves.
 */
const readBasicAuth = (req) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Basic ')) return null;

    const credentials = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const separator = credentials.indexOf(':');
    if (separator === -1) return null;

    return {username: credentials.slice(0, separator), password: credentials.slice(separator + 1)};
};

/**
 * Authenticates a scrape.
 *
 * This route deliberately does not use the shared password middleware - it
 * speaks Basic auth rather than the x-password header - but it must not skip
 * the middleware's throttle. Without it this was an unmetered online password
 * oracle, and at one bcrypt comparison per request a way to saturate the event
 * loop from outside. It also used to serve metrics to anyone at all whenever no
 * password was configured.
 */
const authorizeMetrics = async (req, res) => {
    const passwordHash = await config.getValue("password");
    const unconfigured = passwordHash === config.NO_PASSWORD;

    if (unconfigured && allowsPasswordlessAccess(req)) return true;

    if (isThrottled(req)) {
        res.status(429).end('Too many failed attempts');
        return false;
    }

    const credentials = readBasicAuth(req);
    if (credentials === null || credentials.username !== METRICS_USERNAME) {
        unauthorized(res);
        return false;
    }

    const valid = unconfigured
        ? matchesSetupToken(credentials.password)
        : await bcrypt.compare(credentials.password, passwordHash);

    if (!valid) {
        recordFailedAttempt(req);
        unauthorized(res);
        return false;
    }

    clearFailedAttempts(req);
    return true;
};

const speedLabels = ['server_id', 'server_name', 'server_host'];

// A packet loss of zero is a measurement; only null and undefined mean the
// provider never reported one.
const isMeasured = (value) => value !== null && value !== undefined;

const pingGauge = new promClient.Gauge({name: 'myspeed_ping', help: 'Current ping in ms', labelNames: speedLabels});
const jitterGauge = new promClient.Gauge({name: 'myspeed_jitter', help: 'Current jitter in ms', labelNames: speedLabels});
const downloadGauge = new promClient.Gauge({name: 'myspeed_download', help: 'Current download speed in Mbps', labelNames: speedLabels});
const uploadGauge = new promClient.Gauge({name: 'myspeed_upload', help: 'Current upload speed in Mbps', labelNames: speedLabels});
const packetLossGauge = new promClient.Gauge({
    name: 'myspeed_packet_loss',
    help: 'Packet loss of the latest test in percent',
    labelNames: speedLabels
});
// Exported separately per direction because they differ: a line can be clean
// downstream and badly buffered upstream, which is the usual asymmetry.
const downloadLatencyGauge = new promClient.Gauge({
    name: 'myspeed_download_latency',
    help: 'Latency measured while the download was saturated, in ms',
    labelNames: speedLabels
});
const uploadLatencyGauge = new promClient.Gauge({
    name: 'myspeed_upload_latency',
    help: 'Latency measured while the upload was saturated, in ms',
    labelNames: speedLabels
});
const currentServerGauge = new promClient.Gauge({name: 'myspeed_server', help: 'Current server ID'});
const timeGauge = new promClient.Gauge({name: 'myspeed_time', help: 'Time of the test', labelNames: speedLabels});
const serverInfoGauge = new promClient.Gauge({
    name: 'myspeed_server_info',
    help: 'Static info about the speedtest server (always 1). Join via group_left to add server metadata to other metrics.',
    labelNames: speedLabels
});

const resolveServerLabels = (latest) => {
    const serverId = latest.serverId ?? 0;
    let serverName = latest.serverName ?? null;
    let serverHost = latest.serverHost ?? null;

    if (!serverName || !serverHost) {
        const ooklaServers = serverController.getOoklaServers();
        const entry = ooklaServers && ooklaServers[serverId];
        if (entry) {
            if (typeof entry === "string") {
                if (!serverName) serverName = entry;
            } else if (typeof entry === "object") {
                if (!serverName) serverName = entry.sponsor || entry.name || null;
                if (!serverHost) serverHost = entry.host || null;
            }
        }
    }

    return {
        server_id: String(serverId),
        server_name: serverName ?? '',
        server_host: serverHost ?? ''
    };
};

app.get('/metrics', async (req, res) => {
    if (!await authorizeMetrics(req, res)) return;

    const latest = await testController.getLatest();
    if (!latest) return res.status(500).end('No test found');

    if (latest.error || latest.ping === -1)
        return res.status(500).end('Error in the latest test');

    const labels = resolveServerLabels(latest);

    pingGauge.reset();
    jitterGauge.reset();
    downloadGauge.reset();
    uploadGauge.reset();
    timeGauge.reset();
    serverInfoGauge.reset();
    packetLossGauge.reset();
    downloadLatencyGauge.reset();
    uploadLatencyGauge.reset();

    pingGauge.set(labels, latest.ping);
    if (latest.jitter !== null && latest.jitter !== undefined)
        jitterGauge.set(labels, latest.jitter);
    downloadGauge.set(labels, latest.download);
    uploadGauge.set(labels, latest.upload);
    currentServerGauge.set(latest.serverId);
    serverInfoGauge.set(labels, 1);

    // Left unset rather than zeroed when the provider did not measure them: an
    // absent series is a gap in a graph, while a zero is a claim that the line
    // was flawless. Only Ookla reports any of these.
    if (isMeasured(latest.packetLoss)) packetLossGauge.set(labels, latest.packetLoss);
    if (isMeasured(latest.downloadLatency)) downloadLatencyGauge.set(labels, latest.downloadLatency);
    if (isMeasured(latest.uploadLatency)) uploadLatencyGauge.set(labels, latest.uploadLatency);

    if (latest.time)
        timeGauge.set(labels, latest.time);

    res.set('Content-Type', promClient.register.contentType);
    res.end(await promClient.register.metrics());
});

export default app;