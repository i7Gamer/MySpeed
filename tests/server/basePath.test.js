import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import { normaliseBasePath, stripBasePath } from "../../server/middlewares/basePath.js";

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
    const strip = (url, base) => {
        const request = {url, originalUrl: url};

        stripBasePath(base)(request, {}, () => undefined);

        return request;
    };

    it("removes it from the path the routes will read", () => {
        assert.equal(strip("/internet_speed/api/health", "/internet_speed").url, "/api/health");
    });

    it("keeps the query string", () => {
        assert.equal(strip("/internet_speed/api/speedtests?limit=5", "/internet_speed").url,
            "/api/speedtests?limit=5");
    });

    /**
     * The prefix on its own is the application root. Left as an empty string the
     * static handler has no path to match and answers 404 for the one URL the
     * operator will actually type.
     */
    it("turns the bare prefix into the root", () => {
        assert.equal(strip("/internet_speed", "/internet_speed").url, "/");
        assert.equal(strip("/internet_speed/", "/internet_speed").url, "/");
        assert.equal(strip("/internet_speed?x=1", "/internet_speed").url, "/?x=1");
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
