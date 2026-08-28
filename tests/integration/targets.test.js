import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, setConfig } from "./helpers/boot.js";

/**
 * The targets API end to end: the list an operator manages, what a read-only
 * visitor may know of it, and the round semantics the rows drive - including
 * the manual-only shape, where a disabled target never joins the schedule but
 * still runs by name.
 */

let server;
let targets;

before(async () => {
    server = await bootServer();
    targets = await import("../../server/controller/targets.js");
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    await targets.removeAll();
    await server.tests.destroy({where: {}});
});

const put = (body) => api(server.baseUrl, "/targets", {
    method: "PUT", headers: {"content-type": "application/json"}, body: JSON.stringify(body)
});

const patch = (path, body) => api(server.baseUrl, `/targets${path}`, {
    method: "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify(body)
});

describe("PUT /api/targets", () => {
    it("creates a target and answers its id", async () => {
        const {status, body} = await put({name: "Frankfurt", provider: "ookla", serverId: "1234"});

        assert.equal(status, 200);
        assert.ok(Number.isInteger(body.id));

        const [row] = await targets.listAll();
        assert.equal(row.name, "Frankfurt");
        assert.equal(row.serverId, "1234");
        // sqlite hands a boolean back as 1 under the global raw:true.
        assert.equal(Boolean(row.enabled), true);
    });

    it("refuses what targetProblem refuses, naming the problem", async () => {
        const {status, body} = await put({name: "x", provider: "ookla", serverId: "12a4"});

        assert.equal(status, 400);
        assert.match(body.message, /server/i);
    });

    it("assigns round order by arrival", async () => {
        await put({name: "first", provider: "ookla"});
        await put({name: "second", provider: "cloudflare"});

        const rows = await targets.listAll();
        assert.deepEqual(rows.map((row) => row.name), ["first", "second"]);
        assert.ok(rows[0].sortOrder < rows[1].sortOrder);
    });

    it("ignores fields the server assigns", async () => {
        await put({name: "sneaky", provider: "ookla", id: 999, sortOrder: -5, created: "then"});

        const [row] = await targets.listAll();
        assert.notEqual(row.id, 999);
        assert.equal(row.sortOrder, 0);
    });
});

/**
 * A target's name is the key the history backup files rows under:
 * importedTargetId keeps the first id in round order for a shared name, so two
 * targets wearing one would silently merge their histories on the next
 * restore. Refused at the door instead - and stored trimmed on every path, or
 * the padded copy and the trimmed one stop matching across the round trip.
 */
/**
 * The one line an instance-wide surface speaks for.
 *
 * The recommendation card and the public preview image both have to name a
 * single line - a gigabit LAN box averaged into a WAN figure describes
 * neither - and both were spelling the same four-step preference out for
 * themselves, in two files, each with a comment saying it was the same rule.
 * One home, so a change to which line an instance headlines cannot land in
 * one of them and not the other.
 */
/**
 * Unscheduling the instance's first line is an ordinary thing to do to a line
 * during an outage, and it is the one edit with a consequence the interface
 * cannot show: the base MQTT topic speaks for the first line on record and for
 * no other - deliberately, because moving it hands one line's Home Assistant
 * entities to another's numbers, and the retained discovery configs never
 * announce a correction. While that line is unscheduled the topic simply goes
 * quiet, and the entities keep their last value with nothing anywhere saying
 * why. So it is said out loud, once, to the operator doing it.
 */
describe("unscheduling the line the base topic speaks for", () => {
    const warningsWhile = async (body) => {
        const warn = console.warn;
        const said = [];
        console.warn = (...parts) => said.push(parts.join(" "));

        try {
            await body();
        } finally {
            console.warn = warn;
        }

        return said;
    };

    it("says the base topic is about to go quiet", async () => {
        const first = await targets.create({name: "WAN", provider: "ookla", sortOrder: 0});
        await targets.create({name: "LAN", provider: "ookla", sortOrder: 1});

        const said = await warningsWhile(() => patch(`/${first.id}`, {enabled: false}));

        assert.ok(said.some((line) => /base .*topic/i.test(line)),
            "the operator was told nothing about the entities that just stopped updating");
    });

    it("says nothing when another line is unscheduled", async () => {
        await targets.create({name: "WAN", provider: "ookla", sortOrder: 0});
        const second = await targets.create({name: "LAN", provider: "ookla", sortOrder: 1});

        const said = await warningsWhile(() => patch(`/${second.id}`, {enabled: false}));

        assert.deepEqual(said.filter((line) => /base .*topic/i.test(line)), []);
    });

    // Said when the edit is what takes it quiet, not every time the row is
    // touched afterwards: the operator has already been told.
    it("says nothing on a later edit to a line already unscheduled", async () => {
        const first = await targets.create({name: "WAN", provider: "ookla",
            enabled: false, sortOrder: 0});

        const said = await warningsWhile(() => patch(`/${first.id}`, {optimalDownload: 500}));

        assert.deepEqual(said.filter((line) => /base .*topic/i.test(line)), []);
    });
});

