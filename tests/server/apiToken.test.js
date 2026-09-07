import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
    LAST_USED_GRANULARITY_MS, MAX_TOKENS, SCOPE_RUN, SCOPES, TOKEN_BYTES, TOKEN_NAME_LIMIT, TOKEN_PREFIX,
    digestOf, generateToken, importableToken, parseBearer, shouldTouch, resetTouches, tokenNameProblem
} from "../../server/controller/tokens.js";
import { tokenOrPassword } from "../../server/middlewares/apiToken.js";
import { PASSWORD_REQUIRED, SERVER_BUSY } from "../../server/util/authOutcome.js";

/*
 * A token is a credential the operator issues for one purpose - starting a
 * test from outside - so that a script or a home-automation platform never
 * holds the admin password. Everything about its shape, and the one place it
 * is judged, is held here without a database.
 */

describe("generateToken", () => {
    it("carries the prefix that makes a leaked token recognisable", () => {
        assert.ok(generateToken().startsWith(TOKEN_PREFIX));
        assert.equal(TOKEN_PREFIX, "msp_");
    });

    it("holds 256 bits of randomness, base64url encoded", () => {
        const secret = generateToken().slice(TOKEN_PREFIX.length);

        assert.equal(TOKEN_BYTES, 32);
        assert.equal(Buffer.from(secret, "base64url").length, TOKEN_BYTES);
        assert.match(secret, /^[A-Za-z0-9_-]+$/, "a token must survive a shell, a URL and a header unquoted");
    });

    it("never repeats", () => {
        const seen = new Set(Array.from({length: 100}, generateToken));
        assert.equal(seen.size, 100);
    });
});

describe("digestOf", () => {
    it("is the token's sha256 as hex, and nothing an attacker could reverse", () => {
        const secret = generateToken();

        assert.equal(digestOf(secret), crypto.createHash("sha256").update(secret).digest("hex"));
        assert.equal(digestOf(secret).length, 64);
        assert.notEqual(digestOf(secret), digestOf(secret + "x"));
    });
});

/**
 * Only a MySpeed token is read off the header. A forward-auth proxy - oauth2-
 * proxy, Authelia, Authentik - injects `Authorization: Bearer <JWT>` on every
 * request it forwards, and a browser behind one must keep reaching the
 * password gate rather than being refused for a token it never sent.
 */
describe("parseBearer", () => {
    const token = generateToken();

    it("reads a token off a Bearer header, whatever the scheme's case or spacing", () => {
        assert.equal(parseBearer(`Bearer ${token}`), token);
        assert.equal(parseBearer(`bearer ${token}`), token);
        assert.equal(parseBearer(`BEARER   ${token}  `), token);
    });

    it("ignores a Bearer that is not a MySpeed token", () => {
        assert.equal(parseBearer("Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc"), null);
        assert.equal(parseBearer("Bearer "), null);
        assert.equal(parseBearer("Bearer"), null);
    });

    it("ignores every other scheme and every other shape", () => {
        assert.equal(parseBearer(`Basic ${Buffer.from("metrics:x").toString("base64")}`), null);
        assert.equal(parseBearer(token), null);
        assert.equal(parseBearer(undefined), null);
        assert.equal(parseBearer(null), null);
        assert.equal(parseBearer(["Bearer", token]), null);
        assert.equal(parseBearer(`Bearer ${token} extra`), null);
    });
});

describe("tokenNameProblem", () => {
    it("accepts an ordinary name", () => {
        assert.equal(tokenNameProblem("Home Assistant"), null);
    });

    it("refuses an empty, blank or non-string name", () => {
        for (const name of ["", "   ", null, undefined, 42, {}])
            assert.equal(typeof tokenNameProblem(name), "string", String(name));
    });

    it("refuses a name past the limit, counted after trimming", () => {
        assert.equal(tokenNameProblem("a".repeat(TOKEN_NAME_LIMIT)), null);
        assert.equal(typeof tokenNameProblem("a".repeat(TOKEN_NAME_LIMIT + 1)), "string");
        assert.equal(tokenNameProblem(" " + "a".repeat(TOKEN_NAME_LIMIT) + " "), null);
    });

    it("bounds the table", () => {
        assert.ok(MAX_TOKENS >= 10 && MAX_TOKENS <= 100);
    });
});

