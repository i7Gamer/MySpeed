import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryRouter } from "react-router-dom";
import {
    formatLatency, formatWhole, formatWithUnit, NOT_MEASURED, SPEED_UNIT_MBYTES, wholeSpeed
} from "@/common/utils/FormatUtil.js";
import { getIconBySpeed, isFailedTest } from "@/common/utils/TestUtil.js";
import { resolveLimits } from "@/common/utils/TargetUtil.js";
import { act, cleanup, createElement, render, settle, window } from "../helpers/renderHarness.js";
import { AlertProvider } from "@/common/contexts/Alert";
import { ConfigContext } from "@/common/contexts/Config";
import { NodeContext } from "@/common/contexts/Node";
import { PreferencesContext } from "@/common/contexts/Preferences";
import { ToastNotificationContext } from "@/common/contexts/ToastNotification";
import { NodeContainer, TARGETS_RECHECK_MS } from "@/pages/Nodes/components/NodeContainer/NodeContainer.jsx";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const card = fs.readFileSync(
    path.join(CLIENT_SRC, "pages", "Nodes", "components", "NodeContainer", "NodeContainer.jsx"), "utf8");

/**
 * The card's own statements, lifted out of the component and run.
 *
 * They are plain JavaScript - the JSX and the hooks around them are what node
 * cannot evaluate - so the alternative is asserting on their spelling, which
 * passes for any wording that happens to contain the right words. What matters
 * here is which figure reaches each place, and that is only visible by building
 * the card and reading the figures back. Same approach as
 * detailLatencyPrecision.test.js.
 */
const slice = (from, to) => {
    const start = card.indexOf(from);
    assert.notEqual(start, -1, `the card no longer contains "${from}"`);

    const end = card.indexOf(to, start);
    assert.notEqual(end, -1, `"${to}" no longer closes it`);

    return card.slice(start, end + to.length);
};

const CARD_END = "\n        });";

/**
 * What the card stores about one test, built by its own setNodeData call.
 *
 * `targetsById` is what the node answered for its own /targets, keyed the way
 * the card keys it. Empty is the ordinary case as well as the degenerate one:
 * a node from before 1.5.0 has no such route, and a row measured before targets
 * existed names no target - both grade against the instance-wide settings.
 */
const dataFor = (test, config = {}, targetsById = {}) => {
    let captured = null;

    new Function("tests", "config", "targetsById", "setNodeData",
        "formatLatency", "formatWhole", "isFailedTest", "getIconBySpeed", "resolveLimits",
        slice("const ping = formatLatency", CARD_END))(
        [test], config, targetsById, (data) => { captured = data; },
        formatLatency, formatWhole, isFailedTest, getIconBySpeed, resolveLimits);

    assert.notEqual(captured, null, "the card never stored anything");
    return captured;
};

/**
 * What one speed reads as, built by the card's own helper.
 *
 * The closure carries only the names the helper reads: supplying the old
 * shape's formatWhole and convertSpeed as well is what would let a revert to
 * round-after-convert still evaluate - the band fixture below is the other net.
 */
const speedText = (mbps, preferences = {}, unit = "Mbps") => new Function(
    "preferences", "speedUnit", "formatWithUnit", "wholeSpeed",
    `${slice("const speedText =", ";")}\nreturn speedText;`)(
    preferences, unit, formatWithUnit, wholeSpeed)(mbps);

/**
 * A node card is a list row like any other, and it prints whole numbers.
 *
 * It always rounded its two speeds and showed its ping at one decimal, which
 * was the precision the overview used at the time. The overview rows print
 * whole numbers now - see formatWhole - and a card that switches to that page
 * showing "12.6 ms" for the test the page itself calls "13 ms" is one figure
 * written two ways.
 */
