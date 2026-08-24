import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

/**
 * Serving from a subdirectory, end to end - upstream #771.
 *
 * The unit tests hold the middleware, and every one of them would still pass if
 * app.js never mounted it or mounted it too late. This boots the server with
 * BASE_PATH set and asks it for real URLs.
 *
 * BASE_PATH has to be in the environment before app.js is imported, which is why
 * this file boots its own server rather than sharing the harness: the node test
 * runner gives each file its own process, so setting it here affects nothing
 * else.
 */
const PREFIX = "/internet_speed";

/** Identifies the stand-in page below, so "the SPA answered" is what gets asserted. */
const PAGE_MARKER = "stand-in client build";

let server;
let baseUrl;

before(async () => {
    process.env.BASE_PATH = PREFIX;
    process.env.DB_TYPE = "sqlite";

    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseprefix-"));

    /*
     * A stand-in for the client build, not the real one.
     *
     * app.js reads process.cwd()/build when it is imported and mounts the static
     * handler and the SPA fallback only if it is there, so something has to be
     * at that path before the import below or two thirds of this file would be
     * asserting against routes that were never mounted.
     *
     * Synthesised rather than copied from client/build, because the CI job runs
     * the suite before it builds the client - a copy would have made this file
     * pass here and fail there. It also keeps the boundary honest: what is being
     * tested below is the server, that it serves whatever the page asks for once
     * the prefix is off. That vite emits those URLs relatively in the first
     * place is a property of the build, and is held by the `base: "./"` case in
     * tests/client/basePath.test.js.
     *
     * The marker is deliberately not the real page's title: an assertion that
     * matched /MySpeed/ would read like evidence about the shipped index.html
     * when it is only evidence about these four lines.
     */
    const buildDir = path.join(dataDir, "build");
    const ENTRY = "assets/index-fixture.js";

    fs.mkdirSync(path.join(buildDir, "assets", "locales"), {recursive: true});
    fs.writeFileSync(path.join(buildDir, "index.html"),
        `<!doctype html><title>${PAGE_MARKER}</title><script type="module" src="./${ENTRY}"></script>`);
    fs.writeFileSync(path.join(buildDir, ENTRY), "// stand-in for the entry bundle");
    fs.writeFileSync(path.join(buildDir, "assets", "locales", "en.json"), '{"test": "ok"}');

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
    delete process.env.BASE_PATH;
});

const get = (pathname) => fetch(`${baseUrl}${pathname}`);

describe("an instance behind a path prefix", () => {
    it("answers the API under the prefix", async () => {
        const response = await get(`${PREFIX}/api/health`);

        assert.equal(response.status, 200);
        assert.equal((await response.json()).status, "ok");
    });

    /**
     * And without it, which is not merely tolerance: the container healthcheck
     * asks 127.0.0.1:5216/api/health directly, with no proxy in front, so an
     * instance that answered 404 there would be restarted forever.
     */
    it("still answers the API at the root, which is what the healthcheck asks", async () => {
        assert.equal((await get("/api/health")).status, 200);
    });

    it("serves the application at the prefix itself", async () => {
        const response = await get(PREFIX);

        assert.equal(response.status, 200);
        assert.ok((await response.text()).includes(PAGE_MARKER));
    });

    it("serves it at the prefix with a trailing slash too", async () => {
        assert.equal((await get(`${PREFIX}/`)).status, 200);
    });

    /**
     * The asset the page then asks for. It is requested relatively, so the
     * browser resolves it against the prefix and asks for it there - which is
     * the request #771 reports failing.
     *
     * Read out of the served page rather than hard-coded, so this follows the
     * URL the browser would actually have built.
     */
    it("serves the assets the page asks for under the prefix", async () => {
        const page = await (await get(`${PREFIX}/`)).text();
        const asset = /src="\.\/(assets\/[^"]+\.js)"/.exec(page);

        assert.ok(asset, "the page did not ask for its entry script relatively");

        const response = await get(`${PREFIX}/${asset[1]}`);

        assert.equal(response.status, 200, `${PREFIX}/${asset[1]} was not served`);
    });

    it("serves the locale files under the prefix", async () => {
        assert.equal((await get(`${PREFIX}/assets/locales/en.json`)).status, 200);
    });

    /**
     * A path that merely starts the same way is a different path. Stripping it
     * would turn /internet_speedy/api/health into /y/api/health - and worse,
     * /internet_speedy/api would become /y/api, so a careless prefix match could
     * put the API somewhere it was never mounted.
     *
     * Asserted on the body rather than the status: the SPA fallback answers any
     * unmatched path with index.html and a 200, so a status check here passes
     * whatever the middleware did. What matters is that the request did not
     * reach the API.
     */
    it("does not treat a lookalike path as the prefix", async () => {
        const body = await (await get("/internet_speedy/api/health")).text();

        assert.ok(!body.includes('"status"'),
            "a path that only looks like the prefix was stripped and reached the API");
    });

    // A deep client route reloaded in the browser. The server has no such route,
    // so the SPA fallback has to answer it - under the prefix as well as without.
    it("serves the application for a client route under the prefix", async () => {
        const response = await get(`${PREFIX}/statistics`);

        assert.equal(response.status, 200);
        assert.ok((await response.text()).includes(PAGE_MARKER));
    });
});
