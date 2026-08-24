import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import { appPath, normaliseBasePath, stripBasePath } from "../../server/middlewares/basePath.js";

/**
 * Serving from a subdirectory, which is upstream #771.
 *
 * The reporter runs Traefik with `PathPrefix('/internet_speed')` and no
 * StripPrefix beside it, so the server receives the prefix on every request -
 * and asked for "an env var that I could set and all requests are prepended with
 * this value".
 *
 * Which is what BASE_PATH is. It is taken off at the very front rather than
 * threaded through thirty route mounts: every route below then sees the path it
 * was written for, and none of the security scans that read those mounts stop
 * being able to read them. It is the same thing a StripPrefix middleware does,
 * done where the operator can switch it on without a proxy that offers one.
 */
describe("reading the setting", () => {
    it("takes a path as written", () => {
        assert.equal(normaliseBasePath("/internet_speed"), "/internet_speed");
    });

    /**
     * A leading slash is added and a trailing one removed, because the value is
     * typed by a person: "internet_speed", "/internet_speed" and
     * "/internet_speed/" are all the same intention, and only one of them
     * concatenates correctly against a route that begins with a slash.
     */
    it("does not mind how the operator wrote it", () => {
        for (const written of ["internet_speed", "/internet_speed", "/internet_speed/", "internet_speed/"])
            assert.equal(normaliseBasePath(written), "/internet_speed", `${written} was read differently`);
    });

    it("keeps a nested path whole", () => {
        assert.equal(normaliseBasePath("/apps/myspeed/"), "/apps/myspeed");
    });

    /**
     * Unset means unset. Every existing instance has no BASE_PATH, and the empty
     * string has to leave the middleware doing nothing at all rather than
     * stripping "" from the front of every request.
     */
    it("answers nothing for a value that names no prefix", () => {
        for (const written of [undefined, null, "", "   ", "/", "//"])
            assert.equal(normaliseBasePath(written), "", `${JSON.stringify(written)} was read as a prefix`);
    });

    it("answers nothing for a value that is not a string", () => {
        for (const written of [42, {}, []]) assert.equal(normaliseBasePath(written), "");
    });
});

describe("taking the prefix off a request", () => {
    const strip = (url, base, method = "GET") => {
        const request = {url, originalUrl: url, method};
        const response = {redirected: null, redirect(status, to) { this.redirected = {status, to}; }};
        let passed = false;

        stripBasePath(base)(request, response, () => { passed = true; });

        return {...request, redirected: response.redirected, passed};
    };

    it("removes it from the path the routes will read", () => {
        assert.equal(strip("/internet_speed/api/health", "/internet_speed").url, "/api/health");
    });

    it("keeps the query string", () => {
        assert.equal(strip("/internet_speed/api/speedtests?limit=5", "/internet_speed").url,
            "/api/speedtests?limit=5");
    });

    /**
     * The prefix with a slash on the end is the application root. Left as an
     * empty string the static handler has no path to match and answers 404 for
     * the one URL the operator will actually type.
     */
    it("turns the prefix root into the root", () => {
        assert.equal(strip("/internet_speed/", "/internet_speed").url, "/");
        assert.equal(strip("/internet_speed/?x=1", "/internet_speed").url, "/?x=1");
    });

    /**
     * The bare prefix is redirected to that root rather than served as it, and
     * this is the whole reason the client can be told nothing and still work.
     *
     * index.html asks for `./assets/index-x.js`, which the browser resolves
     * against the URL the page was served from. Served AT /internet_speed, that
     * base has no trailing slash, so the last segment is not read as a directory
     * and the asset resolves to https://host/assets/index-x.js - outside the
     * prefix, where the proxy serves something else or nothing at all, and the
     * page comes up blank. One slash puts every one of those URLs back inside.
     *
     * This used to be rewritten to "/" and served directly, which answered 200
     * and so looked correct to a test that only read the status.
     */
    it("redirects the bare prefix to the prefix root", () => {
        const {redirected, passed} = strip("/internet_speed", "/internet_speed");

        assert.deepEqual(redirected, {status: 302, to: "/internet_speed/"});
        assert.ok(!passed, "the request was also passed on down the chain");
    });

    it("keeps the query when it redirects", () => {
        assert.deepEqual(strip("/internet_speed?x=1", "/internet_speed").redirected,
            {status: 302, to: "/internet_speed/?x=1"});
    });

    // Temporary, not permanent: an operator who takes BASE_PATH off again should
    // not be fighting a redirect that every browser in the house cached forever.
    it("redirects temporarily", () => {
        assert.equal(strip("/internet_speed", "/internet_speed").redirected.status, 302);
    });

    /**
     * Only the methods a browser follows. A redirected POST loses its body, and
     * nothing the client sends posts to the bare prefix in any case.
     */
    it("does not redirect a request that is not a GET or HEAD", () => {
        const {redirected, url} = strip("/internet_speed", "/internet_speed", "POST");

        assert.equal(redirected, null);
        assert.equal(url, "/");
    });

    it("does not redirect a path underneath the prefix", () => {
        assert.equal(strip("/internet_speed/api/health", "/internet_speed").redirected, null);
        assert.equal(strip("/internet_speed/", "/internet_speed").redirected, null);
    });

    /**
     * A path that merely starts with the same characters is a different path.
     * Stripping it would turn /internet_speedy into /y, which is nobody's route
     * and would 404 with no explanation.
     */
    it("does not strip a path that only looks like it", () => {
        assert.equal(strip("/internet_speedy/api", "/internet_speed").url, "/internet_speedy/api");
        assert.equal(strip("/internet_speeds", "/internet_speed").url, "/internet_speeds");
    });

    /**
     * A request that does not carry the prefix passes through untouched, and
     * this is load-bearing rather than lenient: the container healthcheck asks
     * 127.0.0.1:5216/api/health directly, with no proxy and no prefix in front
     * of it, and an instance that answered 404 there would be restarted forever.
     */
    it("leaves a request without the prefix alone", () => {
        assert.equal(strip("/api/health", "/internet_speed").url, "/api/health");
        assert.equal(strip("/", "/internet_speed").url, "/");
    });

    it("does nothing at all when no prefix is configured", () => {
        assert.equal(strip("/api/health", "").url, "/api/health");
        assert.equal(strip("/internet_speed/api", "").url, "/internet_speed/api");
    });

    /**
     * originalUrl is what the HTTPS redirect builds its Location from, so it has
     * to keep the prefix - a redirect that dropped it would send the caller out
     * of the application and into whatever else the proxy serves at the root.
     */
    it("leaves originalUrl as the caller sent it", () => {
        assert.equal(strip("/internet_speed/api/health", "/internet_speed").originalUrl,
            "/internet_speed/api/health");
    });
});