describe("the figures a node card prints", () => {
    it("prints all three measurements as whole numbers", () => {
        const data = dataFor({ping: 12.64, download: 93.72, upload: 41.38});

        assert.equal(data.ping, 13);
        assert.equal(speedText(data.download), "94 Mbps");
        assert.equal(speedText(data.upload), "41 Mbps");
    });

    /**
     * The card used to round the stored figure and convert afterwards, so a
     * reader on MB/s got an eighth of a rounded number - decimals and all -
     * where the overview beside it prints a rounded eighth. The conversion has
     * to come first, which means the rounding cannot happen until the card is
     * rendered and the preference is known.
     */
    it("rounds the speed it prints, not the one it stores", () => {
        assert.equal(speedText(100, {speedUnit: SPEED_UNIT_MBYTES}, "MB/s"), "13 MB/s",
            "100 Mbps is 12.5 MB/s, which prints as 13");
        // The band fixture: 100 agrees under round-after-convert too, so it
        // alone cannot notice that shape coming back.
        assert.equal(speedText(99.97, {speedUnit: SPEED_UNIT_MBYTES}, "MB/s"), "12 MB/s",
            "12.49625 rounds once to 12, not via 12.5 to 13");
        assert.equal(dataFor({download: 93.72}).download, 93.72,
            "the stored speed is rounded before anything can convert it");
    });

    /**
     * The colour has to agree with the overview's, and the overview grades the
     * ping at one decimal - getIconBySpeed floors a percentage, so a ping that
     * crosses a bucket boundary on its way to a whole number would wear one
     * colour on this card and another on the page the card switches to.
     */
    it("grades the ping at the decimal the page it switches to grades it at", () => {
        assert.equal(dataFor({ping: 12.5}, {ping: "10"}).pingIcon, "green");
        assert.equal(getIconBySpeed(formatWhole(12.5), "10", false), "orange",
            "a fixture both gradings agree on proves nothing here");
    });

    it("grades the speeds on what was measured rather than on what is shown", () => {
        const data = dataFor({download: 93.72, upload: 41.38}, {download: "100", upload: "40"});

        assert.equal(data.downloadIcon, getIconBySpeed(93.72, "100", true));
        assert.equal(data.uploadIcon, getIconBySpeed(41.38, "40", true));
    });

    // Math.round(null) is 0 and Math.round(undefined) is NaN. A node answers
    // with whatever its own API returns, so neither may become a reading.
    it("does not turn an absent figure into a reading of zero", () => {
        for (const absent of [null, undefined]) {
            assert.equal(dataFor({ping: absent}).ping, absent, `ping ${String(absent)}`);
            assert.equal(speedText(absent), NOT_MEASURED, `speed ${String(absent)}`);
        }
    });

    // The card marks a failure rather than printing the -1 placeholders as
    // readings, so the value it holds only has to stay recognisable.
    it("keeps a failed test recognisable", () => {
        const data = dataFor({ping: -1, download: -1, upload: -1});

        assert.equal(data.failed, true);
        assert.equal(data.ping, -1);
        assert.equal(data.pingIcon, "error");
    });

    /**
     * A MIXED row is not a failure - one real reading keeps it - so the card
     * renders its figures, and the placeholder among them must print as
     * unmeasured, not as "-1 ms" beside an error-red icon. The row's ping
     * travels through formatWhole into formatWithUnit exactly as the render
     * does at the card's ping line; both spellings, because a legacy-restored
     * history holds either.
     */
    it("prints a mixed row's placeholder as unmeasured, not as minus one", () => {
        for (const spelt of [-1, "-1"]) {
            const data = dataFor({ping: spelt, download: 480.2, upload: -1});

            assert.equal(data.failed, false, "one real reading keeps the row");
            assert.equal(formatWithUnit(data.ping, "ms"), NOT_MEASURED,
                `a ping of ${JSON.stringify(spelt)} printed as a reading`);
        }
        assert.equal(speedText(-1), NOT_MEASURED, "the speed placeholder printed as minus one megabit");
        assert.equal(speedText("-1"), NOT_MEASURED);
    });

    // The tripwire for the two speeds drifting apart, which is what one-line
    // formatting at each of two call sites invites.
    it("formats both speeds through the one helper", () => {
        assert.ok(card.includes("{speedText(nodeData.download)}"), "the download is formatted inline again");
        assert.ok(card.includes("{speedText(nodeData.upload)}"), "the upload is formatted inline again");
    });
});

