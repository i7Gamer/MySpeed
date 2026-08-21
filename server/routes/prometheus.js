import express from 'express';
import * as testController from '../controller/speedtests.js';
import promClient from 'prom-client';
import * as config from '../controller/config.js';
import * as serverController from '../controller/servers.js';
import bcrypt from 'bcryptjs';
import {
    ATTEMPT_BUSY, ATTEMPT_LOCKED_OUT, allowsPasswordlessAccess, clearFailedAttempts, reserveAttempt
} from '../middlewares/password.js';
import { matchesSetupToken } from '../util/setupToken.js';
import { isFailedTest } from '../util/testOutcome.js';
import { metricValue } from '../util/metricValue.js';
import { createQueue } from '../util/serialiseQueue.js';
import { clientGone } from '../util/clientGone.js';

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

    const credentials = readBasicAuth(req);
    if (credentials === null || credentials.username !== METRICS_USERNAME) {
        unauthorized(res);
        return false;
    }

    // Refused or reserved in one atomic call - see reserveAttempt for why the
    // check and the write must not be separable. After the credentials parse,
    // not before it: only a request carrying a guess costs bcrypt work, so only
    // one spends the budget, and a locked-out scraper that sent no credentials
    // still gets the WWW-Authenticate challenge that says what is missing.
    const admission = reserveAttempt(req);

    if (admission.outcome === ATTEMPT_LOCKED_OUT) {
        res.status(429).end('Too many failed attempts');
        return false;
    }

    // Busy is transient and not about the credentials, so a scraper that
    // briefly overlapped its own correct polls is told to retry rather than
    // that its password was refused.
    if (admission.outcome === ATTEMPT_BUSY) {
        res.status(503).set('Retry-After', '1').end('Busy checking passwords');
        return false;
    }

    let valid = false;
    let compared = false;

    try {
        valid = unconfigured
            ? matchesSetupToken(credentials.password)
            : await bcrypt.compare(credentials.password, passwordHash);
        compared = true;
    } finally {
        // Released whatever happened, and counted as a failure only if a
        // comparison actually ran and the guess was wrong - a scraper polling
        // with the right password never spends the failure budget, and neither
        // does an error on the way to checking one.
        admission.settle({failed: compared && !valid ? 1 : 0});
    }

    if (!valid) {
        unauthorized(res);
        return false;
    }

    clearFailedAttempts(req);
    return true;
};

const speedLabels = ['server_id', 'server_name', 'server_host'];

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
/**
 * Whether the newest test failed, as a figure rather than as a broken scrape.
 *
 * This route used to answer 500 for a failed test. Prometheus reads that as the
 * target being down - no sample is recorded, every myspeed_* series goes stale,
 * and the alert it raises says the exporter is unreachable. So the monitoring
 * went blind at the moment the connection had a problem worth seeing, and
 * blamed the wrong thing for it.
 */
const testFailedGauge = new promClient.Gauge({
    name: 'myspeed_test_failed',
    help: 'Whether the most recent speedtest failed (1) or succeeded (0)',
    labelNames: speedLabels
});
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


const ALL_GAUGES = [pingGauge, jitterGauge, downloadGauge, uploadGauge, timeGauge, serverInfoGauge,
    packetLossGauge, downloadLatencyGauge, uploadLatencyGauge, testFailedGauge];

// Removed rather than reset, because this one carries no labels: reset() gives
// an unlabelled gauge the value 0 and exports it, and 0 is a server id a real
// instance can be pinned to - so an instance that has never tested would be
// indistinguishable from one testing against server 0. set() brings it back.
const clearGauges = () => {
    ALL_GAUGES.forEach(gauge => gauge.reset());
    currentServerGauge.remove();
};

/**
 * One scrape at a time.
 *
 * Every gauge above is module-level and shared by every request, and a scrape
 * clears them, reads the latest test, sets them and renders - all but the clear
 * asynchronous. Two scrapes overlapping across those awaits can leave one of
 * them rendering gauges the other has just cleared, and an empty exporter reads
 * as an instance that has never tested rather than as a concurrent scrape. A
 * Prometheus HA pair scrapes the same target by design.
 *
 * The registry is what render reads from, so the values must be in it while it
 * renders and building them in locals first would not help. Queueing is the
 * whole of the fix, and the rate limit already in front of this route in
 * app.js bounds how long the queue can get.
 */
const scrapes = createQueue();

const collect = async (res) => {
    const serve = async () => {
        res.set('Content-Type', promClient.register.contentType);
        res.end(await promClient.register.metrics());
    };

    // Cleared before anything is decided, so a branch that sets fewer series
    // than the last scrape cannot leave the previous values standing as though
    // they were current.
    clearGauges();

    const latest = await testController.getLatest();

    // Nothing measured yet is not a broken exporter - it is an instance that
    // was installed five minutes ago. The families are simply empty, which is
    // what an absent series already means everywhere else here.
    if (!latest) return serve();

    const labels = resolveServerLabels(latest);

    // The attempt happened, against a server, whether or not it succeeded -
    // and which server it was is most of the diagnosis when one server is what
    // keeps failing.
    serverInfoGauge.set(labels, 1);
    /*
     * Every value below goes through metricValue, and none of them used to.
     *
     * prom-client throws for anything that is not a number, and the throw is
     * ahead of the response - so one unreadable column in the newest test
     * answered 500 for every scrape until a newer test landed, which Prometheus
     * reads as the exporter being down. `?? 0` covered the null this route was
     * first bitten by and nothing else: serverId was the one numeric column the
     * history import never validated, so "auto" could be written into it
     * through the API, and any measurement column can hold a string on a
     * history imported before that validation existed - the case
     * createRecommendations guards against by name.
     */
    currentServerGauge.set(metricValue(latest.serverId) ?? 0);

    // Positive, not merely truthy: a failed test's duration is -1 like the rest
    // of its row, and exporting that would be the placeholder this branch
    // exists to keep out.
    const time = metricValue(latest.time);
    if (time !== null && time > 0) timeGauge.set(labels, time);

    if (isFailedTest(latest)) {
        testFailedGauge.set(labels, 1);
        return serve();
    }

    testFailedGauge.set(labels, 0);

    // An unreadable measurement leaves its series absent, which is what an
    // absent series already means here - the provider did not report it. That
    // is the honest answer, and it keeps the rest of the scrape standing.
    const measured = (gauge, value) => {
        const reading = metricValue(value);
        if (reading !== null) gauge.set(labels, reading);
    };

    measured(pingGauge, latest.ping);
    measured(jitterGauge, latest.jitter);
    measured(downloadGauge, latest.download);
    measured(uploadGauge, latest.upload);

    // Left unset rather than zeroed when the provider did not measure them: an
    // absent series is a gap in a graph, while a zero is a claim that the line
    // was flawless. Only Ookla reports any of these.
    measured(packetLossGauge, latest.packetLoss);
    measured(downloadLatencyGauge, latest.downloadLatency);
    measured(uploadLatencyGauge, latest.uploadLatency);

    return serve();
};

// Authorised outside the queue: a caller who may not scrape at all has no
// business waiting behind the ones who may.
app.get('/metrics', async (req, res) => {
    if (!await authorizeMetrics(req, res)) return;

    // Checked at the front of the queue rather than on arrival: the wait is
    // what outlasts the caller. Prometheus drops a scrape at its scrape_timeout
    // - ten seconds by default - and a queued entry that reaches the front
    // after that would read the database and render the whole registry into a
    // socket nobody is listening to.
    await scrapes(() => clientGone(req, res) ? undefined : collect(res));
});

export default app;