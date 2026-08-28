import https from 'node:https';
import fs from 'node:fs';
import app from './app.js';
import { certPath, keyPath, httpsPort, hasSSLCerts, setHttpsListening } from './config/tls.js';
import { announceSetupToken } from './util/setupToken.js';
import * as timerTask from './tasks/timer.js';
import * as integrationTask from './tasks/integrations.js';
import './util/loadServers.js';
import errorHandler from './util/errorHandler.js';
import { describeError } from './util/errorDetail.js';
import { QueryTypes } from 'sequelize';
import db, { SQLITE_STORAGE_PATH } from './config/database.js';
import { checkIntegrity, recoveryAdvice } from './util/databaseIntegrity.js';
import { runMigrations } from './util/migrationRunner.js';
import * as config from './controller/config.js';
import { initialize as initializeIntegrations } from './controller/integrations.js';
import { requestInterfaces } from './util/loadInterfaces.js';
import { load as loadCli } from './util/loadCli.js';
import { removeOld } from './tasks/speedtest.js';
import { markShutdown, terminateActiveProcess, waitForActiveProcessExit } from './util/speedtest.js';
import { createShutdown } from './util/shutdown.js';
import {
    clearedReport, noConfigReport, RESET_NO_CONFIG, resetPassword, wantsPasswordReset
} from './util/resetPassword.js';

const INTERFACE_REFRESH_INTERVAL = 3600000;
const RETENTION_SWEEP_INTERVAL = 60000;

// How the reset command stops when it has not cleared a password. Two codes
// rather than one, because they ask the operator for opposite things:
//
//   113  The database opened and held no MySpeed configuration. Nothing was
//        wrong and nothing was done - the data is somewhere else, and the
//        working directory is what to change.
//   114  The configuration is there and the write did not go through: a locked
//        database, a read-only data directory, a connection lost mid-command.
//        The path is right and the database is what needs attention.
//
// Under one number the second reading disappears into the first, and an
// operator whose database is in trouble is sent off to check a path that was
// never wrong. isMissingConfigTable is written narrow for exactly that reason -
// it lets an unwell database keep travelling rather than answering it with
// "there is no configuration here" - and these are where it travels to.
//
// Distinct from the start-up codes further down as well: 111 is a database that
// would not open and 112 a start-up that did not finish, and either can happen
// on the way to a reset.
const RESET_NOTHING_TO_DO_EXIT = 113;
const RESET_FAILED_EXIT = 114;

// The two start-up codes the comment above names: a database that would not open
// and a start-up that did not finish. A failed HTTP bind is the second of these.
const DATABASE_OPEN_FAILED_EXIT = 111;
const STARTUP_FAILED_EXIT = 112;

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
/**
 * The one way this command stops, whatever it found.
 *
 * The exit is explicit because the database handle and whatever the top-level
 * imports left open would otherwise hold a command that has finished its work.
 * The close before it is what makes that exit safe: sqlite runs in WAL mode, so
 * a live connection has a -wal and a -shm beside the database file, and leaving
 * them uncheckpointed is not merely untidy under Docker. `docker exec` skips the
 * entrypoint and with it the privilege drop, so this runs as root and creates
 * those two files root-owned inside a volume the server reads as another user -
 * which then cannot write them, and stays broken until the container restarts
 * and the entrypoint chowns the directory again.
 */
const stopAfterReset = async (code) => {
    await db.close().catch(() => undefined);
    process.exit(code);
};

const runPasswordReset = async () => {
    const outcome = await resetPassword();

    if (outcome === RESET_NO_CONFIG) {
        noConfigReport().forEach(line => console.error(line));
        return await stopAfterReset(RESET_NOTHING_TO_DO_EXIT);
    }

    clearedReport(outcome).forEach(line => console.log(line));

    return await stopAfterReset(0);
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

        // A speedtest in flight is a child process, and nothing else here can
        // reach it. Left alone it outlives the server under the Windows
        // service - there is no namespace to tear it down as docker has - and
        // finishes by writing its result into a handle onCleanup has closed.
        //
        // Latched first, because the kill itself surfaces to the run as an
        // ordinary failure - and a failed first attempt answers those with a
        // retry, spawning a fresh child after the only moment this could
        // reach it.
        markShutdown();
        terminateActiveProcess();
    },
    /**
     * The same close stopAfterReset makes, for the same reason.
     *
     * sqlite runs in WAL mode, so a live connection has a -wal and a -shm
     * beside the database file, and this is the path every `docker stop`,
     * `docker restart` and image upgrade takes - it stopped the timers and left
     * the handle to the exit. The reset command has closed it deliberately for
     * a while now and this did not, which is the half of the shutdown nobody
     * had cause to look at.
     *
     * After the listeners, never before: a request still being served reads
     * through this handle. Swallowed, because a database that has already gone
     * away is exactly when this rejects, and there is nothing left to do about
     * it at this point.
     *
     * And after the child, which onStop only *signalled*: the SIGKILL
     * escalation is an unref'd one-second timer, and on a quiet shutdown the
     * exit used to land in milliseconds - before it fired - orphaning a CLI
     * that ignores SIGTERM on exactly the platforms with no namespace to tear
     * it down. The wait is capped well inside the shutdown deadline, and the
     * ordering is the same statement as the paragraph above: the child writes
     * its result through the handle this closes.
     */
    onCleanup: async () => {
        await waitForActiveProcessExit();
        await db.close().catch(() => undefined);
    }
});

