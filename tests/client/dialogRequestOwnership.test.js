import {afterEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {useState} from "react";
import {act, cleanup, click, createElement, render, settle, window} from "../helpers/renderHarness.js";
import TokensDialog from "@/common/components/TokensDialog";
import ConnectionsDialog from "@/common/components/ConnectionsDialog";
import {IntegrationDialog, SAVE_CONFIRM_MS} from "@/common/components/IntegrationDialog";
import {ConfigContext} from "@/common/contexts/Config";
import {NodeContext} from "@/common/contexts/Node";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {AlertProvider} from "@/common/contexts/Alert";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {writeStored} from "@/common/utils/Storage";

const noop = () => {};
const originalFetch = globalThis.fetch;
const originalError = console.error;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; console.error = originalError; });
const answer = body => new Response(JSON.stringify(body), {status: 200});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; };
const definitions = {webhook: {fields: [{name: "body", type: "textarea", variables: ["ping"]}]}};
const integration = name => [{id: 7, name: "webhook", displayName: name, data: {body: "hi"}}];
const token = name => [{id: 1, name, created: "2026-09-01T00:00:00Z"}];
const connection = name => [{id: 1, provider: name, targetId: null, created: "2026-09-01T00:00:00Z", ip: null, isp: null}];
const mount = Component => {
    let setOpen, setNode;
    const Harness = () => {
        const [open, updateOpen] = useState(true), [node, updateNode] = useState(0);
        setOpen = updateOpen; setNode = updateNode;
        return createElement(ConfigContext.Provider, {value: [{previewMode: false}, noop]},
            createElement(NodeContext.Provider, {value: [[], noop, node]},
                createElement(ToastNotificationContext.Provider, {value: noop},
                    createElement(Component, {open, onClose: noop}))));
    };
    const rendered = render(createElement(AlertProvider, null,
        createElement(PreferencesContext.Provider, {value: [{}, noop]}, createElement(Harness))));
    return {...rendered, open: value => act(() => setOpen(value)), node: value => act(() => {writeStored("currentNode", value); setNode(value);})};
};
const type = (input, value) => act(() => {
    const prototype = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
    input.dispatchEvent(new window.Event("input", {bubbles: true}));
});
const document = window.document;

