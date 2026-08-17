import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    convertSpeed, formatLatency, formatShortTime, formatWhole, SPEED_UNIT_MBYTES
} from "@/common/utils/FormatUtil.js";
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
 * The narrow grid tiers state their tracks once.
 *
 * The 920px three-column row is "the same three widths the six-column row
 * uses, minus the tracks that fold away" - an invariant that lived in a
 * comment, so a re-measure of one block could leave the other behind with
 * nothing to say so. Both narrow templates now spell their tracks with the
 * same variables, which makes the subset true by construction; the base tier
 * keeps its own literals, being its own set of measurements.
 */
describe("the narrow grid tiers share their track widths", () => {
    const templates = [...styles.matchAll(/grid-template-columns:([^\n]*)/g)]
        .map(([, tracks]) => tracks.trim());

    const names = (template) => template.match(/\$[\w-]+/g) ?? [];

    it("has the three tiers it sizes", () => {
        assert.equal(templates.length, 3, "a grid tier appeared or vanished; re-map this file's contract");
    });

    it("leaves no literal width in either narrow tier", () => {
        for (const template of templates.slice(1))
            assert.doesNotMatch(template, /[\d.]+rem/,
                "a narrow tier states a width inline again, free to drift from its sibling tier");
    });

    it("builds the folded row from the six-column row's own tracks", () => {
        const six = names(templates[1]);
        const three = names(templates[2]);

        assert.equal(six.length, 5, "the six-column tier no longer names five tracks plus auto");
        assert.equal(three.length, 3, "the folded row no longer names three tracks");

        for (const name of three)
            assert.ok(six.includes(name),
                `${name} is not one of the six-column tier's tracks, so the two layouts disagree`);
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
 * The date cell prints the time and nothing else.
 *
 * It carried a translated preposition in front of it - `t("time.at")` before a
 * clock time, `t("time.on")` before a day. In English that is one short word,
 * and the date track was measured with it sitting there. In other languages it
 * is not: "A las", "W dniu", "Zamanında", "На адрес". A prefix wider than the
 * track wraps the cell onto a second line, and the cell is what sets the height
 * of the row - so a list of a hundred tests stood a good deal taller than its
 * contents needed, in every language but the one it was measured in.
 *
 * Width is only half of it. Four of those are translations of the English word
 * rather than of its sense here - "on" as in a website (ru, bg), "on" as in
 * active (pt "Ativo"), "at" as in on time (tr "Zamanında") - and uk has neither
 * key at all. That is what a bare preposition handed to a translator produces:
 * there is no sentence around it, and nothing in the string says what it
 * prefixes. Shortening it would leave every one of those still wrong.
 *
 * Nothing goes with it. The cell prints a clock time and the icon beside it
 * says so, which is the whole of what the word was adding.
 *
 * It used to have a second format to tell apart - a named day, for rows that
 * stood for a whole day - and the preposition switched between "on" and "at" to
 * match. Those rows have not existed since listAverage was removed from the
 * speedtest controller in June 2025, so the branch was choosing between one
 * reachable format and one that nothing could produce. It is gone with the
 * word; the last two tests below are what keep it gone.
 */
describe("what the row's date cell prints", () => {
    const CELL = 'className="date-text"';

    const LABEL_START = "let timeString";
    const LABEL_END = "const pingValue";

    // The expression the cell draws, taken as written. What is wrong with a
    // composed label is the composing, so this asserts on the source rather
    // than on a rendered string: any spelling that concatenates something in
    // front of the time is the defect, whatever that something formats to.
    const drawn = () => {
        const start = row.indexOf(CELL);
        assert.notEqual(start, -1, "the date cell is no longer marked date-text");

        const from = row.indexOf(">", start);
        const to = row.indexOf("</h2>", from);
        assert.notEqual(to, -1, "the date cell is no longer an h2");

        return row.slice(from + 1, to).trim();
    };

    /**
     * The label itself, lifted out and run - the same treatment the printed
     * figures below get, and for the same reason: what a row's label comes out
     * as is only observable by handing it a row.
     */
    const labelled = (props, preferences = {}) => {
        const start = row.indexOf(LABEL_START);
        assert.notEqual(start, -1, "the row no longer derives its label in one place");

        const end = row.indexOf(LABEL_END, start);
        assert.notEqual(end, -1, `${LABEL_END} no longer follows it`);

        return new Function("props", "preferences", "formatShortTime",
            `${row.slice(start, end)}\nreturn timeString;`)(props, preferences, formatShortTime);
    };

    it("draws the formatted date alone", () => {
        assert.equal(drawn(), "{timeString}",
            "the cell composes its text again, which is how a translated word got in front of the time");
    });

    it("puts no translated word in front of it", () => {
        assert.doesNotMatch(row, /t\(\s*"time\./,
            "the row reads a time.* string again - the prefix that wrapped the cell in half the languages");
    });

    it("prints a clock time", () => {
        assert.equal(labelled({time: new Date(2026, 7, 15, 14, 32)}), "14:32");
    });

    /**
     * And one whatever the row claims to be.
     *
     * `type` is a database column, and a row carrying "average" was once drawn
     * as a named day instead. The controller stopped producing those rows when
     * listAverage was removed in June 2025 - the importer will not accept the
     * value either, taking only "auto" and "custom" - so for a year the row
     * carried a formatter that could not be reached. A stored row saying
     * otherwise must not bring the second format back.
     */
    it("prints one whatever type the row carries", () => {
        const afternoon = new Date(2026, 7, 15, 14, 32);

        for (const type of ["auto", "custom", "average", undefined])
            assert.equal(labelled({type, time: afternoon}), "14:32", `failed for type ${String(type)}`);
    });

    // Both ends of the plumbing, so neither the branch nor the prop feeding it
    // comes back on its own.
    it("is handed no row type to branch on", () => {
        assert.doesNotMatch(row, /props\.type/,
            "the row reads a type column again - the last one it branched on had no producer for a year");
        assert.doesNotMatch(area, /type=\{test\.type\}/,
            "the list passes a type the row does not read");
    });
});

/**
 * The date column is wide enough for the widest clock it can print.
 *
 * The track was measured against a 24-hour label, which is the shorter of the
 * two the cell can be set to: "04:44" is 94px at the base tier where "10:44 AM"
 * is 147px, and the column only ever had 137px to give. So on a 12-hour clock
 * the ten, eleven and twelve o'clock rows wrapped and stood 30px taller than
 * the rows around them - a list that changes height as it scrolls, which is the
 * thing the constants at the top of that stylesheet exist to prevent.
 *
 * It went unseen because the translated prefix in front of the label used to
 * overflow the column in every language at every hour, so the rows were
 * uniformly too tall rather than unevenly so. Removing the prefix left the
 * three genuine offenders on their own.
 *
 * The widths below were measured in a browser over all 1440 clock times at each
 * tier's own font size, rather than over the times a fixture happens to hold -
 * the sample said "10:03 AM", which is only the widest of what was in it. The
 * assertion is the inequality rather than the figures, so re-measuring one part
 * of the cell does not quietly invalidate the others.
 *
 * The stacked tier below 660px is deliberately absent: the row is a flex column
 * with align-items: flex-start there, so the cell is as wide as its own content
 * and there is no track to outgrow.
 */
describe("the room the date column gives its label", () => {
    const REM = 16;

    // The rules below are found by their indentation, so the carriage returns
    // have to go first - a sass rule read off a CRLF checkout ends every line
    // in one, and \s+ then swallows the newline it is meant to anchor to.
    const source = styles.replace(/\r/g, "");

    // Measured, Chrome, at the font size each tier sets on .date-text: 32px at
    // the base tier and 24px below 1400px. "10:44 AM" is the widest of all 1440
    // clock times at both, and comfortably wider than the widest 24-hour one.
    const WIDEST_LABEL = {base: 147, narrow: 110};

    // The clock glyph beside it, which the flex row lays out before the text.
    // Same box at both tiers - it is sized in rem by its own rule, not by the
    // label's font size.
    const ICON = 35;

    const rem = (value) => {
        const match = /([\d.]+)rem/.exec(value);
        assert.ok(match, `${value} is no longer stated in rem`);
        return parseFloat(match[1]) * REM;
    };

    const templates = [...source.matchAll(/grid-template-columns:([^\n]*)/g)]
        .map(([, tracks]) => tracks.trim());

    // The first track of the base tier, which states its widths as literals.
    const baseTrack = () => rem(templates[0].split(/\s+/)[0]);

    const narrowTrack = () => {
        const declared = /\$narrow-date:\s*([\d.]+rem)/.exec(source);
        assert.ok(declared, "the narrow tiers no longer name their date track");
        return rem(declared[1]);
    };

    // .date-text sets `margin: 0 0 0 1rem` at the base tier and overrides
    // margin-left below 1400px.
    const baseMargin = () => {
        const shorthand = /\.date-text\n\s+margin:\s*([^\n]+)/.exec(source);
        assert.ok(shorthand, ".date-text no longer sets its margin as a shorthand");
        return rem(shorthand[1].trim().split(/\s+/).pop());
    };

    const narrowMargin = () => {
        const override = /\.date-text\n\s+font-size:[^\n]*\n\s+margin-left:\s*([^\n]+)/.exec(source);
        assert.ok(override, "the narrow tiers no longer override the label's margin");
        return rem(override[1].trim());
    };

    it("fits the widest clock at the base tier", () => {
        const available = baseTrack() - ICON - baseMargin();

        assert.ok(available >= WIDEST_LABEL.base,
            `the date track leaves ${available}px for a label needing ${WIDEST_LABEL.base}px, `
            + "so a two-digit hour on a 12-hour clock wraps and that row stands taller than its neighbours");
    });

    it("fits the widest clock at the narrow tiers", () => {
        const available = narrowTrack() - ICON - narrowMargin();

        assert.ok(available >= WIDEST_LABEL.narrow,
            `$narrow-date leaves ${available}px for a label needing ${WIDEST_LABEL.narrow}px`);
    });

    /**
     * And no wider than it has to be. The row's total is what decides where it
     * stops fitting and folds, so width taken here is width the measurements
     * beside it do not get - the column was already the one carrying slack,
     * being the only one whose content is not a measurement.
     */
    it("takes no more room than the label needs", () => {
        const slack = {
            base: baseTrack() - ICON - baseMargin() - WIDEST_LABEL.base,
            narrow: narrowTrack() - ICON - narrowMargin() - WIDEST_LABEL.narrow
        };

        for (const [tier, spare] of Object.entries(slack))
            assert.ok(spare < REM,
                `the ${tier} date track carries ${spare}px past its widest label, which is width `
                + "the row's own total pays for");
    });
});

/**
 * The row folds before it runs out of room, not after.
 *
 * The six-column tier holds fixed tracks, so the width it needs is arithmetic:
 * five tracks, the chevron, the gaps between them and the row's own padding.
 * Below that it has to fold, and the ceiling of the folded tier is what decides
 * when. Those two numbers were consistent and unrelated - nothing tied the
 * ceiling to the tracks it exists to give up on - so widening the date track by
 * 0.75rem for the 12-hour clock silently opened a band just above the fold
 * where the row no longer fitted: measured, it overran its padding by 5px at
 * 921px and by 1px at 925px, the last column drawn into the page gutter.
 *
 * A grid item does not clip, so that band showed as the chevron leaving the
 * card rather than as anything wrapping. The ceiling moved to 930px, and the
 * inequality below is what keeps the two together the next time a track is
 * re-measured.
 */
describe("where the six-column row gives up", () => {
    const REM = 16;

    /**
     * What surrounds the row at the fold, measured in a browser: the page
     * gutters either side of the card plus its borders, everything between the
     * viewport width and the row's own border box.
     *
     * Constant across this tier - it comes from the page layout, not from the
     * row - and confirmed at 935px and 960px, which agreed to the pixel.
     */
    const PAGE_CHROME = 34;

    const px = (value) => {
        const match = /([\d.]+)rem/.exec(value);
        assert.ok(match, `${value} is no longer stated in rem`);
        return parseFloat(match[1]) * REM;
    };

    // The compiled tier, so the track variables arrive resolved.
    const sixColumn = mediaBlocks(css)
        .find(({condition, body}) => /max-width:\s*1400px/.test(condition)
            && /grid-template-columns/.test(body));

    const folded = mediaBlocks(css)
        .find(({body}) => /\.speedtest\s*\{[^}]*grid-template-rows/.test(body));

    it("has both tiers to relate", () => {
        assert.ok(sixColumn, "the six-column tier no longer sizes its own tracks");
        assert.ok(folded, "the row no longer folds into rows at all");
    });

    it("folds at or above the width its own tracks need", () => {
        const template = /grid-template-columns:([^;}]*)/.exec(sixColumn.body)[1];
        const tracks = template.trim().split(/\s+/).filter((track) => track !== "auto");

        assert.equal(tracks.length, 5, "the six-column tier no longer names five fixed tracks");

        const chevron = px(/\.speedtest-chevron\s*\{[^}]*width:\s*([^;}]+)/.exec(css)[1]);
        const gap = px(/\.speedtest\s*\{[^}]*[^-]gap:\s*([^;}]+)/.exec(css)[1]);
        const padding = /padding:\s*([^;}]+)/.exec(sixColumn.body)[1].trim().split(/\s+/);

        // Five tracks and the chevron make six columns, so five gaps between
        // them; the padding is stated as vertical then horizontal.
        const needs = tracks.reduce((total, track) => total + px(track), 0)
            + chevron + gap * 5 + px(padding[1]) * 2 + PAGE_CHROME;

        const ceiling = Number(/max-width:\s*(\d+)px/.exec(folded.condition)[1]);

        assert.ok(ceiling >= needs,
            `the row folds at ${ceiling}px but needs ${needs}px, so between those two widths it `
            + "lays out wider than the page gives it and the last column is drawn into the gutter");
    });

    /**
     * And not far above it either: every pixel between the two is a width where
     * the row has folded into two lines with room to spare for one.
     */
    it("does not fold earlier than it has to", () => {
        const ceiling = Number(/max-width:\s*(\d+)px/.exec(folded.condition)[1]);
        const template = /grid-template-columns:([^;}]*)/.exec(sixColumn.body)[1];
        const tracks = template.trim().split(/\s+/).filter((track) => track !== "auto");

        const chevron = px(/\.speedtest-chevron\s*\{[^}]*width:\s*([^;}]+)/.exec(css)[1]);
        const gap = px(/\.speedtest\s*\{[^}]*[^-]gap:\s*([^;}]+)/.exec(css)[1]);
        const padding = /padding:\s*([^;}]+)/.exec(sixColumn.body)[1].trim().split(/\s+/);

        const needs = tracks.reduce((total, track) => total + px(track), 0)
            + chevron + gap * 5 + px(padding[1]) * 2 + PAGE_CHROME;

        assert.ok(ceiling - needs < 2 * REM,
            `the row folds ${ceiling - needs}px before it has to, giving up a column layout that fits`);
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