/**
 * The whole path with the prefix already taken off, for the handlers that need
 * the whole path.
 *
 * req.url is not it: once Express enters a mounted router, req.url holds only
 * the part below the mount, which is why the two callers of this reach for
 * originalUrl instead. But originalUrl still carries the prefix, and both of
 * them then match it against a pattern anchored at ^/api - so under a prefix the
 * node proxy asked a child for a path the child does not serve, and the backup
 * relay silently lost its larger size allowance.
 */
describe("the path a handler should match on", () => {
    const run = (url, base) => {
        const request = {url, originalUrl: url, method: "GET"};

        stripBasePath(base)(request, {redirect() {}}, () => undefined);

        return request;
    };

    it("is the whole path without the prefix", () => {
        assert.equal(appPath(run("/internet_speed/api/nodes/1/storage/config", "/internet_speed")),
            "/api/nodes/1/storage/config");
    });

    it("is the whole path when no prefix is configured", () => {
        assert.equal(appPath(run("/api/nodes/1/storage/config", "")), "/api/nodes/1/storage/config");
    });

    it("keeps the query, which the backup paths strip for themselves", () => {
        assert.equal(appPath(run("/internet_speed/api/speedtests?limit=5", "/internet_speed")),
            "/api/speedtests?limit=5");
    });

    /**
     * Falls back rather than answering undefined: a router exercised without the
     * middleware in front of it - which several suites do - would otherwise hand
     * every one of these matchers undefined, and match nothing at all.
     */
    it("falls back to originalUrl when the middleware never ran", () => {
        assert.equal(appPath({originalUrl: "/api/nodes/1/storage/config"}), "/api/nodes/1/storage/config");
    });
});

/**
 * Where it sits, which is the whole reason this approach is cheap.
 */
describe("the middleware chain", () => {
    const source = readSource("server/app.js");

    it("takes the prefix off before anything reads the path", () => {
        const stripped = source.indexOf("stripBasePath(");

        assert.notEqual(stripped, -1, "the prefix is never removed, so every route below 404s under it");

        /*
         * Ahead of the body parser in particular. isLargeBodyPath reads req.path
         * to decide which limit a request gets, so a prefixed import would have
         * been handed the small parser and refused for a body that is allowed.
         */
        assert.ok(stripped < source.indexOf("isLargeBodyPath(req.path)"),
            "the body-size decision is made on a path that still carries the prefix");

        assert.ok(stripped < source.indexOf('app.use("/api'),
            "a route is mounted before the prefix that would stop it matching is removed");
    });

    // Before the redirect too, so the rate limiters and the throttle key on the
    // same canonical path whether or not a proxy is in front.
    it("takes it off before the https redirect and the rate limiters", () => {
        assert.ok(source.indexOf("stripBasePath(") < source.indexOf("httpsRedirect()"));
    });
});
