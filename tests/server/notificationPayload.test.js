import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    FAILED_VARIABLES, FINISHED_VARIABLES, failedPayload, finishedPayload, rowValues
} from "../../server/util/notificationPayload.js";
import { readSource } from "../helpers/source.js";
import { DATE_VARIABLES, replaceVariables } from "../../server/util/helpers.js";
import { BASELINE_ARMED, BASELINE_BREACHED } from "../../server/util/alertThreshold.js";
import {
    MAX_OFFSET_MINUTES, localWallClock, serverZone, zoneFromName, zoneFromOffset
} from "../../server/util/timezone.js";

/**
 * What an integration is told about a test.
 *
 * It used to be five numbers - ping, jitter, download, upload and the duration
 * - while the row being written beside it already recorded which provider ran
 * the test, which server it reached, what the connection looked like from
 * outside, what the run cost in traffic and how much was lost. Upstream #1250
 * asks for that, and #1049 for the server id in particular: a webhook is how
 * MySpeed feeds anything else, and a consumer that cannot tell which server or
 * which provider produced a number cannot do much with it.
 *
 * The keys are the column names, so a webhook consumer, the CSV export and the
 * API all describe a test with the same vocabulary.
 */
const RECORD = {
    id: 4711,
    created: "2026-08-13T09:15:00.000Z",
    provider: "ookla",
    ping: 12.64, jitter: 3.46, download: 512.5, upload: 204.25, time: 14,
    packetLoss: 0, downloadLatency: 41.2, uploadLatency: 88.9,
    serverId: 1234, serverName: "Frankfurt", serverHost: "fra.example.net:8080",
    isp: "Deutsche Telekom", externalIp: "203.0.113.7",
    resultId: "abc123",
    bytesDownloaded: 2_100_000_000, bytesUploaded: 850_000_000
};

describe("finishedPayload", () => {
    it("carries every measurement the row recorded", () => {
        const payload = finishedPayload(RECORD);

        for (const [key, value] of Object.entries(RECORD))
            assert.equal(payload[key], value, `${key} was dropped`);
    });

    // The five it always sent. A consumer written against the old shape keeps
    // reading exactly what it read before.
    it("still carries the fields it always did", () => {
        const payload = finishedPayload(RECORD);

        assert.deepEqual(
            {ping: payload.ping, jitter: payload.jitter, download: payload.download,
                upload: payload.upload, time: payload.time},
            {ping: 12.64, jitter: 3.46, download: 512.5, upload: 204.25, time: 14});
    });

    /**
     * Flat on purpose. Every key becomes a %variable% a message template can
     * use, and an object nested under one of them would substitute into a
     * message as "[object Object]".
     */
    it("nests nothing", () => {
        for (const [key, value] of Object.entries(finishedPayload(RECORD)))
            assert.ok(value === null || typeof value !== "object",
                `${key} is an object and would render as [object Object]`);
    });

    /**
     * An absent measurement stays absent rather than becoming zero. Only ookla
     * reports packet loss and the loaded latencies, and a provider that never
     * looked must not report a flawless line.
     */
    it("keeps what was not measured as null", () => {
        const payload = finishedPayload({...RECORD, packetLoss: null, isp: null, bytesDownloaded: null});

        assert.equal(payload.packetLoss, null);
        assert.equal(payload.isp, null);
        assert.equal(payload.bytesDownloaded, null);
    });

    /**
     * A template naming a variable the provider did not report should read as
     * unmeasured rather than be left in the message as a literal "%isp%".
     *
     * The payload carries the measurement names; the clock names beside them in
     * the advertised list are supplied by replaceVariables, not by the record.
     */
    it("answers with every key even for a record that carries none of them", () => {
        const payload = finishedPayload({});
        const expected = FINISHED_VARIABLES.filter((name) => !DATE_VARIABLES.includes(name));

        assert.deepEqual(Object.keys(payload).sort(), expected.sort());
        for (const key of expected) assert.equal(payload[key], null, `${key} is not null`);
    });

    /**
     * Which member the base topics and unlabelled series speak for. The MQTT
     * module routes secondary members to subtopics on exactly this flag - the
     * payload is the one thing a broker-side module can read without a
     * database - and a payload from an older node carries null, which every
     * reader treats as the primary: the way the single-target instance always
     * behaved.
     */
    it("says whether the member is the one the base topics speak for", () => {
        assert.equal(finishedPayload({...RECORD, primary: true}).primary, true);
        assert.equal(finishedPayload({...RECORD, primary: false}).primary, false);
        assert.equal(failedPayload({error: "boom", primary: false}).primary, false);
        assert.equal(finishedPayload(RECORD).primary, null);
    });

    /**
     * And whether the member takes part in alerting, because that is what
     * routes the fan-out: a member with alerts off still reaches every data
     * sink - suppressesEvent quiets the notifiers on exactly this flag - so
     * the payload has to carry the answer. Null from an older node, which the
     * gate reads as alerting: the way the single-target instance always
     * behaved.
     */
    it("says whether the member takes part in alerting", () => {
        assert.equal(finishedPayload({...RECORD, alerts: false}).alerts, false);
        assert.equal(finishedPayload({...RECORD, alerts: true}).alerts, true);
        assert.equal(failedPayload({error: "boom", alerts: false}).alerts, false);
        assert.equal(finishedPayload(RECORD).alerts, null);
    });
});

