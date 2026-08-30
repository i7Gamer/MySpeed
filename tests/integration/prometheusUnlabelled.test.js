import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, seedTarget, seedTests, setConfig } from "./helpers/boot.js";

/**
 * Who owns the unlabelled Prometheus series - target="" provider="" - when no
 * target leads the round.
 *
 * That series is the identity every dashboard and alert built before targets
 * existed still follows, and the exporter gives it to the primary target.
 * primaryTarget() is the first *enabled* target, so an instance whose targets
 * all have "Scheduled" switched off has no primary at all - an ISP outage on
 * the WAN target, beside the manual-only iperf3 box this feature exists to
 * support, and nothing in PATCH /targets/:id refuses the last one. The exporter
 * used to fall back to the newest row of *any* target there, which put a
 * hand-started LAN run under the identity a WAN throughput alert reads, and put
 * it there a second time under its own name so any sum() over the family
 * counted it twice.
 *
 * The states below are the ones that judgement has to tell apart, and they are
 * held here rather than at the route because only a booted server answers what
 * a scrape actually says.
 */
let server;
let targetsController;

before(async () => {
    server = await bootServer();
    targetsController = await import("../../server/controller/targets.js");
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    await setConfig(server.config, "password", "none");
});

const metrics = () => api(server.baseUrl, "/prometheus/metrics");

const linesOf = (text, family) => text.split("\n").filter((row) => row.startsWith(family));

const valueOf = (line) => parseFloat(line.slice(line.lastIndexOf(" ") + 1));

const downloads = (text) => linesOf(text, "myspeed_download{");

const unlabelledDownload = (text) => downloads(text).find((row) => row.includes('target=""'));

const namedDownload = (text, name) => downloads(text).find((row) => row.includes(`target="${name}"`));

const serverLine = (text) => linesOf(text, "myspeed_server ")[0];

/** Two lines, neither scheduled: nothing leads the round and both compete. */
describe("several targets, none of them scheduled", () => {
    beforeEach(async () => {
        const wan = await seedTarget({provider: "ookla", name: "WAN", enabled: false});
        const nas = await targetsController.create({
            name: "NAS", provider: "iperf3", endpoint: "10.0.0.5:5201", enabled: false
        });

        await seedTests(server.tests, [
            {created: "2026-08-26T10:00:00.000Z", ping: 9, download: 250, serverId: 49631, targetId: wan.id},
            {created: "2026-08-26T10:01:00.000Z", ping: 0.4, download: 941, serverId: 7, targetId: nas.id}
        ]);
    });

    it("gives the unlabelled series to nobody rather than to whichever ran last", async () => {
        const {text} = await metrics();
        const claimed = text.split("\n")
            .filter((row) => row.startsWith("myspeed_") && row.includes('target=""'));

        assert.deepEqual(claimed, [],
            "a hand-started LAN run is exported as the internet line a pre-1.4 alert reads");
    });

    it("exports the newest reading once, not twice", async () => {
        const {text} = await metrics();
        const lan = downloads(text).filter((row) => valueOf(row) === 941);

        assert.equal(lan.length, 1, "one reading is double-counted by any sum() over the family");
        assert.match(lan[0], /target="NAS"/);
    });

    // Unscheduling a target does not unpublish it: it is still runnable by
    // hand, and the rows it did measure are still its own.
    it("still exports every target under its own name", async () => {
        const {text} = await metrics();

        assert.equal(valueOf(namedDownload(text, "WAN")), 250);
        assert.equal(valueOf(namedDownload(text, "NAS")), 941);
        assert.match(text, /myspeed_target_info\{[^}]*target="WAN"[^}]*\} 1/);
        assert.match(text, /myspeed_target_info\{[^}]*target="NAS"[^}]*\} 1/);
    });

    /**
     * myspeed_server carries no labels at all, so it cannot say which line it
     * describes. With nothing leading the round it named the server of
     * whichever target happened to run last - the LAN box - under an identity
     * that means "the server this instance is testing against".
     */
    it("reports no current server", async () => {
        const {text} = await metrics();

        assert.equal(serverLine(text), undefined,
            "the last target to run is reported as the server the instance tests against");
    });
});

