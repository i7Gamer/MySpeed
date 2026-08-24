import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, blockEnd } from "../helpers/source.js";

/**
 * The error page counts five seconds down and reloads - with the counter in
 * the effect's dependency list, so every tick tore the interval down and built
 * a new one. That is five intervals for one countdown, and the tick that does
 * the counting was always a fresh timer's first: a page that re-rendered for
 * any other reason mid-second stretched the countdown by resetting the timer
 * it was supposedly reading.
 *
 * The interval lives for the countdown now, reading the counter through a
 * functional update, and the reload is its own effect watching for zero - the
 * same second of "Reloading now..." the old shape showed, without rebuilding
 * the timer that shows it.
 */
const source = readSource("client/src/pages/Error/Error.jsx");

const effectAt = (from) => {
    const start = source.indexOf("useEffect(", from);
    if (start === -1) return null;
    return {text: source.slice(start, blockEnd(source, source.indexOf("{", start)) + 1), start};
};

describe("the error page's reload countdown", () => {
    it("keeps one interval for the whole countdown", () => {
        let at = 0;
        let counting = null;

        for (let effect = effectAt(at); effect; effect = effectAt(at)) {
            if (effect.text.includes("setInterval")) counting = effect;
            at = effect.start + 1;
        }

        assert.ok(counting, "nothing counts down any more");

        // The dependency list follows the closing brace of the callback.
        const deps = source.slice(counting.start + counting.text.length,
            source.indexOf(")", counting.start + counting.text.length) + 1);

        assert.doesNotMatch(deps, /reloadTimer/,
            "the countdown depends on its own counter, so every tick rebuilds the interval");
    });

    it("reads the counter through a functional update", () => {
        assert.match(source, /setReloadTimer\(\(prev\)/,
            "the tick reads the counter from the closure the interval was built in");
    });

    it("still reloads, from its own effect", () => {
        assert.match(source, /window\.location = window\.location\.href/,
            "the page no longer reloads at all");
    });
});
