import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import { mediaQueryAnswer, watchMediaQuery } from "../../client/src/common/contexts/Theme/mediaQuery.js";

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

/**
 * What a MediaQueryList's answer actually is, on engines that cannot give one.
 *
 * An engine that has matchMedia but not prefers-color-scheme parses the query
 * to nothing and serialises its media as "not all" - and then answers
 * `matches: false` forever. Read bare, that false is indistinguishable from
 * "the machine prefers light", and resolveTheme flipped exactly the degraded
 * embedded webviews Storage.js exists for to light - against its own
 * documented rule that a machine which cannot answer stays dark.
 */
describe("mediaQueryAnswer", () => {
    it("reads a supported query's matches as the answer", () => {
        assert.equal(mediaQueryAnswer({matches: true, media: "(prefers-color-scheme: dark)"}), true);
        assert.equal(mediaQueryAnswer({matches: false, media: "(prefers-color-scheme: dark)"}), false);
    });

    it("reads an unparseable query as no answer at all", () => {
        assert.equal(mediaQueryAnswer({matches: false, media: "not all"}), undefined);
    });

    it("reads no list as no answer", () => {
        assert.equal(mediaQueryAnswer(undefined), undefined);
        assert.equal(mediaQueryAnswer(null), undefined);
    });
});

describe("the theme context uses the shim", () => {
    const source = readSource("client/src/common/contexts/Theme/ThemeContext.jsx");

    it("subscribes through watchMediaQuery rather than addEventListener directly", () => {
        assert.match(source, /const query = window\.matchMedia\(DARK_QUERY\)/,
            "the effect no longer builds the query it watches");
        assert.match(source, /watchMediaQuery\(query,/,
            "the provider subscribes directly again, which throws on Safari before 14");
        assert.doesNotMatch(source, /matchMedia\(DARK_QUERY\)\.addEventListener/,
            "a direct subscription is exactly the throw the shim exists for");
    });

    // Both readings, not just the first: the initial sample and the change
    // handler each have to go through the answer rule, or an unsupported
    // query's false sneaks back in through whichever one forgets.
    it("reads the machine only through mediaQueryAnswer", () => {
        assert.doesNotMatch(source, /matchMedia\(DARK_QUERY\)\.matches/,
            "a bare .matches read treats an unanswerable query as a light preference");
        assert.match(source, /mediaQueryAnswer/,
            "the provider does not use the answer rule at all");
    });

    /**
     * The attach-time race: the machine is sampled once for the initial state,
     * and the subscription only reports *changes* - so a preference that
     * flipped between the first sample and the effect's subscription stood
     * wrong until the next flip. The effect re-samples the query it is about
     * to watch.
     */
    it("re-samples the query inside the effect before watching it", () => {
        assert.match(source, /setSystemDark\(mediaQueryAnswer\(/,
            "the effect trusts the mount-time sample it took before subscribing");
    });
});