/**
 * And what this target's own line usually delivers, beside what it just did.
 *
 * The verdict is decided in util/baselineAlert.js before the row is written and
 * travels here for the same reason `alerts` and `primary` do: the gate that
 * reads it touches no database. Adding the names to FINISHED_KEYS is the whole
 * of the work - FINISHED_VARIABLES is derived from it, and that is the list the
 * integration dialog offers as the chips a template may use.
 */
describe("the baseline a member was judged against", () => {
    const JUDGED = {...RECORD, baselineArmed: true, baselineBreached: true,
        baselineDownload: 500, baselineUpload: 200};

    it("carries the verdict and the yardstick it was reached with", () => {
        const payload = finishedPayload(JUDGED);

        assert.equal(payload.baselineArmed, true);
        assert.equal(payload.baselineBreached, true);
        assert.equal(payload.baselineDownload, 500);
        assert.equal(payload.baselineUpload, 200);
    });

    /**
     * Null on every target that set no baseline, and on every payload a node
     * older than the feature produced. The gate reads either as "no baseline",
     * the way it reads an absent `alerts` as alerting.
     */
    it("carries null for a member that has none", () => {
        const payload = finishedPayload(RECORD);

        for (const key of ["baselineArmed", "baselineBreached", "baselineDownload", "baselineUpload"])
            assert.equal(payload[key], null, `${key} is not null`);
    });

    // The names the gate looks for are the names the payload carries. Taken
    // from the module that reads them as a decision, so a rename cannot leave a
    // chip in the dialog that substitutes nothing.
    it("names them the way the alert gate reads them", () => {
        assert.ok(FINISHED_VARIABLES.includes(BASELINE_ARMED));
        assert.ok(FINISHED_VARIABLES.includes(BASELINE_BREACHED));
    });

    /**
     * Deliberately not on a failed test. There is no measurement to compare, so
     * every one of the four would be null in a message that already says the
     * run failed - and a failure notifies unconditionally, so an armed baseline
     * there would decide nothing.
     */
    it("is offered on a finished test and not on a failed one", () => {
        for (const key of ["baselineArmed", "baselineBreached", "baselineDownload", "baselineUpload"]) {
            assert.ok(FINISHED_VARIABLES.includes(key), `${key} is not offered to a finished message`);
            assert.equal(FAILED_VARIABLES.includes(key), false,
                `${key} is offered to a failed message, which carries no measurement`);
        }

        assert.equal("baselineArmed" in failedPayload(JUDGED), false);
    });
});