// Registering these is also what makes the signals deliverable: the runtime
// only installs a watcher once JS asks for one, and the kernel discards a
// signal still at its default disposition - which it is for PID 1, as bun is
// under docker-entrypoint.sh's exec with no init process in front of it.
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/**
 * Asks sqlite whether the file can be read, and says what to do when it cannot.
 *
 * Ahead of the migrations, because a migration is the first thing that would
 * touch a damaged page - and it would do so halfway through applying itself,
 * reporting whatever sqlite threw as an unexplained startup failure. Upstream
 * #1549 is that failure repeated 138 times, ended by deleting the database.
 *
 * Reported rather than fatal, and that is the point: exiting is what produced
 * the restart loop. Coming up lets the operator reach the interface and export
 * whatever is still readable, with the ways out already on the console.
 *
 * sqlite only. MySQL has no such pragma and its own consistency machinery, and
 * the file this advice names does not exist there.
 */
const reportDatabaseDamage = async () => {
    if (process.env.DB_TYPE === "mysql") return;

    const outcome = await checkIntegrity((sql) => db.query(sql, {type: QueryTypes.SELECT}));

    if (outcome.ok) return;

    for (const line of recoveryAdvice(SQLITE_STORAGE_PATH, outcome.problems)) console.error(line);
};

const run = async () => {
    await reportDatabaseDamage();

    await runMigrations();

    await initializeIntegrations();

    await requestInterfaces();
    intervals.push(setInterval(() => requestInterfaces(), INTERFACE_REFRESH_INTERVAL));

    if (process.env.PREVIEW_MODE !== "true") await loadCli();

    await config.insertDefaults();

    timerTask.startTimer(await config.getValue("cron"), await config.getValue("timezone"));
    intervals.push(setInterval(() => removeOld().catch(err =>
        console.error(`Could not apply the retention policy: ${err?.message ?? err}`)), RETENTION_SWEEP_INTERVAL));

    integrationTask.startTimer();
    if (process.env.RUN_TEST_ON_STARTUP === "true") {
        timerTask.runTask().catch(err =>
            console.error(`The startup speedtest failed: ${err?.message ?? err}`));
    }

    await announceAccess();

    const httpServer = app.listen(port, () => console.log(`Server listening on port ${port}`));

    // The HTTP listener is the instance's only way in on a plain-HTTP install,
    // so a bind that fails - the port already held by another copy of the server
    // is the realistic cause - is a start-up failure, reported and exited the
    // way run()'s own catch does. Left to the uncaughtException handler instead,
    // which is for states that genuinely cannot be reasoned about, this benign
    // and expected clash was logged as a fatal fault under a generic exit 1. The
    // https listener below has carried the same handler all along.
    //
    // Which of the two it is depends on whether the listener ever bound. The
    // handler stays attached for the life of the server, so it also hears an
    // 'error' from a healthy instance hours later - an accept that runs out of
    // descriptors, say. Reported as a failure to listen and exited with the
    // start-up code, that would be a wrong diagnosis followed by a shutdown
    // nobody asked for; after the bind this logs and carries on, exactly as the
    // https handler below does, and the only reason the pre-bind case does not
    // is that there is no server there to carry on as.
    //
    // Both go through errorHandler, which is what the uncaughtException path
    // this replaced was quietly providing: it is the only thing that writes
    // data/logs/error.log, the file the log's own header points bug reports at.
    // The console line stays alongside it for the bind, because an operator
    // watching a start-up that will not finish should not have to go and find a
    // file to learn which port was taken.
    httpServer.on("error", (err) => {
        if (!httpServer.listening) {
            console.error(`The server could not listen on port ${port}: ${err.message}`);
            return errorHandler(err, {fatal: true, code: STARTUP_FAILED_EXIT,
                context: `The server could not listen on port ${port}`});
        }

        errorHandler(err, {fatal: false, context: `The server listening on port ${port} reported an error`});
    });

    listeners.push(httpServer);

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
            // That the password is unchanged is the thing to say here. This is
            // the branch where the configuration was found and the write did
            // not go through, so the operator is still locked out - and the
            // database, not the working directory, is what to look at.
            console.error("The password could not be reset: " + (err?.message ?? err));
            console.error("The stored password is unchanged. This database is the right one - check that it");
            console.error("is not locked by another process and that the data directory is writable.");
            return stopAfterReset(RESET_FAILED_EXIT);
        });
    }

    // Startup is not optional: a failure here leaves a listening server with no
    // migrations, no defaults and no scheduler, which is worse than not
    // starting at all.
    run().catch(err => {
        // describeError, not the bare message: a failed migration or a stored
        // value the model refuses arrives here as sequelize's "Validation
        // error" and nothing else, and this line is the only thing the
        // operator gets before the process leaves - upstream #1549 is 138
        // restarts on exactly that, ended by deleting the database.
        console.error("The server could not finish starting up: " + describeError(err));
        process.exit(STARTUP_FAILED_EXIT);
    });
}).catch(err => {
    console.error("Could not open the database: " + err.message);

    // "Maybe it is damaged" was the only hint this used to give, and it points
    // at the wrong thing far more often than the right one: the usual cause is
    // a data directory the server cannot write to.
    if (process.env.DB_TYPE !== "mysql")
        console.error("Check that the data directory is writable by the user the server runs as.");

    process.exit(DATABASE_OPEN_FAILED_EXIT);
});
