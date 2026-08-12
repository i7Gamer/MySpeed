import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    renderableIntegrations
} from "../../client/src/common/components/IntegrationDialog/renderableIntegrations.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const dialog = fs.readFileSync(path.join(CLIENT_SRC,
    "common/components/IntegrationDialog/IntegrationDialog.jsx"), "utf8");

const DEFINITIONS = {
    discord: {name: "discord", fields: [{name: "url", type: "text", required: true}]},
    gotify: {name: "gotify", fields: []}
};

const row = (name, extra = {}) => ({uuid: `uuid-${name}`, id: name, name, data: {}, ...extra});

/**
 * A stored row whose integration no longer exists.
 *
 * The dialog looked its definition up by name and handed the result straight to
 * IntegrationCard, which reads `integrationDef.fields` inside a useState
 * initialiser - so an unknown name did not render a broken card, it threw
 * during render and took the whole integrations dialog with it. The only way
 * back was to delete the row from the database by hand, which is not something
 * the dialog it broke could be used to do.
 *
 * These rows are real: the server's own withoutSecrets() carries a comment
 * about "a stale row for an integration that has since been removed", so
 * removing an integration in an upgrade is a case the backend already knows it
 * has to survive.
 */
describe("renderableIntegrations", () => {
    it("keeps every row whose integration is still installed", () => {
        const active = [row("discord"), row("gotify")];

        assert.deepEqual(renderableIntegrations(active, DEFINITIONS), active);
    });

    it("drops a row for an integration that no longer exists", () => {
        const active = [row("discord"), row("myspace"), row("gotify")];
        const kept = renderableIntegrations(active, DEFINITIONS);

        assert.deepEqual(kept.map((item) => item.name), ["discord", "gotify"],
            "an unknown name reached IntegrationCard, which throws on it during render");
    });

    it("survives the definitions not having arrived yet", () => {
        assert.deepEqual(renderableIntegrations([row("discord")], undefined), []);
        assert.deepEqual(renderableIntegrations([row("discord")], null), []);
    });

    it("survives an empty or absent active list", () => {
        assert.deepEqual(renderableIntegrations([], DEFINITIONS), []);
        assert.deepEqual(renderableIntegrations(undefined, DEFINITIONS), []);
        assert.deepEqual(renderableIntegrations(null, DEFINITIONS), []);
    });

    it("drops a row with no name at all", () => {
        assert.deepEqual(renderableIntegrations([row(undefined), null], DEFINITIONS), []);
    });

    /**
     * `definitions["toString"]` answers with Object.prototype's, which is
     * truthy - so a plain lookup would keep a row named after a prototype
     * member and hand IntegrationCard a function to read `.fields` off. The
     * server's getIntegration() was fixed for exactly this trap; the client
     * reads the same names.
     */
    it("is not fooled by a name borrowed from Object.prototype", () => {
        const active = [row("toString"), row("constructor"), row("hasOwnProperty")];

        assert.deepEqual(renderableIntegrations(active, DEFINITIONS), []);
    });

    it("keeps the rows it returns intact", () => {
        const active = [row("discord", {displayName: "Alerts"})];

        assert.equal(renderableIntegrations(active, DEFINITIONS)[0].displayName, "Alerts");
    });
});

describe("the integrations dialog", () => {
    it("filters the list it renders", () => {
        assert.match(dialog, /renderableIntegrations/,
            "the dialog still maps over every stored row, including ones it cannot render");
    });
});
