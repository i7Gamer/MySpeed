import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import {
    ARROW_STEPS, nextIndex
} from "../../client/src/common/components/SegmentedControl/radioNavigation.js";

const source = readSource("client/src/common/components/SegmentedControl/SegmentedControl.jsx");

/**
 * The radiogroup pattern is one tab stop and arrows within - every option a
 * tab stop of its own is a list, whatever the roles claim. The control put
 * tabIndex={0} on each option and answered no arrow at all, so a screen
 * reader announced "radio, 1 of 3", the user pressed ArrowRight, and nothing
 * happened; Tab then walked every option instead of leaving the group.
 */
describe("which option in the segment holds the tab stop", () => {
    it("is the chosen one, not all of them", () => {
        assert.doesNotMatch(source, /tabIndex=\{0\}/,
            "every option is its own tab stop, so the group reads as a list of radios");
        assert.match(source, /tabIndex=\{active/,
            "no option holds the tab stop, so the group cannot be reached at all");
    });

    // A value that matches no option - a stale preference, a removed choice -
    // must not make the whole group unreachable.
    it("falls back to the first option when none is chosen", () => {
        assert.match(source, /!hasActive && index === 0/,
            "a group whose value matches nothing has no tab stop left");
    });

    it("answers the arrows", () => {
        assert.match(source, /ARROW_STEPS\[event\.key]/,
            "the options claim to be radios and ignore every arrow");
    });
});

describe("where an arrow moves the choice", () => {
    const options = [{id: "a"}, {id: "b"}, {id: "c"}];

    it("steps to the neighbour", () => {
        assert.equal(nextIndex(options, "a", 1), 1);
        assert.equal(nextIndex(options, "b", -1), 0);
    });

    // The radiogroup convention: the arrows cycle rather than stopping.
    it("wraps at the ends", () => {
        assert.equal(nextIndex(options, "c", 1), 0);
        assert.equal(nextIndex(options, "a", -1), 2);
    });

    it("starts from the first option when none is chosen", () => {
        assert.equal(nextIndex(options, "missing", 1), 1);
    });

    it("answers nothing for an empty group", () => {
        assert.equal(nextIndex([], "a", 1), -1);
    });

    // Left/up and right/down are synonyms in a radiogroup, so a vertical
    // stack and a horizontal row read the same.
    it("reads both axes", () => {
        assert.equal(ARROW_STEPS.ArrowRight, 1);
        assert.equal(ARROW_STEPS.ArrowDown, 1);
        assert.equal(ARROW_STEPS.ArrowLeft, -1);
        assert.equal(ARROW_STEPS.ArrowUp, -1);
    });
});
