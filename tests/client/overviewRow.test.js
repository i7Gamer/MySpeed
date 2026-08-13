import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as sass from "sass";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const ROW = "pages/Home/components/Speedtest/SpeedtestComponent.jsx";
const STYLES = "pages/Home/components/Speedtest/styles.sass";

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const row = read(ROW);
const styles = read(STYLES);

const aliasImporter = {
    findFileUrl(url) {
        if (!url.startsWith("@/")) return null;
        return pathToFileURL(path.join(CLIENT_SRC, url.slice(2)));
    }
};

const css = sass.compile(path.join(CLIENT_SRC, STYLES), {importers: [aliasImporter]}).css;

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
 */
const pressKey = (key, {fromNestedControl = false} = {}) => {
    const toggles = [];
    const handler = new Function("expanded", "setExpanded", `return (\n${propValue(row, "onKeyDown")}\n);`)(
        false, (value) => toggles.push(value));

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
