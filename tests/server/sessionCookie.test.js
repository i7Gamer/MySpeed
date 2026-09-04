import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import { expiredCookies, readCookie, readCookies, serialiseCookie } from "../../server/util/cookies.js";

const attribute = (header, name) =>
    header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));

const startedWith = process.env.BASE_PATH;

beforeEach(() => {
    delete process.env.BASE_PATH;
});

afterEach(() => {
    if (startedWith === undefined) delete process.env.BASE_PATH;
    else process.env.BASE_PATH = startedWith;
});

/** The request as the cookie helper reads it: the URL the client actually asked for. */
const asked = (originalUrl) => ({originalUrl});

const pathFor = (originalUrl, options = {}) =>
    attribute(serialiseCookie("myspeed_session", "abc", {req: asked(originalUrl), maxAge: 60, ...options}), "Path");

/**
 * The one cookie this server writes, and where the browser is told to send it
 * back.
 *
 * `Path=/` was hard-coded, which is right for the instance that owns its origin
 * and wrong for the deployment BASE_PATH exists for: one origin serving several
 * applications at different prefixes, which is exactly the Traefik setup the
 * upstream issue described. There the browser attaches `myspeed_session` to
 * every request to the sibling application too - a full-access session token in
 * another service's request logs - and `SameSite=Strict` does not help, because
 * the token is sent to that server directly rather than read by a script.
 *
 * Every other path this server writes into a response is already prefix-aware.
 * This was the one left behind.
 */
describe("the session cookie's Path", () => {
    it("is the root when no prefix is configured", () => {
        assert.equal(pathFor("/api/session"), "Path=/");
    });

    it("is the prefix when the request came in under one", () => {
        process.env.BASE_PATH = "/internet_speed";

        assert.equal(pathFor("/internet_speed/api/session"), "Path=/internet_speed");
    });

    /**
     * And it is the root when the request did not, which is not a hypothetical
     * shape.
     *
     * `stripBasePath` serves an un-prefixed request as well as a prefixed one,
     * deliberately and load-bearingly: the container healthcheck asks
     * 127.0.0.1:5216/api/health with no proxy in front of it. So an instance
     * with BASE_PATH set answers on both, and a browser reaching it directly -
     * on the LAN, past the proxy, or through a second route that does strip the
     * prefix - loads the page at "/" and posts to "/api/session".
     *
     * Scoping that reply to the prefix hands the browser a cookie it will never
     * send back: the sign-in succeeds, the session is stored, and the next
     * request carries nothing, so the page asks for the password again. A login
     * loop with no error message, on a deployment that worked before BASE_PATH
     * was set.
     */
    it("is the root when the request did not carry the prefix", () => {
        process.env.BASE_PATH = "/internet_speed";

        assert.equal(pathFor("/api/session"), "Path=/",
            "a browser on the un-prefixed route is handed a cookie it can never send back");
    });

    // The boundary, the same way stripBasePath checks it: a different
    // application whose name merely starts with the prefix is not this one.
    it("does not read a longer name as the prefix", () => {
        process.env.BASE_PATH = "/internet_speed";

        assert.equal(pathFor("/internet_speedy/api/session"), "Path=/");
    });

    // The bare prefix with a query on it is the prefixed route too - that is
    // the request stripBasePath rewrites rather than redirects.
    it("reads the bare prefix as the prefix", () => {
        process.env.BASE_PATH = "/internet_speed";

        assert.equal(pathFor("/internet_speed"), "Path=/internet_speed");
        assert.equal(pathFor("/internet_speed?next=/"), "Path=/internet_speed");
    });

    /**
     * Read through the same normaliser everything else reads it through, so the
     * three ways an operator writes the same prefix scope the cookie the same
     * way - and so a trailing slash cannot produce `Path=/internet_speed/`,
     * which a browser reads as the directory and not the bare prefix the
     * redirect lands on.
     */
    it("does not mind how the operator wrote the prefix", () => {
        for (const written of ["internet_speed", "/internet_speed", "/internet_speed/"]) {
            process.env.BASE_PATH = written;

            assert.equal(pathFor("/internet_speed/api/session"), "Path=/internet_speed",
                `${written} scoped the cookie differently`);
        }
    });

    // A prefix of "/" means the root to whoever typed it, and taking it
    // literally would be the same answer by a different route anyway.
    it("reads a prefix of one slash as no prefix", () => {
        process.env.BASE_PATH = "/";

        assert.equal(pathFor("/api/session"), "Path=/");
    });

    /**
     * A prefix that would not survive being written into the header is not
     * written into it.
     *
     * `normaliseBasePath` takes the slashes off the ends and passes everything
     * else through, because everything else is a routing question and any byte
     * is a legal path segment. Set-Cookie is not routing: ";" ends the
     * attribute, so `BASE_PATH="/x; Domain=evil.example"` would append a second
     * attribute of the operator's choosing to every session cookie, and a
     * control character would have node refuse the whole response.
     *
     * It is admin-set input either way, so this is a guard rail rather than a
     * boundary - the answer is the scope that is always safe to send, not a
     * refusal that would take the instance down over a typo.
     */
    it("falls back to the root for a prefix that could not be an attribute", () => {
        const clean = serialiseCookie("myspeed_session", "abc", {req: asked("/api/session"), maxAge: 60});

        for (const written of ["/x; Domain=evil.example", "/x y", `/x${String.fromCharCode(9)}y`, "/x,y"]) {
            process.env.BASE_PATH = written;

            assert.equal(serialiseCookie("myspeed_session", "abc",
                {req: asked(`${written}/api/session`), maxAge: 60}), clean,
            `${JSON.stringify(written)} reached the header`);
        }
    });

    // Nothing to read the request from is nothing to decide with, and the root
    // is the scope every browser can send back. It is the cookie's reach that
    // is given up, not the session - and the suite below is what keeps a third
    // call site from getting here.
    it("falls back to the root when there is no request to read", () => {
        process.env.BASE_PATH = "/internet_speed";

        assert.equal(attribute(serialiseCookie("myspeed_session", "abc", {maxAge: 60}), "Path"), "Path=/");
    });

    // The rest of the header is what it was. HttpOnly is the whole reason this
    // function exists, and SameSite is what keeps the cookie from turning every
    // state-changing endpoint into a CSRF target.
    it("leaves the other attributes alone", () => {
        process.env.BASE_PATH = "/internet_speed";

        const header = serialiseCookie("myspeed_session", "abc",
            {req: asked("/internet_speed/api/session"), maxAge: 60, secure: true});

        assert.match(header, /^myspeed_session=abc;/);
        assert.match(header, /HttpOnly/);
        assert.match(header, /SameSite=Strict/);
        assert.match(header, /Max-Age=60/);
        assert.match(header, /Secure/);
    });
});

