import https from 'node:https';
import fs from 'node:fs';
import app from './app.js';
import { certPath, keyPath, httpsPort, hasSSLCerts, setHttpsListening } from './config/tls.js';
import { announceSetupToken } from './util/setupToken.js';
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
import { createShutdown } from './util/shutdown.js';
import {
    RESET_ALREADY_CLEAR, RESET_NO_CONFIG, resetPassword, wantsPasswordReset
} from './util/resetPassword.js';

const INTERFACE_REFRESH_INTERVAL = 3600000;
const RETENTION_SWEEP_INTERVAL = 60000;

// Nothing was wrong and nothing was done - the database opened, it simply held
// no configuration to reset. Distinct from the failures below so a script can
// tell "recovered" from "you pointed me at the wrong file".
const RESET_NOTHING_TO_DO_EXIT = 113;

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

    announceSetupToken();
};

/**
 * Clears the password and stops, instead of starting the server.
 *
 * Deliberately does *not* print a setup token: this process would mint one of
 * its own, and an instance already running holds a different one - the operator
 * would be handed a credential that the server refusing them has never heard
 * of. The running server prints its own the moment it next turns someone away,
 * which is what loading the page does, so pointing at the log is both correct
 * and enough. Nothing needs restarting either: the stored password is read from
 * the database on every request.
 */
const runPasswordReset = async () => {
    const outcome = await resetPassword();

    if (outcome === RESET_NO_CONFIG) {
        console.error("This database holds no MySpeed configuration, so there is no password to reset.");
        console.error("Check that the data directory is the one the server actually runs against.");
        return process.exit(RESET_NOTHING_TO_DO_EXIT);
    }

    console.log("");
    console.log(outcome === RESET_ALREADY_CLEAR
        ? "  This instance already had no password set."
        : "  The password has been removed.");
    console.log("");
    console.log("  The instance is now open to the machine it runs on, and asks every other");
    console.log("  machine for a setup token. Open the interface: the server prints that token");
    console.log("  to its log as it turns the request away. Then set a new password from the");
    console.log("  settings menu - no restart is needed.");
    console.log("");

    // Explicit: the database handle and whatever the top-level imports left open
    // would otherwise hold a command that has finished its work.
    return process.exit(0);
};

process.on('uncaughtException', err => errorHandler(err));

// Node terminates the process on an unhandled rejection. Several background
// tasks deliberately do not await their promise, so without this a single
// failing integration or scheduled test takes the whole server down. Logging it
// and carrying on is the entire point - handling it and then exiting anyway,
// which is what this did, left the server crash-looping on any such throw.
process.on('unhandledRejection', reason =>
    errorHandler(reason instanceof Error ? reason : new Error(String(reason)), {fatal: false}));

// Filled in as they start, so a signal arriving mid-start-up still closes
// whatever is already listening.
const listeners = [];
const intervals = [];

const shutdown = createShutdown({
    listeners,
    onStop: () => {
        for (const interval of intervals) clearInterval(interval);
        timerTask.stopTimer();
        integrationTask.stopTimer();
    }
});

// Registering these is also what makes the signals deliverable: the runtime
// only installs a watcher once JS asks for one, and the kernel discards a
// signal still at its default disposition - which it is for PID 1, as bun is
// under docker-entrypoint.sh's exec with no init process in front of it.
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const run = async () => {
    await runMigrations();

    await initializeIntegrations();

    await requestInterfaces();
    intervals.push(setInterval(() => requestInterfaces(), INTERFACE_REFRESH_INTERVAL));

    if (process.env.PREVIEW_MODE !== "true") await loadCli();

    await config.insertDefaults();

    timerTask.startTimer(await config.getValue("cron"));
    intervals.push(setInterval(() => removeOld().catch(err =>
        console.error(`Could not apply the retention policy: ${err?.message ?? err}`)), RETENTION_SWEEP_INTERVAL));

    integrationTask.startTimer();
    if (process.env.RUN_TEST_ON_STARTUP === "true") {
        timerTask.runTask().catch(err =>
            console.error(`The startup speedtest failed: ${err?.message ?? err}`));
    }

    await announceAccess();

    listeners.push(app.listen(port, () => console.log(`Server listening on port ${port}`)));

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

            listeners.push(httpsServer);

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

    // Ahead of run(), and it never returns: the recovery command must not
    // migrate, download a CLI, start the scheduler or take the port - an
    // instance is usually still running on it while this is being used.
    if (wantsPasswordReset()) {
        return runPasswordReset().catch(err => {
            console.error("The password could not be reset: " + (err?.message ?? err));
            process.exit(RESET_NOTHING_TO_DO_EXIT);
        });
    }

    // Startup is not optional: a failure here leaves a listening server with no
    // migrations, no defaults and no scheduler, which is worse than not
    // starting at all.
    run().catch(err => {
        console.error("The server could not finish starting up: " + (err?.message ?? err));
        process.exit(112);
    });
}).catch(err => {
    console.error("Could not open the database: " + err.message);

    // "Maybe it is damaged" was the only hint this used to give, and it points
    // at the wrong thing far more often than the right one: the usual cause is
    // a data directory the server cannot write to.
    if (process.env.DB_TYPE !== "mysql")
        console.error("Check that the data directory is writable by the user the server runs as.");

    process.exit(111);
});
