import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clickLandsOutside } from "../../client/src/common/hooks/useClickOutside.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

// A stand-in for a DOM element: contains() is all the judgement reads.
const element = (...children) => ({contains: (target) => children.includes(target)});

describe("clickLandsOutside", () => {
    const target = {};

    it("is false while any element holds the target", () => {
        assert.equal(clickLandsOutside(target, [element(), element(target)]), false);
    });

    it("is true when none of them do", () => {
        assert.equal(clickLandsOutside(target, [element(), element()]), true);
    });

    it("treats an unmounted ref as not containing anything", () => {
        assert.equal(clickLandsOutside(target, [null, undefined, element()]), true);
        assert.equal(clickLandsOutside(target, [null, element(target)]), false);
    });
});

/**
 * Four components used to register their own document-level mousedown
 * listener with four slightly different outside-click rules - and the
 * dropdown's walked event.composedPath() by fixed depth to find the opener,
 * which breaks the moment a wrapper element appears.
 */
describe("the popovers share the click-outside hook", () => {
    const POPOVERS = [
        "common/components/ExportButton/ExportButton.jsx",
        "common/components/DateRangePicker/DateRangePicker.jsx",
        "common/components/Dropdown/DropdownComponent.jsx",
        "common/components/ContextMenu/ContextMenu.jsx"
    ];

    for (const file of POPOVERS) {
        const name = path.basename(file, ".jsx");
        const source = read(file);

        it(`${name} uses useClickOutside`, () => {
            assert.match(source, /useClickOutside\(/, `${name} still hand-rolls the listener`);
        });
    }

    it("the dropdown no longer walks composedPath by depth", () => {
        assert.doesNotMatch(read("common/components/Dropdown/DropdownComponent.jsx"),
            /composedPath\(\)\[\d\]/);
    });
});
