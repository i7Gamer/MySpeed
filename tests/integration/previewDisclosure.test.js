import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, seedTests } from "./helpers/boot.js";

let server;

const TELEGRAM_TOKEN = "123456789:AAsupersecrettokenvalue";
const CHAT_ID = "-1001234567890";

const CONNECTION = {isp: "Deutsche Telekom AG", externalIp: "203.0.113.5", resultId: "9876543210"};

const asVisitor = (pathname) => api(server.baseUrl, pathname);

const onDemo = async (pathname) => {
    process.env.PREVIEW_MODE = "true";
    return await asVisitor(pathname);
};

before(async () => {
    server = await bootServer();

    // Created before the demo flag is set, because previewReadOnly refuses a
    // PUT once it is - which is the point: the rows a demo discloses are the
    // ones an operator stored while the instance was still their own.
    await api(server.baseUrl, "/integrations/telegram", {
        method: "PUT",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({token: TELEGRAM_TOKEN, chat_id: CHAT_ID, send_failed: true})
    });

    await seedTests(server.tests, [CONNECTION]);
});

after(async () => {
    await server?.close();
});

afterEach(() => {
    delete process.env.PREVIEW_MODE;
});

/**
 * What a visitor to a public demo is allowed to know.
 *
 * The password middleware waves every request through in preview mode, and it
 * did so without setting `req.viewMode` - so the flag stayed undefined, which
 * is falsy, which every redaction on the read routes read as "this caller is
 * the operator". Three of them were skipped in one go on an address whose whole
 * purpose is being handed to strangers:
 *
 *   - GET /api/integrations/active answered with the stored rows untouched,
 *     credentials included: a telegram bot token, a discord webhook URL, an
 *     influxdb token, a healthchecks ping URL. withoutSecrets existed and was
 *     wired only to the config export.
 *   - GET /api/config disclosed the whole WITHHELD_IN_VIEW_MODE list - the
 *     operator's own adapter name, the schedule, and the nightly hours that say
 *     when nobody is home. The list's own comment explains why a read-only
 *     visitor must not have them; the demo is the more public of the two.
 *   - GET /api/speedtests handed back the provider and the external address of
 *     the line being measured.
 *
 * The fix is a predicate of its own rather than setting `viewMode` on a demo,
 * and the last test here is why.
 */
describe("a demo instance", () => {
    it("blanks the credential in the active integrations", async () => {
        const {status, body} = await onDemo("/integrations/active");

        assert.equal(status, 200);

        const telegram = body.find((row) => row.name === "telegram");
        assert.ok(telegram, "the seeded integration is not in the answer at all");
        assert.equal(telegram.data.token, null, "the bot token reached an anonymous visitor");
    });

    // The shape is what the dialog renders from, and a demo exists to be
    // looked at - so the credential is blanked rather than the row withheld.
    it("keeps the rest of the row so the dialog still draws it", async () => {
        const {body} = await onDemo("/integrations/active");

        const telegram = body.find((row) => row.name === "telegram");

        assert.ok("token" in telegram.data, "the shape of the payload changed");
        assert.equal(telegram.data.chat_id, CHAT_ID, "a non-credential field was blanked too");
    });

    for (const key of ["interface", "cron", "scheduleOffset", "quietHoursStart", "quietHoursEnd",
        "ooklaId", "libreId", "libreUrl", "passwordLevel"])
        it(`withholds ${key} from the config`, async () => {
            const {body} = await onDemo("/config");

            assert.equal(body[key], undefined, `${key} reached a visitor to a public demo`);
        });

    it("strips the connection identity from the history", async () => {
        const {body} = await onDemo("/speedtests");

        assert.ok(body.length > 0, "nothing was seeded, so this would pass vacuously");
        assert.equal(body[0].isp, null, "the provider reached an anonymous visitor");
        assert.equal(body[0].externalIp, null, "the external address reached an anonymous visitor");
    });

    it("strips it from the status route as well", async () => {
        const {body} = await onDemo("/speedtests/status");

        assert.equal(body.lastTest.isp, null);
        assert.equal(body.lastTest.externalIp, null);
    });

    /**
     * And the demo is still a demo.
     *
     * `viewMode` is echoed straight back to the client here and drives the
     * whole interface: StatusUtil gates the run button on it, the dropdown
     * hides its entries behind it, and configOutcome redirects to the node
     * list. Setting it on a demo would have taken the one thing a visitor comes
     * to press - preview mode has a branch in tasks/speedtest.js that answers a
     * run with a plausible generated result - which is why the redaction is
     * driven by a predicate of its own rather than by this flag.
     */
    it("does not turn the client into a read-only viewer", async () => {
        const {body} = await onDemo("/config");

        assert.equal(body.viewMode, false, "the demo would lose the run button");
        assert.equal(body.previewMode, true);
    });

    // The dashboard is the whole of what a demo shows, so the redaction must
    // not reach the values it grades against.
    it("still answers with what the dashboard needs", async () => {
        const {body} = await onDemo("/config");

        for (const key of ["ping", "download", "upload"])
            assert.ok(body[key], `${key} is needed to grade the measurements`);
    });
});

/**
 * The operator's own instance is unchanged.
 *
 * Loopback with no password configured is admitted as the operator, which is
 * how the rest of the integration suite reaches these routes.
 */
describe("an ordinary instance", () => {
    it("still hands the operator the credential", async () => {
        const {body} = await asVisitor("/integrations/active");

        const telegram = body.find((row) => row.name === "telegram");

        assert.equal(telegram.data.token, TELEGRAM_TOKEN,
            "the dialog reads the stored value back from here");
    });

    it("still hands the operator the schedule and the adapter", async () => {
        const {body} = await asVisitor("/config");

        assert.ok(body.interface, "the provider dialog reads the interface back from here");
        assert.ok(body.cron, "the frequency dialog reads the cron back from here");
    });

    it("still hands the operator the connection identity", async () => {
        const {body} = await asVisitor("/speedtests");

        assert.equal(body[0].isp, CONNECTION.isp);
        assert.equal(body[0].externalIp, CONNECTION.externalIp);
    });
});
