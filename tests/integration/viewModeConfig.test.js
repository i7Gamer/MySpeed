import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, setConfig } from "./helpers/boot.js";

let server;

const PASSWORD = "Viewer1!pass";

// Sent as if forwarded, so the caller is not treated as local - an
// unconfigured or loopback caller is waved through and would mask view mode.
const asVisitor = (pathname) => api(server.baseUrl, pathname, {
    headers: {"x-forwarded-for": "203.0.113.5"}
});

before(async () => {
    server = await bootServer();
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    await setConfig(server.config, "password", PASSWORD);
    await setConfig(server.config, "passwordLevel", "read");
});

/**
 * What a read-only visitor is allowed to know about the instance.
 *
 * The route already withholds the provider ids, the custom LibreSpeed URL, the
 * schedule and the access level. `interface` was missed: it is the name of the
 * operator's own network adapter - on the instance this was found on,
 * "vEthernet (External)", which also says the host is a Hyper-V machine. Its
 * only consumer is the provider dialog, which view mode never opens, so it was
 * disclosed to every visitor of a public dashboard for nothing.
 */
describe("GET /api/config in view mode", () => {
    const WITHHELD = ["password", "interface", "ooklaId", "libreId", "libreUrl",
        "cron", "scheduleOffset", "passwordLevel"];

    it("marks the caller as a viewer", async () => {
        const {status, body} = await asVisitor("/config");

        assert.equal(status, 200);
        assert.equal(body.viewMode, true);
    });

    for (const key of WITHHELD) {
        it(`withholds ${key}`, async () => {
            const {body} = await asVisitor("/config");

            assert.equal(body[key], undefined, `${key} reached a read-only visitor`);
        });
    }

    // The dashboard draws its target bars from these, so withholding them would
    // break the very view this mode exists to serve.
    it("still answers with what the dashboard needs to render", async () => {
        const {body} = await asVisitor("/config");

        for (const key of ["ping", "download", "upload"])
            assert.ok(body[key], `${key} is needed to grade the measurements`);
    });

    it("gives the operator everything, interface included", async () => {
        const {body} = await api(server.baseUrl, "/config", {headers: {"x-password": PASSWORD}});

        assert.equal(body.viewMode, false);
        assert.ok(body.interface, "the operator's own config must still carry the interface");
        assert.equal(body.password, undefined, "the password is never disclosed, to anyone");
    });
});
