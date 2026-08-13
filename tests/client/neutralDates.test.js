import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

/**
 * No date reaches the screen spelled as bare numbers.
 *
 * `17.08` is read as 17 August by the people who write dates that way and as
 * nothing at all by everyone else, and 08.09 is genuinely two different days
 * depending on the reader - upstream #785. Every displayed date goes through a
 * formatter that names the month in the app's language instead.
 *
 * This is a source check because there is no renderer in the test environment
 * to ask. It catches the shape the offending code had - a component reaching
 * for the calendar fields itself and joining them with a separator - which is
 * the only way a numeric date can be built here, since every formatter in
 * FormatUtil delegates to toLocaleDateString.
 *
 * Deliberately scoped to what is rendered. TimeframeUtil builds `YYYY-MM-DD`
 * for query parameters, which is a wire format the server parses and no one
 * reads, and DateRangePicker walks months to lay out a calendar grid.
 */
const EXEMPT = [
    // Serialises a range into the URL and the API query string.
    "common/utils/TimeframeUtil.js",
    // Calendar arithmetic: which month the grid is showing, not a label.
    "common/components/DateRangePicker/calendarNav.js",
    "common/components/DateRangePicker/DateRangePicker.jsx"
];

const sourceFiles = (dir) => fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) return sourceFiles(full);

    return /\.jsx?$/.test(entry.name) ? [full] : [];
});

/**
 * A calendar field read straight off a Date and joined to another with a
 * separator - `getDate() + "." + getMonth()`, in any order and with or without
 * the padStart in between.
 */
const HAND_BUILT_DATE = /get(?:Date|Month|FullYear)\(\)[^\n]{0,80}?["'`][.\/-]["'`]/;

describe("dates on screen", () => {
    it("are never assembled from raw calendar fields", () => {
        const offenders = [];

        for (const file of sourceFiles(CLIENT_SRC)) {
            const relative = path.relative(CLIENT_SRC, file).split(path.sep).join("/");
            if (EXEMPT.includes(relative)) continue;

            for (const line of fs.readFileSync(file, "utf8").split("\n"))
                if (HAND_BUILT_DATE.test(line)) offenders.push(`${relative}: ${line.trim()}`);
        }

        assert.deepEqual(offenders, [],
            "use a FormatUtil formatter so the month is named in the app's language");
    });

    // The guard is only worth having if it would have caught the original.
    it("is a check that recognises the shape it was written for", () => {
        assert.match(`String(props.time.getDate()).padStart(2, '0') + "." + String(props.time.getMonth() + 1)`,
            HAND_BUILT_DATE);
    });
});