/**
 * A row as a backup carries it: written back only when every field is what
 * the table would have produced, and refused whole otherwise - the way a node
 * row is judged before a restore touches anything.
 */
describe("importableToken", () => {
    const digest = digestOf(generateToken());
    const row = () => ({id: 3, name: "Router hook", digest, scope: SCOPE_RUN,
        created: "2026-09-07T10:00:00.000Z", lastUsed: null});

    it("keeps a well-formed row, without the file's id", () => {
        assert.deepEqual(importableToken(row()), {name: "Router hook", digest, scope: SCOPE_RUN,
            created: "2026-09-07T10:00:00.000Z", lastUsed: null});
    });

    it("keeps a last-used moment", () => {
        assert.equal(importableToken({...row(), lastUsed: "2026-09-07T11:00:00.000Z"}).lastUsed,
            "2026-09-07T11:00:00.000Z");
    });

    it("refuses a digest that is not a sha256 hex", () => {
        for (const bad of [undefined, null, "", "abc", digest.slice(1), digest.toUpperCase(), digest + "0", 42])
            assert.equal(importableToken({...row(), digest: bad}), null, String(bad));
    });

    it("refuses a scope the server does not know", () => {
        assert.equal(importableToken({...row(), scope: "admin"}), null);
        assert.equal(importableToken({...row(), scope: undefined}), null);
        assert.deepEqual(SCOPES, [SCOPE_RUN]);
    });

    it("refuses a bad name, a bad moment, and a row that is not an object", () => {
        assert.equal(importableToken({...row(), name: ""}), null);
        assert.equal(importableToken({...row(), created: "yesterday"}), null);
        assert.equal(importableToken({...row(), lastUsed: 12}), null);
        assert.equal(importableToken(null), null);
        assert.equal(importableToken("row"), null);
    });

    it("stamps a row that carries no creation moment", () => {
        const {created, ...rest} = row();
        assert.match(importableToken(rest).created, /^\d{4}-\d{2}-\d{2}T/);
    });
});

/**
 * The last-used column is a courtesy to the operator reading the list, not a
 * ledger: an automation polling the live status twice a second must not cost
 * a database write per poll.
 */
describe("shouldTouch", () => {
    beforeEach(resetTouches);

    it("writes the first use, then not again inside the granularity", () => {
        assert.equal(shouldTouch(7, 1000), true);
        assert.equal(shouldTouch(7, 1000 + LAST_USED_GRANULARITY_MS - 1), false);
        assert.equal(shouldTouch(7, 1000 + LAST_USED_GRANULARITY_MS), true);
    });

    it("keeps tokens apart", () => {
        assert.equal(shouldTouch(7, 1000), true);
        assert.equal(shouldTouch(8, 1000), true);
    });
});

/** A request and a response as the middleware sees them. */
const fakeReq = (authorization, extra = {}) => ({headers: authorization === undefined ? {} : {authorization}, ...extra});

const fakeRes = () => {
    const res = {statusCode: 200, body: null, headers: {}};
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    res.set = (name, value) => { res.headers[name] = value; return res; };
    return res;
};

