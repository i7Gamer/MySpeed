import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { convertSpeed, formatLatency, formatWhole, SPEED_UNIT_MBYTES } from "@/common/utils/FormatUtil.js";
import { getIconBySpeed } from "@/common/utils/TestUtil.js";
import { clickable } from "@/common/utils/Clickable.js";
import { compile, mediaBlocks, read } from "../helpers/sass.mjs";

const ROW = "pages/Home/components/Speedtest/SpeedtestComponent.jsx";
const AREA = "pages/Home/components/TestArea/TestAreaComponent.jsx";
const STYLES = "pages/Home/components/Speedtest/styles.sass";

const row = read(ROW);
const area = read(AREA);
const styles = read(STYLES);

const css = compile(STYLES);

/**
 * The keyboard handler the row is wired with, taken out of the JSX and run.
 *
 * The handler is plain JavaScript - the JSX around it is what node cannot parse,
 * not the arrow itself - so the alternative to lifting it out is asserting on
 * the shape of its source, which passes for any spelling that happens to contain
 * the right words. What is wrong here is what the function does with the event
 * it is handed, and that is only observable by handing it one.
 */
const propValue = (source, prop) => {
    const start = source.indexOf(`${prop}={`);
    assert.notEqual(start, -1, `the row no longer sets ${prop}`);

    const from = source.indexOf("{", start);
    let depth = 0;

    for (let index = from; index < source.length; index++) {
        if (source[index] === "{") depth++;
        else if (source[index] === "}" && --depth === 0) return source.slice(from + 1, index);
    }

    assert.fail(`the value of ${prop} is never closed`);
};

/**
 * The row's Enter/Space handler, and the calls it made.
 *
 * `expanded` is false throughout: what the handler asks for is the state it
 * wants to move to, so a recorded `true` is a row that expanded and an empty
 * list is a row that stayed put.
 *
 * The handler used to be written out in the JSX and was lifted out of the source
 * to be run. It is `clickable` now - the same shape, shared with the statistics
 * tiles and the node cards, which had no keyboard handling at all while this row
 * had all of it - so the real function is called instead. What is asserted below
 * is unchanged: what matters is what it does with the event it is handed.
 */
const pressKey = (key, {fromNestedControl = false} = {}) => {
    const toggles = [];
    const expanded = false;
    const {onKeyDown: handler} = clickable(() => toggles.push(!expanded));

    // The row div: what the handler is attached to, and what the keydown targets
    // when the row itself has focus. A press inside one of the help buttons
    // bubbles up to the same handler with the button as its target.
    const rowElement = {};
    const event = {
        key,
        currentTarget: rowElement,
        target: fromNestedControl ? {} : rowElement,
        defaultPrevented: false,
        preventDefault() {
            this.defaultPrevented = true;
        }
    };

    handler(event);

    return {toggles, prevented: event.defaultPrevented};
};

/**
 * The help buttons inside the row could be tabbed to and not operated.
 *
 * Every icon on the card is a real button so that a keyboard can reach it, but
 * the row around them is a control too, and its handler called preventDefault()
 * for Enter and Space on anything that bubbled up. preventDefault on a keydown
 * cancels the click the browser would have synthesised from that key, so the
 * button's own onClick never ran - and the row expanded instead of explaining
 * the measurement. useMetricInfo stops the click, which is a different event
 * and by then a click that no longer happens.
 */
describe("a key pressed inside the row's help buttons", () => {
    for (const key of ["Enter", " "]) {
        const named = key === " " ? "Space" : key;

        it(`leaves ${named} to the button it was aimed at`, () => {
            const {toggles, prevented} = pressKey(key, {fromNestedControl: true});

            assert.equal(prevented, false,
                "preventDefault on the keydown cancels the button's native activation, so its help never opens");
            assert.deepEqual(toggles, [],
                "the row expanded on a key press meant for a button inside it");
        });

        it(`still expands the row on ${named} aimed at the row itself`, () => {
            const {toggles, prevented} = pressKey(key);

            assert.deepEqual(toggles, [true], "the row no longer answers the keyboard at all");
            assert.equal(prevented, true,
                "without preventDefault, Space scrolls the list while it opens the panel");
        });
    }

    it("ignores every other key", () => {
        const {toggles, prevented} = pressKey("a");

        assert.deepEqual(toggles, []);
        assert.equal(prevented, false, "typing anywhere in the list was swallowed");
    });
});

/**
 * A failed row is exactly as tall as a row of measurements.
 *
 * Both floors were the metric line box until the grade badge arrived: drawn at
 * the size of an icon it is taller than that box, so the measurement rows were
 * raised to clear it and the failure line was left behind on the old floor,
 * three pixels short of every neighbour. A list that changes row height as it
 * scrolls is the thing the constants at the top of that file exist to stop.
 */
