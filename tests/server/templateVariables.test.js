import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { initialize, getIntegrations } from "../../server/controller/integrations.js";
import { FAILED_VARIABLES, FINISHED_VARIABLES } from "../../server/util/notificationPayload.js";

/**
 * A message template says which variables it accepts.
 *
 * The templates have always understood %ping% and the rest, and nothing
 * anywhere said so - the only hint was the example in the placeholder, which
 * disappears the moment anything is typed. Upstream #774 asks for the list to
 * be shown; the list has to come from the server, because that is where the
 * substitution happens and a second copy in the interface would drift the first
 * time a field was added to the payload.
 *
 * Declared per field rather than per integration: a template for a finished
 * test and one for a failure do not accept the same names, and offering a
 * variable that will not substitute leaves a literal "%download%" in the
 * message that arrives.
 */
before(async () => {
    await initialize();
});

const everyField = () => Object.entries(getIntegrations())
    .flatMap(([name, definition]) => definition.fields.map((field) => ({integration: name, field})));

const FINISHED_TEMPLATE = "finished_message";
const FAILED_TEMPLATE = "error_message";

/**
 * A field whose value is a template, told by the name it is declared under.
 *
 * A convention, not the rule: the rule is whether the module puts the value
 * through replaceVariables, and that pairing is held in
 * tests/server/templateVariableOffers.test.js, which reads the modules. This is
 * the cheaper half - it catches a credential or a URL that has somehow grown a
 * variables array, where a list under it would say the opposite of the truth.
 *
 * The subjects are here because email substitutes into them exactly as it does
 * the bodies. While this said "_message" alone it was asserting the naming
 * convention rather than the behaviour, and it passed for as long as the two
 * agreed - which ended the moment the subjects were offered the variables they
 * had always accepted.
 */
const TEMPLATE_SUFFIXES = ["_message", "_subject"];

const isTemplateName = (name) => TEMPLATE_SUFFIXES.some((suffix) => name.endsWith(suffix));

describe("the variables a template advertises", () => {
    it("finds fields to check", () => {
        assert.ok(everyField().length > 40);
    });

    it("offers the finished-test names on a finished-test template", () => {
        const templates = everyField().filter(({field}) => field.name === FINISHED_TEMPLATE);

        assert.ok(templates.length >= 5, `only found ${templates.length} finished templates`);
        for (const {integration, field} of templates)
            assert.deepEqual(field.variables, FINISHED_VARIABLES, `${integration} offers the wrong list`);
    });

    it("offers the failure names on a failure template", () => {
        const templates = everyField().filter(({field}) => field.name === FAILED_TEMPLATE);

        assert.ok(templates.length >= 5, `only found ${templates.length} failure templates`);
        for (const {integration, field} of templates)
            assert.deepEqual(field.variables, FAILED_VARIABLES, `${integration} offers the wrong list`);
    });

    /**
     * The rule, rather than the two names it happens to match today. A module
     * adding a third template would otherwise get an input that silently
     * advertises nothing.
     */
    it("leaves no message template without a list", () => {
        const bare = everyField()
            .filter(({field}) => isTemplateName(field.name) && !field.variables)
            .map(({integration, field}) => `${integration}.${field.name}`);

        assert.deepEqual(bare, [], "these templates accept variables but advertise none");
    });

    // A credential or a URL substitutes nothing, and a list under it would say
    // the opposite.
    it("advertises nothing on a field that is not a template", () => {
        const wrong = everyField()
            .filter(({field}) => field.variables && !isTemplateName(field.name))
            .map(({integration, field}) => `${integration}.${field.name}`);

        assert.deepEqual(wrong, []);
    });

    // The definitions travel to the client through a shallow copy per field, so
    // anything declared on one arrives - but only if it is on the definition
    // initialize() stored rather than added to the copy.
    it("survives the trip to the client", () => {
        const finished = getIntegrations().telegram.fields.find((field) => field.name === "finished_message");

        assert.ok(Array.isArray(finished.variables));
        assert.ok(finished.variables.includes("ping"));
        assert.ok(finished.variables.includes("provider"), "the newly carried fields are offered too");
    });
});
