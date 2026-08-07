import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripMarkdown } from "../../server/integrations/telegram.js";
import { replaceVariables } from "../../server/util/helpers.js";

const FAILURE_TEMPLATE = "❌ *A speedtest has failed*\n`Reason`: %error%";

describe("stripMarkdown", () => {
    it("leaves an ordinary message alone", () => {
        assert.deepEqual(stripMarkdown({error: "Connection refused"}), {error: "Connection refused"});
    });

    /**
     * Regression: Telegram parses the message as legacy markdown, which has no
     * escape syntax and rejects the whole request with a 400 when the
     * formatting does not balance. Speedtest errors are raw CLI output, so a
     * stray backtick or asterisk silently swallowed the failure notification -
     * precisely the one that needed to arrive.
     */
    it("removes the characters that break the parser", () => {
        const dirty = "Cannot open `./bin/speedtest`: *no such file* [errno 2]";
        const {error} = stripMarkdown({error: dirty});

        for (const character of ["*", "_", "`", "[", "]"])
            assert.ok(!error.includes(character), `"${character}" survived in "${error}"`);
    });

    it("keeps the surrounding text readable", () => {
        assert.equal(stripMarkdown({error: "*fatal*: `speedtest` failed"}).error, "fatal: speedtest failed");
    });

    it("leaves non-string values untouched", () => {
        assert.deepEqual(stripMarkdown({ping: 12, jitter: null}), {ping: 12, jitter: null});
    });

    it("tolerates being handed nothing", () => {
        assert.deepEqual(stripMarkdown(undefined), {});
    });

    // The operator writes the template, so its own formatting has to survive.
    it("does not touch the template's own markdown", () => {
        const message = replaceVariables(FAILURE_TEMPLATE, stripMarkdown({error: "a *bad* thing"}));

        assert.match(message, /\*A speedtest has failed\*/);
        assert.match(message, /`Reason`/);
        assert.equal((message.match(/\*/g) ?? []).length % 2, 0, "unbalanced asterisks would be rejected");
    });

    it("leaves the rendered message with balanced formatting", () => {
        const message = replaceVariables(FAILURE_TEMPLATE, stripMarkdown({error: "unclosed ` and *"}));

        assert.equal((message.match(/`/g) ?? []).length % 2, 0);
        assert.equal((message.match(/\*/g) ?? []).length % 2, 0);
    });
});
