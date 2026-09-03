import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_RETENTION_DAYS } from "@/common/components/StorageDialog/tabs/Speedtests.jsx";
import { MAX_RETENTION_DAYS as SERVER_MAX_RETENTION_DAYS, validateInput } from "../../server/controller/config.js";
import { readSource } from "../helpers/source.js";

/**
 * The retention ceiling, held to the rule that enforces it.
 *
 * The dialog spells this number twice - once in the input's `max`, once in the
 * check that greys Save - and the server names it in the refusal it answers a
 * larger value with. The two agreed, and nothing said so: every other rule
 * duplicated across the two sides here has a pin of its own (the iperf3 host,
 * the tuning bounds, the baseline percentage, the quiet hours), because a
 * ceiling that drifts is a spinner that steps to a value the save then refuses,
 * or one that stops short of what the server would have taken.
 *
 * Written the way tuningParity is: both sides imported directly, the client's
 * through the alias the bundler gives it and the server's by path.
 */
describe("the retention ceiling", () => {
    it("is the same number on both sides", () => {
        assert.equal(MAX_RETENTION_DAYS, SERVER_MAX_RETENTION_DAYS,
            "the field offers a retention the server does not take, or stops short of one it does");
    });

    // And it is the number the door actually enforces, not merely a constant
    // the door happens to also hold: the ceiling itself saves, and one day
    // past it is refused.
    it("is where the door draws its line", async () => {
        assert.deepEqual(await validateInput("retentionDays", String(MAX_RETENTION_DAYS)),
            {value: String(MAX_RETENTION_DAYS)}, "the ceiling itself was refused");

        assert.equal(typeof await validateInput("retentionDays", String(MAX_RETENTION_DAYS + 1)), "string",
            "a day past the ceiling was taken");
    });

    /**
     * And the dialog states it from the constant rather than from a copy.
     *
     * Read as text, because what is asserted is that the number reaches the
     * input and the Save gate through the name - a second literal would agree
     * with this file for exactly as long as nobody changes the server's.
     */
    it("reaches the field and the Save gate by name", () => {
        const source = readSource("client/src/common/components/StorageDialog/tabs/Speedtests.jsx");

        assert.match(source, /max=\{String\(MAX_RETENTION_DAYS\)\}/,
            "the input's ceiling is not the shared constant");
        assert.match(source, /currentRetentionDays <= MAX_RETENTION_DAYS/,
            "the Save gate's ceiling is not the shared constant");
        assert.equal(source.split(String(MAX_RETENTION_DAYS)).length - 1, 1,
            "the ceiling is spelled as a literal somewhere other than its own declaration");
    });
});
