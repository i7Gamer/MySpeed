import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, setConfig } from "./helpers/boot.js";

let server;

const OWNER_PASSWORD = "Hunter2!";
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

        for (const planted of ["Hunter2!", "", "$2a$notahash", null, 12345]) {
            const {status} = await importConfig({...backup, config: {...backup.config, password: planted}});

            assert.equal(status, 500, `accepted ${JSON.stringify(planted)}`);
            assert.equal(await server.config.getValue("password"), before);
        }

        assert.equal((await api(server.baseUrl, "/speedtests?limit=1", withPassword(OWNER_PASSWORD))).status, 200);
    });

    /**
     * A well-formed hash is not yet a usable one. The two digits after the
     * version are the cost, and each step doubles the work: this instance
     * writes 10, and a backup somebody else prepared can say 31, at which one
     * comparison runs for days. Every password guess from anyone would then
     * hold the only thread that long, and the owner's own password could never
     * be checked again - a lockout and a standing denial of service, restored
     * by the operator's own hand from a file that passed every other check.
     */
    describe("a backup whose hash names a cost", () => {
        const SALT_AND_DIGEST = "abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234";
        const hashAt = (cost) => `$2b$${String(cost).padStart(2, "0")}$${SALT_AND_DIGEST}`;

        const restore = async (planted) => {
            await setConfig(server.config, "password", OWNER_PASSWORD);
            const {body: backup} = await exportConfig("?includeSecrets=true");

            return importConfig({...backup, config: {...backup.config, password: planted}});
        };

        it("is refused above what a comparison may cost", async () => {
            for (const cost of [13, 14, 20, 31, 99]) {
                const {status} = await restore(hashAt(cost));

                assert.equal(status, 500, `accepted a cost of ${cost}`);
                assert.notEqual(await server.config.getValue("password"), hashAt(cost));
            }

            assert.equal((await api(server.baseUrl, "/speedtests?limit=1", withPassword(OWNER_PASSWORD))).status, 200,
                "a refused restore changed the password");
        });

        // What this instance writes, and what a neighbouring tool reasonably
        // might: the ceiling must not turn away an ordinary backup.
        it("is accepted at and below the ceiling", async () => {
            for (const cost of [4, 10, 12])
                assert.equal((await restore(hashAt(cost))).status, 200, `refused a cost of ${cost}`);
        });

        // bcrypt itself has no cost below 4, so such a hash can match nothing.
        it("is refused below what bcrypt accepts", async () => {
            for (const cost of [0, 3])
                assert.equal((await restore(hashAt(cost))).status, 500, `accepted a cost of ${cost}`);
        });
    });

    // The export is machine-independent apart from this: an adapter name from
    // another host would be rejected and fail the whole import.
    /**
     * The integration rows as a full export carries them. withoutSecrets
     * parses `data` on the redacted branch; the full branch handed the rows
     * on as read, and under the raw mapping sqlite reads the JSON column back
     * as the string it stored - so a full sqlite backup embedded every
     * integration's data as a JSON string inside the JSON.
     */
    it("carries an integration's data as an object in a full export", async () => {
        const created = await api(server.baseUrl, "/integrations/webhook", {
            method: "PUT",
            headers: {"content-type": "application/json", "x-password": OWNER_PASSWORD},
            body: JSON.stringify({url: "http://hooks.example.invalid/myspeed", send_finished: true})
        });
        assert.equal(created.status, 200, "the webhook could not be created");

        for (const query of ["?includeSecrets=true", ""]) {
            const {body} = await exportConfig(query);
            const row = body.integrations.find((entry) => entry.name === "webhook");

            assert.ok(row, `the export ${query || "(redacted)"} carries no webhook row`);
            assert.equal(typeof row.data, "object", `data is a ${typeof row.data} in the export ${query || "(redacted)"}`);
            assert.equal(row.data.send_finished, true);
        }
    });

    it("never carries the network interface", async () => {
        const {body} = await exportConfig("?includeSecrets=true");
        assert.equal(body.config.interface, undefined);
    });

    // The response body is the credential, so nothing between the server and
    // the browser may keep a copy of it.
    it("is never cached", async () => {
        for (const query of ["", "?includeSecrets=true"]) {
            const {headers} = await exportConfig(query);
            assert.match(headers.get("cache-control") ?? "", /no-store/, `missing on ${query || "the redacted export"}`);
        }
    });
});