/**
 * And the two call sites have to agree.
 *
 * A browser keys a cookie by name *and* path, so a sign-out that clears
 * `Path=/` after a login that set `Path=/internet_speed` does not delete
 * anything - it writes a second, empty cookie beside the first and leaves the
 * live session id in the browser. So neither call site names a scope: the set
 * hands over the request and the helper answers, and the clear names no scope
 * at all because it covers every one the set could have used.
 */
describe("where the cookie is set and cleared", () => {
    const source = readSource("server/routes/session.js");
    const calls = [...source.matchAll(/(?:serialiseCookie|expiredCookies)\((?:[^()]|\([^()]*\))*\)/g)]
        .map((match) => match[0]);

    it("writes the cookie in exactly two places", () => {
        assert.equal(calls.length, 2,
            "the login and the sign-out are no longer the only writers of the session cookie");
    });

    /**
     * As a property of its own, not as `secure: req.secure`.
     *
     * The first spelling of this was `/\breq\b/`, which the `secure: req.secure`
     * already in both calls satisfies - so deleting the `req` that scopes the
     * cookie, the whole point of the change, left the suite green.
     */
    it("has the set hand over the request", () => {
        const set = calls.filter((call) => call.startsWith("serialiseCookie"));

        assert.equal(set.length, 1, "the cookie is set somewhere other than the login");
        assert.match(set[0], /[{,]\s*req\s*[,}]/,
            `the login writes the cookie without the request: ${set[0]} - it cannot be scoped to the route asked`);
    });

    // The clear takes none: its scope is every scope, which is a property of
    // the instance rather than of this request.
    it("has the clear name no scope of its own", () => {
        const cleared = calls.filter((call) => call.startsWith("expiredCookies"));

        assert.equal(cleared.length, 1, "the sign-out clears the cookie somewhere else, or not at all");
        assert.doesNotMatch(cleared[0], /path\s*:/i,
            `the sign-out names a Path: ${cleared[0]} - a clear that names one cannot cover the other`);
    });

    // And the attribute is written in one place, so there is nowhere else for a
    // second spelling of it to appear.
    it("writes the attribute in one place", () => {
        assert.doesNotMatch(source, /Path=/, "the routes spell the Path attribute out for themselves");
        assert.match(readSource("server/util/cookies.js"), /Path=\$\{/,
            "the cookie helper hard-codes the Path again");
    });
});

/**
 * And a sign-out has to reach every scope a sign-in could have written.
 *
 * Scoping the cookie to the route the request came in on made the scope a
 * property of the request rather than of the browser - and this server answers
 * on two routes under BASE_PATH, on purpose. So one browser can hold two
 * `myspeed_session` cookies at two paths: sign in through the proxy, then open
 * the instance directly on the LAN, find yourself logged out (the first cookie
 * does not path-match), and sign in again.
 *
 * Signing out then cleared one of them. The browser sends both, longest path
 * first; the route read the first and destroyed that session; the Set-Cookie
 * named that path alone. The other cookie path-matches everything, so the next
 * request was still authenticated - a sign-out that reports success and leaves
 * the session live is worse than the leak the scoping was added to fix.
 */
describe("signing out of every scope", () => {
    const carrying = (...values) => ({
        headers: {cookie: values.map((value) => `myspeed_session=${value}`).join("; ")}
    });

    it("reads every session id the browser sent, not just the first", () => {
        assert.deepEqual(readCookies(carrying("prefixed", "rooted"), "myspeed_session"),
            ["prefixed", "rooted"],
            "a browser holding two scopes has one of them left live by the sign-out");
    });

    // The single reader is unchanged for a caller that wants one. Neither
    // session reader is one any more - both ask whether any value the browser
    // sent is live - but the helper stays for the next caller that does.
    it("still answers one for the readers that ask for one", () => {
        assert.equal(readCookie(carrying("prefixed", "rooted"), "myspeed_session"), "prefixed");
        assert.equal(readCookie(carrying(), "myspeed_session"), null);
        assert.deepEqual(readCookies(carrying(), "myspeed_session"), []);
    });

    it("clears both scopes when a prefix is configured", () => {
        process.env.BASE_PATH = "/internet_speed";

        const headers = expiredCookies("myspeed_session", {secure: true});

        assert.deepEqual(headers.map((header) => attribute(header, "Path")),
            ["Path=/", "Path=/internet_speed"],
            "a sign-out leaves a live cookie at the scope it did not name");

        for (const header of headers) {
            assert.match(header, /^myspeed_session=;/, "the cleared cookie carries a value");
            assert.match(header, /Max-Age=0/, "without Max-Age=0 the browser keeps it");
            assert.match(header, /HttpOnly/);
            assert.match(header, /SameSite=Strict/);
            assert.match(header, /Secure/);
        }
    });

    // One scope, one header: there is nowhere else the cookie could have been
    // written, and a second Set-Cookie for the same name and path is noise.
    it("clears one scope when none is configured", () => {
        assert.deepEqual(expiredCookies("myspeed_session", {}).map((header) => attribute(header, "Path")),
            ["Path=/"]);
    });

    // A prefix the Path attribute cannot carry is one the set never used, so
    // there is no second scope to clear either.
    it("clears one scope for a prefix that could not be written", () => {
        process.env.BASE_PATH = "/x; Domain=evil.example";

        assert.deepEqual(expiredCookies("myspeed_session", {}).map((header) => attribute(header, "Path")),
            ["Path=/"]);
    });
});

/**
 * And the route does both halves.
 *
 * Clearing every scope is only half a sign-out: the ids the browser sent are
 * live server-side until they are destroyed, and destroying one of two leaves
 * the other usable by anything that still holds it.
 */
describe("what the sign-out route does", () => {
    const source = readSource("server/routes/session.js");
    const signOut = source.slice(source.indexOf("app.delete("));

    it("destroys every session the browser sent", () => {
        assert.notEqual(signOut, "", "there is no sign-out route");
        assert.match(signOut, /readCookies\(req, SESSION_COOKIE\)/,
            "the sign-out destroys one session and leaves any other the browser holds live");
        assert.match(signOut, /destroySession\(/);
    });

    it("clears every scope it could have written", () => {
        assert.match(signOut, /expiredCookies\(SESSION_COOKIE/,
            "the sign-out names one scope, so a cookie at the other one survives it");
        assert.doesNotMatch(signOut, /paths*:/i, "the route names a Path of its own again");
    });
});
