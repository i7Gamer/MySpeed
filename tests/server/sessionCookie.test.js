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
        assert.equal(attribute(serialiseCookie("myspeed_session", "abc", {maxAge: 60}), "Path"), "Path=/");
    });

    it("is the prefix when one is", () => {
        process.env.BASE_PATH = "/internet_speed";

        assert.equal(attribute(serialiseCookie("myspeed_session", "abc", {maxAge: 60}), "Path"),
            "Path=/internet_speed");
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

            assert.equal(attribute(serialiseCookie("myspeed_session", "abc", {maxAge: 60}), "Path"),
                "Path=/internet_speed", `${written} scoped the cookie differently`);
        }
    });

    // A prefix of "/" means the root to whoever typed it, and taking it
    // literally would be the same answer by a different route anyway.
    it("reads a prefix of one slash as no prefix", () => {
        process.env.BASE_PATH = "/";

        assert.equal(attribute(serialiseCookie("myspeed_session", "abc", {maxAge: 60}), "Path"), "Path=/");
    });

    // The rest of the header is what it was. HttpOnly is the whole reason this
    // function exists, and SameSite is what keeps the cookie from turning every
    // state-changing endpoint into a CSRF target.
    it("leaves the other attributes alone", () => {
        process.env.BASE_PATH = "/internet_speed";

        const header = serialiseCookie("myspeed_session", "abc", {maxAge: 60, secure: true});

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
 * both take the single default, and there is no argument for a future call site
 * to get wrong.
 */
describe("where the cookie is set and cleared", () => {
    const source = readSource("server/routes/session.js");
    const calls = [...source.matchAll(/serialiseCookie\((?:[^()]|\([^()]*\))*\)/g)].map((match) => match[0]);

    it("writes the cookie in exactly two places", () => {
        assert.equal(calls.length, 2,
            "the login and the sign-out are no longer the only writers of the session cookie");
    });

    it("lets both of them take the same Path", () => {
        for (const call of calls)
            assert.doesNotMatch(call, /path/i,
                `a call site names its own Path: ${call} - a set and a clear that disagree leave the session live`);
    });

    // And the attribute is written in one place, so there is nowhere else for a
    // second spelling of it to appear.
    it("writes the attribute in one place", () => {
        assert.doesNotMatch(source, /Path=/, "the routes spell the Path attribute out for themselves");
        assert.match(readSource("server/util/cookies.js"), /Path=\$\{/,
            "the cookie helper hard-codes the Path again");
    });
});
