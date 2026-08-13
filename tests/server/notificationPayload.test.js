import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    FAILED_VARIABLES, FINISHED_VARIABLES, failedPayload, finishedPayload
} from "../../server/util/notificationPayload.js";
import { DATE_VARIABLES, replaceVariables } from "../../server/util/helpers.js";

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

    it("offers the clock without being given it", () => {
        const substituted = replaceVariables(DATE_VARIABLES.map((name) => `%${name}%`).join("-"), {});

        assert.doesNotMatch(substituted, /%\w+%/);
        assert.match(substituted, /^\d{4}-/);
    });
});
