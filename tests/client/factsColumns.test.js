import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compile, read } from "../helpers/sass.mjs";

const STYLES = "common/components/TestDetails/styles.sass";

const css = compile(STYLES);
const source = read(STYLES);

const ruleFor = (selector) => {
    const match = css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)}`));
    assert.ok(match, `${selector} declares nothing`);
    return match[1];
};

/**
 * The facts grid dropped to one column with room for two.
 *
 * `repeat(auto-fit, minmax(min(18rem, 100%), 1fr))`, and that 18rem was set by
 * the widest value any fact can hold - an external IPv6, about 270px. Two
 * columns of it need 38rem, so the panel fell to a single column below that,
 * and every short fact was paying for an address most connections do not carry.
 *
 * Measured on a typical test: six facts, 226px at the widest and 119px at the
 * median, in columns floored at 288px. Two columns held to 687px of window;
 * with a floor sized for the other facts they hold to about 460.
 */
describe("the floor a facts column stands on", () => {
    it("has a narrower one to fall back to", () => {
        assert.match(source, /\$fact-column:\s*\d+(\.\d+)?rem/, "the wide floor is a literal again");
        assert.match(source, /\$fact-column-narrow:\s*\d+(\.\d+)?rem/,
            "there is only one floor, so the grid still drops straight to a single column");
    });

    // The two have to be a step apart in the right direction, or the fallback
    // is the same figure written twice - or worse, the wider of the two.
    it("falls back to something actually narrower", () => {
        const widthOf = (name) => parseFloat(source.match(new RegExp(`\\${name}:\\s*([\\d.]+)rem`))[1]);

        assert.ok(widthOf("$fact-column-narrow") < widthOf("$fact-column"),
            "the fallback floor is no narrower than the one it replaces");
    });

    /**
     * Against the panel, not the window.
     *
     * This markup is drawn inside an expanded overview row on one page and
     * inside the chart modal on the other, and those two give it different room
     * at the same viewport - so one viewport figure is necessarily wrong for one
     * of them. The panel is the thing that knows how much room it has.
     */
    it("measures the panel rather than the viewport", () => {
        assert.match(css, /@container[^{]*\{/, "the fallback is chosen off the window again");
        assert.match(ruleFor(".test-details"), /container-type:\s*inline-size/,
            "nothing establishes a container, so the @container query never matches");
    });

    // Derived from the two floors and the gap between them rather than typed:
    // the width where two wide columns stop fitting is exactly where the narrow
    // floor has to take over, and a hand-written figure drifts the moment either
    // of the three changes.
    it("switches where two wide columns stop fitting", () => {
        const query = css.match(/@container\s*\(([^)]*)\)/);
        assert.ok(query, "the container query is gone");

        assert.match(query[1], /38rem/,
            "the switch is not at 2 x 18rem + 2rem of gap, so there is a band with room for"
            + " two columns that draws one - or one that draws two and overflows");
    });

    /**
     * And the address is left to wrap rather than given a row of its own.
     *
     * `grid-column: 1 / -1` on that one fact is the tidier-sounding fix and it
     * does not work here: the four facts carrying a second line are deliberately
     * adjacent so only one row grows tall (factsGridRows.test.js), and pulling
     * the fourth out of the flow strands the third. Measured on a complete
     * record: two holes in the grid at every two-column width.
     */
    it("lets no fact break out of the flow", () => {
        assert.doesNotMatch(css, /grid-column:\s*1\s*\/\s*-1/,
            "a fact spans the row again, which leaves a hole beside the one before it");
    });

    it("keeps the value able to wrap, which is what the narrow floor relies on", () => {
        assert.match(ruleFor(".detail-fact-value"), /overflow-wrap:\s*anywhere/,
            "an IPv6 has no space to break at, so a narrow column overflows instead of wrapping");
    });
});
