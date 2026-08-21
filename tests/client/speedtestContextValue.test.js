import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

/**
 * What every consumer of the test list re-renders for.
 *
 * SpeedtestProvider reads StatusContext, because the list refetches on the
 * falling edge of a run. StatusContext samples the live status every 500ms while
 * a test is running, so this provider re-renders twice a second for the length
 * of a speedtest - and it handed down a fresh object literal each time. Context
 * has no selectors: a new value identity re-renders every consumer, so the whole
 * of the overview - the list and each of its rows - was reconciled twice a
 * second throughout every run, for a value none of whose contents had changed.
 *
 * Memoising the value is what breaks that chain, and the reason it works is
 * that everything in it is already stable between renders: the four state
 * values, the range and timeframe derived through useMemo, and six callbacks
 * that are each useCallback'd.
 *
 * A memo is only as good as its dependency array, though, and this is the shape
 * where that goes wrong quietly: a key added to the value and not to the deps
 * gives every consumer a stale copy of it, which reads as the list refusing to
 * update rather than as anything to do with this line. So the two are held
 * against each other.
 */
const source = readSource("client/src/common/contexts/Speedtests/SpeedtestContext.jsx");

const providerValue = () => {
    const at = source.indexOf("<SpeedtestContext.Provider value=");
    assert.notEqual(at, -1, "the provider no longer hands its value down here");

    return source.slice(at, source.indexOf(">", at) + 1);
};

describe("the value SpeedtestProvider hands down", () => {
    it("is memoised rather than rebuilt on every render", () => {
        assert.match(providerValue(), /value=\{contextValue\}|value=\{\s*useMemo/,
            "a new object identity every 500ms re-renders every row of the overview through a whole run");

        assert.match(source, /const contextValue = useMemo\(/,
            "nothing holds the value's identity across a render that changed none of it");
    });

    /**
     * Read off the memo itself rather than from a list written here: a key this
     * test does not know about is exactly the one that would go missing from the
     * dependencies.
     */
    it("depends on everything it carries", () => {
        const at = source.indexOf("const contextValue = useMemo(");
        assert.notEqual(at, -1, "the value is no longer memoised");

        const body = source.slice(at, source.indexOf("]);", at) + 3);
        const object = body.slice(body.indexOf("({") + 2, body.indexOf("})"));
        const dependencies = body.slice(body.lastIndexOf("["), body.lastIndexOf("]") + 1);

        // `key`, or `key: source` - the dependency is whatever it is built from.
        const carried = object.split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
            .map((entry) => entry.includes(":") ? entry.split(":")[1].trim() : entry);

        assert.ok(carried.length >= 8, `only ${carried.length} entries were read out of the value`);

        for (const value of carried)
            assert.match(dependencies, new RegExp(`\\b${value}\\b`),
                `${value} is handed down but not depended on, so consumers get a stale one`);
    });

    // The list, the flags and the range are what the overview draws; the six
    // callbacks are what its controls call. Named so that dropping one from the
    // value is a failure here rather than a missing function at a call site.
    it("still carries everything its consumers read", () => {
        const value = providerValue() + source.slice(source.indexOf("const contextValue = useMemo("));

        for (const key of ["speedtests", "updateTests", "reloadTests", "deleteTest", "loadMoreTests",
            "loading", "hasMore", "timeframe", "range", "selectTimeframe", "selectRange"])
            assert.match(value, new RegExp(`\\b${key}\\b`), `${key} is no longer handed down`);
    });
});
