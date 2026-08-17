import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import previewReadOnly from "../../server/middlewares/previewReadOnly.js";
import { listSources, mountText, readSource } from "../helpers/source.js";

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

    const routeFiles = listSources("server/routes").map((name) => `server/routes/${name}`);

    const GUARDED = routeFiles.flatMap((file) => {
        const source = readSource(file);

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
        const source = readSource("server/routes/speedtests.js");
        const at = source.indexOf('app.post("/run"');

        assert.notEqual(at, -1, "the run route is gone");
        assert.doesNotMatch(mountText(source, at), /previewReadOnly/,
            "running a test is what preview mode exists to demonstrate");
    });

    for (const {file, route, at} of GUARDED) {
        it(`${route} in ${file.split("/").pop()} is guarded`, () => {
            const source = readSource(file);

            // The middleware list, up to the handler - a guard placed after
            // the work has been done is not a guard. Bounded at the next mount
            // before it is trimmed at the handler, so a route with no arrow of
            // its own cannot be handed the following route's guard.
            const declaration = mountText(source, at);

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
    const source = readSource("server/routes/nodes.js");

    const declarationOf = (mount) => {
        const at = source.indexOf(mount);
        assert.notEqual(at, -1, `${mount} is gone from server/routes/nodes.js`);

        return mountText(source, at);
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

    /**
     * And it decides that through the shared predicate.
     *
     * A hand-written `process.env.PREVIEW_MODE === "true"` in the handler is
     * the very shape previewReadOnly was written to replace, and this file's
     * own history is the argument: the two routes that were missed were the two
     * nobody remembered to copy the check onto. A copy here would also be
     * invisible to the scan below, which only walks the mutating verbs.
     */
    it("decides the listing through the shared predicate", () => {
        const listing = source.slice(source.indexOf('app.get("/", password(false)'),
            source.indexOf('app.put("/"'));

        assert.doesNotMatch(listing, /process\.env/,
            "the guard is written out by hand again, where nothing scans for it");
        assert.match(listing, /isUntrustedReader/);
    });
});

/**
 * And every read route has decided what a demo may have.
 *
 * The mutating routes have been held to their guard by the scan above since two
 * of them were found open. The reads had nothing of the kind, and the count is
 * the argument for giving them one: preview mode admits every caller, so full
 * disclosure is the default and each route has to opt out by hand. GET /config,
 * /integrations/active and four speedtest routes were fixed, then the node
 * listing and the node proxy - and GET /storage/config was still answering an
 * anonymous visitor with the admin password hash, every node password and every
 * integration credential, with the two history downloads and the adapter list
 * beside it.
 *
 * A runtime allowlist would have been the wrong shape: a demo is a working
 * dashboard, so most of these must answer, several of them redacted rather than
 * refused, and a blanket rule would either break the demo or say nothing. What
 * was missing is not a rule but a decision per route - so this asserts the
 * decision exists. A new `app.get` fails here until it is written down.
 *
 * The redactions themselves are held by tests/integration/previewDisclosure.
 * This is only about there being an answer at all.
 */
describe("every read route decides what a demo may have", () => {
    /**
     * Served on a demo. Some in full, some redacted - the note says which, and
     * previewDisclosure holds the redaction.
     */
    const READABLE = {
        "config.js /": "the dashboard's own settings, with the operator's keys withheld",
        "health.js /": "liveness, which says nothing about the instance",
        "integrations.js /": "the registry of integration types, not anybody's rows",
        "integrations.js /active": "the configured rows, with their credentials blanked",
        "nodes.js /": "answers empty on a demo",
        "opengraph.js /image": "the measurements as a picture, which is the demo's point",
        "prometheus.js /metrics": "the measurements again, and the same server labels a viewer sees",
        "recommendations.js /": "the target values the dashboard grades against",
        "session.js /": "whether this caller holds a session, which is about them",
        "speedtests.js /": "the history, with the connection identity stripped",
        "speedtests.js /statistics": "aggregates, which carry no identity to strip",
        "speedtests.js /export": "the redacted way to take the measurements away",
        "speedtests.js /status": "the latest test, stripped, and no countdown",
        "speedtests.js /:id": "one test, stripped",
        "storage.js /": "how much disk the database uses",
        "system.js /version": "the running version, which the footer shows",
        "system.js /server/:provider": "the public server lists, which are the provider's"
    };

    /** Refused on a demo, and each must carry the guard that refuses it. */
    const SEALED = {
        "nodes.js /:nodeId/*route": "reaches another machine with that machine's password attached",
        "storage.js /config": "the full export: the password hash, node passwords and every credential",
        "storage.js /tests/history/json": "the raw history, which /speedtests/export serves redacted",
        "storage.js /tests/history/csv": "the same rows in the other format",
        "system.js /interfaces": "the adapter names GET /config withholds one of"
    };

    /**
     * `all` as well as `get`. An app.all route answers a GET, and it satisfies
     * the mutating scan above by carrying plain previewReadOnly - which lets
     * reads straight through. That is the node proxy exactly: it reached
     * another machine with that machine's password attached, and took three
     * passes to find because a read there does not look like a read. A scan
     * written to stop that recurring has to be able to see the verb it
     * happened on.
     */
    const MOUNT = /^app\.(get|all)\(\s*(["'`])(.*?)\2/gm;

    /**
     * A guard two routes share is bound to a name first, so that one refusal
     * is worded once. The scan resolves that one level rather than pushing the
     * routes into repeating themselves to be seen.
     */
    const GUARD = /previewReadOnly\.blocking/;
    const NAMED_GUARD = /const\s+(\w+)\s*=\s*previewReadOnly\.blocking/g;

    const found = listSources("server/routes")
        .flatMap((name) => {
            const source = readSource(`server/routes/${name}`);
            const named = [...source.matchAll(NAMED_GUARD)].map(([, binding]) => binding);

            return [...source.matchAll(MOUNT)].map(([match, , , route]) => {
                const declaration = mountText(source, source.indexOf(match));

                return {
                    key: `${name} ${route}`,
                    guarded: GUARD.test(declaration)
                        || named.some((binding) => new RegExp(`\\b${binding}\\b`).test(declaration))
                };
            });
        });

    it("finds the read routes to check", () => {
        // Against the scan silently matching nothing, which would make every
        // assertion below vacuous.
        assert.ok(found.length >= 18, `only ${found.length} read routes were found`);
    });

    it("has an answer for every one of them", () => {
        const unclassified = found
            .map(({key}) => key)
            .filter((key) => !Object.hasOwn(READABLE, key) && !Object.hasOwn(SEALED, key));

        assert.deepEqual(unclassified, [],
            "a read route was added without deciding what a demo visitor may have from it");
    });

    it("does not answer twice for any of them", () => {
        const both = Object.keys(SEALED).filter((key) => Object.hasOwn(READABLE, key));

        assert.deepEqual(both, [], "these two lists disagree");
    });

    // The lists cannot describe routes that are gone, or they go stale as
    // quietly as the guard they replace.
    it("describes only routes that exist", () => {
        const keys = new Set(found.map(({key}) => key));
        const missing = [...Object.keys(READABLE), ...Object.keys(SEALED)]
            .filter((key) => !keys.has(key));

        assert.deepEqual(missing, [], "these entries name routes that are no longer mounted");
    });

    for (const [key, why] of Object.entries(SEALED))
        it(`${key} is sealed on a demo - ${why}`, () => {
            const route = found.find((entry) => entry.key === key);

            assert.equal(route.guarded, true, `${key} is listed as sealed and carries no guard`);
        });

    for (const key of Object.keys(READABLE))
        it(`${key} still answers on a demo`, () => {
            const route = found.find((entry) => entry.key === key);

            assert.equal(route.guarded, false, `${key} is listed as readable and is sealed`);
        });
});