describe("failedPayload", () => {
    it("names the reason and the provider that could not complete", () => {
        const payload = failedPayload({error: "no route to host", provider: "libre", id: 12,
            created: "2026-08-13T09:15:00.000Z"});

        assert.equal(payload.error, "no route to host");
        assert.equal(payload.provider, "libre");
        assert.equal(payload.id, 12);
    });

    it("answers with every key it advertises", () => {
        const expected = FAILED_VARIABLES.filter((name) => !DATE_VARIABLES.includes(name));

        assert.deepEqual(Object.keys(failedPayload({})).sort(), expected.sort());
    });
});

/**
 * The advertised list and the payload cannot drift.
 *
 * The interface offers these names to the operator writing a message template,
 * so a name advertised but never substituted leaves a literal "%isp%" in the
 * message that arrives.
 */
describe("the advertised variables", () => {
    it("are exactly what a finished test substitutes", () => {
        const substituted = replaceVariables(
            FINISHED_VARIABLES.map((name) => `%${name}%`).join("|"), finishedPayload(RECORD));

        assert.doesNotMatch(substituted, /%\w+%/, "a variable was advertised but not substituted");
    });

    it("are exactly what a failed test substitutes", () => {
        const substituted = replaceVariables(
            FAILED_VARIABLES.map((name) => `%${name}%`).join("|"), failedPayload({error: "boom"}));

        assert.doesNotMatch(substituted, /%\w+%/, "a variable was advertised but not substituted");
    });

    // The clock variables are added by replaceVariables itself rather than by
    // the payload, and are usable in either kind of message.
    it("include the date and time in both", () => {
        for (const list of [FINISHED_VARIABLES, FAILED_VARIABLES])
            for (const name of DATE_VARIABLES)
                assert.ok(list.includes(name), `${name} is missing from the advertised list`);
    });

    it("advertise no name twice", () => {
        for (const list of [FINISHED_VARIABLES, FAILED_VARIABLES])
            assert.equal(new Set(list).size, list.length, `duplicate in ${list.join(", ")}`);
    });
});

/**
 * A measurement no provider reported has to read as something in a sentence.
 *
 * The payload carries an honest null, which is right for the webhook's JSON but
 * renders as the word "null" when substituted into a message - "Ping: 12 ms
 * (±null ms)" was already going out for providers that do not measure jitter,
 * and widening the payload turns one such case into a dozen.
 */
describe("replaceVariables", () => {
    it("substitutes every value it is given", () => {
        assert.equal(replaceVariables("%ping% / %download%", {ping: 12, download: 500}), "12 / 500");
    });

    it("replaces every occurrence, not just the first", () => {
        assert.equal(replaceVariables("%ping% %ping%", {ping: 12}), "12 12");
    });

    it("writes an unmeasured value as N/A rather than as null", () => {
        assert.equal(replaceVariables("%jitter%", {jitter: null}), "N/A");
        assert.equal(replaceVariables("%isp%", {isp: undefined}), "N/A");
    });

    // Zero is a measurement - a line that lost no packets - and must not be
    // swept into the same bucket as one that was never measured.
    it("keeps a measured zero", () => {
        assert.equal(replaceVariables("%packetLoss%", {packetLoss: 0}), "0");
    });

    it("leaves a name it was given no value for alone", () => {
        assert.equal(replaceVariables("%unknown%", {ping: 12}), "%unknown%");
    });

    /**
     * A value is written verbatim, dollars and all.
     *
     * `$&`, `` $` ``, `$'` and `$$` all mean something in a string replacement,
     * and the payload now carries text a remote provider chose - the server's
     * name, its location, the ISP, the external address, the failure reason.
     * A server called "ACME $& Co" wrote the placeholder itself back into the
     * message that was delivered. Before the payload was widened every value
     * here was a number, so nothing could carry a dollar at all.
     */
    it("writes a value containing a dollar sequence verbatim", () => {
        assert.equal(replaceVariables("Server: %serverName%", {serverName: "ACME $& Co"}),
            "Server: ACME $& Co");
        assert.equal(replaceVariables("ISP %isp%", {isp: "X$`Y"}), "ISP X$`Y");
        assert.equal(replaceVariables("[%error%]", {error: "boom $' tail"}), "[boom $' tail]");
        assert.equal(replaceVariables("%provider%", {provider: "a$$b"}), "a$$b");
    });

    /**
     * A substituted value is the end of the substitution, not more template.
     *
     * The names were replaced one after another, so a value written early that
     * happened to spell a later name was replaced again on that name's turn.
     * The payload's own key order puts serverName ahead of isp, externalIp,
     * resultId and both byte counts, and a provider chooses the server's name.
     */
    it("does not substitute again inside a value it just wrote", () => {
        assert.equal(
            replaceVariables("Server: %serverName% ISP: %isp%",
                {serverName: "Host %isp% Ltd", isp: "Deutsche Telekom"}),
            "Server: Host %isp% Ltd ISP: Deutsche Telekom");
    });

    it("offers the clock without being given it", () => {
        const substituted = replaceVariables(DATE_VARIABLES.map((name) => `%${name}%`).join("-"), {});

        assert.doesNotMatch(substituted, /%\w+%/);
        assert.match(substituted, /^\d{4}-/);
    });

    // The contract the dispatch point is built around: the zone is resolved
    // once, up there, and handed down - because an async replaceVariables would
    // hand every `balancedForTelegram(replaceVariables(...))` a promise, and
    // every synchronous assertion in this file and in telegramMarkdown.test.js
    // would be asserting against "[object Promise]".
    it("answers with the message rather than a promise for it", () => {
        assert.equal(typeof replaceVariables("%hour%", {}), "string");
    });
});

