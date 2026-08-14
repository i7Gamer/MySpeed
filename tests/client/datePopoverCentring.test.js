import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const styles = fs.readFileSync(
    path.join(CLIENT_SRC, "common", "components", "DateRangePicker", "styles.sass"), "utf8");

// A top-level block, from its header to the next line that starts at column 0.
const topLevelBlock = (header) => {
    const at = styles.indexOf(header);
    assert.notEqual(at, -1, `there is no ${header} in this stylesheet`);

    const ends = styles.slice(at + header.length).search(/\r?\n\S/);
    return ends === -1 ? styles.slice(at) : styles.slice(at, at + header.length + ends);
};

// A rule nested one level inside a block, from its selector to the next
// selector at the same depth.
const nestedRule = (block, selector) => {
    const at = block.indexOf(selector);
    assert.notEqual(at, -1, `${selector} is no longer in this block`);

    const ends = block.indexOf("\n  .", at + 1);
    return ends === -1 ? block.slice(at) : block.slice(at, ends);
};

const animationOf = (rule) => {
    const named = rule.match(/animation:\s*([\w-]+)/);
    assert.notEqual(named, null, "this popover no longer animates open");

    return named[1];
};

const transformsIn = (keyframes) =>
    [...keyframes.matchAll(/transform:\s*([^\r\n]+)/g)].map(([, value]) => value.trim());

/**
 * Below 600px the popover is centred in the viewport, and for the first 0.2s it
 * was not.
 *
 * The centring is `top: 50%; left: 50%` undone by `transform: translate(-50%,
 * -50%)`. The rule also runs the shared popoverFadeIn, whose keyframes animate
 * `transform` - and an animation outranks a normal author declaration for as
 * long as it runs, so for the whole of the opening the centring transform was
 * replaced by the keyframes' translateY and the two offsets were left standing
 * alone. The sheet was painted from the middle of the viewport outwards: on a
 * 375px phone its left edge lands at 187.5px and it is `calc(100vw - 2rem)` =
 * 343px wide, so it runs some 155px past the right edge, and its full height
 * hangs below the middle. Then it snapped into place, since nothing carried the
 * animated value forward.
 *
 * Asserted as an invariant over whichever keyframes the rule names, rather than
 * against one spelling of them: what has to hold is that the opening animation
 * never gives up the centring, however it is written.
 */
describe("the date range popover opens where it is meant to sit", () => {
    const narrow = () => topLevelBlock("@media screen and (max-width: 600px)");
    const popover = () => nestedRule(narrow(), ".date-range-popover");

    it("centres itself on a narrow viewport", () => {
        assert.match(popover(), /transform:\s*translate\(-50%,\s*-50%\)/,
            "the popover is no longer centred at all");
        assert.match(popover(), /position:\s*fixed/);
    });

    it("never lets its opening animation drop that centring", () => {
        const keyframes = topLevelBlock(`@keyframes ${animationOf(popover())}`);

        for (const transform of transformsIn(keyframes))
            assert.match(transform, /translate\(-50%/,
                `"${transform}" replaces the centring while the popover opens, painting it half off-screen`);
    });

    // The point of using its own keyframes rather than dropping the animation:
    // the slide is what says the sheet opened rather than having always been
    // there.
    it("still slides as it opens", () => {
        const keyframes = topLevelBlock(`@keyframes ${animationOf(popover())}`);
        const [from] = transformsIn(keyframes);

        assert.match(keyframes, /opacity:\s*0/, "the popover no longer fades in");
        assert.notEqual(from, undefined, "the popover no longer moves as it opens");
        assert.doesNotMatch(from, /translate\(-50%,\s*-50%\)/,
            "the popover starts exactly where it ends, so nothing moves");
    });

    /**
     * And the desktop popover is untouched. It hangs under its trigger rather
     * than being centred, so it has no transform of its own for the shared
     * keyframes to overwrite - the slide there was always correct.
     */
    it("leaves the anchored popover sliding as it did", () => {
        const anchored = topLevelBlock(".date-range-popover");

        assert.match(anchored, /position:\s*absolute/);
        assert.doesNotMatch(anchored, /transform:/,
            "the anchored popover now sets a transform, which its own animation would override");
        assert.match(transformsIn(topLevelBlock(`@keyframes ${animationOf(anchored)}`)).join(" "),
            /translateY/, "the anchored popover no longer slides in");
    });
});
