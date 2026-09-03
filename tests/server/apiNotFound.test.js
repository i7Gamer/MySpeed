import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readSource } from "../helpers/source.js";

const appSource = readSource("server/app.js");

const NOT_FOUND = "Route not found";

/**
 * The path the JSON 404 is actually mounted at, read out of app.js.
 *
 * Read rather than repeated, because everything below is about what one
 * spelling matches: a copy of it here would go on passing after the mount was
 * changed, which is the one thing this suite exists to notice.
 */
const catchAllMount = () => {
    const line = appSource.split("\n").find((text) => text.includes(NOT_FOUND));

    assert.ok(line, "app.js no longer mounts a JSON 404 at all");

    const mounted = line.match(/^app\.use\(\s*(["'`])(.*?)\1/);

    assert.ok(mounted, `the JSON 404 is no longer a plain app.use mount: ${line}`);

    return mounted[2];
};

/**
 * One request through an Express app, without a socket under it.
 *
 * A real IncomingMessage and a real ServerResponse, so the routing and the
 * response helpers are the ones that ship rather than a mock of them - and
 * `app.handle` rather than `app.listen`, because nothing here needs a port and
 * this suite has no business binding one.
 */
const dispatch = (app, method, url) => new Promise((resolve) => {
    const req = new http.IncomingMessage(null);
    req.method = method;
    req.url = url;
    req.headers = {};

    const res = new http.ServerResponse(req);
    let body = "";

    res.write = (chunk) => {
        body += chunk;
        return true;
    };

    res.end = (chunk) => {
        if (chunk) body += chunk;
        resolve({status: res.statusCode, body});
        return res;
    };

    // Nothing matched at all, which is what Express's own plain-text
    // "Cannot POST /api" is built from.
    app.handle(req, res, () => resolve({status: 404, body: "unmatched"}));
});

/** app.js in miniature: an API router, the catch-all as mounted, the SPA. */
const miniature = () => {
    const app = express();

    app.use("/api/session", (req, res) => res.json({active: false}));
    app.use(catchAllMount(), (req, res) => res.status(404).json({message: NOT_FOUND}));
    app.get("*all", (req, res) => res.status(200).type("html").send("<html>the dashboard</html>"));

    return app;
};

/**
 * What an unmatched API path is answered with.
 *
 * The catch-all was `app.use("/api*all", …)`, and in Express 5 that pattern
 * does not match the bare `/api`: the parameter has to have something to
 * capture. So `GET /api` fell past it into the SPA fallback and came back as
 * the dashboard with a 200 - an HTML page where a caller asked the API a
 * question - while `POST /api` matched nothing at all and got Express's own
 * plain-text default. Every other unmatched `/api/…` earned the JSON 404 the
 * client knows how to read.
 *
 * The plain string covers `/api` and everything below it, and drops the mirror-
 * image over-match the pattern had at the other end: `/apifoo` is not an API
 * path and has no business being answered by the API's 404.
 */
describe("an unmatched API path", () => {
    it("answers the bare /api with the JSON 404", async () => {
        const {status, body} = await dispatch(miniature(), "GET", "/api");

        assert.equal(status, 404);
        assert.deepEqual(JSON.parse(body), {message: NOT_FOUND});
    });

    // Not the dashboard. A caller asking the API for something gets an answer
    // it can parse, whatever the answer is.
    it("does not serve the dashboard from /api", async () => {
        const {body} = await dispatch(miniature(), "GET", "/api");

        assert.doesNotMatch(body, /<html>/, "the SPA fallback answered an API path");
    });

    it("answers a POST to /api with it too", async () => {
        const {status, body} = await dispatch(miniature(), "POST", "/api");

        assert.equal(status, 404);
        assert.deepEqual(JSON.parse(body), {message: NOT_FOUND});
    });

    it("still answers a path below it", async () => {
        for (const url of ["/api/", "/api/nope", "/api/nope/deeper"]) {
            const {status, body} = await dispatch(miniature(), "GET", url);

            assert.equal(status, 404, `${url} was not answered by the API 404`);
            assert.deepEqual(JSON.parse(body), {message: NOT_FOUND});
        }
    });

    // The other end of it. `/apifoo` shares four characters with the prefix and
    // is a different path, so it belongs to the SPA like any other.
    it("leaves a path that merely starts with the same letters to the SPA", async () => {
        const {status, body} = await dispatch(miniature(), "GET", "/apifoo");

        assert.equal(status, 200);
        assert.match(body, /the dashboard/);
    });

    // And the routers in front of it still answer, which is the whole point of
    // it being mounted last.
    it("does not swallow a route mounted before it", async () => {
        const {status, body} = await dispatch(miniature(), "GET", "/api/session");

        assert.equal(status, 200);
        assert.deepEqual(JSON.parse(body), {active: false});
    });
});

/**
 * And the mount stays last, because a plain `/api` prefix answers everything
 * below it: an `/api/…` router added after this line is mounted somewhere
 * nothing can reach, and the route simply stops existing with no error anywhere
 * to say so.
 */
describe("where the API catch-all sits", () => {
    it("is mounted as a plain prefix", () => {
        assert.equal(catchAllMount(), "/api");
    });

    it("has no API router after it", () => {
        const at = appSource.indexOf(NOT_FOUND);
        const below = appSource.slice(at);

        assert.doesNotMatch(below, /^app\.(use|get|post|put|patch|delete|all)\(\s*["'`]\/api/m,
            "an API route is mounted after the catch-all, where nothing can reach it");
    });
});
