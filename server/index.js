import https from 'node:https';
import path from 'node:path';
import fs from 'node:fs';
import app from './app.js';
import * as timerTask from './tasks/timer.js';
import * as integrationTask from './tasks/integrations.js';
import './util/loadServers.js';
import errorHandler from './util/errorHandler.js';
import db from './config/database.js';
import { runMigrations } from './util/migrationRunner.js';
import * as config from './controller/config.js';
import { initialize as initializeIntegrations } from './controller/integrations.js';
import { requestInterfaces } from './util/loadInterfaces.js';
import { load as loadCli } from './util/loadCli.js';
import { removeOld } from './tasks/speedtest.js';

const INTERFACE_REFRESH_INTERVAL = 3600000;
const RETENTION_SWEEP_INTERVAL = 60000;

const port = process.env.SERVER_PORT || 5216;
const httpsPort = process.env.HTTPS_PORT || 5217;

const certsDir = path.join(process.cwd(), 'data', 'certs');
const certPath = path.join(certsDir, 'cert.pem');
const keyPath = path.join(certsDir, 'key.pem');

const hasSSLCerts = () => fs.existsSync(certPath) && fs.existsSync(keyPath);

process.on('uncaughtException', err => errorHandler(err));

const run = async () => {
    await runMigrations();

    await initializeIntegrations();

    await requestInterfaces();
    setInterval(() => requestInterfaces(), INTERFACE_REFRESH_INTERVAL);

    if (process.env.PREVIEW_MODE !== "true") await loadCli();

    await config.insertDefaults();

    timerTask.startTimer(await config.getValue("cron"));
    setInterval(async () => removeOld(), RETENTION_SWEEP_INTERVAL);

    integrationTask.startTimer();
    if (process.env.RUN_TEST_ON_STARTUP === "true") {
        timerTask.runTask().then(undefined);
    }

    app.listen(port, () => console.log(`Server listening on port ${port}`));

    if (hasSSLCerts()) {
        try {
            const sslOptions = {
                cert: fs.readFileSync(certPath),
                key: fs.readFileSync(keyPath)
            };

            https.createServer(sslOptions, app).listen(httpsPort, () =>
                console.log(`HTTPS server listening on port ${httpsPort}`)
            );
        } catch (err) {
            console.error(`Failed to start HTTPS server: ${err.message}`);
        }
    }
}

db.authenticate().then(() => {
    console.log("Successfully connected to the database " + (process.env.DB_TYPE === "mysql" ? "server" : "file"));
    run().then(undefined);
}).catch(err => {
    console.error("Could not open the database file. Maybe it is damaged?: " + err.message);
    process.exit(111);
});
