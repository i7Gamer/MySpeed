import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api } from "./helpers/boot.js";

let server;

before(async () => {
    server = await bootServer();
});

after(async () => {
    await server?.close();
});

/**
 * Every member of Object.prototype is a truthy value on an object literal, so
 * a bare `integrations[name]` lookup answers one for a name no integration has.
 *
 * The 404 that should have ended the request was skipped, and validateInput's
 * `for (const field of integration.fields)` then threw on undefined - a 500
 * where a 400 or a 404 was owed. Admin-only and nothing is written, so this is
 * a wrong status code rather than prototype pollution; the config controller
 * had already fixed the identical trap with Object.hasOwn and named it in a
 * comment.
 */
const PROTOTYPE_NAMES = ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"];

describe("an integration named after an Object.prototype member", () => {
    for (const name of PROTOTYPE_NAMES) {
        it(`is not found rather than crashing: ${name}`, async () => {
            const {status} = await api(server.baseUrl, `/integrations/${encodeURIComponent(name)}`, {
                method: "PUT",
                headers: {"content-type": "application/json"},
                body: JSON.stringify({url: "https://hook.example"})
            });

            assert.equal(status, 404, `${name} did not answer 404`);
        });
    }

    it("never answers one of them with a 500", async () => {
        for (const name of PROTOTYPE_NAMES) {
            const {status} = await api(server.baseUrl, `/integrations/${encodeURIComponent(name)}`, {
                method: "PUT",
                headers: {"content-type": "application/json"},
                body: JSON.stringify({})
            });

            assert.notEqual(status, 500, name);
        }
    });

    // The same bare lookup sits in importConfig's integration handling, where
    // it decides which fields count as credentials.
    it("does not stop a config import that carries one", async () => {
        const {status} = await api(server.baseUrl, "/storage/config", {
            method: "PUT",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({
                config: {},
                nodes: [],
                recommendations: [],
                integrations: [{id: "planted", name: "toString", displayName: "Nope", data: {url: "x"}}]
            })
        });

        assert.notEqual(status, 500);
    });
});