/**
 * The instance-wide optima and one target's own, and a test that is excellent
 * against the second and dreadful against the first.
 *
 * The reported shape, kept as the fixture: a LAN target measured against
 * settings meant for the internet line. 24 ms is 240% of a 10 ms optimum and
 * 80% of a 30 ms one; 95 Mbit/s is 9% of 1000 and 95% of 100; 38 is 7% of 500
 * and 95% of 40. So every one of the three glyphs changes colour with the
 * basis, which is what makes the fixture worth having - a row that agrees
 * either way would prove nothing about which basis was used.
 */
const INSTANCE_OPTIMA = {ping: "10", download: "1000", upload: "500"};
const TARGET = {id: 4, name: "fritzbox", optimalPing: "30", optimalDownload: "100", optimalUpload: "40"};
const MEASURED = {id: 9, targetId: 4, ping: 24, download: 95, upload: 38, created: "2026-09-01T10:00:00.000Z"};

// A target the instance still has and this row does not name, so a lookup
// that misses is a miss among entries rather than a miss in an empty map.
const OTHER_TARGET = {id: 99, optimalPing: "500", optimalDownload: "1", optimalUpload: "1"};

describe("the optima a node card grades against", () => {
    /**
     * The defect this fixture was written for: the card read config.ping,
     * config.download and config.upload and never looked at the row's target,
     * while the overview row, the detail pane and the latest-test card all go
     * through resolveLimits. The comment above the grading says why they have
     * to agree - one measurement changing colour between two views of it is
     * the worse of the two faults - and this was three of them at once.
     */
    it("takes the row's own target's optima over the instance-wide settings", () => {
        const data = dataFor(MEASURED, INSTANCE_OPTIMA, {[TARGET.id]: TARGET});

        assert.deepEqual([data.pingIcon, data.downloadIcon, data.uploadIcon], ["green", "green", "green"],
            "the card painted the instance-wide verdict over the one the dashboard shows");
    });

    // Which is the same grading the card has always done, and still the right
    // one wherever no target's optima are known: a node too old to have the
    // route, a row recorded before targets existed, a target since deleted.
    it("falls back to the instance-wide settings when the row's target is not among them", () => {
        for (const [what, targetsById, test] of [
            ["a node with no targets route", {}, MEASURED],
            ["a row that names no target", {[TARGET.id]: TARGET}, {...MEASURED, targetId: undefined}],
            ["a target since deleted", {[OTHER_TARGET.id]: OTHER_TARGET}, MEASURED]
        ]) {
            const data = dataFor(test, INSTANCE_OPTIMA, targetsById);

            assert.deepEqual([data.pingIcon, data.downloadIcon, data.uploadIcon], ["red", "red", "red"], what);
        }
    });

    // A target that set none of the three is graded wholly by the instance
    // settings, and one that set some of them only by those - resolveLimits
    // answers per field, and the card must not collapse that to all or nothing.
    it("takes the instance settings field by field where the target set none", () => {
        const data = dataFor(MEASURED, INSTANCE_OPTIMA, {[TARGET.id]: {id: TARGET.id, optimalDownload: "100"}});

        assert.equal(data.downloadIcon, "green", "the target's own download optimum was ignored");
        assert.equal(data.pingIcon, "red", "a ping the target says nothing about lost the instance setting");
        assert.equal(data.uploadIcon, "red", "an upload the target says nothing about lost the instance setting");
    });
});

/**
 * The card driven rather than read, because everything this section is about
 * lives in when a request lands and what the card does with the one that says
 * nothing useful. A source pin can see that /targets is fetched; only a mounted
 * card can show that a node answering 404 to it stays green, that it is not
 * asked twice, and that a poll the next one overtook cannot write last.
 *
 * The card is affordable to mount: three requests, no canvas and no chart.
 */
