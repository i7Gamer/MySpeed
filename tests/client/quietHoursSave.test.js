import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {act, cleanup, click, createElement as h, render, window} from "../helpers/renderHarness.js";
import {t} from "i18next";
import {PauseDialog} from "@/common/components/PauseDialog/PauseDialog";
import {ConfigContext} from "@/common/contexts/Config";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {request} from "@/common/utils/RequestUtil";

/**
 * Change both times so stale context, the requested window and a partially
 * written server window remain distinguishable when a failed save re-reads.
 */
const CONTEXT = {quietHoursStart: "23:00", quietHoursEnd: "08:00", timezone: "Europe/Berlin"};

const SECOND_PATCH = 2;

const originalFetch = globalThis.fetch;
const noop = () => {};
const response = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: {"content-type": "application/json"}
});
afterEach(() => { globalThis.fetch = originalFetch; cleanup(); });

const mountDialog = ({refuse = () => false, reread, waitForWrite} = {}) => {
    const seen = {patches: [], toasts: [], reads: 0, reloads: 0};
    const stored = {...CONTEXT};
    globalThis.fetch = async (url, init = {}) => {
        if (init.method === "PATCH") {
            const key = String(url).split("/").at(-1);
            const {value} = JSON.parse(init.body);
            seen.patches.push({url: String(url), value});
            await waitForWrite?.();
            if (refuse(seen.patches.length)) return response({message: "Write refused"}, 403);
            stored[key] = value;
            return response({});
        }
        assert.equal(String(url), "/api/config");
        seen.reads++;
        return reread ? reread() : response(stored);
    };
    const checkConfig = async () => (await request("/config")).json();
    render(h(ConfigContext.Provider, {value: [CONTEXT, () => seen.reloads++, checkConfig]},
        h(PreferencesContext.Provider, {value: [{}, noop]},
            h(ToastNotificationContext.Provider, {value: (...args) => seen.toasts.push(args)},
                h(PauseDialog, {open: true, onClose: noop})))));
    const dialog = window.document.querySelector(".pause-dialog");
    click([...dialog.querySelectorAll("button")].find(button => button.textContent === t("pause.quiet_hours")));
    return {seen, stored, dialog, save: () => dialog.querySelector(".pause-quiet-save")};
};

const editField = async (element, value) => {
    const prototype = element.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
        element.dispatchEvent(new window.Event(element.tagName === "SELECT" ? "change" : "input", {bubbles: true}));
    });
};
const timeFields = dialog => [...dialog.querySelectorAll(".pause-quiet-range input")];
const editWindow = async (view, start = "22:00", end = "07:00") => {
    const [from, until] = timeFields(view.dialog);
    await editField(from, start);
    await editField(until, end);
};
const saveWindow = async view => { await act(async () => click(view.save())); };
const windowWrites = [
    {url: "/api/config/quietHoursStart", value: "22:00"},
    {url: "/api/config/quietHoursEnd", value: "07:00"}
];

describe("saving quiet hours through the rendered dialog", () => {
    it("clicks Save through real checked requests without rewriting the unchanged timezone", async () => {
        const view = mountDialog();
        await editWindow(view);
        await saveWindow(view);
        assert.deepEqual(view.seen.patches, windowWrites);
        assert.deepEqual(view.seen.toasts.map(([, colour]) => colour), ["green"]);
        assert.equal(view.seen.reloads, 1);
        assert.equal(view.seen.reads, 0);
        assert.equal(view.save().disabled, false);
    });

    it("writes the selected timezone before either time", async () => {
        const view = mountDialog();
        await editWindow(view);
        await editField(view.dialog.querySelector(".timezone-select"), "Europe/Paris");
        await saveWindow(view);
        assert.deepEqual(view.seen.patches, [{url: "/api/config/timezone", value: "Europe/Paris"}, ...windowWrites]);
        assert.deepEqual(view.seen.toasts.map(([, colour]) => colour), ["green"]);
    });

    it("stops after a rejected timezone and displays the unchanged server values", async () => {
        const view = mountDialog({refuse: () => true});
        await editWindow(view);
        await editField(view.dialog.querySelector(".timezone-select"), "Europe/Paris");
        await saveWindow(view);
        assert.deepEqual(view.seen.patches, [{url: "/api/config/timezone", value: "Europe/Paris"}]);
        assert.deepEqual(timeFields(view.dialog).map(field => field.value), [CONTEXT.quietHoursStart, CONTEXT.quietHoursEnd]);
        assert.equal(view.dialog.querySelector(".timezone-select").value, CONTEXT.timezone);
        assert.deepEqual(view.seen.toasts.map(([, colour]) => colour), ["red"]);
        assert.equal(view.seen.reloads, 1);
        assert.equal(view.save().disabled, false);
    });

    for (const rollbackRefused of [false, true]) it(`re-reads server values after a ${rollbackRefused ? "refused" : "successful"} rollback`, async () => {
        const view = mountDialog({refuse: ordinal => rollbackRefused ? ordinal >= SECOND_PATCH : ordinal === SECOND_PATCH});
        await editWindow(view);
        await saveWindow(view);
        assert.deepEqual(view.seen.patches, [...windowWrites, {url: "/api/config/quietHoursStart", value: CONTEXT.quietHoursStart}]);
        assert.deepEqual(timeFields(view.dialog).map(field => field.value), [
            rollbackRefused ? "22:00" : CONTEXT.quietHoursStart, CONTEXT.quietHoursEnd
        ]);
        assert.equal(view.seen.reads, 1);
        assert.equal(view.seen.reloads, 1);
        assert.deepEqual(view.seen.toasts.map(([, colour]) => colour), ["red"]);
        assert.equal(view.save().disabled, false);
    });

    for (const [name, reread] of [
        ["a refusal body", () => response({message: "Unauthorized"}, 401)],
        ["invalid JSON", () => new Response("not JSON")],
        ["a dropped connection", () => { throw new Error("Network unavailable"); }]
    ]) it(`keeps edited fields when the re-read returns ${name}`, async () => {
        const view = mountDialog({refuse: ordinal => ordinal >= SECOND_PATCH, reread});
        await editWindow(view);
        await saveWindow(view);
        assert.deepEqual(timeFields(view.dialog).map(field => field.value), ["22:00", "07:00"]);
        assert.equal(view.seen.reads, 1);
        assert.equal(view.seen.reloads, 1);
        assert.deepEqual(view.seen.toasts.map(([, colour]) => colour), ["red"]);
        assert.equal(view.save().disabled, false);
    });

    it("disables Save for an incomplete window", async () => {
        const view = mountDialog();
        await editWindow(view, "22:00", "");
        assert.equal(view.save().disabled, true);
        await saveWindow(view);
        assert.deepEqual(view.seen.patches, []);
        assert.deepEqual(view.seen.toasts, []);
        assert.equal(view.seen.reloads, 0);
    });

    it("disables Save while writes are pending and prevents another request chain", async () => {
        let finish;
        const pending = new Promise(resolve => { finish = resolve; });
        const view = mountDialog({waitForWrite: () => pending});
        await editWindow(view);
        await saveWindow(view);
        assert.equal(view.save().disabled, true);
        await saveWindow(view);
        assert.deepEqual(view.seen.patches, [windowWrites[0]]);
        await act(async () => finish());
        assert.deepEqual(view.seen.patches, windowWrites);
        assert.equal(view.save().disabled, false);
        assert.deepEqual(view.seen.toasts.map(([, colour]) => colour), ["green"]);
        assert.equal(view.seen.reloads, 1);
    });
});
