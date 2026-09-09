import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, withoutJsComments } from "../helpers/source.js";
import { act, cleanup, click, createElement, render, settle, window } from "../helpers/renderHarness.js";
import { AlertProvider } from "@/common/contexts/Alert";
import { ConfigContext } from "@/common/contexts/Config";
import { ToastNotificationContext } from "@/common/contexts/ToastNotification";
import TokensDialog from "@/common/components/TokensDialog";
import { PreferencesContext } from "@/common/contexts/Preferences";

/*
 * The dialog that issues and revokes tokens. Rendered against a scripted
 * fetch: what matters is that the list shows what the server holds, that the
 * secret is shown once after creation and never again, and that the copy of
 * the trigger line a reader pastes into their automation is complete.
 */

afterEach(() => {
    globalThis.fetch = realFetch;
    cleanup();
});

const realFetch = globalThis.fetch;
const noop = () => undefined;

const answer = (body, status = 200) =>
    new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json"}});

const TOKEN = "msp_" + "A".repeat(43);

const ROWS = [
    {id: 1, name: "Home Assistant", scope: "run", created: "2026-09-01T10:00:00.000Z", lastUsed: "2026-09-07T08:00:00.000Z"},
    {id: 2, name: "Router hook", scope: "run", created: "2026-09-02T10:00:00.000Z", lastUsed: null}
];

/** A server with the rows above, recording every write. */
const scripted = (rows = ROWS) => {
    const writes = [];
    let list = [...rows];

    globalThis.fetch = async (url, init = {}) => {
        const path = String(url);
        const method = init.method ?? "GET";

        if (path.endsWith("/api/tokens") && method === "GET") return answer(list);

        if (path.endsWith("/api/tokens") && method === "POST") {
            const {name} = JSON.parse(init.body);
            writes.push({method, name});
            const row = {id: 9, name, scope: "run", created: "2026-09-07T12:00:00.000Z", lastUsed: null};
            list = [...list, row];
            return answer({...row, token: TOKEN}, 201);
        }

        if (/\/api\/tokens\/\d+$/.test(path) && method === "DELETE") {
            const id = Number(path.split("/").pop());
            writes.push({method, id});
            list = list.filter((row) => row.id !== id);
            return answer({message: "Token revoked"});
        }

        return answer({}, 404);
    };

    return {writes};
};

const mount = async (toast = noop) => {
    render(createElement(AlertProvider, null,
        createElement(ConfigContext.Provider, {value: [{viewMode: false, previewMode: false}, noop, noop]},
            createElement(ToastNotificationContext.Provider, {value: toast},
                createElement(PreferencesContext.Provider, {value: [{}, noop]},
                    createElement(TokensDialog, {open: true, onClose: noop}))))));
    await settle();
    await settle();

    return window.document;
};

const rowsOf = (document) => [...document.querySelectorAll(".token-row")];

/**
 * The end of a CSS animation the stylesheet would have run. The shared alert
 * resolves its promise only once its fade-out has ended, and jsdom runs no
 * animation - see overlayFocusBehaviour.test.js.
 */
const animationEnd = (element, animationName) => act(() => {
    const event = new window.Event("animationend", {bubbles: true});
    Object.defineProperty(event, "animationName", {value: animationName});
    element.dispatchEvent(event);
});

const typeName = async (document, name) => {
    const input = document.querySelector("#api-token-name");
    assert.ok(input, "there is no name field");

    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(input, name);
        input.dispatchEvent(new window.Event("input", {bubbles: true}));
    });
};

