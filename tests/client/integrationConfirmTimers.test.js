import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import { act, cleanup, click, createElement, render, settle, window } from "../helpers/renderHarness.js";
import { ConfigContext } from "@/common/contexts/Config";
import { IntegrationDialog, SAVE_CONFIRM_MS, DELETE_CONFIRM_MS } from "@/common/components/IntegrationDialog/IntegrationDialog";

/**
 * The two confirmations an integration card flashes, and the timers behind
 * them.
 *
 * Both were bare setTimeout calls: nothing held the id, so nothing could clear
 * it. A card taken off the screen inside either window - the dialog closed, a
 * new integration deleted before it was ever saved - left a callback in flight
 * that would set state on something that no longer exists, and a second arming
 * left the first timer running to cut the second one short.
 *
 * What is driven here is the ownership: the checkmark and the armed delete
 * appear, they go again when their own window closes, and closing the dialog
 * takes the pending timer with it.
 */
afterEach(cleanup);

const noop = () => undefined;

// An ordinary instance: not a demo, not read-only. The card draws neither its
// save nor its delete button in preview mode.
const CONFIG = {viewMode: false, previewMode: false};

const INTEGRATION_ID = 7;

/**
 * One integration, declared the way the server declares them: a name, and the
 * fields the card is to draw. The template variable is what makes this test
 * able to dirty the form with a click rather than by typing into it - the
 * button appends a token and marks the card unsaved, which is what puts the
 * save button on screen.
 */
const DEFINITIONS = {
    webhook: {fields: [{name: "body", type: "textarea", variables: ["ping"]}]}
};

const ACTIVE = [{id: INTEGRATION_ID, name: "webhook", data: {body: "hi"}, lastActivity: null}];

/*
 * A clock that only pretends where it is asked to.
 *
 * Real timers underneath - React schedules its own work on them and the
 * harness settles promises through them - with every arming recorded, so a
 * test can reach past a one-and-a-half second wait by running the callback
 * itself. The real timer is cancelled as its callback is run by hand, so
 * nothing fires twice or lands in the test after this one.
 */
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

let armed = [];
let cleared = [];

beforeEach(() => {
    armed = [];
    cleared = [];

    globalThis.setTimeout = (handler, delay, ...rest) => {
        const id = realSetTimeout(handler, delay, ...rest);
        armed.push({id, delay, handler, spent: false});
        return id;
    };

    globalThis.clearTimeout = (id) => {
        cleared.push(id);
        return realClearTimeout(id);
    };
});

afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
});

/** The timer still waiting on a given delay, of which the card arms one at a time. */
const pending = (delay) => armed.findLast((timer) => timer.delay === delay
    && !timer.spent && !cleared.includes(timer.id));

/** Runs that timer's callback now, and takes the real one out of the queue. */
const elapse = (delay) => {
    const timer = pending(delay);
    assert.ok(timer, `nothing was waiting on ${delay}ms`);

    timer.spent = true;
    realClearTimeout(timer.id);
    act(() => timer.handler());
};

const answer = (body) => new Response(JSON.stringify(body), {status: 200, headers: {"content-type": "application/json"}});

const realFetch = globalThis.fetch;

const requests = [];

beforeEach(() => {
    requests.length = 0;

    globalThis.fetch = async (url, init = {}) => {
        const path = String(url);
        requests.push({path, method: init.method ?? "GET"});

        if (path.endsWith("/integrations/active")) return answer(ACTIVE);
        if (path.endsWith("/integrations")) return answer(DEFINITIONS);
        return answer({id: INTEGRATION_ID});
    };
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

/** The open dialog, with its one card expanded and ready to be dirtied. */
const openDialog = async () => {
    const mount = render(createElement(ConfigContext.Provider, {value: [CONFIG, noop, noop]},
        createElement(IntegrationDialog, {open: true, onClose: noop})));

    await settle();

    const card = window.document.querySelector(".expandable-card");
    assert.ok(card, "the dialog drew no integration card");

    click(card.querySelector(".expandable-card-header"));
    assert.ok(card.querySelector(".expandable-card-body"), "the card did not open");

    return {mount, card};
};

const dirty = (card) => {
    const variable = card.querySelector(".template-variable");
    assert.ok(variable, "the card drew no template variable to change the form with");

    click(variable);
};

const saveButton = (card) => card.querySelector(".save-btn");
const checkmark = (card) => card.querySelector(".success-indicator");
const deleteButton = (card) => card.querySelector(".delete-btn");

describe("the checkmark a saved integration card shows", () => {
    it("appears when the save lands and goes when its own window closes", async () => {
        const {card} = await openDialog();

        dirty(card);
        click(saveButton(card));
        await settle();

        assert.ok(checkmark(card), "a saved card showed nothing at all");

        elapse(SAVE_CONFIRM_MS);

        assert.equal(checkmark(card), null, "the checkmark outlived its window");
    });

    /*
     * The leak: the dialog is closed while the checkmark is still up. Nothing
     * held the id, so nothing could stop the callback, and it woke to set
     * state on a card that had been taken off the screen.
     */
    it("takes its timer with it when the dialog closes", async () => {
        const {mount, card} = await openDialog();

        dirty(card);
        click(saveButton(card));
        await settle();

        const timer = pending(SAVE_CONFIRM_MS);
        assert.ok(timer, "the save armed nothing, so there is no confirmation to clear");

        mount.unmount();

        assert.ok(cleared.includes(timer.id),
            "closing the dialog left the confirmation timer running on an unmounted card");
    });
});

describe("the delete button's second-thoughts window", () => {
    it("arms on the first press and disarms when its window closes", async () => {
        const {card} = await openDialog();

        click(deleteButton(card));

        assert.ok(deleteButton(card).classList.contains("confirm"), "the first press did not ask for confirmation");
        assert.equal(requests.filter(({method}) => method === "DELETE").length, 0,
            "the first press deleted the integration outright");

        elapse(DELETE_CONFIRM_MS);

        assert.equal(deleteButton(card).classList.contains("confirm"), false,
            "the delete button stayed armed past its window");
    });

    it("takes its timer with it when the dialog closes", async () => {
        const {mount, card} = await openDialog();

        click(deleteButton(card));

        const timer = pending(DELETE_CONFIRM_MS);
        assert.ok(timer, "the press armed nothing");

        mount.unmount();

        assert.ok(cleared.includes(timer.id),
            "closing the dialog left the delete window running on an unmounted card");
    });
});

/**
 * The third thing the ids are held for, which no sequence of clicks can reach
 * today: a second arming inside a window still open.
 *
 * The save button is drawn only while the card is dirty *and* not already
 * showing its checkmark, so there is no way to press it twice inside the
 * window - and the delete button's second press deletes rather than re-arms.
 * That makes the re-arm unreachable rather than correct: it depends entirely
 * on those two render conditions, and either could reasonably change. Pinned
 * at the source, since a click cannot get at it.
 */
describe("a confirmation re-armed inside its own window", () => {
    const source = readSource("client/src/common/components/IntegrationDialog/IntegrationDialog.jsx");

    for (const [what, ref] of [["save", "saveTimer"], ["delete", "deleteTimer"]]) {
        it(`clears the ${what} timer before arming another`, () => {
            const arming = source.indexOf(`${ref}.current = setTimeout`);
            assert.notEqual(arming, -1, `the ${what} confirmation no longer keeps its timer`);

            assert.match(source.slice(0, arming).slice(-200), new RegExp(`clearTimeout\\(${ref}\\.current\\)`),
                `a second ${what} confirmation leaves the first timer running, cutting the second one short`);
        });
    }
});
