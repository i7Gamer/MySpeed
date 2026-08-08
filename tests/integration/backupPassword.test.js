import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, setConfig } from "./helpers/boot.js";

let server;

const OWNER_PASSWORD = "hunter2";
const withPassword = (value) => ({headers: {"x-password": value}});

before(async () => {
    server = await bootServer();
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    await setConfig(server.config, "password", "none");
    await setConfig(server.config, "passwordLevel", "none");
});

const exportConfig = (query = "") => api(server.baseUrl, `/storage/config${query}`, withPassword(OWNER_PASSWORD));

const importConfig = (payload) => api(server.baseUrl, "/storage/config", {
    method: "PUT",
    headers: {"content-type": "application/json", "x-password": OWNER_PASSWORD},
    body: JSON.stringify(payload)
});

/** True when the instance refuses an unauthenticated read. */
const isProtected = async () => (await api(server.baseUrl, "/speedtests?limit=1")).status === 401;

describe("the admin password in a config backup", () => {
    it("is absent from a redacted export", async () => {
        await setConfig(server.config, "password", OWNER_PASSWORD);

        const {body, text} = await exportConfig();

        assert.equal(body.config.password, undefined);
        assert.equal(body.secretsRedacted, true);
        assert.doesNotMatch(text, /\$2[aby]\$/, "no hash may appear in a redacted export");
    });

    it("is carried by a full export, as a hash and never in clear", async () => {
        await setConfig(server.config, "password", OWNER_PASSWORD);

        const {body, text} = await exportConfig("?includeSecrets=true");

        assert.match(body.config.password, /^\$2[aby]\$/);
        assert.doesNotMatch(text, new RegExp(OWNER_PASSWORD));
    });

    /**
     * The point of the whole exercise: a restore used to bring the instance back
     * unprotected, because the export dropped the password and the import
     * skipped the key. That is the one difference from the original state
     * nobody thinks to check after a restore.
     */
    it("comes back on restore, and the original password still works", async () => {
        await setConfig(server.config, "password", OWNER_PASSWORD);
        const {body: backup} = await exportConfig("?includeSecrets=true");

        await setConfig(server.config, "password", "none");
        assert.equal(await isProtected(), false);

        assert.equal((await importConfig(backup)).status, 200);

        assert.equal(await isProtected(), true, "the restore left the instance open");
        assert.equal((await api(server.baseUrl, "/speedtests?limit=1", withPassword(OWNER_PASSWORD))).status, 200);
    });

    // The hash must go back exactly as it was: hashing it a second time would
    // leave a value that no password on earth compares equal to.
    it("does not re-hash the stored hash", async () => {
        await setConfig(server.config, "password", OWNER_PASSWORD);
        const {body: backup} = await exportConfig("?includeSecrets=true");

        await importConfig(backup);

        assert.equal(await server.config.getValue("password"), backup.config.password);
    });

    it("restores the unprotected state faithfully too", async () => {
        const {body: backup} = await exportConfig("?includeSecrets=true");
        assert.equal(backup.config.password, "none");

        await setConfig(server.config, "password", OWNER_PASSWORD);
        assert.equal((await importConfig(backup)).status, 200);

        assert.equal(await isProtected(), false);
    });

    it("leaves the current password alone when restoring a redacted export", async () => {
        await setConfig(server.config, "password", OWNER_PASSWORD);
        const {body: redacted} = await exportConfig();
        const before = await server.config.getValue("password");

        assert.equal((await importConfig(redacted)).status, 200);

        assert.equal(await server.config.getValue("password"), before);
        assert.equal(await isProtected(), true);
    });

    /**
     * A hand-edited backup carrying a plaintext password would be written
     * straight into the column password.js compares against, and bcrypt never
     * matches a malformed hash - the owner would be locked out of their own
     * instance with no way back short of editing the database.
     */
    it("refuses a backup whose password is not a stored hash", async () => {
        await setConfig(server.config, "password", OWNER_PASSWORD);
        const {body: backup} = await exportConfig("?includeSecrets=true");
        const before = await server.config.getValue("password");

        for (const planted of ["hunter2", "", "$2a$notahash", null, 12345]) {
            const {status} = await importConfig({...backup, config: {...backup.config, password: planted}});

            assert.equal(status, 500, `accepted ${JSON.stringify(planted)}`);
            assert.equal(await server.config.getValue("password"), before);
        }

        assert.equal((await api(server.baseUrl, "/speedtests?limit=1", withPassword(OWNER_PASSWORD))).status, 200);
    });

    // The export is machine-independent apart from this: an adapter name from
    // another host would be rejected and fail the whole import.
    it("never carries the network interface", async () => {
        const {body} = await exportConfig("?includeSecrets=true");
        assert.equal(body.config.interface, undefined);
    });
});