describe("the floor a row stands on", () => {
    const escape = (selector) => selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // The lookahead keeps ".speedtest-row" off the rules for ".speedtest-row"
    // prefixed names, so the floor is read from the rule that declares it.
    const floorOf = (selector) => {
        const bodies = [...css.matchAll(
            new RegExp(`${escape(selector)}(?![-\\w])[^{},]*\\{([^}]*)}`, "g"))].map(([, body]) => body);
        const floors = bodies.flatMap((body) => [...body.matchAll(/min-height:\s*([^;}]+)/g)]
            .map(([, value]) => value.trim()));

        assert.equal(floors.length, 1, `${selector} declares ${floors.length} floors, expected one`);
        return floors[0];
    };

    // The rule as it is written, so a shared value can be told from a value
    // pasted twice. `.speedtest-row` is also restated inside a media query, at
    // an indent - only the unindented one opens the rule this reads.
    const declarationsIn = (selector) => {
        const lines = styles.split("\n").map((line) => line.replace(/\r$/, ""));
        const start = lines.indexOf(selector);
        assert.notEqual(start, -1, `${selector} is no longer a rule of its own`);

        const body = [];
        for (const line of lines.slice(start + 1)) {
            if (line.trim() === "") continue;
            if (!/^\s/.test(line)) break;
            body.push(line.trim());
        }

        return body;
    };

    const sourceFloorOf = (selector) => {
        const floor = declarationsIn(selector).find((line) => line.startsWith("min-height:"));
        assert.ok(floor, `${selector} reserves no height at all`);

        return floor.slice("min-height:".length).trim();
    };

    it("is the same height for a failure as for a measurement", () => {
        assert.equal(floorOf(".speedtest-failure"), floorOf(".speedtest-row"),
            "an error card is a different height from the cards around it, so the list jogs as it scrolls");
    });

    it("comes from one named constant rather than from two literals", () => {
        const shared = sourceFloorOf(".speedtest-row");

        assert.match(shared, /^\$[\w-]+$/,
            "the floor is a literal, so the next change to it has two places to remember");
        assert.equal(sourceFloorOf(".speedtest-failure"), shared,
            "the failure line reserves a height of its own, which is how the two drifted apart");
    });
});

/**
 * And it has to be given a width to stand that height in.
 *
 * The failure line is one sentence, nowrap, with an ellipsis for when it does
 * not fit - and none of that does anything without something bounding its
 * width. In both grid layouts the bound is its `grid-column`, which spans the
 * tracks the measurements would have used. Below 660px the row stops being a
 * grid: `flex-direction: column` with `align-items: flex-start`, where a
 * grid-column means nothing and an item is as wide as its content.
 *
 * So the sentence ran straight past the card. Measured at a 600px viewport: the
 * cell rendered 342px beyond the right edge of a 566px card, clipped by the
 * card's own `overflow: hidden` - cut mid-word, with no ellipsis to say it had
 * been cut, and the `title` attribute the only way left to read it.
 */
describe("the failure line on a stacked row", () => {
    // The block that turns the row into a stack, found by what it does rather
    // than by the width it does it at.
    const stacked = mediaBlocks(css)
        .map(({body}) => body)
        .find((body) => /\.speedtest\s*\{[^}]*flex-direction:\s*column/.test(body));

    it("has a stack to guard at all", () => {
        assert.ok(stacked, "the row no longer becomes a column, so this guards nothing");
    });

    /**
     * Stretch rather than a width: the row's padding is its own business and a
     * percentage would have to know it. What the cell needs is simply to be as
     * wide as the column it is in, which is what the cross-axis default would
     * have given it had the row not asked for flex-start.
     */
    it("is bounded by the column it sits in", () => {
        assert.match(stacked, /\.speedtest-failure\s*\{[^}]*align-self:\s*stretch/,
            "the sentence is as wide as its own text, so it overruns the card instead of ellipsing");
    });

    // The two together are what an ellipsis needs: something to overflow, and
    // permission to shrink below the content that overflows it.
    it("keeps the pieces an ellipsis is made of", () => {
        assert.match(css, /\.speedtest-failure\s*\{[^}]*min-width:\s*0/,
            "the cell cannot shrink below its sentence, so the bound above buys nothing");
        assert.match(css, /\.speedtest-failure-text\s*\{[^}]*text-overflow:\s*ellipsis/,
            "the sentence is cut with nothing to say it was cut");
    });
});

