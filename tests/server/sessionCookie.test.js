import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import { serialiseCookie } from "../../server/util/cookies.js";

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
 * live session id in the browser. The set and the clear have to name the same
 * scope, and the way to be sure of that is for neither of them to name one:
 * both hand over the request and the helper answers, so two calls made by the
 * same browser get the same scope by construction - it loads the page under one
 * prefix or the other and asks for both endpoints the same way.
 */
describe("where the cookie is set and cleared", () => {
    const source = readSource("server/routes/session.js");
    const calls = [...source.matchAll(/serialiseCookie\((?:[^()]|\([^()]*\))*\)/g)].map((match) => match[0]);

    it("writes the cookie in exactly two places", () => {
        assert.equal(calls.length, 2,
            "the login and the sign-out are no longer the only writers of the session cookie");
    });

    it("has both of them hand over the request", () => {
        for (const call of calls) {
            assert.match(call, /\breq\b/,
                `a call site writes the cookie without the request: ${call} - it cannot be scoped to the route asked`);
            assert.doesNotMatch(call, /path/i,
                `a call site names its own Path: ${call} - a set and a clear that disagree leave the session live`);
        }
    });

    // And the attribute is written in one place, so there is nowhere else for a
    // second spelling of it to appear.
    it("writes the attribute in one place", () => {
        assert.doesNotMatch(source, /Path=/, "the routes spell the Path attribute out for themselves");
        assert.match(readSource("server/util/cookies.js"), /Path=\$\{/,
            "the cookie helper hard-codes the Path again");
    });
});
