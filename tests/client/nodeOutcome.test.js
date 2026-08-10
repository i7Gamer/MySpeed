import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    describeNodeOutcome, OUTCOME_CREATED, OUTCOME_ERROR, OUTCOME_INVALID_URL, OUTCOME_PASSWORD
} from "../../client/src/pages/Nodes/utils/outcome.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

/**
 * The create-node dialog used to branch on three response types and fall off
 * the end for everything else: submitting the empty form (MISSING_PARAMETERS)
 * did nothing at all, and the server's specific refusals - "This host is not
 * in ALLOWED_NODE_HOSTS" among them - were collapsed into a bare red border.
 */
describe("describeNodeOutcome", () => {
    it("recognises a created node", () => {
        assert.deepEqual(describeNodeOutcome({type: "NODE_CREATED", id: 3}), {kind: OUTCOME_CREATED});
    });

    it("recognises a node that wants a password", () => {
        assert.equal(describeNodeOutcome({type: "PASSWORD_REQUIRED"}).kind, OUTCOME_PASSWORD);
    });

    it("carries the server's own reason for a refused url", () => {
        const outcome = describeNodeOutcome({type: "INVALID_URL", message: "This host is not in ALLOWED_NODE_HOSTS"});

        assert.equal(outcome.kind, OUTCOME_INVALID_URL);
        assert.equal(outcome.message, "This host is not in ALLOWED_NODE_HOSTS");
    });

    it("turns an unhandled type into an error instead of silence", () => {
        const outcome = describeNodeOutcome({type: "MISSING_PARAMETERS", message: "Missing parameters"});

        assert.equal(outcome.kind, OUTCOME_ERROR);
        assert.equal(outcome.message, "Missing parameters");
    });

    it("survives a body with nothing usable in it", () => {
        assert.equal(describeNodeOutcome(null).kind, OUTCOME_ERROR);
        assert.equal(describeNodeOutcome({}).kind, OUTCOME_ERROR);
    });
});

/**
 * Both node dialogs used to hand-roll a recursive ask-again loop for the
 * password. promptUntilAccepted exists precisely so the prompts cannot drift
 * apart - the shared loop is what the admin login and the unauthenticated
 * page already use.
 */
describe("the node dialogs share the password loop", () => {
    for (const file of [
        "pages/Nodes/components/CreateNodeDialog/CreateNodeDialog.jsx",
        "pages/Nodes/components/NodeContainer/NodeContainer.jsx"
    ]) {
        const name = path.basename(file, ".jsx");
        const source = read(file);

        it(`${name} uses promptUntilAccepted`, () => {
            assert.match(source, /promptUntilAccepted\(/, `${name} still hand-rolls the retry loop`);
        });
    }

    it("the create dialog names the refusal instead of only a red border", () => {
        const source = read("pages/Nodes/components/CreateNodeDialog/CreateNodeDialog.jsx");

        assert.match(source, /describeNodeOutcome/, "the dialog does not classify the response");
        assert.match(source, /\{urlError\}/, "the server's reason is never rendered");
    });

    it("the node card no longer carries the dead length check", () => {
        const source = read("pages/Nodes/components/NodeContainer/NodeContainer.jsx");

        assert.doesNotMatch(source, /length < 0/, "tests.length < 0 is always false");
    });
});
