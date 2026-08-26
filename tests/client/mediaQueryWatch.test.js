import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import { watchMediaQuery } from "../../client/src/common/contexts/Theme/mediaQuery.js";

/**
 * The theme's watch on the machine, on engines that spell it either way.
 *
 * Safari before 14 - and the embedded webviews built on engines of that age -
 * implements MediaQueryList without addEventListener, so subscribing threw a
 * TypeError out of the provider's effect and took the whole tree down on
 * exactly the browsers a wall-mounted dashboard tends to run. addListener is
 * the older spelling of the same subscription.
 *
 * Imported and run rather than read: the module is plain JS with no JSX and no
 * imports, so the behaviour itself is testable here.
 */
describe("watchMediaQuery", () => {
    const modernQuery = () => {
        const calls = {added: [], removed: []};

        return {
            calls,
            addEventListener: (type, fn) => calls.added.push({type, fn}),
            removeEventListener: (type, fn) => calls.removed.push({type, fn})
        };
    };

    const legacyQuery = () => {
        const calls = {added: [], removed: []};

        return {
            calls,
            addListener: (fn) => calls.added.push(fn),
            removeListener: (fn) => calls.removed.push(fn)
        };
    };

    it("prefers addEventListener where it exists", () => {
        const query = modernQuery();
        const onChange = () => undefined;

        const unsubscribe = watchMediaQuery(query, onChange);

        assert.deepEqual(query.calls.added, [{type: "change", fn: onChange}]);

        unsubscribe();
        assert.deepEqual(query.calls.removed, [{type: "change", fn: onChange}]);
    });

    it("falls back to addListener where it does not", () => {
        const query = legacyQuery();
        const onChange = () => undefined;

        const unsubscribe = watchMediaQuery(query, onChange);

        assert.deepEqual(query.calls.added, [onChange]);

        unsubscribe();
        assert.deepEqual(query.calls.removed, [onChange]);
    });

    // A list with neither spelling is watched by nobody rather than thrown on:
    // the theme then means "whatever the machine said when the tab opened",
    // which is what it meant for everyone before the machine was watched.
    it("shrugs at a list with neither spelling", () => {
        const unsubscribe = watchMediaQuery({}, () => undefined);

        assert.equal(typeof unsubscribe, "function");
        unsubscribe();
    });
});

describe("the theme context uses the shim", () => {
    const source = readSource("client/src/common/contexts/Theme/ThemeContext.jsx");

    it("subscribes through watchMediaQuery rather than addEventListener directly", () => {
        assert.match(source, /watchMediaQuery\(window\.matchMedia\(DARK_QUERY\)/,
            "the provider subscribes directly again, which throws on Safari before 14");
    });
});
