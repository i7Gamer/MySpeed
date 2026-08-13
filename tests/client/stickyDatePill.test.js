import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as sass from "sass";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const compile = (file) => sass.compile(path.join(CLIENT_SRC, file), {
    importers: [{
        findFileUrl: (url) => url.startsWith("@/") ? pathToFileURL(path.join(CLIENT_SRC, url.slice(2))) : null
    }]
}).css;

/**
 * The floating date is a scrolling indicator that never left.
 *
 * It answers "which day am I looking at", which is a question the reader has
 * while the list is moving and not once it has stopped - and it is a fixed pill
 * at the top of the viewport, so what it does in between is sit on top of
 * whatever is up there. On a phone that is the first line of a panel somebody
 * has just opened.
 */
describe("the floating date pill", () => {
    const area = read("pages/Home/components/TestArea/TestAreaComponent.jsx");

    it("goes away when the scrolling does", () => {
        assert.match(area, /STICKY_DATE_LINGER_MS/);
        assert.match(area, /setTimeout\(\(\) => setShowStickyDate\(false\), STICKY_DATE_LINGER_MS\)/);
    });

    // Re-armed rather than set once, or a long scroll takes the pill away in
    // the middle of the gesture it exists for.
    it("stays up for as long as the list keeps moving", () => {
        const handler = area.slice(area.indexOf("const throttledScrollHandler"));

        assert.match(handler.slice(0, handler.indexOf("};")), /keepPillUp\(\)/);
        assert.match(area, /clearTimeout\(pillTimer\.current\)/);
    });

    /**
     * A page restored halfway down its list raises the pill from the mount-time
     * call, and no scroll event ever arrives to take it away again.
     */
    it("is armed by the first reading too", () => {
        const mount = area.slice(area.indexOf("setTimeout(() => {"));

        assert.match(mount.slice(0, mount.indexOf("}, 100)")), /keepPillUp\(\)/);
    });

    // A timer that outlives its component sets state on a corpse.
    it("clears its timer when the list unmounts", () => {
        const teardown = area.slice(area.lastIndexOf("removeEventListener('scroll'") - 400);

        assert.match(teardown.slice(0, 500), /return \(\) => \{[\s\S]*clearTimeout\(pillTimer\.current\)/);
    });
});

/**
 * "Peak-hour slowdown" against a 10rem label, cut one letter in.
 *
 * The row's description is hidden at that width and its icon with it, so the
 * label is the whole of what names the number beside it - and an ellipsis there
 * leaves the reader guessing which measurement they are looking at.
 */
describe("the overview card's row labels", () => {
    const css = compile("pages/Statistics/charts/OverviewChart/styles.sass");

    const narrow = [...css.matchAll(/@media screen and \(max-width: (\d+)px\)\s*\{([\s\S]*?)\n}/g)]
        .map(([, width, body]) => ({width: Number(width), body}))
        .filter(({body}) => /\.info-area h2/.test(body))
        .sort((a, b) => a.width - b.width)[0];

    it("finds the narrowest rule for them", () => {
        assert.notEqual(narrow, undefined, "no width-specific rule for the labels any more");
    });

    it("wraps rather than truncating", () => {
        const rule = narrow.body.match(/\.info-area h2\s*\{([^}]*)}/)?.[1] ?? "";

        assert.match(rule, /white-space:\s*normal/);
        assert.doesNotMatch(rule, /text-overflow:\s*ellipsis/);
    });

    /**
     * The label takes what the value does not, rather than a share of its own.
     * A fixed fraction reserves room the number beside it never wanted, and
     * "Total tests" then wraps onto two lines to hold space open for a "14s".
     */
    it("gives the label the room the value leaves", () => {
        const area = narrow.body.match(/\.info-area\s*\{([^}]*)}/)?.[1] ?? "";

        assert.match(area, /flex:\s*1 1 auto/);
        // Without it a flex item refuses to go below its content's minimum,
        // which is the whole width of the untruncated label.
        assert.match(area, /min-width:\s*0/);
    });

    // The base rule centres the label, which only reads as centred while the
    // box is the width of its text.
    it("keeps the label at the start of the row once it can grow", () => {
        assert.match(narrow.body.match(/\.info-area\s*\{([^}]*)}/)?.[1] ?? "",
            /justify-content:\s*flex-start/);
    });
});
