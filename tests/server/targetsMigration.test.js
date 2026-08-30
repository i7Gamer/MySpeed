import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { legacyTarget, seedTarget } from "../../server/migrations/0013-add-targets.js";
import { targetProblem } from "../../server/controller/targets.js";

/**
 * The fold from the four legacy config keys to the seeded first target.
 *
 * The migration's idempotence rides on this answering null once the keys are
 * gone, and the seeded row is the operator's whole existing setup - a wrong
 * fold here silently changes what an upgraded instance measures.
 */
describe("legacyTarget", () => {
    it("folds an ookla choice with a pinned server", () => {
        const target = legacyTarget({provider: "ookla", ooklaId: "1234", libreId: "none", libreUrl: "none"});

        assert.equal(target.name, "Ookla");
        assert.equal(target.provider, "ookla");
        assert.equal(target.serverId, "1234");
        assert.equal(target.endpoint, null);
        assert.equal(target.enabled, true);
        assert.equal(target.alerts, true);
        assert.equal(target.sortOrder, 0);
    });

    it("reads the automatic-server sentinel as no pin", () => {
        assert.equal(legacyTarget({provider: "ookla", ooklaId: "none"}).serverId, null);
    });

    it("folds a libre choice with a custom backend", () => {
        const target = legacyTarget({provider: "libre", libreId: "none", libreUrl: "https://speed.example.net"});

        assert.equal(target.provider, "libre");
        assert.equal(target.endpoint, "https://speed.example.net");
        assert.equal(target.serverId, null);
    });

    it("keeps a libre server id when one was pinned", () => {
        assert.equal(legacyTarget({provider: "libre", libreId: "7"}).serverId, "7");
    });

    it("folds cloudflare with neither id nor endpoint", () => {
        const target = legacyTarget({provider: "cloudflare"});

        assert.equal(target.name, "Cloudflare");
        assert.equal(target.serverId, null);
        assert.equal(target.endpoint, null);
    });

    it("answers null when no provider was ever chosen", () => {
        assert.equal(legacyTarget({provider: "none"}), null);
        assert.equal(legacyTarget({}), null);
    });

    it("answers null on a second run, when the seed already removed the keys", () => {
        assert.equal(legacyTarget({ooklaId: "1234"}), null);
    });

    it("stamps an ISO created instant", () => {
        assert.match(legacyTarget({provider: "cloudflare"}).created, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    });
});

/**
 * And what the migration is allowed to write, which is not the same question.
 *
 * The seeded row outlives the upgrade and is re-judged whole by targetProblem
 * on every later PATCH - the dialog's scheduled switch sends {enabled} by
 * itself - so a row folded verbatim out of a config that only an older,
 * looser validator accepted is a target nothing can edit and nothing can run.
 *
 * That up() writes *this* fold rather than legacyTarget's is asserted where it
 * can be seen happening, against a real database, in
 * tests/integration/migrations.test.js.
 */
describe("seedTarget", () => {
    const accepted = (values) => {
        const seed = seedTarget(values);

        assert.notEqual(seed, null, "the fold answered null");

        const problem = targetProblem(seed);
        assert.equal(problem, null, `the migration would seed a row the API refuses: ${problem}`);

        return seed;
    };

    it("keeps a backend URL the server can actually fetch", () => {
        assert.equal(accepted({provider: "libre", libreUrl: "https://speed.example.net"}).endpoint,
            "https://speed.example.net");
    });

    // The exact shape older versions stored behind a 200: `new URL()` reads it
    // as scheme "localhost:", so the bare-parse check let it through.
    it("drops a scheme-less backend URL rather than seeding an uneditable row", () => {
        assert.equal(accepted({provider: "libre", libreUrl: "localhost:8080"}).endpoint, null);
    });

    for (const libreUrl of ["speed.lan:8080/backend", "nas:3000", "file:///etc/passwd",
        "javascript:alert(1)", "not a url"])
        it(`drops ${libreUrl}`, () => {
            assert.equal(accepted({provider: "libre", libreUrl}).endpoint, null);
        });

    it("drops a server id that is not digits", () => {
        assert.equal(accepted({provider: "ookla", ooklaId: "de-frankfurt"}).serverId, null);
    });

    // Never withheld over a bad value: the insert is what the history's
    // back-fill hangs off, so "no row" would be the more expensive answer.
    it("still seeds a row when every stored address was unreadable", () => {
        assert.notEqual(seedTarget({provider: "libre", libreId: "x", libreUrl: "nas:3000"}), null);
    });

    it("still folds nothing when no provider was ever chosen", () => {
        assert.equal(seedTarget({provider: "none"}), null);
        assert.equal(seedTarget({}), null);
    });

    /**
     * The tripwire for the drift the migration deliberately cannot see. It
     * judges the endpoint by ALLOWED_PROTOCOLS and the id by a pattern of its
     * own rather than importing targetProblem, so that what an upgrade does
     * stays fixed in that file. The price is that a new rule in targetProblem
     * about a field the fold sets would go unnoticed - here, and only here.
     */
    it("seeds a row the current API accepts, for every legacy config", () => {
        for (const values of [
            {provider: "ookla", ooklaId: "1234", libreId: "none", libreUrl: "none"},
            {provider: "ookla", ooklaId: "none"},
            {provider: "libre", libreId: "7", libreUrl: "none"},
            {provider: "libre", libreId: "none", libreUrl: "http://speed.lan:8080"},
            {provider: "libre", libreId: "none", libreUrl: "localhost:8080"},
            {provider: "cloudflare"}
        ])
            assert.equal(targetProblem(seedTarget(values)), null,
                `seeded a row the API refuses for ${JSON.stringify(values)}`);
    });
});
