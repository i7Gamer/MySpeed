import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, withoutJsComments } from "../helpers/source.js";
import { compile } from "../helpers/sass.mjs";

/**
 * Where the delete button sits, and why it sits in two different places.
 *
 * It was a block under the facts, so it took a row of its own. The facts are a
 * grid of `auto-fit` 18rem columns, and a test with six facts in four columns
 * leaves two cells empty on the last row - measured in Chrome at 1440px, the
 * button in one of those cells takes the grid from 166px to 103px.
 *
 * The last column, though, not the next free cell. Auto-placement would put it
 * wherever the facts happened to stop: column 3 with six facts, column 1 with
 * eight, column 2 with five. A destructive control whose position moves with
 * what the provider reported is worse than one row of whitespace, and pinning
 * it to `-2 / -1` keeps the right edge it already had.
 *
 * A failed test has no facts grid to join - it renders the raw error instead -
 * so the actions follow the error block there and keep the margin the grid's
 * row gap replaces. That branch is the only reason the conditional exists,
 * which makes it the one that has to be checked.
 */
describe("the detail pane's caller-owned actions", () => {
    const source = withoutJsComments(readSource("client/src/common/components/TestDetails/TestDetails.jsx"));

    // From TestDetails' own declaration, so DetailFact - a second component in
    // the same file, whose {children} is the fact's value - is not counted.
    const pane = source.slice(source.indexOf("export const TestDetails ="));

    /** The JSX between a tag and its matching close, for the two branches. */
    const between = (open, close) => {
        const start = pane.indexOf(open);
        assert.notEqual(start, -1, `${open} is not in the pane`);

        const end = pane.indexOf(close, start);
        assert.notEqual(end, -1, `${close} does not follow ${open}`);

        return pane.slice(start, end);
    };

    it("joins the facts grid when there are facts", () => {
        assert.match(between('<div className="detail-facts">', "</div>"), /\{children}/,
            "the actions are outside the grid, so they take a row of their own again");
    });

    it("follows the error block when there are not", () => {
        assert.match(between('<div className="detail-error">', "</div>"), /\{children}/,
            "a failed test would render no actions at all - there is no facts grid on that branch");
    });

    it("renders them once per branch and not once overall", () => {
        assert.equal((pane.match(/\{children}/g) ?? []).length, 2,
            "both branches place the actions themselves; a third copy would double them on one of them");
    });
});

describe("the delete button's placement", () => {
    const css = compile("pages/Home/components/Speedtest/styles.sass");

    const ruleFor = (selector) => {
        const at = css.indexOf(`${selector} {`);
        assert.notEqual(at, -1, `${selector} is not in the compiled stylesheet`);

        return css.slice(at, css.indexOf("}", at));
    };

    /**
     * Pinned rather than auto-placed. Without the column it lands in the first
     * free cell, which is a different column for every fact count.
     */
    it("is the last column of whatever row it lands on", () => {
        const actions = ruleFor(".detail-actions");

        assert.match(actions, /grid-column:\s*-2\s*\/\s*-1/,
            "auto-placement would move it with the number of facts");
        assert.match(actions, /justify-self:\s*end/, "a grid cell is far wider than the button");
    });

    /**
     * The properties above do nothing outside a grid, which is what lets one
     * class serve both branches - but the margin is not so forgiving. Inside
     * the grid it would push the button out of the row it was placed in.
     */
    it("keeps its own spacing outside the grid and drops it inside", () => {
        assert.match(ruleFor(".detail-actions"), /margin-top:\s*1\.25rem/,
            "on the failed-test branch nothing else separates it from the error");
        assert.match(ruleFor(".detail-facts .detail-actions"), /margin-top:\s*0/,
            "the grid's row gap already does this, and the margin displaces the row");
    });
});
