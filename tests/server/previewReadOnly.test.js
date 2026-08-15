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

    const GUARDED = [
        {file: "server/routes/storage.js", route: 'app.delete("/tests/history"'},
        {file: "server/routes/storage.js", route: 'app.delete("/config"'},
        {file: "server/routes/storage.js", route: 'app.put("/tests/history"'},
        {file: "server/routes/storage.js", route: 'app.put("/config"'},
        {file: "server/routes/speedtests.js", route: 'app.delete("/:id"'},
        {file: "server/routes/config.js", route: 'app.patch("/:key"'},
        {file: "server/routes/config.js", route: 'app.delete("/password"'},
        // The schedule is shared by everyone looking at the demo, so one visitor
        // pausing it stops the tests for every other visitor - and leaves it
        // stopped, since nothing resumes it on their behalf.
        {file: "server/routes/speedtests.js", route: 'app.post("/pause"'},
        {file: "server/routes/speedtests.js", route: 'app.post("/continue"'}
    ];

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

    for (const {file, route} of GUARDED) {
        it(`${route.replace(/app\.|\("|"$/g, " ").trim()} in ${path.basename(file)} is guarded`, () => {
            const source = read(file);
            const at = source.indexOf(route);

            assert.notEqual(at, -1, `${route} is no longer a route in ${file}`);

            // The middleware list, up to the handler - a guard placed after the
            // work has been done is not a guard.
            const declaration = source.slice(at, source.indexOf("=>", at));

            assert.match(declaration, /previewReadOnly/,
                `${route} in ${file} can be called by any visitor to a demo instance`);
        });
    }
});
