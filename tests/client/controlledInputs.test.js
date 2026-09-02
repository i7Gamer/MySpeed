import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

const FORM_FIELD = "client/src/common/components/FormField/FormField.jsx";
const DROPDOWN = "client/src/common/components/Dropdown/DropdownComponent.jsx";

/**
 * A field handed `undefined` is an uncontrolled input, and React will not let
 * it become a controlled one again without a warning - after which typing into
 * it stops updating the value it was given.
 *
 * The number branch already guarded this and the three beside it did not, which
 * is the whole of the fault: one component, four inputs, two contracts.
 */
describe("the form field's value", () => {
    const source = readSource(FORM_FIELD);

    const branchFor = (type) => {
        const at = source.indexOf(`type === "${type}"`);
        assert.notEqual(at, -1, `the ${type} branch is gone`);

        return source.slice(at, source.indexOf(")}", at));
    };

    for (const type of ["text", "number", "textarea", "select"])
        it(`never hands the ${type} input an undefined value`, () => {
            assert.match(branchFor(type), /value=\{value \?\? ""\}/,
                `the ${type} input flips between controlled and uncontrolled`);
        });

    // The same asymmetry one branch further down, and the same warning: a
    // checkbox given undefined is uncontrolled too.
    it("never hands the toggle an undefined checked", () => {
        assert.match(branchFor("boolean"), /checked=\{value \?\? false\}/);
    });

    // The number branch round-trips "" back out through onChange, so "" is
    // already this component's spelling of "no value". Changing that would
    // change what the integration card submits.
    //
    // The value is matched by shape rather than by name: the branch reads its
    // input from NumberField's argument now instead of from an event, and what
    // has to hold is that the same expression is tested and converted - an
    // empty string out as an empty string, anything else as a number.
    it("leaves the change contract alone", () => {
        assert.match(source, /([\w.]+) === "" \? "" : Number\(\1\)/);
    });
});

/**
 * What React is given to tell one dropdown entry from another.
 *
 * `key={entry.run}` handed it a function, which React stringifies to the
 * function's own source text. That is stable enough by accident, but it means a
 * key hundreds of bytes long carrying the entry's comments, and two entries
 * whose handlers ever become textually identical would collide silently.
 *
 * `entry.text` would be worse, not better: every one of those is a t() call
 * evaluated at render, so switching language changes all ten keys at once and
 * remounts the whole menu - and the pause entry's text flips on every pause
 * toggle. The separators already carry a stable key of their own; this gives
 * every entry one, so both branches read the same.
 */
describe("the dropdown's entry keys", () => {
    const source = readSource(DROPDOWN);

    it("is never the handler itself", () => {
        assert.doesNotMatch(source, /key=\{entry\.run\}/,
            "the key is the handler's source text, comments and all");
    });

    it("is never the translated label", () => {
        assert.doesNotMatch(source, /key=\{entry\.text\}/,
            "switching language remounts every entry in the menu");
    });

    it("is the entry's own stable key, on both branches", () => {
        const keys = source.match(/key=\{entry\.\w+\}/g) ?? [];

        assert.ok(keys.length >= 2, "the entries are no longer keyed at all");
        for (const key of keys)
            assert.equal(key, "key={entry.key}", `${key} is not the entry's stable key`);
    });

    /**
     * Every entry has to declare one, or the map hands React undefined for the
     * ones that do not - which is the same as no key at all. Counted against
     * the entries themselves rather than trusted: entries are added to this
     * list often, and a new one without a key would be invisible.
     */
    it("is declared by every entry in the list", () => {
        const list = source.slice(source.indexOf("const options = ["),
            source.indexOf("];", source.indexOf("const options = [")));

        const entries = list.match(/^\s*\{.*\},?$/gm) ?? [];

        assert.ok(entries.length >= 10, `only ${entries.length} entries were read`);
        for (const entry of entries)
            assert.match(entry, /\bkey:\s*["'`]/, `an entry declares no key: ${entry.trim()}`);
    });
});
