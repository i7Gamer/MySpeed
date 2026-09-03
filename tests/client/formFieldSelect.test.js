import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { act, cleanup, createElement, render, window } from "../helpers/renderHarness.js";
import { FormField } from "@/common/components/FormField/FormField";

/**
 * The fourth field type the integration form draws: a choice from a list,
 * which the language setting every notifier carries is. A native select
 * rather than the dropdown menu the dialog's add button uses - that one is a
 * command menu, and this is a value.
 *
 * Rendered rather than scanned, because what matters is what a keyboard and
 * a screen reader meet: a labelled select whose first entry is the "none"
 * the server reads as English, and which reports the chosen value the way
 * every other field type does.
 */
afterEach(cleanup);

const OPTIONS = [{value: "en", label: "English"}, {value: "de", label: "Deutsch"}];

const mount = (props = {}) => {
    const changes = [];
    const {container} = render(createElement(FormField, {
        label: "Message language", type: "select", options: OPTIONS, placeholder: "English (default)",
        value: "de", onChange: (value) => changes.push(value), ...props
    }));
    const select = container.querySelector("select");
    assert.ok(select, "no select was drawn");

    return {container, select, changes};
};

const choose = (select, value) => act(() => {
    select.value = value;
    select.dispatchEvent(new window.Event("change", {bubbles: true}));
});

describe("a select form field", () => {
    it("offers the options after a blank entry that reads as the placeholder", () => {
        const {select} = mount();
        const entries = [...select.options].map((option) => [option.value, option.textContent]);

        assert.deepEqual(entries, [["", "English (default)"], ["en", "English"], ["de", "Deutsch"]]);
    });

    /**
     * A field whose definition names no placeholder still has to name its
     * blank entry. It was drawn empty - a nameless first option in an open
     * list, which a screen reader announces as nothing at all and a reader
     * cannot tell from a rendering fault. The label is the one name the field
     * always has, and it is what IntegrationDialog's getPlaceholder already
     * falls back to for the other three field types.
     */
    it("names the blank entry after the label when nothing else does", () => {
        const {select} = mount({placeholder: undefined});

        assert.equal(select.options[0].textContent, "Message language");
    });

    it("shows the value it was given", () => {
        assert.equal(mount().select.value, "de");
        assert.equal(mount({value: undefined}).select.value, "", "an unset value did not land on the blank entry");
        assert.equal(mount({value: null}).select.value, "");
    });

    it("reports a choice, and the blank entry as an empty string", () => {
        const {select, changes} = mount();

        choose(select, "en");
        choose(select, "");

        assert.deepEqual(changes, ["en", ""]);
    });

    /**
     * A stored code the list no longer offers - a locale dropped in an
     * upgrade. React sets a select to a value with no option as blank, and
     * the blank control was still sent on save and refused by the server, a
     * red mark over a field the operator never touched. Shown as itself, it
     * can be seen and changed.
     */
    it("shows a value the list does not offer as itself", () => {
        const {select} = mount({value: "tlh"});

        assert.equal(select.value, "tlh");
        assert.deepEqual([...select.options].map((option) => option.value), ["", "en", "de", "tlh"]);
    });

    it("is labelled for the reader", () => {
        const {container, select} = mount();
        const label = container.querySelector("label");

        assert.equal(label.getAttribute("for"), select.id);
        assert.equal(label.textContent, "Message language");
    });

    it("wears the error mark like every other field type", () => {
        const {select} = mount({error: true});

        assert.ok(select.classList.contains("input-error"), "the select is not marked");
    });

    it("can be disabled", () => {
        assert.equal(mount({disabled: true}).select.disabled, true);
    });
});
