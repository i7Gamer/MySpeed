import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { targetProblem, resolveLimits, viewerFacing, TARGET_NAME_LIMIT }
    from "../../server/controller/targets.js";

/**
 * The judgement half of the targets controller, kept pure so it can be read
 * and tested without a database: what a valid target is, what a viewer may
 * see of one, and which optimal values govern a target's runs.
 */
describe("targetProblem", () => {
    const valid = {name: "Frankfurt", provider: "ookla", serverId: "1234", endpoint: null};

    it("accepts a well-formed target", () => {
        assert.equal(targetProblem(valid), null);
    });

    it("requires a name that is not blank", () => {
        assert.match(targetProblem({...valid, name: "  "}), /name/i);
        assert.match(targetProblem({...valid, name: undefined}), /name/i);
    });

    it("bounds the name so a paragraph cannot become a label", () => {
        assert.equal(targetProblem({...valid, name: "x".repeat(TARGET_NAME_LIMIT)}), null);
        assert.match(targetProblem({...valid, name: "x".repeat(TARGET_NAME_LIMIT + 1)}), /name/i);
    });

    it("refuses a provider the registry does not know", () => {
        assert.match(targetProblem({...valid, provider: "iperf3"}), /provider/i);
        assert.match(targetProblem({...valid, provider: "none"}), /provider/i);
    });

    it("requires server ids to be digits", () => {
        assert.match(targetProblem({...valid, serverId: "12a4"}), /server/i);
        assert.equal(targetProblem({...valid, serverId: null}), null);
    });

    it("holds a libre endpoint to the allowed protocols", () => {
        const libre = {...valid, provider: "libre", serverId: null};

        assert.equal(targetProblem({...libre, endpoint: "https://speed.example.net"}), null);
        assert.equal(targetProblem({...libre, endpoint: null}), null);
        assert.match(targetProblem({...libre, endpoint: "ftp://speed.example.net"}), /URL|protocol/i);
        assert.match(targetProblem({...libre, endpoint: "not a url"}), /URL/i);
    });

    it("refuses an endpoint on a provider that takes none", () => {
        assert.match(targetProblem({...valid, endpoint: "https://x.example"}), /endpoint/i);
        assert.match(targetProblem({...valid, provider: "cloudflare", serverId: null,
            endpoint: "https://x.example"}), /endpoint/i);
    });

    it("refuses a cloudflare server id, which has nowhere to go", () => {
        assert.match(targetProblem({...valid, provider: "cloudflare", serverId: "5"}), /server/i);
    });

    it("holds the optimal overrides to positive numbers or null", () => {
        assert.equal(targetProblem({...valid, optimalPing: 25, optimalDownload: 940.5}), null);
        assert.match(targetProblem({...valid, optimalPing: -1}), /optimal/i);
        assert.match(targetProblem({...valid, optimalDownload: "fast"}), /optimal/i);
        assert.match(targetProblem({...valid, optimalUpload: 0}), /optimal/i);
    });

    /**
     * Every plain object answers `"toString" in it`, and the registry is a
     * plain object. So the names on Object.prototype passed the guard that
     * exists to refuse a provider nobody implements: the target was created
     * with a 200, joined every scheduled round, and each run failed reporting a
     * binary called `./bin/undefined` - because `REGISTRY["toString"]` is a
     * native function, and the `if (!entry)` guard in descriptor() reads it as
     * a provider that exists.
     *
     * Reachable through the import path as well as the route: importConfig runs
     * every restored row through this same function, and its own comment says a
     * backup must not be a way past it.
     */
    it("refuses a provider that exists only on Object.prototype", () => {
        for (const name of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"])
            assert.match(targetProblem({...valid, provider: name}), /provider/i,
                `${name} was accepted as a provider`);
    });

    // The same trap one line up: the rule about which providers may pin a
    // server reads the registry too, and a prototype name answered "yes, and it
    // takes a server id" - so the id was judged against a provider that is a
    // function.
    it("does not let a prototype name inherit a real provider's rules", () => {
        assert.match(targetProblem({...valid, provider: "toString", serverId: "1234"}), /provider/i);
    });

    /**
     * `enabled` and `alerts` were the only two writable fields nothing judged.
     * A non-boolean was stored verbatim in a BOOLEAN column - Sequelize coerces
     * only 'true'/'false' - where it read truthy everywhere JavaScript asked,
     * while roundTargets()'s `where: {enabled: true}` compares against SQL 1
     * and excluded it. The dialog drew the target as part of the round and the
     * round never ran it, with nothing in the log.
     *
     * Refused rather than coerced, unlike the import path's `Boolean(...)`:
     * `Boolean("false")` is true, which is a worse surprise than a 400.
     */
    it("holds the flags to real booleans", () => {
        assert.equal(targetProblem({...valid, enabled: true, alerts: false}), null);
        assert.equal(targetProblem({...valid, enabled: undefined, alerts: null}), null);

        assert.match(targetProblem({...valid, enabled: "yes"}), /enabled/i);
        assert.match(targetProblem({...valid, enabled: "false"}), /enabled/i);
        assert.match(targetProblem({...valid, enabled: "1"}), /enabled/i);
        assert.match(targetProblem({...valid, alerts: "true"}), /alerts/i);
        assert.match(targetProblem({...valid, alerts: 2}), /alerts/i);
        assert.match(targetProblem({...valid, alerts: {}}), /alerts/i);
    });

    /**
     * This function judges two shapes, and the flags are the only fields whose
     * representation differs between them: the fragment a request carried,
     * where a flag is a JSON boolean, and the row a PATCH would become - merged
     * from a raw database read, where SQLite's BOOLEAN is an integer.
     *
     * So 0 and 1 are as valid here as false and true. Refusing them refuses
     * every PATCH of an existing target, which is what the integration suite
     * caught: `{...current, ...fragment}` carries `enabled: 1` out of the
     * database for a target nobody had touched.
     */
    it("accepts the 0 and 1 the column comes back as", () => {
        assert.equal(targetProblem({...valid, enabled: 1, alerts: 1}), null);
        assert.equal(targetProblem({...valid, enabled: 0, alerts: 0}), null);
    });
});

describe("resolveLimits", () => {
    const global = {ping: "25", download: "100", upload: "50"};

    it("inherits the global values where a target sets none", () => {
        assert.deepEqual(resolveLimits({}, global), {ping: 25, download: 100, upload: 50});
    });

    it("lets a target's own values win, each on its own", () => {
        const limits = resolveLimits({optimalPing: 1, optimalDownload: 940}, global);

        assert.deepEqual(limits, {ping: 1, download: 940, upload: 50});
    });

    it("treats null overrides as unset rather than as zero", () => {
        assert.deepEqual(resolveLimits({optimalPing: null, optimalDownload: null, optimalUpload: null}, global),
            {ping: 25, download: 100, upload: 50});
    });
});

describe("viewerFacing", () => {
    it("keeps the name and provider and withholds the rest", () => {
        const row = {id: 3, name: "NAS", provider: "libre", serverId: "7",
            endpoint: "https://user:secret@speed.example.net", enabled: true, alerts: false,
            optimalPing: 1, optimalDownload: 940, optimalUpload: 940, sortOrder: 2, created: "x"};

        assert.deepEqual(viewerFacing(row), {
            id: 3, name: "NAS", provider: "libre", enabled: true, sortOrder: 2,
            optimalPing: 1, optimalDownload: 940, optimalUpload: 940
        });
    });
});
