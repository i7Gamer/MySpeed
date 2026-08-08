import https from 'node:https';
import fs from 'node:fs';
import app from './app.js';
import { certPath, keyPath, httpsPort, hasSSLCerts, setHttpsListening } from './config/tls.js';
import { getSetupToken } from './util/setupToken.js';
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

/**
 * Tells the operator how to reach an instance that has no password yet.
 *
 * Requests from the network are refused until either a password is set or the
 * token below is presented, so this banner is the only way in on a fresh
 * install that is not being driven from the console.
 */
const announceAccess = async () => {
    if (process.env.PREVIEW_MODE === "true") return;
    if (await config.getValue("password") !== config.NO_PASSWORD) return;

    if (process.env.ALLOW_NO_PASSWORD === "true") {
        console.warn("WARNING: no password is set and ALLOW_NO_PASSWORD is enabled. " +
            "Anyone who can reach this instance has full control of it.");
        return;
    }

    console.log("");
    console.log("  No password is configured yet. Requests from other machines need this");
    console.log("  one-time setup token - enter it when the interface asks for a password,");
    console.log("  then set a real password from the settings menu.");
    console.log("");
    console.log(`      Setup token: ${getSetupToken()}`);
    console.log("");
    console.log("  A new token is issued every restart. Set ALLOW_NO_PASSWORD=true to run");
    console.log("  without one, only on a network you trust.");
    console.log("");
};

process.on('uncaughtException', err => errorHandler(err));

// Node terminates the process on an unhandled rejection. Several background
// tasks deliberately do not await their promise, so without this a single
// failing integration or scheduled test takes the whole server down. Logging it
// and carrying on is the entire point - handling it and then exiting anyway,
// which is what this did, left the server crash-looping on any such throw.
process.on('unhandledRejection', reason =>
    errorHandler(reason instanceof Error ? reason : new Error(String(reason)), {fatal: false}));

const run = async () => {
    await runMigrations();

    await initializeIntegrations();

    await requestInterfaces();
    setInterval(() => requestInterfaces(), INTERFACE_REFRESH_INTERVAL);

    if (process.env.PREVIEW_MODE !== "true") await loadCli();

    await config.insertDefaults();

    timerTask.startTimer(await config.getValue("cron"));
    setInterval(() => removeOld().catch(err =>
        console.error(`Could not apply the retention policy: ${err?.message ?? err}`)), RETENTION_SWEEP_INTERVAL);

    integrationTask.startTimer();
    if (process.env.RUN_TEST_ON_STARTUP === "true") {
        timerTask.runTask().catch(err =>
            console.error(`The startup speedtest failed: ${err?.message ?? err}`));
    }

    await announceAccess();

    app.listen(port, () => console.log(`Server listening on port ${port}`));

    if (hasSSLCerts()) {
        try {
            const sslOptions = {
                cert: fs.readFileSync(certPath),
                key: fs.readFileSync(keyPath)
            };

            const httpsServer = https.createServer(sslOptions, app);

            // The redirect follows the listener, not the certificate files: a
            // port clash or an unreadable key would otherwise send every caller
            // to a port with nothing behind it.
            httpsServer.on("error", (err) => {
                setHttpsListening(false);
                console.error(`HTTPS server error: ${err.message}`);
            });

            httpsServer.listen(httpsPort, () => {
                setHttpsListening(true);
                console.log(`HTTPS server listening on port ${httpsPort}`);
            });
        } catch (err) {
            console.error(`Failed to start HTTPS server: ${err.message}`);
        }
    }
}

db.authenticate().then(() => {
    console.log("Successfully connected to the database " + (process.env.DB_TYPE === "mysql" ? "server" : "file"));
    // Startup is not optional: a failure here leaves a listening server with no
    // migrations, no defaults and no scheduler, which is worse than not
    // starting at all.
    run().catch(err => {
        console.error("The server could not finish starting up: " + (err?.message ?? err));
        process.exit(112);
    });
}).catch(err => {
    console.error("Could not open the database file. Maybe it is damaged?: " + err.message);
    process.exit(111);
});