/**
 * And it says what the instance's clock says, not what the process's does.
 *
 * The six clock names were built from `new Date().getHours()` and its siblings
 * - the host clock - while the schedule, the digests, the quiet hours and the
 * /status countdown all resolve the stored `timezone` setting, which exists
 * because the Docker image pins `ENV TZ=Etc/UTC`. So a Berlin instance sent
 * "09:14" for a test that ran at 11:14, using a chip the notification dialog
 * itself offers.
 */
describe("the clock a message is written on", () => {
    const MINUTES_PER_HOUR = 60;
    const SHIFT_HOURS = 6;

    const pad = (value) => String(value).padStart(2, "0");

    /**
     * A zone six hours from whatever this host's own is.
     *
     * Not a fixed named zone: on a machine already in that zone the case would
     * coincide with the default and assert nothing, which is the shape of
     * vacuously-green this whole fix exists to avoid. Whichever direction keeps
     * the offset inside the range zoneFromOffset accepts.
     */
    const elsewhere = () => {
        const host = new Date().getTimezoneOffset();
        const shift = SHIFT_HOURS * MINUTES_PER_HOUR;
        const offset = Math.abs(host + shift) <= MAX_OFFSET_MINUTES ? host + shift : host - shift;

        return zoneFromOffset(offset).zone;
    };

    /**
     * What a zone's wall clock reads right now, in the shape the template
     * renders it.
     *
     * Read either side of the substitution by every case below, because the
     * instant is replaceVariables' own: one taken before and one after cannot
     * both be on the wrong side of a minute boundary, so accepting either is
     * exact rather than tolerant.
     */
    const clockOn = (zone) => {
        const wall = localWallClock(zone, new Date());

        return `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`;
    };

    const rendered = (zone) => {
        const before = clockOn(zone);
        const substituted = replaceVariables("%hour%:%minute%", {}, zone);

        return {substituted, acceptable: [before, clockOn(zone)]};
    };

    it("reads the zone it is given rather than the host's", () => {
        const zone = elsewhere();
        const {substituted, acceptable} = rendered(zone);

        assert.ok(acceptable.includes(substituted),
            `rendered ${substituted}, and the zone's own clock read ${acceptable.join(" then ")}`);
        assert.notEqual(substituted, clockOn(serverZone),
            "the zone made no difference, so the host clock is still what a message says");
    });

    /**
     * The default, which is what makes an un-migrated call site a genuine
     * no-op rather than a half-fix: localWallClock(serverZone, now) shifts by
     * exactly the offset getHours() would have applied, so the six parts come
     * out bit-identical to the host getters they replaced.
     */
    it("falls back to the host's clock when it is given none", () => {
        const before = clockOn(serverZone);
        const substituted = replaceVariables("%hour%:%minute%", {});

        assert.ok([before, clockOn(serverZone)].includes(substituted));
    });

    it("answers the same for the host zone spelt out as for no zone at all", () => {
        assert.ok(rendered(serverZone).acceptable.includes(replaceVariables("%hour%:%minute%", {})));
    });

    // All six, not just the two the cases above read: a zone that moves the
    // hour past midnight moves the date with it, and the year on New Year's Eve.
    it("builds every one of the six from that zone", () => {
        const zone = zoneFromName("Asia/Tokyo");
        const wall = localWallClock(zone, new Date());

        const expected = {
            year: String(wall.getUTCFullYear()), month: pad(wall.getUTCMonth() + 1),
            day: pad(wall.getUTCDate()), hour: pad(wall.getUTCHours()),
            minute: pad(wall.getUTCMinutes()), second: pad(wall.getUTCSeconds())
        };

        for (const name of DATE_VARIABLES) {
            const substituted = replaceVariables(`%${name}%`, {}, zone);

            // The second may have turned between the reading above and the
            // substitution, and a turning second carries the minute, the hour
            // and the date with it at a boundary - so the reading is taken
            // again rather than the case being loosened.
            const after = localWallClock(zone, new Date());
            const now = {
                year: String(after.getUTCFullYear()), month: pad(after.getUTCMonth() + 1),
                day: pad(after.getUTCDate()), hour: pad(after.getUTCHours()),
                minute: pad(after.getUTCMinutes()), second: pad(after.getUTCSeconds())
            };

            assert.ok([expected[name], now[name]].includes(substituted),
                `%${name}% rendered ${substituted}, not ${expected[name]}`);
        }
    });

    // A value the payload carries still wins over the clock, which is what
    // lets a template name a column called `day` without the clock eating it.
    it("lets a given value override the clock name it shares", () => {
        assert.equal(replaceVariables("%hour%", {hour: "given"}, zoneFromName("Asia/Tokyo")), "given");
    });
});

