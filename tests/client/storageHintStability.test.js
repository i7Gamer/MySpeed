import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

/**
 * The export row's hint and the toggle that lives under it.
 *
 * Ticking "Include credentials" swaps the hint sentence for a longer one, the
 * paragraph grows a line, and the toggle - the control the pointer is still
 * over - moves down out from under it. Both sentences render stacked in one
 * grid cell instead, the inactive one hidden in place, so the paragraph is
 * always as tall as the longer sentence and nothing below it ever moves, in
 * whichever of the locales that sentence is the longer one.
 *
 * A source scan like the dialog's other rules: there is no logic to execute,
 * only the shape that keeps the row still.
 */
const config = readSource("client/src/common/components/StorageDialog/tabs/Configuration.jsx");
const styles = readSource("client/src/common/components/StorageDialog/styles.sass");

const swapBlock = () => {
    const start = styles.indexOf(".storage-row-hint-swap");
    assert.notEqual(start, -1, "the stylesheet no longer knows the stacked hint");

    // Up to the next selector at the same 4-space depth, blank lines skipped.
    const rest = styles.slice(start);
    const end = rest.search(/\r?\n {4}[.\w&]/);

    return end === -1 ? rest : rest.slice(0, end);
};

describe("the export hint holds its height when the toggle swaps it", () => {
    it("renders both sentences at once, each muted by the opposite state", () => {
        assert.match(config, /<span aria-hidden=\{includeSecrets\}>\{t\("storage\.export_redacted_desc"\)\}<\/span>/,
            "the redacted sentence is not a stacked span muted while credentials are in");
        assert.match(config, /<span aria-hidden=\{!includeSecrets\}>\{t\("storage\.export_with_secrets_desc"\)\}<\/span>/,
            "the credentials sentence is not a stacked span muted while they are out");
        assert.doesNotMatch(config, /includeSecrets \? "storage\.export_with_secrets_desc"/,
            "the hint still swaps one sentence for the other, so the row jumps under the pointer");
    });

    it("keeps the pair inside the hint's own styling", () => {
        assert.match(config, /className="storage-row-hint storage-row-hint-swap"/,
            "the stacked pair left the hint class, so it lost the hint's size, colour and indent");
    });

    it("stacks the pair in a single cell", () => {
        const block = swapBlock();

        assert.match(block, /display: grid/, "the pair no longer shares a grid");
        assert.match(block, /grid-area: 1 \/ 1/,
            "the sentences sit in separate cells, so the paragraph is both of them tall");
    });

    // visibility keeps the hidden sentence's box in the cell; display: none
    // would take it out of layout and hand the jump straight back whenever
    // the hidden sentence is the taller one.
    it("hides the inactive sentence in place rather than removing its box", () => {
        const block = swapBlock();

        assert.match(block, /span\[aria-hidden="true"\]/,
            "the hiding is no longer keyed on the muting, so a reader and the screen can disagree");
        assert.match(block, /visibility: hidden/, "the inactive sentence is not hidden at all");
        assert.doesNotMatch(block, /display: none/,
            "the inactive sentence leaves the layout, so the reserved height collapses");
    });
});
