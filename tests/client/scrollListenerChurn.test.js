import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const source = fs.readFileSync(
    path.join(CLIENT_SRC, "pages", "Home", "components", "TestArea", "TestAreaComponent.jsx"), "utf8");

// The dependency array closing the useCallback or useEffect that begins at
// `from`, as written.
const dependenciesAfter = (from) => {
    const at = source.indexOf(from);
    assert.notEqual(at, -1, `${from} is no longer in this component`);

    const closes = source.indexOf("}, [", at);
    assert.notEqual(closes, -1, "the hook has no dependency array");

    return source.slice(closes + 3, source.indexOf("]", closes) + 1);
};

/**
 * The overview's scroll handler and the listeners that carry it.
 *
 * handleScroll writes the floating date pill and it listed `stickyDate` among
 * its dependencies, though it reads none of it - it only ever calls
 * setStickyDate. So the callback was rebuilt every time the pill changed, and
 * the effect below, which depends on the callback, tore down and re-registered
 * both scroll listeners on each rebuild. That happens while the list is
 * scrolling past a day boundary, which is the one moment the handler is being
 * called on every frame.
 */
describe("the overview's scroll listeners are not rebuilt as it scrolls", () => {
    it("does not rebuild the handler for the value it only writes", () => {
        const dependencies = dependenciesAfter("const handleScroll = useCallback");

        assert.doesNotMatch(dependencies, /\bstickyDate\b/,
            "the scroll handler is rebuilt on every date the pill shows");
    });

    // The ones it genuinely reads have to stay, or the handler pages in a stale
    // list and stops loading more of it.
    it("keeps the ones it actually reads", () => {
        const dependencies = dependenciesAfter("const handleScroll = useCallback");

        for (const read of ["speedtests", "hasMore", "loading", "loadMoreTests"])
            assert.match(dependencies, new RegExp(`\\b${read}\\b`), `the handler no longer tracks ${read}`);
    });

    /**
     * And the deferred first check is cleared with everything else.
     *
     * It was armed loose, so it outlived the effect that scheduled it: an
     * unmount inside its 100ms ran it against listeners that had already been
     * removed, and it re-armed the pill timer the cleanup had just cleared -
     * leaving a timer alive more than a second past the component.
     */
    it("clears the deferred first check on the way out", () => {
        const effect = source.slice(source.indexOf("let ticking = false"), source.indexOf("const observer"));
        const armed = effect.match(/const (\w+) = setTimeout\(\(\) => \{[\s\S]*?\}, 100\)/);

        assert.notEqual(armed, null, "the deferred first check is armed without being held");
        assert.match(effect.slice(effect.indexOf("return () =>")), new RegExp(`clearTimeout\\(${armed[1]}\\)`),
            "the deferred first check is never cleared, so it fires after the listeners are gone");
    });

    it("still clears the pill timer and both listeners", () => {
        const cleanup = source.slice(source.indexOf("return () =>", source.indexOf("let ticking = false")));

        assert.match(cleanup, /clearTimeout\(pillTimer\.current\)/);
        assert.match(cleanup, /window\.removeEventListener\('scroll'/);
        assert.match(cleanup, /document\.body\.removeEventListener\('scroll'/);
    });
});
