import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripMarkdown } from "../../server/integrations/telegram.js";
import { DISCORD_MARKDOWN, stripMarkdown as stripFor } from "../../server/util/markdown.js";
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

/**
 * The other markdown sink, which had none of this.
 *
 * Discord renders an embed description as markdown too, and the default
 * template wraps `Ping`, `Upload` and `Download` in backticks of its own -
 * so an Ookla error naming its server as `fra-01` re-paired with them and part
 * of the sentence arrived as a code span with the delimiters gone from view.
 * Masked links are live in a description, so a `[text](url)` in provider output
 * became a link the operator never wrote. Two sinks, one hazard, one of them
 * handled: the pass had no shared home, which is how that happened.
 */
describe("the discord embed", () => {
    const DISCORD_TEMPLATE = ":x: **A speedtest has failed**\n > `Reason`: %error%";

    it("removes the characters discord renders as formatting", () => {
        const dirty = "Configuration - Couldn't connect to server `fra-01` **now** ~~gone~~ ||spoiler||";
        const {error} = stripFor({error: dirty}, DISCORD_MARKDOWN);

        for (const character of ["*", "_", "`", "~", "|", "[", "]", "\\"])
            assert.ok(!error.includes(character), `"${character}" survived in "${error}"`);
    });

    it("leaves the template's own backticks paired", () => {
        const message = replaceVariables(DISCORD_TEMPLATE,
            stripFor({error: "Couldn't connect to `fra-01`"}, DISCORD_MARKDOWN));

        assert.match(message, /`Reason`/, "the template lost its own formatting");
        assert.equal((message.match(/`/g) ?? []).length % 2, 0,
            "an unbalanced backtick from the error re-paired with the template's");
    });

    it("does not let provider output become a link", () => {
        const {error} = stripFor({error: "see [the docs](https://example.test/x)"}, DISCORD_MARKDOWN);

        assert.ok(!error.includes("["), "a masked link survived into the embed");
    });

    it("keeps the surrounding text readable", () => {
        assert.equal(stripFor({error: "*fatal*: `speedtest` failed"}, DISCORD_MARKDOWN).error,
            "fatal: speedtest failed");
    });

    it("leaves non-string values and an absent payload alone", () => {
        assert.deepEqual(stripFor({ping: 12, jitter: null}, DISCORD_MARKDOWN), {ping: 12, jitter: null});
        assert.deepEqual(stripFor(undefined, DISCORD_MARKDOWN), {});
    });

    // Telegram's set is unchanged by the move: a pipe or a tilde is not
    // formatting to its legacy parser, and stripping one would be a change to
    // the operator's text for nothing.
    it("does not strip more from telegram than telegram needs", () => {
        assert.equal(stripMarkdown({error: "rate |limited| ~approx~"}).error, "rate |limited| ~approx~");
    });
});

/**
 * And both integrations take the pass from the shared module rather than
 * carrying one, which is the state that let them differ.
 */
describe("the markdown pass", () => {
    const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
    const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

    for (const file of ["server/integrations/telegram.js", "server/integrations/discord.js"]) {
        it(`${path.basename(file)} cleans what it interpolates`, () => {
            const source = read(file);

            assert.match(source, /util\/markdown\.js/, `${file} does not use the shared pass`);
            assert.doesNotMatch(source, /replace\(\s*\/\[/,
                `${file} carries a character class of its own again`);
        });
    }
});
