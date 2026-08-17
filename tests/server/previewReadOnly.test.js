import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import previewReadOnly from "../../server/middlewares/previewReadOnly.js";

/**
 * What a visitor to a public demo is allowed to change, which is nothing that
 * outlives their visit.
 *
 * In preview mode the password middleware waves every request through - there
 * is no password on a demo and nobody to hold one - so the only thing standing
 * between an anonymous visitor and the whole admin API was a check written out
 * by hand on each route that remembered to. Two of them did not: DELETE
 * /api/storage/tests/history emptied the history and DELETE /api/storage/config
 * factory-reset the instance, both unauthenticated, both on an address whose
 * entire purpose is being handed to strangers. Their PUT siblings had the check;
 * the DELETEs beside them never did.
 *
 * A middleware rather than a fourteenth copy of the same `if`: the guard is the
 * kind that is only ever wrong by being forgotten.
 */
const request = (method = "DELETE") => ({method});

const response = () => {
    const res = {statusCode: null, body: null};
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
};

const run = (req) => {
    const res = response();
    let passedThrough = false;

    previewReadOnly(req, res, () => { passedThrough = true; });
    return {res, passedThrough};
};

afterEach(() => {
    delete process.env.PREVIEW_MODE;
});

describe("previewReadOnly", () => {
    describe("on an ordinary instance", () => {
        it("lets every method through", () => {
            for (const method of ["GET", "PUT", "PATCH", "POST", "DELETE"])
                assert.equal(run(request(method)).passedThrough, true, `${method} was refused`);
        });

        // "false", unset, or anything that is not the exact opt-in string. An
        // instance is not a demo by accident.
        it("is not switched on by a stray value", () => {
            process.env.PREVIEW_MODE = "false";
            assert.equal(run(request()).passedThrough, true);

            process.env.PREVIEW_MODE = "1";
            assert.equal(run(request()).passedThrough, true);
        });
    });

    describe("on a demo instance", () => {
        afterEach(() => { delete process.env.PREVIEW_MODE; });

        it("refuses the request rather than performing it", () => {
            process.env.PREVIEW_MODE = "true";

            const {res, passedThrough} = run(request());

            assert.equal(passedThrough, false, "the route ran anyway");
            assert.equal(res.statusCode, 403);
        });

        it("says why, in a sentence a visitor can read", () => {
            process.env.PREVIEW_MODE = "true";

            assert.match(run(request()).res.body.message, /preview mode/i);
        });

        it("refuses every method it is applied to", () => {
            process.env.PREVIEW_MODE = "true";

            for (const method of ["DELETE", "PATCH", "PUT", "POST"])
                assert.equal(run(request(method)).passedThrough, false, `${method} got through`);
        });

        /**
         * Read is the whole point of a demo, and this middleware is mounted per
         * route rather than globally - but a route that only reads has no reason
         * to carry it, so a GET reaching it at all is a mounting mistake worth
         * not compounding.
         */
        it("still allows a read", () => {
            process.env.PREVIEW_MODE = "true";

            assert.equal(run(request("GET")).passedThrough, true);
            assert.equal(run(request("HEAD")).passedThrough, true);
        });
    });

    // Read per request, not once at import: the tests set it, and so does a
    // container that is configured after the module graph is built.
    it("reads the setting per request", () => {
        assert.equal(run(request()).passedThrough, true);

        process.env.PREVIEW_MODE = "true";
        assert.equal(run(request()).passedThrough, false, "the setting was captured at import");
    });
});

/**
 * And every route that destroys something carries it.
 *
 * The two that did not were the two the guard was never written on by hand,
 * which is the failure this list exists to make loud.
 */
