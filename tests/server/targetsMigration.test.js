import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { legacyTarget } from "../../server/migrations/0013-add-targets.js";

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
