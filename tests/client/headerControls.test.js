import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const header = fs.readFileSync(path.join(CLIENT_SRC,
    "common/components/Header/HeaderComponent.jsx"), "utf8");

/**
 * Everything in the header used to be a FontAwesomeIcon carrying an onClick -
 * an <svg role="img">, which is neither focusable nor announced as a control.
 * Measured on a running instance, the header contained zero tabbable elements:
 * a keyboard user could not open the settings, reach the servers page, or sign
 * in as an administrator at all.
 *
 * The test cards had exactly this problem and fixed it the same way, with a
 * real <button> - see the HelpButton in SpeedtestComponent, "as bare svgs they
 * were the one thing on the card a keyboard could not reach at all". The header
 * simply never followed.
 *
 * Asserted against the source: these are controls inside a component with no
 * render harness, and what matters is the element they are built from.
 */
const CONTROLS = [
    {name: "the update notice", marker: "faCircleArrowUp"},
    {name: "the admin login", marker: "faLock"},
    {name: "the download link", marker: "faDownload"},
    {name: "the servers page", marker: "faServer"},
    {name: "the settings dropdown", marker: "icon={icon}"}
];

// Every <button …>…</button> in the header, as source text.
const buttons = () => {
    const found = [];
    for (const [index, chunk] of header.split("<button").entries()) {
        if (index === 0) continue;
        const end = chunk.indexOf("</button>");
        found.push("<button" + (end === -1 ? chunk : chunk.slice(0, end)));
    }
    return found;
};

// Which control the icon belongs to: the button whose body carries it.
const buttonCarrying = (marker) => {
    assert.notEqual(header.indexOf(marker), -1, `${marker} is no longer in the header`);
    return buttons().find((button) => button.includes(marker)) ?? null;
};

describe("the header's controls are real buttons", () => {
    for (const {name, marker} of CONTROLS) {
        it(`${name} is a button, not a bare icon`, () => {
            assert.notEqual(buttonCarrying(marker), null,
                `${name} is not inside a <button>, so no keyboard can reach it`);
        });
    }

    it("every header button says what it does", () => {
        const buttons = header.match(/<button[^>]*className="header-icon[^>]*>/g) ?? [];

        assert.ok(buttons.length >= CONTROLS.length - 1, "expected the header controls to be buttons");
        for (const button of buttons)
            assert.match(button, /aria-label=/, `a header button has no accessible name: ${button}`);
    });

    // Inside no form, but browsers default a button to submit.
    it("declares its buttons as type button", () => {
        for (const button of header.match(/<button[^>]*className="header-icon[^>]*>/g) ?? [])
            assert.match(button, /type="button"/, `a header button is missing type="button": ${button}`);
    });

    /**
     * The title opens the About dialog, so it is a control too - and it was an
     * <h2> with an onClick, which reads to a screen reader as a heading and to
     * a keyboard as nothing.
     */
    it("makes the instance title operable without hiding that it is a heading", () => {
        assert.match(header, /<h2[^>]*>\s*<button[^>]*className="header-about"/,
            "the title still carries its own onClick instead of holding a button");
    });
});
