import {afterEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {cleanup, click, createElement, render, settle, window} from "../helpers/renderHarness.js";
import Configuration from "@/common/components/StorageDialog/tabs/Configuration.jsx";
import {ConfigContext} from "@/common/contexts/Config";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";

const originalFetch = globalThis.fetch;
const originalReader = globalThis.FileReader;
const originalClick = window.HTMLInputElement.prototype.click;
const CURRENT_URL = "http://localhost/internet_speed/statistics?range=7d&compare=1y";
const noop = () => {};

afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    globalThis.window = window;
    globalThis.FileReader = originalReader;
    window.HTMLInputElement.prototype.click = originalClick;
});

const mount = (ok) => {
    const calls = {reload: [], close: 0, requests: [], toasts: []};
    const location = {href: CURRENT_URL, reload: () => calls.reload.push(location.href)};
    // jsdom's Location is intentionally non-configurable. Keep its real DOM,
    // replacing only the navigation boundary that this component owns.
    globalThis.window = new Proxy(window, {get: (target, key) =>
        key === "location" ? location : Reflect.get(target, key, target)});
    globalThis.fetch = async (url, init) => {
        calls.requests.push({url: String(url), method: init.method, body: init.body});
        return new Response(JSON.stringify({key: "targets"}), {status: ok ? 200 : 400});
    };
    globalThis.FileReader = class {
        readAsText() { this.result = JSON.stringify({targets: [{id: 1, name: "Existing", download: 500}]}); this.onload(); }
    };
    window.HTMLInputElement.prototype.click = function () {
        assert.equal(this.type, "file");
        Object.defineProperty(this, "files", {value: [{}]});
        this.onchange();
    };
    const view = render(createElement(ConfigContext.Provider,
        {value: [{viewMode: false}, noop, noop]},
        createElement(ToastNotificationContext.Provider, {value: (...args) => calls.toasts.push(args)},
            createElement(Configuration, {close: () => calls.close++}))));
    return {...view, calls};
};

describe("configuration replacement reloads all application providers", () => {
    for (const action of ["import", "reset"]) {
        for (const ok of [true, false]) {
            it(`${ok ? "reloads the current URL after a successful" : "keeps the dialog open after a refused"} ${action}`, async () => {
                const {container, calls} = mount(ok);
                const button = [...container.querySelectorAll("button")]
                    .find(element => element.textContent === (action === "import" ? "Import" : "Reset"));
                assert.ok(button);
                click(button);
                if (action === "reset") {
                    assert.equal(calls.requests.length, 0, "the first reset click only confirms intent");
                    assert.deepEqual(calls.reload, []);
                    click(button);
                }
                await settle();
                assert.equal(calls.requests.length, 1);
                assert.equal(calls.requests[0].method, action === "import" ? "PUT" : "DELETE");
                assert.ok(calls.requests[0].url.endsWith("/storage/config"));
                assert.equal(calls.close, ok ? 1 : 0);
                assert.equal(calls.toasts.at(-1)[1], ok ? "green" : "red");
                assert.deepEqual(calls.reload, ok ? [CURRENT_URL] : [],
                    "a successful instance-wide replacement must rebuild all providers at the existing URL");
            });
        }
    }
});
