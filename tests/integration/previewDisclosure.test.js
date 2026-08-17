import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, seedTests } from "./helpers/boot.js";

let server;
let nodeId;

const TELEGRAM_TOKEN = "123456789:AAsupersecrettokenvalue";
const CHAT_ID = "-1001234567890";

const NODE = {name: "Attic", url: "http://192.168.1.40:5216", password: "TheNodesOwn1!"};

const CONNECTION = {isp: "Deutsche Telekom AG", externalIp: "203.0.113.5", resultId: "9876543210"};

/**
 * A range around the seeded row, since the export refuses a request without one.
 *
 * Bounded rather than every year there has ever been: the route caps a window
 * at MAX_RANGE_DAYS and answers 400 above it, so an "all of time" range would
 * fail for a reason that has nothing to do with what is being asserted.
 */
const EXPORT_RANGE = "from=2026-01-01&to=2026-12-31";

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

    // Written straight to the model: PUT /nodes checks the URL is safe and then
    // fetches the node to verify its password, and neither belongs in a test
    // about what the row discloses once it exists.
    const {default: Node} = await import("../../server/models/Node.js");
    await Node.destroy({where: {}});
    nodeId = (await Node.create(NODE)).id;

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
     * And the countdown goes with the cron it is derived from.
     *
     * Withholding `cron` from the config would be worth nothing on its own:
     * one poll of this route recovers the schedule's minute field, and polling
     * across an evening walks out both edges of the quiet window, since the
     * countdown steps over it. Null is what this route already answers when
     * nothing is scheduled, so the status bar has a branch for it.
     */
    it("does not count down to the next test", async () => {
        const {body} = await onDemo("/speedtests/status");

        assert.equal(body.nextTest, null,
            "polling the countdown recovers the schedule the config withholds");
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
 * The exports, which are operator artefacts however they are asked for.
 *
 * GET /api/storage/config takes `includeSecrets` from the query string and had
 * no preview guard at all, so a visitor to a demo could ask for the full export
 * and be given it: the admin password hash, every node password in clear and
 * every integration credential. Worse than the /integrations/active hole beside
 * it, which never carried the hash or the node passwords - and the route's own
 * comment lists exactly what a full export contains. It simply never asked who
 * was asking.
 *
 * The two history downloads are the same shape: they answer with tests.listAll()
 * untouched, so the provider and external address that /api/speedtests/export
 * strips for an untrusted reader went out in full through this door instead.
 *
 * Sealed rather than redacted. A redacted config export still carries the whole
 * withheld list - the cron, the quiet hours, the adapter name - because that is
 * what a configuration is, and /api/speedtests/export is already the redacted
 * way to take the measurements away. The client catches the refusal and shows
 * its message, which is how every other preview refusal reaches a visitor.
 */
describe("a demo and the exports", () => {
    it("refuses a full configuration export", async () => {
        const {status, body} = await onDemo("/storage/config?includeSecrets=true");

        assert.equal(status, 403, "a demo visitor downloaded the password hash and every credential");
        assert.match(body.message, /preview mode/i);
    });

    // Asked for without the flag it is still the instance's configuration, and
    // still carries every key the config route withholds.
    it("refuses a redacted one too", async () => {
        assert.equal((await onDemo("/storage/config")).status, 403);
    });

    for (const format of ["json", "csv"])
        it(`refuses the ${format} history download`, async () => {
            const {status} = await onDemo(`/storage/tests/history/${format}`);

            assert.equal(status, 403, "the raw history went out with its connection identity");
        });

    /**
     * The adapter list, which is the disclosure the config route keeps one
     * entry of back. Withholding the selected `interface` buys nothing while
     * the whole list is a request away - and the provider dialog that reads it
     * is already closed on a demo.
     */
    it("refuses the network adapter list", async () => {
        assert.equal((await onDemo("/info/interfaces")).status, 403);
    });

    // The redacted export a demo visitor may still take away, so that sealing
    // the raw one above costs a visitor nothing they were meant to have.
    it("still lets a visitor export the measurements", async () => {
        const {status, body} = await onDemo(`/speedtests/export?${EXPORT_RANGE}&format=json`);

        assert.equal(status, 200, "the demo lost the export it is meant to offer");
        assert.ok(body.length > 0, "nothing was in range, so the redaction below proves nothing");
        assert.equal(body[0].isp, null, "and it must still be the redacted one");
    });
});

/**
 * And the operator's own instance keeps all of it.
 */
describe("an ordinary instance and the exports", () => {
    it("still exports the configuration with its secrets", async () => {
        const {status, body} = await asVisitor("/storage/config?includeSecrets=true");

        assert.equal(status, 200);
        assert.equal(body.secretsRedacted, false);

        const telegram = body.integrations.find((row) => row.name === "telegram");
        assert.equal(telegram.data.token ?? JSON.parse(telegram.data).token, TELEGRAM_TOKEN,
            "a full export that redacts is a backup that cannot restore");
    });

    it("still downloads the history", async () => {
        for (const format of ["json", "csv"])
            assert.equal((await asVisitor(`/storage/tests/history/${format}`)).status, 200);
    });

    it("still answers with the adapter list", async () => {
        assert.equal((await asVisitor("/info/interfaces")).status, 200);
    });
});

/**
 * And the other machines the operator owns.
 *
 * Redacting the local read routes was not enough on its own. The node proxy
 * reaches a different server entirely and substitutes that server's stored
 * password on the way, and previewReadOnly lets a GET through by design - so
 * `GET /api/nodes/<id>/integrations/active` on a demo was answered by the far
 * end as though the operator had asked, with its credentials in clear. Every
 * redaction here was reachable through that one door, unredacted, because the
 * far end could not tell it was serving a stranger.
 *
 * The listing is what supplies the id that door needs, and the operator's own
 * host names and addresses along with it.
 */
describe("a demo and the operator's other machines", () => {
    it("offers a visitor no nodes at all", async () => {
        const {status, body} = await onDemo("/nodes");

        assert.equal(status, 200, "the client polls this and takes an error badly");
        assert.deepEqual(body, [], "a demo visitor was given the operator's node list");
    });

    it("refuses to proxy a read to one", async () => {
        const {status, body} = await onDemo(`/nodes/${nodeId}/config`);

        assert.equal(status, 403,
            "a demo visitor read another machine with that machine's stored password");
        assert.match(body.message, /preview mode/i);
    });

    // The credential the proxy would have attached. Named explicitly because it
    // is the thing that makes a proxied read an administrative one.
    it("refuses whatever is asked of the node", async () => {
        for (const route of ["integrations/active", "speedtests", "storage/config"]) {
            const {status} = await onDemo(`/nodes/${nodeId}/${route}`);

            assert.equal(status, 403, `/${route} was proxied to the node on a demo`);
        }
    });

    it("still gives the operator their own node list", async () => {
        const {body} = await asVisitor("/nodes");

        assert.equal(body.length, 1);
        assert.equal(body[0].name, NODE.name);
        assert.equal(body[0].url, NODE.url);
        assert.equal(body[0].password, true, "the listing reports whether a password is set, never the value");
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

    // The countdown is the status bar's whole job for the operator, so the
    // demo's null must not be what everyone gets.
    it("still counts down to the operator's next test", async () => {
        const {body} = await asVisitor("/speedtests/status");

        assert.notEqual(body.nextTest, null, "the status bar lost its countdown");
    });
});