/**
 * The same instance, except its newest row belongs to no target: history
 * restored through PUT /api/storage/tests/history, which writes rows without a
 * targetId on purpose. No named series speaks for those rows, so the identity
 * they carry is the one they always carried - and taking it away would leave
 * this instance exporting no measurement at all.
 */
describe("several targets, none scheduled, and history that belongs to no target", () => {
    beforeEach(async () => {
        const wan = await seedTarget({provider: "ookla", name: "WAN", enabled: false});
        const nas = await targetsController.create({
            name: "NAS", provider: "iperf3", endpoint: "10.0.0.5:5201", enabled: false
        });

        await seedTests(server.tests, [
            {created: "2026-08-26T10:00:00.000Z", download: 250, serverId: 49631, targetId: wan.id},
            {created: "2026-08-26T10:01:00.000Z", download: 941, serverId: 7, targetId: nas.id},
            {created: "2026-08-26T10:02:00.000Z", download: 610, serverId: 1234}
        ]);
    });

    it("keeps exporting the unattributed newest unlabelled", async () => {
        const {text} = await metrics();

        assert.ok(unlabelledDownload(text), "a row that belongs to nobody lost the only identity it had");
        assert.equal(valueOf(unlabelledDownload(text)), 610);
        assert.equal(valueOf(serverLine(text)), 1234);
    });

    it("exports it once, beside the targets' own series", async () => {
        const {text} = await metrics();

        assert.equal(downloads(text).filter((row) => valueOf(row) === 610).length, 1);
        assert.equal(valueOf(namedDownload(text, "WAN")), 250);
        assert.equal(valueOf(namedDownload(text, "NAS")), 941);
    });
});

/**
 * One target, not scheduled - the shape migration 0013 produces for every
 * install that had chosen a provider, one ToggleSwitch away from the state
 * above. There is only one line in this instance, so the unlabelled series
 * cannot be another line's and the pre-1.4 dashboard must keep it. The defect
 * here was only ever that the same row also went out under its own name.
 */
describe("a single target that is not scheduled", () => {
    beforeEach(async () => {
        const only = await seedTarget({provider: "ookla", name: "Ookla", enabled: false});

        await seedTests(server.tests, [
            {created: "2026-08-26T10:00:00.000Z", ping: 9, download: 250, serverId: 49631, targetId: only.id}
        ]);
    });

    it("keeps the series a pre-1.4 dashboard follows", async () => {
        const {text} = await metrics();

        assert.ok(unlabelledDownload(text), "the only line this instance has stopped exporting");
        assert.equal(valueOf(unlabelledDownload(text)), 250);
        assert.equal(valueOf(serverLine(text)), 49631);
    });

    it("exports that one reading once", async () => {
        const {text} = await metrics();

        assert.equal(downloads(text).length, 1,
            "the sole target's reading is exported unlabelled and again under its own name");
        assert.match(text, /myspeed_target_info\{[^}]*target="Ookla"[^}]*\} 1/);
    });
});

/**
 * And the two instances with no target at all: the one that upgraded without
 * ever having chosen a provider, and the one whose targets were all deleted -
 * whose rows keep the id of a target that is gone, because "a deleted target's
 * history is still history".
 */
describe("an instance with no targets at all", () => {
    it("exports its overall latest unlabelled", async () => {
        await targetsController.removeAll();
        await seedTests(server.tests, [
            {created: "2026-08-26T10:00:00.000Z", download: 250, serverId: 49631}
        ]);

        const {text} = await metrics();

        assert.ok(unlabelledDownload(text), "the instance the fallback exists for lost its series");
        assert.equal(valueOf(unlabelledDownload(text)), 250);
        assert.equal(valueOf(serverLine(text)), 49631);
    });

    it("exports an orphaned history unlabelled once the target is gone", async () => {
        const removed = await seedTarget({provider: "ookla", name: "Ookla"});
        await seedTests(server.tests, [
            {created: "2026-08-26T10:00:00.000Z", download: 250, serverId: 49631, targetId: removed.id}
        ]);
        await targetsController.deleteTarget(removed.id);

        const {text} = await metrics();

        assert.equal(valueOf(unlabelledDownload(text)), 250);
        assert.equal(downloads(text).length, 1);
    });
});
