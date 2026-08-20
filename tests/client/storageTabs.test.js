import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const dialog = read("client/src/common/components/StorageDialog/StorageDialog.jsx");
const styles = read("client/src/common/components/StorageDialog/styles.sass");

/** The opening tag of the element carrying `marker`, attributes and all. */
const tagHolding = (source, marker) => {
    const at = source.indexOf(marker);
    assert.notEqual(at, -1, `${marker} is no longer in this component`);

    return source.slice(source.lastIndexOf("<", at), source.indexOf(">", at) + 1);
};

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
});
