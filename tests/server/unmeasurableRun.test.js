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
    });
});
