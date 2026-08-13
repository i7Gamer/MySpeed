import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CronExpressionParser } from "cron-parser";
import { firstRunOutsideWindow } from "@/common/components/PauseDialog/quietHoursWindow.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (...parts) => fs.readFileSync(path.join(CLIENT_SRC, ...parts), "utf8");

const source = read("common", "components", "FrequencyDialog", "FrequencyDialog.jsx");
const dropdown = read("common", "components", "Dropdown", "DropdownComponent.jsx");

// The index of the closer that balances the opener at `from`. The regions dug
// out below carry nested pairs, so a regex cannot find where they end.
const closingIndex = (text, from, opener, closer) => {
    let depth = 0;

    for (let index = from; index < text.length; index++) {
        if (text[index] === opener) depth++;
        else if (text[index] === closer && --depth === 0) return index;
    }

    assert.fail(`a ${opener} is never closed`);
};

/**
 * The module-level helper, taken out of the file and run - the approach
 * escapeTopmost.test.js already uses for code that lives in a JSX file node
 * cannot parse. The helper asks CronExpressionParser what "now" is, so the
 * tests hand in a parse pinned to a known instant; the window logic is the
 * real quietHoursWindow module, not a stand-in.
 */
const getNextRunDateWith = (parse) => {
    const start = source.indexOf("const getNextRunDate");
    assert.notEqual(start, -1, "the quiet-aware helper is gone");

    const brace = source.indexOf("{", source.indexOf("=>", start));
    const helper = source.slice(start, closingIndex(source, brace, "{", "}") + 1);

    return new Function("CronExpressionParser", "firstRunOutsideWindow", `${helper}; return getNextRunDate;`)(
        {parse}, firstRunOutsideWindow);
};

// Everything below digs into the component body, not the helper above it.
const componentStart = source.indexOf("export const FrequencyDialog");

/**
 * The component's one call into the helper, evaluated against a fixture scope.
 *
 * The name-matching assertions further down cannot see argument order: with
 * the two window keys swapped at the call site every name still appears, yet a
 * 23:00-08:00 window is read as 08:00-23:00 and the preview announces times
 * inside the hours it claims to honour.
 */
const callSiteAnswer = (getNextRunDate, customCron, config) => {
    const start = source.indexOf("getNextRunDate(", componentStart);
    assert.notEqual(start, -1, "the component no longer asks the helper");

    const call = source.slice(start, closingIndex(source, start + "getNextRunDate".length, "(", ")") + 1);

    return new Function("getNextRunDate", "customCron", "config", `return ${call};`)(
        getNextRunDate, customCron, config);
};

/**
 * The useMemo call around the preview, evaluated with a recording stand-in so
 * a test can see what the factory computes and what it declares as inputs.
 */
const previewMemo = ({open, customCron, config, getNextRunDate}) => {
    const start = source.indexOf("useMemo(", componentStart);
    assert.notEqual(start, -1, "the preview is recomputed on every render of the mounted dialog");

    const call = source.slice(start, closingIndex(source, start + "useMemo".length, "(", ")") + 1);
    const recorded = {};
    const useMemo = (factory, dependencies) => {
        recorded.factory = factory;
        recorded.dependencies = dependencies;
        return factory();
    };

    recorded.value = new Function("useMemo", "open", "customCron", "config", "getNextRunDate", `return ${call};`)(
        useMemo, open, customCron, config, getNextRunDate);

    return recorded;
};

const QUIET_WINDOW = {quietHoursStart: "23:00", quietHoursEnd: "08:00"};
const NO_WINDOW = {quietHoursStart: "none", quietHoursEnd: "none"};
const HOURLY = "0 * * * *";

// Half an hour into the stored window: every top of the hour from midnight on
// falls inside it, so the first run the scheduler would allow is 08:00 sharp -
// while the window read backwards lets midnight straight through.
const INSIDE_WINDOW = new Date(2026, 0, 5, 23, 30);
const WINDOW_CLOSES = new Date(2026, 0, 6, 8, 0);
const MIDNIGHT_AFTER = new Date(2026, 0, 6, 0, 0);

const parseFrom = (currentDate) => (cron) => CronExpressionParser.parse(cron, {currentDate});

/**
 * The dialog's "Next test:" line used to be a bare CronExpressionParser.next()
 * with no quiet-hours knowledge, which commit 7f684733 had already declared a
 * bug for the other announcer: the server steps over occurrences inside the
 * window because runTask refuses them. So with quiet hours of 23:00-08:00, at
 * 23:30, typing "0 * * * *" made the dialog promise 00:00 while the status bar
 * on the same screen counted down to 08:00.
 *
 * The window logic itself lives in quietHoursWindow.js and is exercised there;
 * this pins the wiring, which a render harness would otherwise be needed for.
 */
