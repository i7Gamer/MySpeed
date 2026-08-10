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
 * The id every other integration route addresses the row by.
 *
 * It used to be Math.random().toString(36) - a dozen characters of
 * non-cryptographic randomness with no collision handling on a primary key.
 * crypto.randomUUID() costs the same line and cannot collide in practice.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("creating an integration", () => {
    it("hands back a collision-proof id", async () => {
        const {status, body} = await api(server.baseUrl, "/integrations/webhook", {
            method: "PUT",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({url: "https://hooks.example.invalid/myspeed", integration_name: "hook"})
        });

        assert.equal(status, 200);
        assert.match(String(body.id), UUID_V4, `"${body.id}" is not a UUID`);
    });

    it("stores the row under that id", async () => {
        const {body: active} = await api(server.baseUrl, "/integrations/active");

        assert.ok(active.some((row) => UUID_V4.test(row.id)), "no UUID-keyed row was stored");
    });
});
