import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as sass from "sass";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

// Stands in for the "@/" alias vite gives the client, which the stylesheets use
// to reach the shared colour definitions.
const aliasImporter = {
    findFileUrl(url) {
        if (!url.startsWith("@/")) return null;
        return pathToFileURL(path.join(CLIENT_SRC, url.slice(2)));
    }
};

const compile = (stylesheet) =>
    sass.compile(path.join(CLIENT_SRC, stylesheet), {importers: [aliasImporter]}).css;

const blocks = (css) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => ({selector: selector.trim(), body}));

const INTEGRATION_SHEET = "common/components/IntegrationDialog/styles.sass";
const DIALOG_SHEET = "common/contexts/Dialog/styles.sass";

const rulesFor = (css, selector) =>
    blocks(css).filter((rule) => rule.selector.split(",").some((part) => part.trim() === selector));

const declaration = (body, property) => {
    const match = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
    return match ? match[1].trim() : null;
};

/**
 * The integration dialog has to hold every setting of every integration, and
 * each card gained a set of shared notification-threshold fields on top of what
 * it already had. Two things stopped it growing into the room it has.
 *
 * The list of cards declared its own `max-height` and `overflow-y`, which put a
 * 20rem scrollport *inside* `.dialog-main` - a box that already scrolls, and
 * which is itself bounded by the dialog's `max-height: calc(100vh - 2rem)`. The
 * result was two nested scrollbars where one would do: an expanded card scrolled
 * within a 320px window on a screen with a thousand pixels going spare, and
 * scrolling to a field near the bottom of a card meant scrolling the inner box
 * to its end and then the outer one.
 *
 * The wrapper was also pinned to a fixed 34rem while `.dialog.integration-dialog`
 * allows 90vw, so a wide window bought nothing. Each field is a `space-between`
 * row of a label against its input, so the width is what a long label and a long
 * value - a webhook URL, a message template - actually compete for.
 */
describe("the integration dialog can grow into the room it has", () => {
    const css = compile(INTEGRATION_SHEET);

    it("lets the dialog body be the only thing that scrolls", () => {
        for (const {selector, body} of blocks(css)) {
            assert.equal(declaration(body, "max-height"), null,
                `"${selector}" caps its own height inside .dialog-main, which already scrolls`);
            assert.equal(declaration(body, "overflow-y"), null,
                `"${selector}" opens a second scrollport inside .dialog-main, which already scrolls`);
        }
    });

    it("widens with the window instead of sitting at a fixed size", () => {
        const [wrapper] = rulesFor(css, ".integrations-wrapper");

        assert.ok(wrapper, "no .integrations-wrapper rule");

        const width = declaration(wrapper.body, "width");
        assert.ok(width, ".integrations-wrapper declares no width");
        assert.match(width, /min\(/,
            `width is ${width}, which cannot follow the window`);
    });

    /**
     * The dialog is capped at 90vw and the wrapper sits inside its 1.25rem of
     * padding, so a wrapper allowed the full 90vw would overflow it - and
     * `.dialog-main` hides its horizontal overflow, so the excess would simply
     * be cut off rather than scrolled to.
     */
    it("stays inside the width the dialog itself allows", () => {
        const [wrapper] = rulesFor(css, ".integrations-wrapper");
        const viewportShare = declaration(wrapper.body, "width").match(/(\d+)vw/);

        assert.ok(viewportShare, "the width names no viewport share to check");
        assert.ok(Number(viewportShare[1]) < 90,
            `${viewportShare[0]} leaves no room for the dialog's own padding inside its 90vw cap`);
    });

    // The premise of the first assertion: if the body ever stopped scrolling,
    // dropping the inner scrollport would make long content unreachable.
    it("is checked against a dialog body that really does scroll", () => {
        const [main] = rulesFor(compile(DIALOG_SHEET), ".dialog-main");

        assert.ok(main, "no .dialog-main rule");
        assert.equal(declaration(main.body, "overflow-y"), "auto");
        assert.equal(declaration(main.body, "min-height"), "0",
            "a flex child needs min-height:0 before it will scroll rather than stretch");
    });
});
