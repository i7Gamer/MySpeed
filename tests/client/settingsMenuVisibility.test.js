import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import { isMenuEntryVisible } from "@/common/components/Dropdown/DropdownComponent";

/**
 * Which of the settings menu's entries an instance is offered.
 *
 * Three separate conditions decide it - an entry hidden on a demo, an entry
 * that exists only on a demo, and the read-only instance that is allowed a
 * couple of them - and all three used to be written as early returns inside
 * the map callback, the last of them as an `if` with no `else`. That is three
 * paths that hand React an `undefined` child rather than nothing, which
 * renders the same but says something different: the list's shape stops being
 * "the entries this instance has" and becomes "one slot per entry, some of
 * them empty". Asked as a predicate, and asked before the mapping, the answer
 * is a list of the entries that exist.
 */

// The three shapes of instance the menu is drawn on. `viewMode` is the
// read-only reader, `previewMode` the public demo; the ordinary instance is
// neither.
const ORDINARY = {viewMode: false, previewMode: false};
const READ_ONLY = {viewMode: true, previewMode: false};
const PREVIEW = {viewMode: false, previewMode: true};

const PLAIN = {key: "storage"};

describe("which settings entries an instance is offered", () => {
    it("offers a plain entry on an ordinary instance", () => {
        assert.equal(isMenuEntryVisible(PLAIN, ORDINARY), true);
    });

    it("hides an entry marked previewHidden on a demo", () => {
        assert.equal(isMenuEntryVisible({key: "password", previewHidden: true}, PREVIEW), false,
            "the demo offers the password dialog, whose save it would refuse");
    });

    it("keeps that entry everywhere else", () => {
        assert.equal(isMenuEntryVisible({key: "password", previewHidden: true}, ORDINARY), true);
    });

    it("hides an entry marked previewShown off a demo", () => {
        assert.equal(isMenuEntryVisible({key: "provider", previewShown: true}, ORDINARY), false,
            "an entry that exists only for the demo is offered on every instance");
    });

    it("draws that entry on the demo it belongs to", () => {
        assert.equal(isMenuEntryVisible({key: "provider", previewShown: true}, PREVIEW), true);
    });

    it("hides an ordinary entry from a read-only reader", () => {
        assert.equal(isMenuEntryVisible(PLAIN, READ_ONLY), false,
            "a reader who may change nothing is offered a dialog that writes");
    });

    it("keeps the entries a read-only reader is allowed", () => {
        assert.equal(isMenuEntryVisible({key: "language", allowView: true}, READ_ONLY), true);
    });

    // The separators are entries too, and they carry none of the three marks -
    // so a read-only reader has never seen one, and that has to stay true or
    // the menu grows rules the entries do not.
    it("treats a separator like any other unmarked entry", () => {
        assert.equal(isMenuEntryVisible({hr: true, key: "hr-1"}, ORDINARY), true);
        assert.equal(isMenuEntryVisible({hr: true, key: "hr-1"}, READ_ONLY), false);
    });
});

describe("the settings menu asks before it draws", () => {
    it("filters the entries rather than mapping over the ones it will not draw", () => {
        const source = readSource("client/src/common/components/Dropdown/DropdownComponent.jsx");
        const list = source.slice(source.indexOf("{options"));

        assert.match(list.slice(0, list.indexOf(".map(")), /\.filter\(/,
            "the menu still decides inside the map, which puts an empty slot where an entry was skipped");
    });
});