describe("the API tokens dialog", () => {
    it("shows a failed load and retries without claiming the list is empty", async (context) => {
        const errors = context.mock.method(console, "error", noop);
        globalThis.fetch = async () => {throw new Error("Token list unavailable");};
        const document = await mount();
        assert.ok(document.querySelector(".tokens-empty") === null, "failed load must not say no tokens");
        assert.match(document.querySelector(".tokens-content").textContent, /Token list unavailable/);
        assert.equal(errors.mock.calls.length, 1);
        scripted();
        const retry = document.querySelector('[role="alert"] button');
        assert.ok(retry);
        click(retry);
        await settle();
        assert.equal(rowsOf(document).length, ROWS.length);
        assert.doesNotMatch(document.querySelector(".tokens-content").textContent, /Token list unavailable/);
    });

    it("reports a refused creation without displaying a secret or adding a row", async () => {
        scripted();
        const fetchList = globalThis.fetch;
        globalThis.fetch = (url, init) => init?.method === "POST"
            ? Promise.resolve(answer({message: "Creation refused"}, 400)) : fetchList(url, init);
        const toasts = [];
        const document = await mount((...toast) => toasts.push(toast));
        await typeName(document, "New token");
        click(document.querySelector("#api-token-create"));
        await settle();
        assert.equal(toasts.at(-1)[0], "Creation refused");
        assert.equal(toasts.at(-1)[1], "red");
        assert.equal(document.querySelector(".token-secret"), null);
        assert.equal(rowsOf(document).length, ROWS.length);
        assert.equal(document.querySelector("#api-token-create").disabled, false);
    });

    it("reports a refused revoke and keeps the existing row", async () => {
        scripted();
        const fetchList = globalThis.fetch;
        globalThis.fetch = (url, init) => init?.method === "DELETE"
            ? Promise.resolve(answer({message: "Revoke refused"}, 400)) : fetchList(url, init);
        const toasts = [];
        const document = await mount((...toast) => toasts.push(toast));
        click(rowsOf(document)[0].querySelector(".token-delete"));
        await settle();
        const confirm = [...document.querySelectorAll("button")]
            .find(button => /^Revoke$/.test(button.textContent.trim()) && !button.classList.contains("token-delete"));
        click(confirm);
        await settle();
        await animationEnd(document.querySelector(".dialog.dialog-hidden"), "fadeOut");
        await settle();
        assert.equal(toasts.at(-1)[0], "Revoke refused");
        assert.equal(toasts.at(-1)[1], "red");
        assert.equal(rowsOf(document).length, ROWS.length);
    });

    it("lists what the server holds, with when each was last used", async () => {
        scripted();
        const document = await mount();

        const rows = rowsOf(document);
        assert.equal(rows.length, 2);
        assert.match(rows[0].textContent, /Home Assistant/);
        assert.match(rows[1].textContent, /Router hook/);
        assert.match(rows[1].textContent, /Never used/);
        assert.doesNotMatch(rows[0].textContent, /Never used/);
    });

    // "Last used: Never used" - the label was written for a date and read
    // against the stand-in for having no date, the way "Last run before Just
    // now" was. A token nothing has used says so once.
    it("says a token has never been used without prefixing it with a label for a date", async () => {
        scripted();
        const document = await mount();

        const rows = rowsOf(document);
        assert.doesNotMatch(rows[1].textContent, /Last used:\s*Never used/);
        assert.match(rows[0].textContent, /Last used:/);
    });

    it("says so when there are none", async () => {
        scripted([]);
        const document = await mount();

        assert.equal(rowsOf(document).length, 0);
        assert.match(document.querySelector(".tokens-content").textContent, /No tokens yet/);
    });

    it("creates a token from the name field and shows the secret once", async () => {
        const {writes} = scripted();
        const document = await mount();

        assert.equal(document.querySelector(".token-secret"), null, "a secret is shown before one was issued");

        await typeName(document, "Kitchen tablet");
        click(document.querySelector("#api-token-create"));
        await settle();
        await settle();

        assert.deepEqual(writes, [{method: "POST", name: "Kitchen tablet"}]);

        const secret = document.querySelector(".token-secret");
        assert.ok(secret, "the issued token is not shown");
        assert.match(secret.textContent, new RegExp(TOKEN));
        assert.equal(rowsOf(document).length, 3, "the list did not pick the new token up");
    });

    it("spells out the trigger request beside the secret", async () => {
        scripted();
        const document = await mount();

        await typeName(document, "Kitchen tablet");
        click(document.querySelector("#api-token-create"));
        await settle();
        await settle();

        const example = document.querySelector(".token-example");
        assert.ok(example, "no example request is shown");
        assert.match(example.textContent, /curl/);
        assert.match(example.textContent, /Authorization: Bearer msp_/);
        assert.match(example.textContent, /\/api\/speedtests\/run/);
    });

    // The dashboard routes its requests to the node it is showing; a token
    // issued that way belonged to the node while the printed request named
    // this instance, which does not hold it.
    it("talks to this instance even while a node is selected", async () => {
        scripted();
        const asked = [];
        const scriptedFetch = globalThis.fetch;
        globalThis.fetch = (url, init) => { asked.push(String(url)); return scriptedFetch(url, init); };
        window.localStorage.setItem("currentNode", "5");

        try {
            const document = await mount();
            await typeName(document, "Kitchen tablet");
            click(document.querySelector("#api-token-create"));
            await settle();
            await settle();

            assert.ok(asked.length >= 2, "nothing was requested");
            for (const url of asked) {
                assert.match(url, /\/api\/tokens/, url);
                assert.doesNotMatch(url, /\/api\/nodes\//, url);
            }
        } finally {
            window.localStorage.removeItem("currentNode");
        }
    });

    it("refuses to send an empty name", async () => {
        const {writes} = scripted();
        const document = await mount();

        const create = document.querySelector("#api-token-create");
        assert.equal(create.disabled, true, "the create button is live with nothing to name");

        click(create);
        await settle();

        assert.deepEqual(writes, []);
    });

    it("revokes a token after the operator confirms", async () => {
        const {writes} = scripted();
        const document = await mount();

        click(rowsOf(document)[1].querySelector(".token-delete"));
        await settle();

        // The shared confirm dialog: its danger button carries the confirming
        // text.
        const confirm = [...document.querySelectorAll("button")]
            .find((button) => /^Revoke$/.test(button.textContent.trim()) && !button.classList.contains("token-delete"));
        assert.ok(confirm, "no confirmation was asked before revoking");

        click(confirm);
        await settle();
        await animationEnd(document.querySelector(".dialog.dialog-hidden"), "fadeOut");
        await settle();
        await settle();

        assert.deepEqual(writes, [{method: "DELETE", id: 2}]);
        assert.equal(rowsOf(document).length, 1);
    });
});

describe("the dropdown entry", () => {
    const dropdown = withoutJsComments(readSource("client/src/common/components/Dropdown/DropdownComponent.jsx"));

    // Dimmed and explained on a demo rather than hidden, the shape every
    // other refused setting takes - and beside the password it complements.
    it("is offered next to the password, and refused on a demo", () => {
        const line = dropdown.split("\n").find((candidate) => candidate.includes('key: "tokens"'));

        assert.ok(line, "the dropdown has no tokens entry");
        assert.match(line, /previewDisabled: true/);
        assert.match(line, /t\("dropdown\.tokens"\)/);
        assert.doesNotMatch(line, /allowView/, "a viewer is offered the token dialog");
    });

    it("mounts the dialog", () => {
        assert.match(dropdown, /<TokensDialog open=\{showTokensDialog\} onClose=\{\(\) => setShowTokensDialog\(false\)\}\/>/);
    });
});