describe("the line an instance-wide surface speaks for", () => {
    const named = async () => (await targets.headlineOrder())[0]?.name;

    it("is the first scheduled target that alerts", async () => {
        await targets.create({name: "diagnostic", provider: "ookla", alerts: false, sortOrder: 0});
        await targets.create({name: "wan", provider: "ookla", sortOrder: 1});

        assert.equal(await named(), "wan");
    });

    /**
     * A target that runs by hand still alerts - that is the whole of the
     * manual-only shape - so it describes a line somebody watches, where the
     * scheduled box beside it with alerts switched off does not. Preferring
     * the round's leader here recommended the LAN box's gigabit figures to an
     * instance whose watched line is a WAN.
     */
    it("prefers a watched line that runs by hand over an unwatched scheduled one", async () => {
        await targets.create({name: "lan", provider: "ookla", alerts: false, sortOrder: 0});
        await targets.create({name: "wan", provider: "ookla", enabled: false, sortOrder: 1});

        assert.equal(await named(), "wan");
    });

    /**
     * The discriminating pair, which none of the cases around it is: both lines
     * are watched, one runs by hand and leads the list, the other is scheduled
     * behind it. Every other case here answers identically whether the first two
     * steps of the preference are in this order or the other, so the rule they
     * were written to hold was not being held by any of them.
     */
    it("prefers a scheduled watched line over a watched one that runs by hand", async () => {
        await targets.create({name: "manual", provider: "ookla", enabled: false, sortOrder: 0});
        await targets.create({name: "scheduled", provider: "ookla", sortOrder: 1});

        assert.equal(await named(), "scheduled");
    });

    it("falls back to the round's leader when nothing alerts at all", async () => {
        await targets.create({name: "first", provider: "ookla", alerts: false, sortOrder: 0});
        await targets.create({name: "second", provider: "ookla", alerts: false, sortOrder: 1});

        assert.equal(await named(), "first");
    });

    it("falls back to the first target on record when nothing is scheduled", async () => {
        await targets.create({name: "manual", provider: "ookla",
            enabled: false, alerts: false, sortOrder: 0});

        assert.equal(await named(), "manual");
    });

    it("is nothing at all on an instance with no targets", async () => {
        assert.deepEqual(await targets.headlineOrder(), []);
    });

    /**
     * And the whole ranking, not only its winner: both callers walk the
     * sequence now - the card for a line with a full sample, the preview image
     * for one with rows in the window it averages - so every step below the
     * first decides something. The list order is reversed against the tiers on
     * purpose, or a ranking that simply returned the table's own order would
     * answer this identically.
     */
    it("ranks every line, not only the one it starts with", async () => {
        await targets.create({name: "unwatched-manual", provider: "ookla",
            enabled: false, alerts: false, sortOrder: 0});
        await targets.create({name: "unwatched", provider: "ookla", alerts: false, sortOrder: 1});
        await targets.create({name: "watched-manual", provider: "ookla",
            enabled: false, sortOrder: 2});
        await targets.create({name: "watched", provider: "ookla", sortOrder: 3});

        assert.deepEqual((await targets.headlineOrder()).map((row) => row.name),
            ["watched", "watched-manual", "unwatched", "unwatched-manual"]);
    });
});

