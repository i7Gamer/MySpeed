import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

/**
 * The coloured dot on a history row is the row's only mark of which target
 * measured it, and it carried nothing but a `title` - which a generic span is
 * commonly skipped over entirely by screen readers, so the attribute the
 * comment beside it relied on ("the title so the dot is not colour alone")
 * was not reliably read at all. role="img" makes it an element with an
 * accessible name, and the aria-label is that name.
 */
describe("the history row's target dot", () => {
    const source = readSource("client/src/pages/Home/components/Speedtest/SpeedtestComponent.jsx");
    const dot = source.match(/<span className="target-dot speedtest-target-dot"(?:(?!\/>)[^])*\/>/)?.[0];

    it("is still there to ask about", () => {
        assert.ok(dot, "the dot is no longer recognisable by its classes");
    });

    it("has an accessible name, not only a tooltip", () => {
        assert.match(dot, /role="img"/,
            "a bare span's title is skipped by screen readers, so the target is colour alone");
        assert.match(dot, /aria-label=\{props\.targetDot\.name}/,
            "the role makes it an element with a name, and nothing supplies the name");
    });
});
