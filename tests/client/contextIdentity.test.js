import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readSource } from "../helpers/source.js";

/**
 * A context provider's value keeps its identity between changes.
 *
 * The providers nest - Config holds Node holds Status holds Speedtest - and
 * four of them handed out a fresh array on every render. useContext re-renders
 * every consumer whenever that identity changes, so a parent re-rendering for
 * reasons of its own re-rendered everything below it to show exactly what was
 * already on screen: the status poll alone did it every few seconds at idle.
 * AlertContext already does this right, and is the pattern being held to here -
 * a memoised value over callbacks that are themselves memoised, because a
 * useMemo over functions rebuilt each render memoises nothing.
 */
const PROVIDERS = [
    "client/src/common/contexts/Preferences/PreferencesContext.jsx",
    "client/src/common/contexts/Status/StatusContext.jsx",
    "client/src/common/contexts/Config/ConfigContext.jsx",
    "client/src/common/contexts/Node/NodeContext.jsx"
];

/**
 * The memo is read for what it carries and what it depends on, rather than
 * for existing.
 *
 * A useMemo over functions rebuilt each render memoises nothing, which is the
 * whole point of the docstring above - and a test that asserts only that the
 * memo is there survives exactly that: turning any one of these callbacks
 * back into a plain arrow puts a fresh identity in the memo's dependencies,
 * so the value is minted again on every render and every consumer below
 * re-renders, with nothing red. speedtestContextValue.test.js reads its own
 * provider this way for the same reason.
 */
const memoOf = (source, name) => {
    const at = source.indexOf("const contextValue = useMemo(");
    assert.notEqual(at, -1, `${name} builds no memoised value at all`);

    const body = source.slice(at, source.indexOf("]);", at) + 3);
    const opens = body.indexOf("=> [");

    assert.notEqual(opens, -1, `${name} no longer memoises a list of values`);

    return {
        carried: body.slice(opens + "=> [".length, body.indexOf("]", opens))
            .split(",").map((entry) => entry.trim()).filter(Boolean),
        dependencies: body.slice(body.lastIndexOf("["), body.lastIndexOf("]") + 1)
    };
};

// Two is the smallest any of these hands down - a value and the one function
// that changes it - so a parse that read nothing cannot pass quietly.
const CARRIED_AT_LEAST = 2;

describe("a context provider's value keeps its identity", () => {
    for (const file of PROVIDERS) {
        const name = path.basename(file, ".jsx");
        const source = readSource(file);

        it(`${name} hands out a memoised value`, () => {
            assert.match(source, /const contextValue = useMemo\(/,
                `${name} builds no memoised value at all`);
            assert.match(source, /\.Provider value=\{contextValue}/,
                `${name} memoises a value and then hands out something else`);
        });

        it(`${name} hands out no inline array`, () => {
            assert.doesNotMatch(source, /\.Provider value=\{\[/,
                `${name} rebuilds its value on every render`);
        });

        it(`${name} depends on everything it carries`, () => {
            const {carried, dependencies} = memoOf(source, name);

            assert.ok(carried.length >= CARRIED_AT_LEAST,
                `only ${carried.length} entries were read out of ${name}'s value`);

            for (const value of carried)
                assert.match(dependencies, new RegExp(`\\b${value}\\b`),
                    `${name} hands down ${value} without depending on it, so consumers get a stale one`);
        });

        /**
         * And every function in it is memoised too. A dependency rebuilt on
         * each render is a memo that answers with a new value on each render,
         * which is the bug this file exists for - spelled the other way
         * round, so it is caught wherever the callback lives.
         */
        it(`${name} carries nothing rebuilt on every render`, () => {
            const {carried} = memoOf(source, name);

            for (const value of carried) {
                // Whatever it is assigned, not just a word: a plain arrow
                // starts with a paren, and a pattern that could only match an
                // identifier read one as "not declared here" and passed.
                const declared = source.match(new RegExp(`const ${value} = ([^;\\n]*)`));

                if (declared === null) continue; // A state value, or another context's.

                assert.match(declared[1], /^(useCallback|useMemo)\(/,
                    `${name}'s ${value} is rebuilt on every render, so the memo around it holds nothing`);
            }
        });
    }
});
