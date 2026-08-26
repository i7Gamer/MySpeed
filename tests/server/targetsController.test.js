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
