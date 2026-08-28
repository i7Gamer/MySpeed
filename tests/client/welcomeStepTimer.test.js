import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

/**
 * The wizard's step transition ends its animation on a timer, and the timer
 * used to be fired and forgotten: two quick presses of Continue left the first
 * timer clearing `animating` 500 ms after the *first* step change, cutting the
 * second transition short - and a timer still outstanding when the wizard
 * unmounted ran its setState against a component that was gone.
 *
 * Kept in a ref so the next transition can clear its predecessor, and cleared
 * on unmount like every other timer this client holds.
 */
const source = readSource("client/src/common/components/WelcomeDialog/WelcomeDialog.jsx");

describe("the wizard's step animation timer", () => {
    it("is kept, so the next step can clear it", () => {
        assert.match(source, /animationTimer\.current = setTimeout\(/,
            "the timer is fired and forgotten, so a quick second step is cut short by the first's");
        assert.match(source, /clearTimeout\(animationTimer\.current\);\s*\n\s*animationTimer\.current = setTimeout\(/,
            "the previous step's timer keeps running under the new step's animation");
    });

    it("is cleared when the wizard unmounts", () => {
        assert.match(source, /useEffect\(\(\) => \(\) => clearTimeout\(animationTimer\.current\), \[]\)/,
            "a timer outstanding at unmount runs its setState against a component that is gone");
    });

    // The duration mirrors the CSS slide-in (0.5s in styles.sass), and a bare
    // 500 in the handler is the kind of pairing nothing keeps in step.
    it("names its duration", () => {
        assert.doesNotMatch(source, /setAnimating\(false\), 500\)/,
            "the animation length is a magic number the stylesheet cannot see");
        assert.match(source, /const STEP_ANIMATION_MS = 500/);
    });
});