describe("management request ownership", () => {
    for (const [Component, rows, path, selector] of [
        [TokensDialog, token, "/tokens", ".token-row"],
        [ConnectionsDialog, connection, "/speedtests/connections", ".connection-row"],
        [IntegrationDialog, integration, "/integrations/active", ".expandable-card"]
    ]) {
        for (const failure of [false, true]) it(`${Component.name} ignores old ${failure ? "failure" : "success"} after reopening`, async () => {
            console.error = noop;
            const old = deferred(), fresh = deferred(); let calls = 0;
            globalThis.fetch = url => String(url).endsWith(path) ? (++calls === 1 ? old.promise : fresh.promise) : Promise.resolve(answer(definitions));
            const view = mount(Component);
            view.open(false); view.open(true);
            fresh.resolve(answer(rows("NEW"))); await settle();
            if (failure) old.reject(new Error("OLD FAILURE")); else old.resolve(answer(rows("OLD")));
            await settle();
            assert.match(document.querySelector(selector).textContent, /NEW/);
            assert.doesNotMatch(document.body.textContent, /OLD/);
        });
        for (const failure of [false, true]) it(`${Component.name} cannot finish a newer spinner with an old ${failure ? "failure" : "success"}`, async () => {
            console.error = noop;
            const old = deferred(), fresh = deferred(); let calls = 0;
            globalThis.fetch = url => String(url).endsWith(path) ? (++calls === 1 ? old.promise : fresh.promise) : Promise.resolve(answer(definitions));
            const view = mount(Component); view.open(false); view.open(true);
            if (failure) old.reject(new Error("OLD FAILURE")); else old.resolve(answer(rows("OLD")));
            await settle();
            assert.ok(document.querySelector(".lds-ellipsis"));
            assert.doesNotMatch(document.body.textContent, /OLD/);
            fresh.reject(new Error("CURRENT FAILURE")); await settle();
            assert.match(document.body.textContent, /CURRENT FAILURE/);
            globalThis.fetch = url => Promise.resolve(answer(String(url).endsWith(path) ? rows("RETRIED") : definitions));
            click(document.querySelector('[role="alert"] button, .integrations-load-error button'));
            await settle();
            assert.match(document.querySelector(selector).textContent, /RETRIED/);
            assert.ok(document.querySelector(".lds-ellipsis") === null);
        });
        it(`${Component.name} retires failures on unmount without reporting them`, async () => {
            const errors = [], held = deferred();
            console.error = (...args) => errors.push(args);
            globalThis.fetch = url => String(url).endsWith(path) ? held.promise : Promise.resolve(answer(definitions));
            const view = mount(Component); view.unmount();
            held.reject(new Error("LEFT DIALOG")); await settle();
            assert.deepEqual(errors, []);
        });
        if (Component !== TokensDialog) it(`${Component.name} retires the previous node's request`, async () => {
            const old = deferred();
            globalThis.fetch = url => String(url).endsWith(path)
                ? String(url).includes("/nodes/2/") ? Promise.resolve(answer(rows("NEW NODE"))) : old.promise
                : Promise.resolve(answer(definitions));
            const view = mount(Component); view.node(2); await settle();
            old.resolve(answer(rows("OLD NODE"))); await settle();
            assert.match(document.querySelector(selector).textContent, /NEW NODE/);
        });
    }
    it("keeps local token ownership when the selected node changes", async () => {
        const held = deferred(); const urls = [];
        globalThis.fetch = url => {urls.push(String(url)); return held.promise;};
        const view = mount(TokensDialog); view.node(2);
        held.resolve(answer(token("LOCAL"))); await settle();
        assert.match(document.querySelector(".token-row").textContent, /LOCAL/);
        assert.deepEqual(urls, ["/api/tokens"]);
    });
    it("does not let an opening token load undo creation's refresh", async () => {
        const old = deferred(); let gets = 0;
        globalThis.fetch = (url, init) => init.method === "POST" ? Promise.resolve(answer({...token("CREATED")[0], token: "secret"}))
            : ++gets === 1 ? old.promise : Promise.resolve(answer(token("CREATED")));
        mount(TokensDialog);
        type(document.querySelector("#api-token-name"), "CREATED"); click(document.querySelector("#api-token-create")); await settle();
        old.resolve(answer([])); await settle();
        assert.match(document.querySelector(".token-row").textContent, /CREATED/);
    });
    for (const failure of [false, true]) it(`an old token creation ${failure ? "failure" : "success"} cannot finish a new creation`, async () => {
        const old = deferred(), fresh = deferred(); let creates = 0;
        globalThis.fetch = (url, init) => init.method === "POST" ? (++creates === 1 ? old.promise : fresh.promise) : Promise.resolve(answer([]));
        const view = mount(TokensDialog); await settle();
        type(document.querySelector("#api-token-name"), "Old"); click(document.querySelector("#api-token-create"));
        view.open(false); view.open(true); await settle();
        type(document.querySelector("#api-token-name"), "New"); click(document.querySelector("#api-token-create"));
        if (failure) old.reject(new Error("OLD")); else old.resolve(answer({...token("Old")[0], token: "OLD SECRET"}));
        await settle();
        assert.equal(document.querySelector("#api-token-create").disabled, true);
        assert.equal(document.querySelector("#api-token-name").value, "New");
        assert.ok(document.querySelector(".token-secret") === null);
        fresh.resolve(answer({...token("New")[0], token: "NEW SECRET"})); await settle();
        assert.equal(document.querySelector(".token-secret").textContent, "NEW SECRET");
    });
    it("hides stale integration cards while reopening loads", async () => {
        let calls = 0; const held = deferred();
        globalThis.fetch = url => String(url).endsWith("/active") && ++calls > 1 ? held.promise
            : Promise.resolve(answer(String(url).endsWith("/active") ? integration("OLD") : definitions));
        const view = mount(IntegrationDialog); await settle();
        view.open(false); view.open(true);
        assert.ok(document.querySelector(".expandable-card") === null);
        assert.ok(document.querySelector(".lds-ellipsis"));
        held.resolve(answer(integration("NEW"))); await settle();
        click(document.querySelector(".expandable-card-header"));
        assert.ok(document.querySelector("textarea"));
    });
});