/** Every collaborator recorded, with one known token in the table. */
const harness = ({scope = SCOPE_RUN, preview = false, rows} = {}) => {
    const token = generateToken();
    const table = rows ?? [{id: 4, name: "Home Assistant", digest: digestOf(token), scope}];
    const calls = {fallback: 0, touched: [], next: 0};

    const deps = {
        findByDigest: async (digest) => table.find((row) => row.digest === digest) ?? null,
        touch: async (id) => { calls.touched.push(id); },
        fallback: (req, res, next) => { calls.fallback++; next(); },
        preview: () => preview
    };

    const run = async (req) => {
        const res = fakeRes();
        await tokenOrPassword(SCOPE_RUN, false, deps)(req, res, () => { calls.next++; });
        return res;
    };

    return {token, calls, deps, run};
};

describe("tokenOrPassword", () => {
    it("hands a request without a MySpeed token to the password gate", async () => {
        const {calls, run} = harness();

        await run(fakeReq(undefined));
        await run(fakeReq("Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc"));
        await run(fakeReq("Basic bWV0cmljczp4"));

        assert.equal(calls.fallback, 3);
        assert.equal(calls.next, 3, "the password gate's next was not honoured");
    });

    it("admits a known token with the right scope as the operator", async () => {
        const {token, calls, run} = harness();
        const req = fakeReq(`Bearer ${token}`);

        const res = await run(req);

        assert.equal(calls.next, 1);
        assert.equal(calls.fallback, 0);
        assert.equal(req.viewMode, false);
        assert.deepEqual(req.apiToken, {id: 4, name: "Home Assistant"});
        assert.deepEqual(calls.touched, [4]);
        assert.equal(res.body, null, "an answer was written for an admitted request");
    });

    it("refuses a token nobody issued", async () => {
        const {calls, run} = harness();

        const res = await run(fakeReq(`Bearer ${generateToken()}`));

        assert.equal(res.statusCode, 401);
        assert.equal(res.body.type, PASSWORD_REQUIRED);
        assert.equal(calls.next, 0);
        assert.equal(calls.fallback, 0, "a refused MySpeed token fell through to the password gate");
        assert.deepEqual(calls.touched, []);
    });

    // A browser never sends a msp_ token, so the refusal cannot start the
    // password prompt loop the node-refusal header exists to prevent - but
    // the message has to say what was refused, since the type is shared.
    it("names the token in the refusal", async () => {
        const {run} = harness();

        const res = await run(fakeReq(`Bearer ${generateToken()}`));

        assert.match(res.body.message, /token/i);
    });

    it("refuses a token issued for another scope", async () => {
        const {token, calls, run} = harness({scope: "later"});

        const res = await run(fakeReq(`Bearer ${token}`));

        assert.equal(res.statusCode, 401);
        assert.equal(calls.next, 0);
    });

    // A table that cannot be read is the server's fault, and answered as such
    // rather than as a refused credential.
    it("answers 503 when the table cannot be read", async () => {
        const {token, deps, run} = harness();
        deps.findByDigest = async () => { throw new Error("database is locked"); };

        const res = await run(fakeReq(`Bearer ${token}`));

        assert.equal(res.statusCode, 503);
        assert.equal(res.body.type, SERVER_BUSY);
        assert.equal(res.headers["Retry-After"], "1");
    });

    it("admits the request when only the last-used stamp failed", async () => {
        const {token, calls, deps, run} = harness();
        deps.touch = async () => { throw new Error("SQLITE_BUSY"); };

        const res = await run(fakeReq(`Bearer ${token}`));

        assert.equal(calls.next, 1);
        assert.equal(res.body, null);
    });

    // A demo admits everyone through the password gate, which is what makes
    // the run button work there; a token is beside the point.
    it("leaves a demo to the password gate", async () => {
        const {token, calls, run} = harness({preview: true});

        await run(fakeReq(`Bearer ${token}`));

        assert.equal(calls.fallback, 1);
        assert.equal(calls.touched.length, 0);
    });

    it("never leaks the token into the request it admits", async () => {
        const {token, run} = harness();
        const req = fakeReq(`Bearer ${token}`);

        await run(req);

        assert.equal(JSON.stringify(req.apiToken).includes(token), false);
    });
});
