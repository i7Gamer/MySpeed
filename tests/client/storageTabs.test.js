import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, tagHolding } from "../helpers/source.js";

/**
 * The storage dialog's two tabs were divs carrying an onClick.
 *
 * Tab walked straight past them, Enter and Space did nothing once focus was
 * forced there, and a screen reader announced no control at all - so the
 * configuration half of the dialog, factory reset included, simply did not
 * exist for a keyboard. The same defect the header's pagination had, fixed the
 * same way: real buttons, plus the tab semantics the styling already implies.
 *
 * Read as source, the way keyboardReachableControls.test.js reads its
 * components.
 */
const dialog = readSource("client/src/common/components/StorageDialog/StorageDialog.jsx");
const styles = readSource("client/src/common/components/StorageDialog/styles.sass");

describe("the storage tabs answer the keyboard", () => {
    it("switches with buttons rather than bare divs", () => {
        assert.match(dialog, /<button\b[^>]*role="tab"/,
            "a tab switcher is not a button, so no keyboard can reach it");
        assert.doesNotMatch(dialog, /<div[^>]*onClick=\{\(\) => setCurrentTab/,
            "a switcher is still a div carrying an onClick");
    });

    // Rendered from one list, so the switchers and the panels cannot drift -
    // and the list still names both halves of the dialog.
    it("draws both tabs from the one list", () => {
        const tabs = dialog.match(/const TABS = \[[^]*?\]/)?.[0];

        assert.ok(tabs, "the tab list is gone");
        assert.match(tabs, /storage\.speedtests/);
        assert.match(tabs, /storage\.configuration/);
    });

    // A button left untyped defaults to submit - the pagination's rule.
    it("declares an explicit type on every button", () => {
        const opened = (dialog.match(/<button\b/g) ?? []).length;
        const typed = (dialog.match(/<button\b[^>]*\btype="button"/g) ?? []).length;

        assert.notEqual(opened, 0, "the dialog contains no buttons at all");
        assert.equal(typed, opened, "a button in the storage dialog leaves its type to the browser");
    });

    /**
     * A <p> may not sit inside a button - the parser closes the button early
     * and the label falls outside the control. The pagination documents the
     * same trap; the stylesheet has to name the same element or the labels
     * lose their size and weight.
     */
    it("labels them with an element a button may contain", () => {
        const buttons = dialog.match(/<button[^]*?<\/button>/g) ?? [];
        assert.notEqual(buttons.length, 0, "the dialog contains no buttons at all");

        for (const button of buttons)
            assert.doesNotMatch(button, /<p>/,
                "a tab label is a paragraph, which cannot sit inside a button");

        assert.match(styles, /\r?\n {2}span\r?\n {4}margin: 0/,
            "the tab label's own rules name an element the markup no longer uses");
    });

    it("moves between tabs with the arrow keys", () => {
        assert.match(dialog, /ArrowRight|ArrowDown/, "no arrow key moves the selection");
        assert.match(dialog, /"Home"/, "Home does not reach the first tab");
        assert.match(dialog, /"End"/, "End does not reach the last tab");
    });
});

describe("the storage tabs say what they are", () => {
    it("sit in a tablist", () => {
        assert.match(tagHolding(dialog, "storage-top"), /role="tablist"/);
    });

    it("announce which one is selected", () => {
        assert.match(dialog, /role="tab"[^>]*aria-selected=/s,
            "a reader is never told which tab they are on");
    });

    /**
     * Roving tabindex: the selected tab is the tab stop, the other is reached
     * by arrow - so Tab crosses the tablist in one step instead of walking it.
     */
    it("keep one tab stop among them", () => {
        assert.match(dialog, /tabIndex=\{[^}]*currentTab[^}]*\? 0 : -1\}/,
            "either every tab is a stop or none is");
    });

    it("name the panel they control", () => {
        assert.match(dialog, /aria-controls=/, "the tabs control nothing a reader can follow");
        assert.match(tagHolding(dialog, "storage-manager"), /role="tabpanel"/);
        assert.match(tagHolding(dialog, "storage-manager"), /aria-labelledby=/);
    });

    // The size readout shares the tabs' styling and none of their behaviour:
    // it must not announce as a third tab that selects nothing.
    it("do not count the size readout among themselves", () => {
        assert.doesNotMatch(tagHolding(dialog, "reset-cursor"), /role="tab"/,
            "the size display announces as a tab a reader can never select");
    });

    /**
     * The readout is styled by the same rule as the tab labels, so it has to
     * be the same element. When the labels became spans the stylesheet's rule
     * followed them - and the readout, still a paragraph, silently lost its
     * margin, size and weight on every desktop viewport. Three independent
     * review passes found it; this holds the whole dialog to one label
     * element so the rule cannot orphan part of it again.
     */
    it("style the size readout with the element the stylesheet names", () => {
        assert.match(dialog, /<span>\{formatBytes\(/,
            "the size readout is not a span, so the tab-label rule does not reach it");
        assert.doesNotMatch(dialog, /<p>/,
            "a paragraph in this dialog is styled by nothing and carries browser default margins");
    });
});

/**
 * The one byte count in the app that did not go through formatBytes. The
 * route answers in bytes; the dialog divided by 1024, labelled the result
 * "KB" in the JSX, and never climbed a ladder - so a year of five-minute
 * tests read as a six-digit number of a unit nobody involved used, where the
 * traffic row beside it says "1.2 GB".
 */
describe("the storage size figure", () => {
    const dialog = readSource("client/src/common/components/StorageDialog/StorageDialog.jsx");

    it("is printed through formatBytes like every other byte count", () => {
        assert.match(dialog, /formatBytes\(storageSize\?\.size\)/, "the size is not printed through formatBytes");
        assert.doesNotMatch(dialog, /\/ 1024/, "the size is still divided by hand");
        assert.doesNotMatch(dialog, /\} KB</, "the unit is still an English literal in the JSX");
    });
});

/**
 * A failed /storage used to be presented as a fact: "0 KB" and "0 tests" on
 * a dialog whose request had been refused. The zeroed shape existed so the
 * render could read .size unconditionally without a TypeError; with the size
 * printed through formatBytes, which answers N/A for null, the shape can say
 * "not known" instead of "nothing".
 */
describe("the storage dialog when /storage fails", () => {
    const dialog = readSource("client/src/common/components/StorageDialog/StorageDialog.jsx");

    it("does not report a figure it does not have", () => {
        assert.match(dialog, /const EMPTY_STORAGE = \{size: null, testCount: null\}/,
            "a refused /storage is still reported as an empty database");
    });
});
