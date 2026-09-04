import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A build directory with nothing in it, behind a path prefix.
 *
 * Serving the page under BASE_PATH means reading it at import rather than
 * handing the path to sendFile per request - see util/indexMeta.js - and a read
 * that throws there takes the whole process down before it has opened a port.
 * A build directory with no index.html in it is a broken deployment either way,
 * but one that answers 404 can be looked at, while one that cannot boot is a
 * container in a restart loop with the same message every ten seconds.
 *
 * Its own file because BASE_PATH has to be in the environment before app.js is
 * imported, and the runner gives each file its own process.
 */
let server;
let baseUrl;
let previousCwd;

before(async () => {
    process.env.BASE_PATH = "/internet_speed";
    process.env.DB_TYPE = "sqlite";

    previousCwd = process.cwd();

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-noindex-"));

    // The directory app.js looks for, holding everything except the one file
    // that makes it a client build.
    fs.mkdirSync(path.join(dataDir, "build"));
    process.chdir(dataDir);

    const {default: app} = await import("../../server/app.js");
    const {default: db} = await import("../../server/config/database.js");
    const {runMigrations} = await import("../../server/util/migrationRunner.js");

    await db.authenticate();
    await runMigrations();

    const listener = await new Promise((resolve) => {
        const started = app.listen(0, "127.0.0.1", () => resolve(started));
    });

    server = {listener, db, dataDir};
    baseUrl = `http://127.0.0.1:${listener.address().port}`;
});

after(async () => {
    await new Promise((resolve) => server.listener.close(resolve));
    await server.db.close().catch(() => undefined);
    process.chdir(previousCwd);
    delete process.env.BASE_PATH;
});

describe("a prefixed instance whose build has no page", () => {
    it("boots at all", () => {
        assert.ok(baseUrl, "app.js threw at import instead of leaving the branch as it was");
    });

    // The half of the instance that has nothing to do with the client keeps
    // working, which is what makes the state diagnosable.
    it("still answers the API", async () => {
        const response = await fetch(`${baseUrl}/internet_speed/api/health`);

        assert.equal(response.status, 200);
        assert.equal((await response.json()).status, "ok");
    });

    // Not an empty 200: a page that is not there reads as a page that is blank,
    // and a blank page is what a broken client build looks like from the front.
    // Asserted whatever the status: this used to check the body only behind
    // `if (status === 200)`, and in the state this suite builds the route
    // answers 404, so the test executed no assertion at all and passed a 500
    // or an empty page alike. A page that is not there is a 404 with a body
    // that says so; a 200 is fine only if it carries one.
    it("does not answer a page request with an empty body", async () => {
        const response = await fetch(`${baseUrl}/internet_speed/`);

        assert.ok([200, 404].includes(response.status), `the SPA route answered ${response.status}`);
        assert.notEqual((await response.text()).trim(), "", "the SPA route served an empty page");
    });
});