describe("integration draft ownership", () => {
    for (const retire of ["close", "unmount", "node"]) it(`a save completed after ${retire} cannot acknowledge an obsolete card`, async context => {
        const held = deferred();
        const realSetTimeout = globalThis.setTimeout;
        const timers = context.mock.method(globalThis, "setTimeout", (...args) => realSetTimeout(...args));
        globalThis.fetch = (url, init) => init.method === "PATCH" ? held.promise
            : Promise.resolve(answer(String(url).endsWith("/active") ? integration("Original") : definitions));
        const view = mount(IntegrationDialog); await settle(); click(document.querySelector(".expandable-card-header"));
        type(document.querySelector("textarea"), "A"); click(document.querySelector(".save-btn"));
        if (retire === "close") view.open(false); else if (retire === "unmount") view.unmount(); else view.node(2);
        held.resolve(answer({})); await settle();
        assert.equal(timers.mock.calls.filter(call => call.arguments[1] === SAVE_CONFIRM_MS).length, 0);
        assert.ok(document.querySelector(".success-indicator") === null);
    });
    for (const creating of [false, true]) it(`${creating ? "PUT" : "PATCH"} keeps newer edits dirty and the next save uses PATCH`, async () => {
        const held = deferred(), writes = [];
        globalThis.fetch = (url, init) => {
            if (init.method === "PUT" || init.method === "PATCH") {
                writes.push({url: String(url), method: init.method, body: JSON.parse(init.body)});
                return writes.length === 1 ? held.promise : Promise.resolve(answer({}));
            }
            return Promise.resolve(answer(String(url).endsWith("/active") ? creating ? [] : integration("Original") : definitions));
        };
        mount(IntegrationDialog); await settle();
        if (creating) {
            click(document.querySelector(".dropdown-select-btn"));
            click(document.querySelector('[role="menuitem"]'));
        } else click(document.querySelector(".expandable-card-header"));
        type(document.querySelector("textarea"), "A"); click(document.querySelector(".save-btn"));
        type(document.querySelector("textarea"), "B"); type(document.querySelector(".expandable-card-body input"), "New name");
        held.resolve(answer({id: 7})); await settle();
        assert.equal(document.querySelector("textarea").value, "B");
        assert.ok(document.querySelector(".save-btn"), "the newer draft still needs saving");
        assert.ok(document.querySelector(".success-indicator") === null);
        click(document.querySelector(".save-btn")); await settle();
        assert.equal(writes[1].method, "PATCH"); assert.match(writes[1].url, /\/integrations\/7$/);
        assert.equal(writes[1].body.body, "B"); assert.equal(writes[1].body.integration_name, "New name");
        assert.ok(document.querySelector(".success-indicator"));
    });
    it("keeps edits and permits retry after a refused save", async () => {
        const held = deferred(); let writes = 0;
        globalThis.fetch = (url, init) => init.method === "PATCH" ? ++writes === 1 ? held.promise : Promise.resolve(answer({}))
            : Promise.resolve(answer(String(url).endsWith("/active") ? integration("Original") : definitions));
        mount(IntegrationDialog); await settle(); click(document.querySelector(".expandable-card-header"));
        type(document.querySelector("textarea"), "A"); click(document.querySelector(".save-btn"));
        type(document.querySelector("textarea"), "B"); held.reject(new Error("refused")); await settle();
        assert.equal(document.querySelector("textarea").value, "B");
        assert.equal(document.querySelector(".save-btn").disabled, false);
        assert.ok(document.querySelector(".success-indicator") === null);
        click(document.querySelector(".save-btn")); await settle();
        assert.ok(document.querySelector(".success-indicator"));
    });
});
