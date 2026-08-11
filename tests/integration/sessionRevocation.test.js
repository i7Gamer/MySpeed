import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { bootServer, api, setConfig } from "./helpers/boot.js";

let server;

const OWNER_PASSWORD = "Hunter2!";

before(async () => {
    server = await bootServer();
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    await setConfig(server.config, "password", "none");
});

const EMPTY_TABLES = {nodes: [], integrations: [], recommendations: []};

/** Signs in the way the browser does and returns the session cookie to send back. */
const signIn = async (password = OWNER_PASSWORD) => {
    const {status, headers} = await api(server.baseUrl, "/session", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({password})
    });

    assert.equal(status, 200, "sign-in was refused");

    return headers.get("set-cookie").split(";")[0];
};

/** Whether the server still honours a cookie. The endpoint answers unauthenticated. */
const sessionActive = async (cookie) =>
    (await api(server.baseUrl, "/session", {headers: {cookie}})).body.active;

const importConfig = (payload, cookie) => api(server.baseUrl, "/storage/config", {
    method: "PUT",
    headers: {"content-type": "application/json", cookie},
    body: JSON.stringify(payload)
});

const exportConfig = (cookie) =>
    api(server.baseUrl, "/storage/config?includeSecrets=true", {headers: {cookie}});

/**
 * Every route that can change the stored password has to revoke the sessions
 * issued against the old one.
 *
 * The client no longer keeps the password - it holds a session cookie the
 * server can take back - and the whole value of that is lost if a route changes
 * the credential without taking the old sessions with it. The password
 * middleware accepts a valid session *before* it ever reads the stored hash, so
 * a surviving cookie keeps full access for the rest of its seven days no matter
 * what the password column now says.
 *
 * The backup restore is the one that matters most: restoring a known-good
 * backup is exactly what an operator does to remediate a compromise, so it is
 * the path where a surviving session does the most damage.
 */
describe("changing the password revokes existing sessions", () => {
    it("through the config route", async () => {
        await setConfig(server.config, "password", OWNER_PASSWORD);
        const cookie = await signIn();
        assert.equal(await sessionActive(cookie), true, "the fresh session was not usable");

        await setConfig(server.config, "password", "Different1!");

        assert.equal(await sessionActive(cookie), false);
    });

    it("through a restored backup that carries one", async () => {
        await setConfig(server.config, "password", OWNER_PASSWORD);
        const cookie = await signIn();

        const {body: backup} = await exportConfig(cookie);
        assert.ok(backup.config.password, "the full export carries no password to restore");

        assert.equal((await importConfig(backup, cookie)).status, 200);

        assert.equal(await sessionActive(cookie), false);
    });

    // The other half of the rule: an import that says nothing about the
    // password must not sign the operator out of the tab they are working in.
    it("but a restore that carries no password leaves the session alone", async () => {
        await setConfig(server.config, "password", OWNER_PASSWORD);
        const cookie = await signIn();

        const {status} = await importConfig({config: {retentionDays: "30"}, ...EMPTY_TABLES}, cookie);
        assert.equal(status, 200);

        assert.equal(await sessionActive(cookie), true);
    });
});

/**
 * Read rather than exercised, deliberately.
 *
 * factoryReset ends by firing requestInterfaces() without awaiting it, which
 * probes speed.cloudflare.com once per non-internal address with a five second
 * timeout each. Calling it from a test drags the real network into the suite
 * and leaves the sweep running after the assertions are done - the runner then
 * waits on it rather than exiting. The revocation itself is one call at the top
 * of the function, and this is enough to keep it there.
 */
describe("a factory reset revokes existing sessions", () => {
    it("calls destroyAllSessions", () => {
        const source = fs.readFileSync(
            fileURLToPath(new URL("../../server/controller/config.js", import.meta.url)), "utf8");

        const factoryReset = source.slice(source.indexOf("export const factoryReset"));

        assert.match(factoryReset, /destroyAllSessions\(\)/,
            "a reset clears the password but leaves every session holding full access");
    });
});
