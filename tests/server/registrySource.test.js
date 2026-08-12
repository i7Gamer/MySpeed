import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
    embeddedClientSource, integrationRegistrySource, literal, migrationRegistrySource
} from "../../scripts/registrySource.js";

/**
 * The three code generators all built their string literals by interpolating a
 * filename between two single quotes. A filename holding a quote of its own -
 * `user's-webhook.js`, or any of the punctuation a designer drops into an asset
 * in client/public - therefore closed the literal early and emitted source that
 * does not parse. The build itself succeeded; the server then died on startup
 * with a SyntaxError pointing at a generated file nobody edits.
 *
 * Asserted by parsing, not by pattern-matching the output: what matters is
 * whether node accepts the file, and a regex agreeing with the generator only
 * proves the two were written by the same hand.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-gen-"));

after(() => fs.rmSync(tmp, {recursive: true, force: true}));

let counter = 0;

/** Whether node can parse the source as an ES module. Resolves nothing. */
const parses = (source) => {
    const file = path.join(tmp, `generated-${counter++}.mjs`);
    fs.writeFileSync(file, source);

    try {
        execFileSync(process.execPath, ["--check", file], {stdio: "pipe"});
        return null;
    } catch (error) {
        return String(error.stderr ?? error.message).split("\n").find((line) => line.includes("Error")) ?? "did not parse";
    }
};

// Names that are all legal on both Linux and macOS, and all fatal to a
// hand-quoted literal.
const HOSTILE = [
    "user's-webhook.js",
    'say-"hello".js',
    "back\\slash.js",
    "new\nline.js",
    "dollar-${x}.js"
];

const mimeFor = () => "text/plain";

describe("literal", () => {
    it("round-trips whatever it is given", () => {
        for (const value of ["plain", "it's", 'a "quote"', "back\\slash", "new\nline", "${x}"])
            assert.equal(JSON.parse(literal(value)), value);
    });

    it("produces something a parser accepts", () => {
        assert.equal(parses(`export default ${literal("it's a \"trap\"")};`), null);
    });
});

describe("integrationRegistrySource", () => {
    const NORMAL = ["discord.js", "gotify.js", "ntfy.js"];

    it("registers every file it is given", () => {
        const source = integrationRegistrySource(NORMAL);

        assert.equal(parses(source), null);
        for (const file of NORMAL)
            assert.ok(source.includes(literal(file.replace(/\.js$/, ""))), `${file} was not registered`);
    });

    /**
     * The emitted `name` has to stay exactly the filename stem: the controller
     * keys its registry off it, every stored row carries it, and the client
     * builds its translation keys and its PUT route from it.
     */
    it("names each integration after its file, unsanitised", () => {
        const source = integrationRegistrySource(["discord-webhook.js"]);

        assert.ok(source.includes(literal("discord-webhook")));
    });

    it("still emits a binding a parser accepts for an awkward filename", () => {
        assert.equal(parses(integrationRegistrySource(["discord-webhook.js", "2fa.js"])), null);
    });

    for (const file of HOSTILE) {
        it(`survives ${JSON.stringify(file)}`, () => {
            const failure = parses(integrationRegistrySource([file]));

            assert.equal(failure, null, `the generated registry does not parse: ${failure}`);
        });
    }
});

describe("migrationRegistrySource", () => {
    const NORMAL = ["0001-initial.js", "0002-add-jitter.js"];

    it("registers every migration in order", () => {
        const source = migrationRegistrySource(NORMAL);

        assert.equal(parses(source), null);
        assert.ok(source.indexOf(literal(NORMAL[0])) < source.indexOf(literal(NORMAL[1])));
    });

    /**
     * The name is the migration's own filename, which the runner records to
     * know what it has already applied - so it must survive verbatim.
     */
    it("names each migration by its full filename", () => {
        assert.ok(migrationRegistrySource(NORMAL).includes(literal("0001-initial.js")));
    });

    it("gives two migrations sharing a numeric prefix distinct bindings", () => {
        assert.equal(parses(migrationRegistrySource(["0007-a.js", "0007-b.js"])), null);
    });

    for (const file of HOSTILE) {
        it(`survives ${JSON.stringify(file)}`, () => {
            const failure = parses(migrationRegistrySource([`0001-${file}`]));

            assert.equal(failure, null, `the generated registry does not parse: ${failure}`);
        });
    }
});

describe("embeddedClientSource", () => {
    const NORMAL = ["index.html", "assets/index-abc.js"];

    it("embeds every file it is given", () => {
        const source = embeddedClientSource(NORMAL, mimeFor);

        assert.equal(parses(source), null);
        assert.ok(source.includes(literal("/index.html")));
        assert.ok(source.includes(literal("/assets/index-abc.js")));
    });

    it("serves index.html as the fallback when it is present", () => {
        assert.match(embeddedClientSource(NORMAL, mimeFor), /indexHtml\s*=\s*fs\.readFileSync/);
    });

    it("has no fallback when index.html was not built", () => {
        assert.match(embeddedClientSource(["assets/index-abc.js"], mimeFor), /indexHtml\s*=\s*null/);
    });

    /**
     * Bug 39: the cache is keyed by the decoded filename, and req.path keeps
     * its percent-encoding, so every asset with a space or a non-ascii
     * character missed and fell through to the SPA fallback.
     */
    it("decodes the request path before looking it up", () => {
        assert.match(embeddedClientSource(NORMAL, mimeFor), /decodeEmbedPath/);
    });

    for (const file of HOSTILE) {
        it(`survives ${JSON.stringify(file)}`, () => {
            const failure = parses(embeddedClientSource([`assets/${file}`], mimeFor));

            assert.equal(failure, null, `the generated embed does not parse: ${failure}`);
        });
    }

    it("survives a mime type with a quote in it", () => {
        assert.equal(parses(embeddedClientSource(["a.bin"], () => "application/x-it's")), null);
    });
});