/**
 * The three measurements a row prints are whole numbers.
 *
 * The list is read down its columns - that is what the fixed grid above exists
 * for - and a column reads as a column when its figures are the same width. The
 * latency column stopped being that when the ping started keeping decimals: an
 * "8.4 ms" under a "132.7 ms" under a "9 ms" is three different widths in three
 * consecutive rows, and the two speed columns beside it carry up to four digits
 * and a fraction of their own.
 *
 * The tenths are not lost, they are one click away: the panel this row opens
 * onto prints every figure at the precision it was measured at, which is where a
 * tenth of a millisecond is worth reading.
 *
 * The three consts are plain JavaScript above the JSX, so they are lifted out
 * and run rather than pattern-matched - what matters is which figure comes out,
 * and a spelling assertion passes for any wording that happens to contain the
 * right words.
 */
describe("the figures a row prints", () => {
    const VALUES_START = "const pingValue";
    const VALUES_END = "const speedUnit";

    const printed = (props, preferences = {}) => {
        const start = row.indexOf(VALUES_START);
        assert.notEqual(start, -1, "the row no longer derives its printed figures in one place");

        const end = row.indexOf(VALUES_END, start);
        assert.notEqual(end, -1, `${VALUES_END} no longer follows them`);

        return new Function("props", "preferences", "formatWhole", "convertSpeed",
            `${row.slice(start, end)}\nreturn {pingValue, downValue, upValue};`)(
            props, preferences, formatWhole, convertSpeed);
    };

    it("rounds all three measurements to whole numbers", () => {
        assert.deepEqual(printed({ping: 12.64, down: 93.72, up: 41.38}),
            {pingValue: 13, downValue: 94, upValue: 41});
    });

    it("leaves a whole figure whole rather than printing a trailing zero", () => {
        assert.deepEqual(printed({ping: 13, down: 94, up: 41}),
            {pingValue: 13, downValue: 94, upValue: 41});
    });

    /**
     * The rounding comes after the unit conversion, not before it: MB/s is an
     * eighth of the figure the column stores, so a download rounded first and
     * divided second would be a different number entirely.
     */
    it("rounds the speed it prints, not the one it stores", () => {
        assert.equal(printed({ping: 12, down: 100, up: 100}, {speedUnit: SPEED_UNIT_MBYTES}).downValue, 13,
            "100 Mbps is 12.5 MB/s, which prints as 13");
    });

    /**
     * Math.round(null) is 0 and Math.round(undefined) is NaN. A row is drawn
     * from whatever the API returns, and an imported row's columns are barely
     * validated - so an unrounded guard would present a figure nobody measured
     * as a reading of zero.
     */
    it("does not turn an absent figure into a reading of zero", () => {
        for (const absent of [null, undefined])
            assert.equal(printed({ping: absent, down: absent, up: absent}).pingValue, absent,
                `failed for ${String(absent)}`);
    });

    // The interface recognises a failed test by the -1 its numeric columns
    // carry, and a row that failed shows its reason instead of three columns.
    it("keeps the failure placeholder recognisable", () => {
        assert.equal(printed({ping: -1, down: -1, up: -1}).pingValue, -1);
    });

    it("still empties the speeds on a row that failed", () => {
        const {downValue, upValue} = printed({ping: -1, down: -1, up: -1, error: "timeout"});

        assert.equal(downValue, "");
        assert.equal(upValue, "");
    });

    // The tripwire for a fourth figure wired straight to a prop, or for one of
    // these three quietly going back to full precision in the markup.
    it("draws the derived figures rather than deriving them again in the markup", () => {
        for (const name of ["pingValue", "downValue", "upValue"])
            assert.ok(row.includes(`{${name}}`), `the markup no longer draws ${name}`);

        assert.doesNotMatch(row, /\{formatLatency\(props\.ping\)}/,
            "the ping is printed at the panel's precision again");
    });
});

/**
 * What the row prints and what it wears are two different figures now.
 *
 * The rule this interface holds to is that one measurement never changes colour
 * between two views of it: the panel this row opens grades the ping at the one
 * decimal it prints, and the row has to agree with the panel. Grading the whole
 * number instead would break that at every bucket boundary - getIconBySpeed
 * floors a percentage, so a ping that rounds across one is green collapsed and
 * orange expanded.
 *
 * That the row now shows a rounder figure than it grades is the smaller fault of
 * the two, and it is the same trade the jitter already makes in the panel.
 */
describe("the colour a row's ping wears", () => {
    const level = (ping, target) => new Function("test", "config", "getIconBySpeed", "formatLatency",
        `return (${propValue(area, "pingLevel")});`)(
        {ping}, {ping: target}, getIconBySpeed, formatLatency);

    it("is read off the figure the panel it opens grades, not the one it prints", () => {
        assert.equal(level(12.5, "10"), "green");
    });

    it("would read differently off the printed figure", () => {
        assert.equal(getIconBySpeed(formatWhole(12.5), "10", false), "orange",
            "a fixture both gradings agree on proves nothing here");
    });
});
