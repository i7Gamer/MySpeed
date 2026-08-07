import express from 'express';
import * as testController from '../controller/speedtests.js';
import promClient from 'prom-client';
import * as config from '../controller/config.js';
import * as serverController from '../controller/servers.js';
import bcrypt from 'bcryptjs';

const app = express.Router();

const speedLabels = ['server_id', 'server_name', 'server_host'];

const pingGauge = new promClient.Gauge({name: 'myspeed_ping', help: 'Current ping in ms', labelNames: speedLabels});
const jitterGauge = new promClient.Gauge({name: 'myspeed_jitter', help: 'Current jitter in ms', labelNames: speedLabels});
const downloadGauge = new promClient.Gauge({name: 'myspeed_download', help: 'Current download speed in Mbps', labelNames: speedLabels});
const uploadGauge = new promClient.Gauge({name: 'myspeed_upload', help: 'Current upload speed in Mbps', labelNames: speedLabels});
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
    let passwordHash = await config.getValue("password");

    if (passwordHash !== "none") {
        if (!req.headers.authorization || req.headers.authorization.indexOf('Basic ') === -1) {
            res.setHeader('WWW-Authenticate', 'Basic realm="User Visible Realm"');
            return res.status(401).end('Unauthorized');
        }

        const base64Credentials =  req.headers.authorization.split(' ')[1];
        const credentials = Buffer.from(base64Credentials ?? "", 'base64').toString('utf8');

        // A value with no colon yields an undefined password, which bcrypt
        // throws on - answering a malformed header with a 500 and a stack
        // trace instead of the 401 it deserves.
        const separator = credentials.indexOf(':');
        const username = separator === -1 ? null : credentials.slice(0, separator);
        const password = separator === -1 ? null : credentials.slice(separator + 1);

        if (username !== "prometheus" || password === null || !await bcrypt.compare(password, passwordHash)) {
            res.setHeader('WWW-Authenticate', 'Basic realm="User Visible Realm"');
            return res.status(401).end('Unauthorized');
        }
    }

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

    pingGauge.set(labels, latest.ping);
    if (latest.jitter !== null && latest.jitter !== undefined)
        jitterGauge.set(labels, latest.jitter);
    downloadGauge.set(labels, latest.download);
    uploadGauge.set(labels, latest.upload);
    currentServerGauge.set(latest.serverId);
    serverInfoGauge.set(labels, 1);

    if (latest.time)
        timeGauge.set(labels, latest.time);

    res.set('Content-Type', promClient.register.contentType);
    res.end(await promClient.register.metrics());
});

export default app;