/**
 * The row as a spreadable object.
 *
 * tests.create answers a Sequelize instance, not the plain row the global
 * `query: {raw: true}` hands back from a read. An instance keeps its columns
 * behind prototype getters, and a spread copies own enumerable properties
 * only - so `{...testResult}` carried dataValues and bookkeeping and not one
 * column, and every integration was told `id: null, created: null` about a
 * test the log line beside it had just numbered.
 */
describe("rowValues", () => {
    it("reads an instance's columns, not its bookkeeping", async () => {
        const { Sequelize, DataTypes } = await import("sequelize");
        const db = new Sequelize({dialect: "sqlite", dialectModule: {}, logging: false, query: {raw: true}});
        const model = db.define("rows", {created: DataTypes.DATE}, {timestamps: false});
        const instance = model.build({id: 4711, created: new Date("2026-08-13T09:15:00.000Z")});

        assert.deepEqual({...instance}.id, undefined, "the spread this replaces already carried the id");
        const values = rowValues(instance);
        assert.equal(values.id, 4711);
        assert.equal(values.created.toISOString(), "2026-08-13T09:15:00.000Z");
        assert.equal("dataValues" in values, false);
    });

    it("hands a plain row back as it is", () => {
        assert.equal(rowValues(RECORD), RECORD);
    });

    it("tolerates a missing row", () => {
        assert.deepEqual(rowValues(undefined), {});
        assert.deepEqual(rowValues(null), {});
    });

    // Both sites, and a spread through the helper rather than of the row: a
    // third notification added beside these would otherwise start out with the
    // very bug this fixed.
    it("is what the speedtest task spreads into both notifications", () => {
        const source = readSource("server/tasks/speedtest.js");
        assert.match(source, /sendFinished\(finishedPayload\(\{\.\.\.rowValues\(testResult\)/);
        assert.match(source, /sendError\(failedPayload\(\{\.\.\.rowValues\(testResult\)/);
        assert.doesNotMatch(source, /\{\.\.\.testResult\b/, "a bare spread of the instance");
    });
});
