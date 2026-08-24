import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { integrationIdentifier, migrationIdentifier, moduleName } from "../../scripts/identifiers.js";

const SERVER_DIR = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "server");

const MIGRATION_FILE = /^\d{4}-.+\.js$/;

const migrationFiles = fs.readdirSync(path.join(SERVER_DIR, "migrations"))
    .filter((file) => MIGRATION_FILE.test(file)).sort();

const integrationFiles = fs.readdirSync(path.join(SERVER_DIR, "integrations"))
    .filter((file) => file.endsWith(".js") && file !== "index.js").sort();

/**
 * Whether a JS parser accepts the string as a binding.
 *
 * Compiled rather than matched against a pattern: the identifiers are written
 * into ES module source and it is the parser, not a regex, that decides whether
 * that source loads. Re-testing them against the same character class the code
 * sanitises with would only prove the class equals itself, and would have
 * happily passed the `import discord-webhook from ...` that started this.
 */
const parsesAsIdentifier = (name) => {
    try {
        new Function(`let ${name};`);
        return true;
    } catch {
        return false;
    }
};

/**
 * The integration names as they are today, frozen deliberately.
 *
 * These strings are what every stored IntegrationData row is keyed by, what
 * server/controller/integrations.js registers each module under, and the stem
 * of the client's `integrations.<name>.title` translation keys. Renaming one is
 * a data migration, not a refactor, so the sanitiser must never be allowed to
 * reach the name field and do it silently.
 */
const PINNED_INTEGRATION_NAMES = [
    "discord", "email", "gotify", "healthChecks", "influxdb", "ntfy", "pushover", "telegram", "webhook"
];

describe("the generated import identifiers", () => {
    it("finds files on disk to check", () => {
        assert.ok(migrationFiles.length > 0, "no migration files matched the naming convention");
        assert.ok(integrationFiles.length > 0, "no integration files found");
    });

    it("gives every migration on disk something the parser accepts", () => {
        migrationFiles.forEach((file, index) => {
            const identifier = migrationIdentifier(file, index);
            assert.ok(parsesAsIdentifier(identifier), `${file} yields "${identifier}", which is not an identifier`);
        });
    });

    it("gives every integration on disk something the parser accepts", () => {
        integrationFiles.forEach((file, index) => {
            const identifier = integrationIdentifier(file, index);
            assert.ok(parsesAsIdentifier(identifier), `${file} yields "${identifier}", which is not an identifier`);
        });
    });

    // The failure that prompted all of this: a hyphen is legal in a filename and
    // illegal in a binding, and the generator emitted it verbatim.
    it("survives a hyphenated integration filename", () => {
        const identifier = integrationIdentifier("discord-webhook.js", 0);

        assert.ok(parsesAsIdentifier(identifier), `"${identifier}" is not an identifier`);
        assert.equal(identifier, "i0_discord_webhook");
    });

    it("survives a hyphenated migration filename", () => {
        const identifier = migrationIdentifier("0001-initial-setup.js", 0);

        assert.ok(parsesAsIdentifier(identifier), `"${identifier}" is not an identifier`);
        assert.equal(identifier, "m0_0001_initial_setup");
    });

    it("strips only the extension from a dotted filename", () => {
        assert.equal(moduleName("my.helper.js"), "my.helper");
        assert.ok(parsesAsIdentifier(integrationIdentifier("my.helper.js", 3)));
        assert.equal(integrationIdentifier("my.helper.js", 3), "i3_my_helper");
    });

    // The unanchored replace took the *first* ".js" it found, so this filename
    // came back as "chart-helper.js" - inner segment gone, real extension still
    // attached, and the extension then sanitised into the identifier.
    it("leaves a .js inside the filename alone", () => {
        const file = "chart.js-helper.js";

        assert.equal(moduleName(file), "chart.js-helper");
        assert.notEqual(moduleName(file), file.replace(".js", ""));
        assert.equal(integrationIdentifier(file, 1), "i1_chart_js_helper");
    });

    // The same collision the migrations already guard against: "a-b" and "a_b"
    // sanitise to one name, and a duplicate binding takes the server down at
    // boot with a SyntaxError pointing at a generated file nobody edits. Only
    // the array index separates them - the identifier is local to the generated
    // file, so the prefix costs nothing.
    it("keeps two integrations that sanitise to the same name apart", () => {
        const identifiers = ["a-b.js", "a_b.js"].map(integrationIdentifier);

        assert.notEqual(identifiers[0], identifiers[1]);
        identifiers.forEach((identifier) => assert.ok(parsesAsIdentifier(identifier)));
    });

    // Two migrations authored against the same 4-digit prefix used to collapse
    // onto one `m0007`, which is a duplicate declaration.
    it("keeps two migrations sharing a prefix apart", () => {
        const files = ["0007-widen-error.js", "0007-add-column.js"];
        const identifiers = files.map(migrationIdentifier);

        assert.notEqual(identifiers[0], identifiers[1]);
        identifiers.forEach((identifier) => assert.ok(parsesAsIdentifier(identifier)));
    });

    // And these two collide even after sanitising - "0007-a.b" and "0007-a-b"
    // both become "0007_a_b". Only the array index separates them.
    it("keeps two migrations that sanitise to the same name apart", () => {
        const files = ["0007-a.b.js", "0007-a-b.js"];
        const identifiers = files.map(migrationIdentifier);

        assert.notEqual(identifiers[0], identifiers[1]);
    });

    it("gives every real migration its own identifier", () => {
        const identifiers = migrationFiles.map(migrationIdentifier);

        assert.equal(new Set(identifiers).size, identifiers.length, `duplicate identifier in ${identifiers.join(", ")}`);
    });

    it("gives every real integration its own identifier", () => {
        const identifiers = integrationFiles.map(integrationIdentifier);

        assert.equal(new Set(identifiers).size, identifiers.length, `duplicate identifier in ${identifiers.join(", ")}`);
    });

    it("emits the plain filename as the integration name", () => {
        assert.deepEqual(integrationFiles.map(moduleName), PINNED_INTEGRATION_NAMES);
    });

    // Read back out of the generated registry rather than recomputed, so the pin
    // still holds if a generator ever stops asking moduleName for the name.
    //
    // The literal is parsed rather than pattern-matched out of its quotes: the
    // generator emits it with JSON.stringify, so what a filename with a quote of
    // its own produces is a JSON string and nothing else.
    it("has written those exact names into the registry", () => {
        const generated = fs.readFileSync(path.join(SERVER_DIR, "integrations", "index.js"), "utf8");
        const names = [...generated.matchAll(/name: ("(?:[^"\\]|\\.)*")/g)]
            .map((match) => JSON.parse(match[1]));

        assert.deepEqual(names, PINNED_INTEGRATION_NAMES,
            'the registry is stale or renamed - run "npm run generate-integrations"');
    });
});
