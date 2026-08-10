import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { passwordPolicyProblem } from "../../server/controller/config.js";

/**
 * The floor a chosen password has to clear: at least 8 characters, both lower
 * and upper case, and at least one number or special character. This is the
 * admin credential of an instance that may face the open internet, and until
 * now a single character was accepted.
 */
describe("passwordPolicyProblem", () => {
    it("accepts a password that clears every rule", () => {
        for (const good of ["Hunter2!", "Pa ss Wörd", "Aa1:b:c!", "CorrectHorse9", "A2345bcd"])
            assert.equal(passwordPolicyProblem(good), null, `${good} was refused`);
    });

    it("refuses fewer than 8 characters, and says so", () => {
        assert.match(passwordPolicyProblem("Sh0rt!"), /at least 8 characters/);
    });

    it("refuses a password without an upper case letter", () => {
        assert.match(passwordPolicyProblem("alllower1!"), /lower and upper case/);
    });

    it("refuses a password without a lower case letter", () => {
        assert.match(passwordPolicyProblem("ALLUPPER1!"), /lower and upper case/);
    });

    it("refuses letters alone, without a number or special character", () => {
        assert.match(passwordPolicyProblem("OnlyLetters"), /number or a special character/);
    });

    it("counts a space as a special character", () => {
        assert.equal(passwordPolicyProblem("Pa ss word"), null);
    });

    it("names the length first when several rules are broken", () => {
        assert.match(passwordPolicyProblem("abc"), /at least 8 characters/);
    });
});