describe("nothing destructive is left open on a demo", () => {
    const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
    const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

    /**
     * Every route that can change something, found rather than listed.
     *
     * This used to enumerate the routes that had been fixed, which is the same
     * failure mode as the hand-written `if` it replaced: it could only ever
     * re-assert what somebody had already remembered. It could not have caught
     * the two DELETEs the guard was written for, and it did not catch the node
     * proxy - `app.all`, which looks like nothing in particular and reaches
     * another machine with that machine's password attached.
     *
     * So the list is derived from the source: every mutating verb mounted in
     * server/routes, minus the one deliberate exemption below.
     */
    const MUTATING_ROUTE = /^app\.(post|put|patch|delete|all)\((?:\s*)(["'`])(.*?)\2/gm;

    /**
     * The deliberate exemptions, each for a stated reason.
     *
     * Running a test is what a demo exists to demonstrate - preview mode has a
     * whole branch in tasks/speedtest.js that answers it with a plausible
     * generated result. The session routes authenticate a caller rather than
     * change the instance: they add and remove an entry in a bounded in-memory
     * map and touch nothing a visitor could destroy, and preview mode waves
     * authentication through regardless, so refusing them would be theatre.
     */
    const ALLOWED = [
        {file: "server/routes/speedtests.js", route: "/run"},
        {file: "server/routes/session.js", route: "/"}
    ];

    const routeFiles = fs.readdirSync(path.join(root, "server", "routes"))
        .filter((name) => name.endsWith(".js"))
        .map((name) => `server/routes/${name}`);

    const GUARDED = routeFiles.flatMap((file) => {
        const source = read(file);

        return [...source.matchAll(MUTATING_ROUTE)]
            .map(([match, , , route]) => ({file, route, at: source.indexOf(match)}))
            .filter(({route}) => !ALLOWED.some((allowed) => allowed.file === file && allowed.route === route));
    });

    it("finds the mutating routes to check", () => {
        // A guard against the scan itself silently matching nothing - which
        // would make every assertion below vacuous.
        assert.ok(GUARDED.length >= 12, `only ${GUARDED.length} mutating routes were found`);
        assert.ok(GUARDED.some(({file}) => file.endsWith("nodes.js")),
            "the node routes were not scanned");
    });

    /**
     * The one mutation a demo is meant to allow.
     *
     * Preview mode has a whole branch in tasks/speedtest.js that answers a run
     * with a plausible generated result, so pressing the button is the thing
     * visitors come for. Read-only would be the simpler rule and the wrong one.
     */
    it("still lets a visitor run a test", () => {
        const source = read("server/routes/speedtests.js");
        const at = source.indexOf('app.post("/run"');

        assert.notEqual(at, -1, "the run route is gone");
        assert.doesNotMatch(source.slice(at, source.indexOf("=>", at)), /previewReadOnly/,
            "running a test is what preview mode exists to demonstrate");
    });

    for (const {file, route, at} of GUARDED) {
        it(`${route} in ${path.basename(file)} is guarded`, () => {
            const source = read(file);

            // The middleware list, up to the handler - a guard placed after the
            // work has been done is not a guard. Handlers here are arrow
            // functions, so the first `=>` after the mount ends the list.
            const declaration = source.slice(at, source.indexOf("=>", at));

            assert.match(declaration, /previewReadOnly/,
                `${route} in ${file} can be called by any visitor to a demo instance`);
        });
    }
});

/**
 * The routes a demo must not reach at all, not even to read.
 *
 * previewReadOnly lets GET through on purpose - reading is what a demo is for.
 * That is the right rule for the instance's own data and the wrong one for the
 * node proxy, which reaches a *different machine* and substitutes that
 * machine's stored password on the way. A read there is not a read of the demo;
 * it is an authenticated read of somebody's other server, and it walks straight
 * past every redaction the demo applies to its own routes.
 */
describe("previewReadOnly.blocking", () => {
    const blocked = (method) => {
        const res = response();
        let passedThrough = false;

        previewReadOnly.blocking("no nodes on a demo")(request(method), res, () => { passedThrough = true; });
        return {res, passedThrough};
    };

    it("refuses a read as well as a write on a demo", () => {
        process.env.PREVIEW_MODE = "true";

        for (const method of ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]) {
            const {res, passedThrough} = blocked(method);

            assert.equal(passedThrough, false, `${method} reached the route on a demo`);
            assert.equal(res.statusCode, 403);
        }
    });

    it("carries the wording it was given", () => {
        process.env.PREVIEW_MODE = "true";

        assert.equal(blocked("GET").res.body.message, "no nodes on a demo");
    });

    it("leaves an ordinary instance alone", () => {
        for (const method of ["GET", "PUT", "DELETE"])
            assert.equal(blocked(method).passedThrough, true, `${method} was refused off a demo`);
    });

    it("reads the setting per request", () => {
        assert.equal(blocked("GET").passedThrough, true);

        process.env.PREVIEW_MODE = "true";
        assert.equal(blocked("GET").passedThrough, false, "the setting was captured at import");
    });
});

/**
 * And the proxy carries it.
 *
 * A source-shape check for the same reason the scan above is one: this guard is
 * only ever wrong by being forgotten, and the route it guards is an `app.all`
 * that looks like nothing in particular.
 */
describe("the node proxy is sealed on a demo", () => {
    const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
    const source = fs.readFileSync(path.join(root, "server/routes/nodes.js"), "utf8");

    const declarationOf = (mount) => {
        const at = source.indexOf(mount);
        assert.notEqual(at, -1, `${mount} is gone from server/routes/nodes.js`);

        return source.slice(at, source.indexOf("=>", at));
    };

    it("refuses the proxy whatever the method", () => {
        assert.match(declarationOf('app.all("/:nodeId/*route"'), /previewReadOnly\.blocking/,
            "a demo visitor can read another machine with that machine's password");
    });

    // The listing is answered rather than refused - see the route - so it must
    // not carry the blocking guard, which would 403 the client's own poll.
    it("still lets the listing route answer", () => {
        assert.doesNotMatch(declarationOf('app.get("/", password(false)'), /previewReadOnly\.blocking/);
    });
});
