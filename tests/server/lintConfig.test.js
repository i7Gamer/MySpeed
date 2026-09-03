import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ESLint } from "eslint";

/**
 * What the linter is actually configured to see, asked of the linter.
 *
 * Nothing guarded this file, and it is the one config in the repo whose failure
 * mode is silence: a block deleted, a `files` glob narrowed or a rule turned off
 * makes `eslint .` pass harder, so the suite and CI both go green over exactly
 * the regression that matters. The hook rules over `tests/` are the newest and
 * the easiest to lose - they were added as their own block, and a merge that
 * dropped it would look like a tidy-up.
 *
 * Asked through calculateConfigForFile rather than by reading the source,
 * because what is in doubt is the resolution: flat config merges blocks by
 * glob, and a `files` pattern that no test file matches is a block that is
 * present, readable, and applied to nothing.
 */
describe("what the linter is configured to see", () => {
    let eslint;

    before(() => { eslint = new ESLint(); });

    const rulesFor = async (file) => (await eslint.calculateConfigForFile(file)).rules ?? {};

    // "off" and 0 are the same answer; a rule can be configured either way.
    const isOn = (setting) => {
        const severity = Array.isArray(setting) ? setting[0] : setting;

        return severity !== undefined && severity !== 0 && severity !== "off";
    };

    // The two trees with React in them. The client's block predates the suite's
    // and is here as the control: a failure in both is a plugin that stopped
    // loading, a failure in one is a glob that stopped matching.
    //
    // A server test among them because the block covers `tests/**` and is meant
    // to: a jsdom harness is a component and can live either side. Sampling
    // only tests/client left the glob free to narrow to that half, which
    // unlints every harness under tests/server without failing anything.
    const WITH_HOOKS = ["tests/client/emptyStates.test.js", "tests/server/sessionCookie.test.js",
        "client/src/App.jsx"];

    // Everything the linter is pointed at, one file from each block, because
    // no-undef is the rule the whole config was adopted for.
    const EVERY_BLOCK = [...WITH_HOOKS, "server/index.js", "scripts/move-client-build.js",
        "eslint.config.mjs", "client/public/themeBoot.js"];

    it("checks the hook rules in the suite as well as in the client", async () => {
        for (const file of WITH_HOOKS) {
            const rules = await rulesFor(file);
            const hooks = Object.keys(rules).filter((name) => name.startsWith("react-hooks/"));

            assert.ok(hooks.length >= 10, `${file} is linted with only ${hooks.length} hook rules`);
            assert.ok(isOn(rules["react-hooks/rules-of-hooks"]),
                `${file} can call a hook conditionally without the linter saying so`);
        }
    });

    /**
     * The one that took the app down to its error boundary with 2300 tests
     * passing: `export {X} from "./y"` forwards X and binds nothing locally, so
     * a module that re-exports a constant and then uses it throws at render
     * while the build stays green.
     */
    it("keeps no-undef on every tree it is pointed at", async () => {
        for (const file of EVERY_BLOCK)
            assert.ok(isOn((await rulesFor(file))["no-undef"]),
                `${file} is linted without no-undef, which is what this config was adopted for`);
    });

    // Warnings, deliberately, and not errors: the compiler-era rules flag
    // patterns this codebase uses on purpose and in volume, and turning them on
    // is a pass of its own. What must not happen quietly is the reverse - the
    // whole plugin going off, which reads as "no findings".
    it("has the deps rule on rather than merely present", async () => {
        assert.ok(isOn((await rulesFor("tests/client/emptyStates.test.js"))["react-hooks/exhaustive-deps"]),
            "the dependency rule is off in the suite, so a stale closure in a harness is invisible");
    });
});