describe("the frequency dialog's next-test preview", () => {
    it("steps over the occurrences the scheduler would refuse", () => {
        assert.match(source, /firstRunOutsideWindow\(/,
            "the preview is not quiet-aware");
        assert.match(source, /quietHoursWindow/,
            "the preview does not reuse the client's window logic");
    });

    it("reads the window from the config it already holds", () => {
        assert.match(source, /config\.quietHoursStart/);
        assert.match(source, /config\.quietHoursEnd/);
    });

    /**
     * Both quiet hours keys are withheld from a read-only visitor, along with
     * the cron itself - so the preview only knows what it needs while the dialog
     * stays behind an operator-only entry. Opening it to view mode would leave
     * it announcing the very time the scheduler skips, to the one audience that
     * cannot correct it.
     */
    it("is only offered to an operator, which is why the window is there to read", () => {
        const entry = dropdown.match(/\{run: \(\) => setShowFrequencyDialog\(true\)[^}]*\}/);
        assert.ok(entry, "the frequency dialog is no longer opened from the dropdown");

        assert.doesNotMatch(entry[0], /allowView/,
            "view mode opens the dialog, and the config it is given carries no quiet hours");
    });

    /**
     * Validity has to stay a question about the expression alone. A window that
     * happens to swallow every occurrence of a perfectly good cron would
     * otherwise make it unsaveable - and the operator's way out of that is the
     * quiet hours dialog, not this one.
     */
    it("does not let the window decide whether an expression can be saved", () => {
        assert.match(source, /isCronValid\(/, "validity is not separated from the preview");

        const guard = source.match(/if \(!cronValue \|\| ([^)]*\)?)\) return;/);
        assert.ok(guard, "the save guard is gone");
        assert.doesNotMatch(guard[1], /getNextRun\b/,
            "the save is blocked by the quiet-aware preview");

        const validity = source.match(/const isCustomValid = [^;]*;/);
        assert.ok(validity, "the custom-cron validity check is gone");
        assert.doesNotMatch(validity[0], /getNextRun\b/,
            "a swallowed schedule marks a valid expression invalid");
    });
});

/**
 * The wiring itself, executed. Everything above pins that the right names
 * appear in the file; only running the call site can pin which end of the
 * window goes where.
 */
describe("the preview, run against a stored window", () => {
    it("announces the first occurrence the window lets through", () => {
        const next = callSiteAnswer(getNextRunDateWith(parseFrom(INSIDE_WINDOW)), HOURLY, QUIET_WINDOW);

        assert.equal(next?.getTime(), WINDOW_CLOSES.getTime(),
            "the preview announces a test inside the very hours it claims to honour");
    });

    // The counterpart that proves the difference above comes from the window:
    // with it off, the same schedule answers with the bare next occurrence.
    it("announces the bare next occurrence when the window is off", () => {
        const next = callSiteAnswer(getNextRunDateWith(parseFrom(INSIDE_WINDOW)), HOURLY, NO_WINDOW);

        assert.equal(next?.getTime(), MIDNIGHT_AFTER.getTime());
    });
});

/**
 * What the preview costs. This dialog is mounted with the header and
 * re-renders with every status poll - every few seconds, all session - and a
 * window that swallows the schedule makes each evaluation walk up to
 * MAX_QUIET_OCCURRENCES occurrences. So the walk has to be memoized on the
 * values that shape it, and skipped outright while the dialog is closed;
 * going stale across an occurrence while it sits open is the cheaper wrong.
 */
describe("what the preview costs the mounted dialog", () => {
    it("computes nothing while the dialog is closed", () => {
        const walks = [];
        const memo = previewMemo({open: false, customCron: HOURLY, config: QUIET_WINDOW,
            getNextRunDate: (...args) => walks.push(args)});

        // What React does on the poll-driven re-renders of a closed dialog.
        memo.factory();

        assert.equal(walks.length, 0, "a closed dialog still walks the schedule");
        assert.equal(memo.value, null);
    });

    it("computes the preview once the dialog is open", () => {
        const walks = [];
        const memo = previewMemo({open: true, customCron: HOURLY, config: QUIET_WINDOW,
            getNextRunDate: (...args) => walks.push(args) && MIDNIGHT_AFTER});

        assert.equal(walks.length, 1, "an open dialog shows no preview at all");
        assert.deepEqual(walks[0], [HOURLY, QUIET_WINDOW.quietHoursStart, QUIET_WINDOW.quietHoursEnd],
            "the window is not handed over the way getNextRunDate reads it");
    });

    it("declares the values that shape the preview as its inputs", () => {
        const memo = previewMemo({open: true, customCron: HOURLY, config: QUIET_WINDOW,
            getNextRunDate: () => MIDNIGHT_AFTER});

        assert.ok(Array.isArray(memo.dependencies), "without a dependency list the memo recomputes every render");

        for (const input of [true, HOURLY, QUIET_WINDOW.quietHoursStart, QUIET_WINDOW.quietHoursEnd]) {
            assert.ok(memo.dependencies.includes(input),
                `the memo does not watch ${JSON.stringify(input)}, so that input can change under a stale preview`);
        }

        for (const dependency of memo.dependencies) {
            assert.ok(typeof dependency !== "object" && typeof dependency !== "function",
                "a dependency rebuilt on every render defeats the memo");
        }
    });
});
