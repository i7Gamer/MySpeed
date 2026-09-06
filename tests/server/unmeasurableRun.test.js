import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import { isFailedTest } from "../../server/util/testOutcome.js";
import { parseData, CLOUDFLARE } from "../../server/util/providers/parseData.js";

/**
 * A run that measured nothing has to leave by the failure door.
 *
 * parseCloudflare is total on purpose: a CLI that prints metadata but no
 * measurement block is not an exception, and the edge that answered and the
 * address the test went out from are true of the attempt even when the
 * measurement is not. So it returns the failure placeholders with the identity
 * still attached rather than throwing.
 *
 * Which leaves the caller with a row every reader calls a failure, sitting on
 * the path that writes `error` as NULL. tasks/speedtest.js picks its path by
 * whether run() threw, so nothing on that path knew: the row was stored with no
 * error text at all, createRecommendations was handed it, healthchecks.io was
 * pinged on the *success* endpoint, and sendFinished told Discord, Telegram and
 * every webhook the test had completed at -1 Mbps. The minutePassed keep-alive
 * then read the stored row as failing and routed to /fail a minute later,
 * flapping the check that had just been told the run was fine.
 *
 * The parser and the writer disagreeing about whether a run failed is the bug.
 * The predicate they both read is the fix.
 */
describe("a run whose provider reported no measurement", () => {
    // Enough for the parser to name the edge and the address, and nothing else -
    // the shape the CLI prints when the measurement block never arrived.
    const metadataOnly = {metadata: {country: "CH", ip: "2a04:ee41:2:4256::1", colo: "ZRH"}};

    it("parses into a row the shared predicate calls a failure", () => {
        const parsed = parseData(CLOUDFLARE, metadataOnly);

        assert.equal(isFailedTest(parsed), true,
            "the placeholders no longer make an unmeasurable run a failure");
        assert.equal(parsed.serverName, "ZRH", "the identity worth keeping was dropped with them");
    });

    describe("the writer", () => {
        const source = readSource("server/tasks/speedtest.js");

        // Between the parse and the write, because that is the only place the
        // check does anything: after tests.create the row already exists with a
        // NULL error, and the notification has already been chosen.
        const betweenParseAndWrite = source.slice(
            source.indexOf("parseData.parseData("),
            source.indexOf("await tests.create("));

        it("refuses to write it as a success", () => {
            assert.match(betweenParseAndWrite, /isFailedTest\(/,
                "the success path stores an unmeasurable run with a NULL error");
            assert.match(betweenParseAndWrite, /throw /,
                "the run is recognised as failed and written down as successful anyway");
        });

        // The same predicate the readers use, not a fourth spelling of it. The
        // whole fault here was two answers to one question.
        it("asks the module that owns the question", () => {
            assert.match(source, /import\s*\{[^}]*isFailedTest[^}]*\}\s*from\s*['"][^'"]*testOutcome\.js['"]/,
                "the writer judges failure by a rule of its own again");
        });

        /**
         * The four nullable figures reach the row through usableFigure, which
         * turns a negative into null. The payload read the raw variables, so a
         * webhook was told "packetLoss: -1" about a row that stored NULL, and
         * a notifier template rendered "-1%" where the row says unmeasured.
         * Settled once, before the write, for both.
         */
        describe("the nullable figures", () => {
            const NULLABLE = ["jitter", "packetLoss", "downloadLatency", "uploadLatency"];
            const write = source.indexOf("await tests.create(");
            const send = source.indexOf("sendFinished(finishedPayload(");

            it("are settled through usableFigure before the row is written", () => {
                for (const figure of NULLABLE)
                    assert.match(betweenParseAndWrite, new RegExp(`^\\s*${figure} = usableFigure\\(${figure}\\);`, "m"),
                        `${figure} reaches the payload as the provider reported it`);
            });

            it("are not re-read raw by the write or the payload", () => {
                const createCall = source.slice(write, source.indexOf("console.log(`Test #", write));
                assert.doesNotMatch(createCall, /usableFigure\(/,
                    "the write sanitises inline, so the payload beside it reads something else");

                const betweenWriteAndSend = source.slice(write, send);
                assert.doesNotMatch(betweenWriteAndSend, new RegExp(`\\b(${NULLABLE.join("|")}) =[^=]`),
                    "a figure is rebound between the row and the payload, so the two disagree again");
            });
        });
    });
});
