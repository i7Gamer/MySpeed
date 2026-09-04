import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIALOG = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..",
    "client", "src", "common", "components", "PasswordDialog", "PasswordDialog.jsx");

const source = fs.readFileSync(DIALOG, "utf8");

/**
 * patchRequest hands back the raw Response, so the dialog used to await it and
 * toast "changes applied" whatever the status was. With the server now
 * refusing weak passwords with a 400, that would have reported success while
 * the instance kept its old password - the refusal has to reach the operator.
 */
describe("the password dialog surfaces a refused password", () => {
    it("checks the response instead of assuming success", () => {
        assert.match(source, /assertOk\(await patchRequest\("\/config\/password"/,
            "the password PATCH is not checked with assertOk");
    });

    it("shows the server's own refusal, which names the broken rule", () => {
        assert.match(source, /instanceof RequestError \? e\.message/,
            "a refusal falls back to the generic 'changes unsaved' toast");
    });
});

/**
 * The removal too. It threw a bare Error on a refused DELETE, which the catch
 * reads as "not a RequestError" and reports with the generic line - so the
 * one refusal that route gives, the preview instance's read-only message,
 * never reached the toast.
 */
describe("the password dialog surfaces a refused removal", () => {
    it("checks the DELETE with assertOk like the PATCH beside it", () => {
        assert.match(source, /assertOk\(await deleteRequest\("\/config\/password"\)/,
            "the password DELETE is not checked with assertOk");
        assert.doesNotMatch(source, /Removing the password failed with status/,
            "the removal still throws a bare Error that the catch cannot name");
    });
});