describe("a node card reading its node", () => {
    afterEach(cleanup);

    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });

    const noop = () => undefined;

    const json = (body, status = 200) => new Response(JSON.stringify(body),
        {status, headers: {"content-type": "application/json"}});

    const NOT_FOUND = 404;

    /**
     * A node that answers everything at once. `targetsStatus` is the whole
     * point of the double: 404 is what every node before 1.5.0 answers, since
     * the route did not exist there.
     */
    const serve = ({tests = [MEASURED], config = INSTANCE_OPTIMA, targets = [TARGET], targetsStatus = 200} = {}) => {
        const asked = [];

        globalThis.fetch = (url) => {
            const path = String(url);
            asked.push(path);

            // Read per request rather than closed over, so a test can have
            // the node gain the route halfway through - which is what an
            // upgrade looks like from here.
            const status = typeof targetsStatus === "function" ? targetsStatus() : targetsStatus;

            if (path.includes("/targets")) return Promise.resolve(status === 200
                ? json(targets) : json({message: "Cannot GET /api/targets"}, status));
            if (path.includes("/config")) return Promise.resolve(json(config));
            return Promise.resolve(json(tests));
        };

        return asked;
    };

    const nest = (child, ...layers) =>
        layers.reduceRight((inner, [Provider, value]) => createElement(Provider, {value}, inner), child);

    const mount = () => render(createElement(MemoryRouter, null,
        nest(createElement(AlertProvider, null,
            createElement(NodeContainer, {id: 3, name: "kitchen", url: "http://192.168.1.50:5216"})),
        [ConfigContext.Provider, [{}, noop]],
        [NodeContext.Provider, [[], noop, 0, noop, () => undefined]],
        [PreferencesContext.Provider, [{}, noop]],
        [ToastNotificationContext.Provider, noop])));

    // The three glyphs in the order the card draws them - ping, download,
    // upload - read off the grade each publishes on its own item.
    const grades = (container) => [...container.querySelectorAll(".speed-item")]
        .map((item) => item.getAttribute("data-grade"));

    const asksFor = (asked, route) => asked.filter((path) => path.includes(route)).length;

    // The reader coming back to a tab, which is one of the card's three
    // triggers and the one a test can raise without waiting ten seconds.
    const returnToTheTab = async () => {
        act(() => window.document.dispatchEvent(new window.Event("visibilitychange")));
        await settle();
        await settle();
    };

    // Five minutes on, without spending them. The card reads Date.now() to
    // decide whether the window has closed, so that is the clock to move -
    // and only for the one call, since jsdom and react read it too.
    const afterTheRecheckWindow = async (run) => {
        const realNow = Date.now;
        Date.now = () => realNow.call(Date) + TARGETS_RECHECK_MS + 1;

        try {
            await run();
        } finally {
            Date.now = realNow;
        }
    };

    const seeTheCard = async () => {
        const mounted = mount();
        await settle();
        await settle();
        return mounted;
    };

    it("paints the grade the dashboard paints, not the instance-wide one", async () => {
        serve();
        const {container} = await seeTheCard();

        assert.deepEqual(grades(container), ["green", "green", "green"],
            "the card graded a target's row against optima that were never its");
    });

    it("reads the targets of the node the card is for", async () => {
        const asked = serve();
        await seeTheCard();

        assert.ok(asked.some((path) => path.endsWith("/api/nodes/3/targets")),
            `no card-scoped targets read among ${JSON.stringify(asked)}`);
    });

    /**
     * The reason the targets read cannot use the card's usual idiom. Every
     * other request here answers a failure with setNodeError, and the whole
     * healthy half of the card is gated on that being absent - so a 404 from a
     * node that simply predates the route would paint a running node red and
     * make switchNode refuse to navigate to it.
     */
    it("stays green for a node too old to have a targets route", async () => {
        serve({targetsStatus: NOT_FOUND});
        const {container} = await seeTheCard();

        assert.equal(container.querySelector(".node-item").className, "node-item hover-green",
            "a node that answered its tests and its config was reported as a problem");
        assert.deepEqual(grades(container), ["red", "red", "red"],
            "a node with no per-target optima is graded by its own instance settings");
    });

    /**
     * And it is asked once. This card polls every ten seconds for as long as
     * the page is open, so an unlatched 404 is one wasted request - proxied
     * through this instance to the child, for a remote node - and one console
     * line every tick, forever. StatusContext keeps the same latch over
     * /status/live for the same reason.
     */
    it("does not ask an old node for its targets again on every tick", async () => {
        const asked = serve({targetsStatus: NOT_FOUND});
        await seeTheCard();

        assert.equal(asksFor(asked, "/targets"), 1, "the first read never asked");

        await returnToTheTab();

        assert.equal(asksFor(asked, "/config"), 2, "coming back to the tab did not re-read the node");
        assert.equal(asksFor(asked, "/targets"), 1,
            "the card asks a node that has already answered 404 again on every tick");
    });

    /**
     * And it is asked again once, five minutes on.
     *
     * The first fix latched the 404 for good, on the reasoning StatusContext
     * latches /status/live with: one card is one node for its whole life. It
     * is the wrong reasoning here, because the fact being latched is about a
     * *remote* node rather than about this build - a node upgraded past 1.5.0
     * while this page sits open answers the route perfectly well, and the card
     * went on grading its rows against the instance-wide optima until somebody
     * reloaded, wearing a colour the dashboard it switches to disagrees with.
     * A 404 from a proxy answering for a child mid-restart latched the same
     * way and had no upgrade to be corrected by at all.
     */
    it("asks a node that has since gained the route, and grades on its answer", async () => {
        let status = NOT_FOUND;
        const asked = serve({targetsStatus: () => status});
        const {container} = await seeTheCard();

        assert.deepEqual(grades(container), ["red", "red", "red"], "the node answered 404 and was graded on it");

        status = 200;
        await afterTheRecheckWindow(returnToTheTab);

        assert.equal(asksFor(asked, "/targets"), 2, "the upgraded node was never asked again");
        assert.deepEqual(grades(container), ["green", "green", "green"],
            "a node upgraded under an open page is graded against optima that were never its");
    });

    /**
     * The three triggers - the ten second tick, the visibility listener and the
     * password dialog - none of which waits for the one before, so two reads
     * can be in flight at once and the slower one used to write last.
     *
     * Here the older read is the one that times out: baseRequest gives up after
     * ten seconds, which is exactly a tick apart, so this is the ordinary case
     * rather than a contrived one. Without the guard the card goes red over a
     * node the newer read has just been told is fine.
     */
    it("does not let an older read's answer overtake a newer one", async () => {
        const pending = [];
        globalThis.fetch = (url) => new Promise((resolve) => pending.push({path: String(url), resolve}));

        const {container} = mount();
        await settle();

        assert.equal(pending.length, 1, "the mount asked for something other than one thing");
        const [firstRead] = pending.splice(0, 1);

        act(() => window.document.dispatchEvent(new window.Event("visibilitychange")));
        await settle();
        assert.equal(pending.length, 1, "coming back to the tab started no second read");
        const [secondRead] = pending.splice(0, 1);

        // The newer read settles all the way through, and the card is drawn.
        secondRead.resolve(json([MEASURED]));
        await settle();
        for (const request of pending.splice(0)) request.resolve(
            request.path.includes("/targets") ? json([TARGET]) : json(INSTANCE_OPTIMA));
        await settle();

        assert.deepEqual(grades(container), ["green", "green", "green"], "the newer read never landed");

        // And only then does the older one give up.
        firstRead.resolve(json({message: "gateway timeout"}, 504));
        await settle();

        assert.equal(container.querySelector(".node-item").className, "node-item hover-green",
            "a stale read painted a node red over the answer that said it is running");
        assert.deepEqual(grades(container), ["green", "green", "green"]);
    });
});
