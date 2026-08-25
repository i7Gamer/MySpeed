import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initialize, getIntegrations } from "../../server/controller/integrations.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const MODULES = path.join(ROOT, "server", "integrations");

before(async () => {
    await initialize();
});

/**
 * A field that substitutes variables, and a field that is offered them.
 *
 * The dialog draws its row of clickable %ping% chips under any field the
 * serialised definition hands it a `variables` array for, and the controller
 * attaches that array from TEMPLATE_VARIABLES, keyed by field name. Which is a
 * second list of field names, kept by hand, beside the modules that actually do
 * the substituting.
 *
 * Email's two subject lines fell in the gap. server/integrations/email.js has
 * always pushed finished_subject and error_subject through replaceVariables,
 * exactly as it does the message bodies - so they always accepted %download%,
 * and were the only templated fields never offered it. On screen the effect was
 * worse than nothing being there: the chips appeared under "Finished message"
 * and not under the "Finished subject" immediately above it, which reads as a
 * statement that the subject does not take variables.
 *
 * Nothing could catch it. The controller's own test asserts the fields it
 * registers get their array, which is true of whatever it registers; the
 * modules' tests assert the substitution happens, which it did. Both ends were
 * covered and the pairing was not.
 *
 * So the pairing is what this reads: the source, for every config field a module
 * hands to replaceVariables, against the definition the browser is served.
 */
const substitutingFields = () => fs.readdirSync(MODULES)
    .filter((file) => file.endsWith(".js") && file !== "index.js")
    .flatMap((file) => {
        const source = fs.readFileSync(path.join(MODULES, file), "utf8");

        // `replaceVariables(c.<field> || …` - the config value, not the default
        // beside it, which is a constant and never a field.
        return [...source.matchAll(/replaceVariables\(\s*\w+\.(\w+)\s*\|\|/g)]
            .map(([, field]) => ({integration: path.basename(file, ".js"), field}));
    });

describe("the template variables an integration offers", () => {
    it("finds fields that substitute, to check", () => {
        assert.ok(substitutingFields().length > 10,
            "no replaceVariables calls were found - the scan no longer matches how modules are written");
    });

    it("is offered for every field that actually substitutes them", () => {
        const definitions = getIntegrations();

        const unoffered = substitutingFields().filter(({integration, field}) => {
            const declared = definitions[integration]?.fields?.find((one) => one.name === field);

            // A module that substitutes into something it does not declare as a
            // field has no dialog row at all, which is a different fault and one
            // integrationFieldLabels.test.js already reports.
            return declared && !Array.isArray(declared.variables);
        }).map(({integration, field}) => `${integration}.${field}`);

        assert.deepEqual(unoffered, [],
            "these fields accept %variables% and the dialog offers none for them");
    });

    /**
     * The direction the registry was already written to guard, kept alongside
     * its mirror: offering a name that will not substitute leaves a literal
     * "%download%" in the message that arrives.
     */
    it("is not offered for a field that does not substitute them", () => {
        const substitutes = new Set(substitutingFields().map(({integration, field}) => `${integration}.${field}`));

        const overoffered = Object.entries(getIntegrations())
            .flatMap(([integration, definition]) => (definition.fields ?? [])
                .filter((field) => Array.isArray(field.variables))
                .map((field) => `${integration}.${field.name}`))
            .filter((key) => !substitutes.has(key));

        assert.deepEqual(overoffered, [],
            "these fields offer variables that nothing substitutes, so the name arrives verbatim");
    });
});