describe("a target's name", () => {
    it("is refused when another target already wears it", async () => {
        await put({name: "Ookla", provider: "ookla"});

        const {status, body} = await put({name: " Ookla ", provider: "cloudflare"});

        assert.equal(status, 400);
        assert.match(body.message, /name/i);
    });

    it("is refused on a rename onto an existing name", async () => {
        await put({name: "WAN", provider: "ookla"});
        const {body: {id}} = await put({name: "NAS", provider: "cloudflare"});

        const {status} = await patch(`/${id}`, {name: "WAN"});

        assert.equal(status, 400);
    });

    it("still accepts a PATCH that keeps the target's own name", async () => {
        const {body: {id}} = await put({name: "WAN", provider: "ookla"});

        assert.equal((await patch(`/${id}`, {name: "WAN", enabled: false})).status, 200);
    });

    /**
     * The door is for names being taken, not for names already shared.
     *
     * Duplicates were legal until this door, and the welcome wizard's
     * double-Done made exact pairs - so an upgraded instance can hold two
     * targets called "Ookla". Judging every PATCH by the row it would become
     * refused every edit to either of them, unscheduling one included, naming
     * a field the request never carried and leaving a rename as the only way
     * out.
     */
    it("lets an unrelated edit through on a pair it did not create", async () => {
        const first = await targets.create({name: "Ookla", provider: "ookla"});
        await targets.create({name: "Ookla", provider: "cloudflare"});

        assert.equal((await patch(`/${first.id}`, {enabled: false})).status, 200,
            "an edit that never mentioned the name was refused over it");
        assert.equal((await patch(`/${first.id}`, {optimalDownload: 500})).status, 200);
    });

    /**
     * And a request that changes the name only by trimming it is a rename.
     *
     * "What this request is doing" was asked of the trimmed name on both sides,
     * so an incoming "Ookla" was judged identical to a stored "Ookla " - and
     * the door stood aside while update() trimmed the padding and made the
     * exact duplicate pair the door exists to prevent. A padded name is not
     * hypothetical: every install from before names were trimmed on the way in
     * holds them, and the operator makes the pair by opening the row and
     * pressing Save.
     */
    it("refuses a save that trims a name onto one already worn", async () => {
        const {default: model} = await import("../../server/models/Targets.js");

        await targets.removeAll();
        // Straight to the model: create() and update() both trim, so a padded
        // name is one only an older version could have written.
        const padded = await model.create({name: "Ookla ", provider: "ookla", sortOrder: 0});
        await targets.create({name: "Ookla", provider: "cloudflare"});

        assert.equal((await patch(`/${padded.id}`, {name: "Ookla"})).status, 400,
            "pressing Save on a padded name made the duplicate pair the door refuses to create");
    });

    // The padding still comes off where nothing else wears the trimmed name -
    // this is a door on names being taken, not on names being tidied.
    it("still lets a padded name be tidied when nothing else wears it", async () => {
        const {default: model} = await import("../../server/models/Targets.js");

        await targets.removeAll();
        const padded = await model.create({name: "Ookla ", provider: "ookla", sortOrder: 0});

        assert.equal((await patch(`/${padded.id}`, {name: "Ookla"})).status, 200);
    });

    // And renaming one of them onto the other is still refused: the door
    // stands for what a request is actually doing.
    it("still refuses a rename that takes the other one's name", async () => {
        const first = await targets.create({name: "Ookla", provider: "ookla"});
        await targets.create({name: "NAS", provider: "cloudflare"});

        assert.equal((await patch(`/${first.id}`, {name: "NAS"})).status, 400);
    });

    it("is stored trimmed however it arrives", async () => {
        const {body: {id}} = await put({name: "WAN", provider: "ookla"});

        assert.equal((await patch(`/${id}`, {name: "  Fibre  "})).status, 200);

        const [row] = await targets.listAll();
        assert.equal(row.name, "Fibre",
            "a padded PATCH survives, and the name-keyed restore stops matching it");
    });
});

describe("PATCH /api/targets/:id", () => {
    it("judges the row it would become, not the fragment that arrived", async () => {
        const {body: {id}} = await put({name: "own", provider: "libre"});

        // An endpoint is legal on libre - and this same fragment must be
        // refused once the row is an ookla target.
        assert.equal((await patch(`/${id}`, {endpoint: "https://speed.example.net"})).status, 200);
        assert.equal((await patch(`/${id}`, {provider: "ookla"})).status, 400,
            "the merged row carries a libre endpoint into a provider that takes none");
    });

    it("404s a target that does not exist", async () => {
        assert.equal((await patch("/999999", {name: "ghost"})).status, 404);
    });

    it("reorders the round by the given id sequence", async () => {
        const {body: {id: first}} = await put({name: "first", provider: "ookla"});
        const {body: {id: second}} = await put({name: "second", provider: "cloudflare"});

        assert.equal((await patch("/order", {ids: [second, first]})).status, 200);
        assert.deepEqual((await targets.listAll()).map((row) => row.name), ["second", "first"]);
    });
});

