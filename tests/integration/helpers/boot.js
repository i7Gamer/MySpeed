import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach } from "node:test";

/**
 * Boots the real Express app against a throwaway sqlite database and a real
 * listening socket, so tests exercise routing, middleware, validation, the
 * controllers and the database together.
 *
 * The app is deliberately imported from server/app.js rather than
 * server/index.js: index.js additionally downloads the speedtest CLI, polls
 * network interfaces and fetches remote server lists, none of which belong in a
 * test. Everything below the HTTP layer is the genuine article.
 *
 * The working directory is switched before the import because the database
 * resolves `data/storage.db` relative to it. That makes this a once-per-process
 * operation, which suits the node test runner - it isolates each test file in
 * its own process.
 */
let booted = null;
let closed = false;

/**
 * Every file that boots gets its limiters put back between tests, from here
 * rather than by each file remembering to. A suite drives one endpoint dozens
 * of times from one address in seconds - not a shape any caller produces - so
 * a route gaining a limit used to turn every test of that route into a test
 * of the limiter, one file at a time, until its author rediscovered the
 * per-file reset idiom. That happened twice in one review cycle. No
 * integration test exercises these limiters live; the limits themselves are
 * tested directly in tests/server/rateLimit.test.js.
 *
 * Registered at import, which node:test reads as a file-level hook for
 * whichever test file imported this helper.
 */
beforeEach(() => booted?.resetRateLimits());

export const bootServer = async () => {
    /**
     * Booting again after close() is not something this can do, and the guard
     * below used to hand back the shut-down instance instead of saying so: a
     * closed database handle, a listener that stopped listening, and a data
     * directory close() had already deleted. What failed was the third
     * assertion afterwards, somewhere inside sequelize, describing none of it.
     *
     * Clearing the guard would not fix it either. The imports below are ESM and
     * cached, so a second boot gets that same closed database back and the same
     * app, while process.chdir has moved out of the directory the storage path
     * resolves against. The node runner gives each test file its own process
     * for exactly this reason, so the rule is the answer rather than a retry.
     */
    if (closed) throw new Error(
        "bootServer() was called after close(). The harness boots once per process - " +
        "the node test runner isolates each test file, so let the file's `after` hook close it.");

    if (booted) return booted;

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-it-"));
    const originalCwd = process.cwd();

    // Keep sqlite (not the preview database) and leave PREVIEW_MODE unset, so
    // the password middleware is exercised for real rather than bypassed.
    process.env.DB_TYPE = "sqlite";
    delete process.env.PREVIEW_MODE;

    process.chdir(dataDir);

    const {default: app, resetRateLimits} = await import("../../../server/app.js");
    const {default: db} = await import("../../../server/config/database.js");
    const {runMigrations} = await import("../../../server/util/migrationRunner.js");
    const config = await import("../../../server/controller/config.js");
    const tests = await import("../../../server/models/Speedtests.js");
    const {initialize: initializeIntegrations} = await import("../../../server/controller/integrations.js");

    await db.authenticate();
    await runMigrations();

    // index.js does this before it listens, and several behaviours depend on the
    // integration definitions being registered - which fields are credentials,
    // among others. Skipping it here made the tests disagree with production.
    await initializeIntegrations();

    await config.insertDefaults();

    const server = await new Promise((resolve) => {
        const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });

    const {port} = server.address();

    booted = {
        baseUrl: `http://127.0.0.1:${port}`,
        db,
        config,
        tests: tests.default,
        dataDir,
        /**
         * Puts the request limiters back as they were. The file-level
         * beforeEach above already calls it between tests; the handle stays
         * exposed for a test that needs a reset mid-case.
         */
        resetRateLimits,
        close: async () => {
            closed = true;

            await new Promise((resolve) => server.close(resolve));
            await db.close().catch(() => undefined);
            process.chdir(originalCwd);
            fs.rmSync(dataDir, {recursive: true, force: true});
        }
    };

    return booted;
};

/** Issues a request against the booted server and decodes the JSON body. */
export const api = async (baseUrl, pathname, options = {}) => {
    const response = await fetch(`${baseUrl}/api${pathname}`, options);
    const text = await response.text();

    // The raw text when it is not JSON: an error page, or an endpoint that
    // answers with a plain string.
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        body = text;
    }

    return {status: response.status, body, text, headers: response.headers};
};

/**
 * Sets a config value the way the HTTP route does.
 *
 * updateValue() stores whatever it is handed; the hashing of `password` happens
 * in validateInput(), so writing a password without it stores plaintext where a
 * bcrypt hash belongs and every comparison then fails.
 */
export const setConfig = async (config, key, value) => {
    // "none" is the stored sentinel for "no password configured", not a
    // password a user may choose, so validateInput refuses it. Writing it
    // directly is what clearPassword() does.
    if (key === "password" && value === "none") return await config.clearPassword();

    const validated = await config.validateInput(key, value);
    if (typeof validated === "string") throw new Error(`Rejected ${key}: ${validated}`);

    await config.updateValue(key, validated.value);
};

/** Replaces the stored speedtests with the supplied rows. */
export const seedTests = async (model, rows) => {
    await model.destroy({where: {}});
    // The quality columns are seeded too, so an assertion that a fixture
    // survives a round trip cannot pass vacuously by comparing null to null.
    await model.bulkCreate(rows.map((row) => ({
        ping: 10, jitter: 2, download: 100, upload: 50, time: 30,
        serverId: 0, type: "auto", error: null,
        packetLoss: 0, downloadLatency: 12, uploadLatency: 20,
        provider: "ookla", bytesDownloaded: 1135809960, bytesUploaded: 917831105, ...row
    })));
};