describe("DELETE /api/targets/:id", () => {
    it("removes the target and leaves its history rows orphaned, not gone", async () => {
        const {body: {id}} = await put({name: "gone", provider: "ookla"});
        await server.tests.create({ping: 10, download: 100, upload: 50, targetId: id,
            created: new Date().toISOString()});

        assert.equal((await api(server.baseUrl, `/targets/${id}`, {method: "DELETE"})).status, 200);

        assert.equal((await targets.listAll()).length, 0);
        const [row] = await server.tests.findAll();
        assert.equal(row.targetId, id, "the history was cascaded away with the target");
    });
});

describe("what a read-only visitor may know", () => {
    it("withholds endpoints, server ids and the alerts flag", async () => {
        await put({name: "own", provider: "libre", endpoint: "https://user:secret@speed.example.net",
            optimalPing: 5});
        await setConfig(server.config, "password", "Hunter2!");
        await setConfig(server.config, "passwordLevel", "read");

        try {
            const {status, body} = await api(server.baseUrl, "/targets");

            assert.equal(status, 200);
            assert.equal(body[0].name, "own");
            assert.equal(body[0].provider, "libre");
            assert.equal(body[0].optimalPing, 5, "the grading loses its limits");
            assert.ok(!("endpoint" in body[0]), "the endpoint - credential included - reached a viewer");
            assert.ok(!("serverId" in body[0]), "the server id reached a viewer");
            assert.ok(!("alerts" in body[0]));
        } finally {
            await setConfig(server.config, "password", "none");
            await setConfig(server.config, "passwordLevel", "none");
        }
    });
});

describe("the manual-only target", () => {
    /*
     * The unnamed run and the round it starts have to be asking the same
     * question. The route guarded on how many targets exist; the round it
     * starts resolves its members through roundTargets(), which are only the
     * scheduled ones - so an instance of nothing but manual-only targets was
     * answered 200 "Speedtest successfully created" and then measured nothing.
     * The toolbar toasted success and drew the gauge, no row was written, no
     * failure was reported and nothing was logged, while the per-row run button
     * beside it kept working - which reads as the start button being broken at
     * random.
     */
    it("is refused as a round of its own, rather than accepted and then not run", async () => {
        await put({name: "diagnostic", provider: "cloudflare", enabled: false});
        await put({name: "other box", provider: "cloudflare", enabled: false});

        const {status, body} = await api(server.baseUrl, "/speedtests/run", {method: "POST"});

        assert.equal(status, 410, "an unnamed run was accepted with nothing scheduled to run");
        assert.match(body.message, /scheduled/i,
            "the refusal does not say the targets exist but sit outside the schedule");

        // The point of the refusal is that the 200 was followed by nothing, so
        // the absence has to be asserted for longer than a round needs to write
        // its first row - the case below gets one within a second.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        assert.equal(await server.tests.count(), 0, "a run was started after all");
    });

    // The guard must refuse only the instance that has nothing to run, not the
    // ordinary one that keeps a diagnostic box beside its scheduled targets.
    it("does not stop the round when something beside it is scheduled", async () => {
        await put({name: "diagnostic", provider: "cloudflare", enabled: false});
        await put({name: "scheduled", provider: "cloudflare"});

        const {status} = await api(server.baseUrl, "/speedtests/run", {method: "POST"});
        assert.equal(status, 200);

        // Drained before the file moves on: no CLI is installed, so the round
        // fails in milliseconds, but leaving it in flight would meet the next
        // test with a 409 and the suite's close with an open database.
        for (let attempt = 0; attempt < 100; attempt++) {
            const {body} = await api(server.baseUrl, "/speedtests/status/live");
            if (!body.running) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    });

    it("never joins the round but runs by name", async () => {
        const {body: {id}} = await put({name: "diagnostic", provider: "cloudflare", enabled: false});

        assert.deepEqual(await targets.roundTargets(), [], "a disabled target joined the round");

        // No CLI is installed here, so the run fails in milliseconds - what
        // matters is that the row it writes belongs to the named target.
        const {status} = await api(server.baseUrl, "/speedtests/run", {
            method: "POST", headers: {"content-type": "application/json"},
            body: JSON.stringify({targetId: id})
        });
        assert.equal(status, 200);

        for (let attempt = 0; attempt < 50; attempt++) {
            if (await server.tests.count() > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        const [row] = await server.tests.findAll();
        assert.equal(row.targetId, id, "the manual run did not record against its target");
        assert.equal(row.provider, "cloudflare");
    });

    it("is not runnable by a name that does not exist", async () => {
        await put({name: "any", provider: "ookla"});

        const {status} = await api(server.baseUrl, "/speedtests/run", {
            method: "POST", headers: {"content-type": "application/json"},
            body: JSON.stringify({targetId: 999999})
        });

        assert.equal(status, 404);
    });
});
