import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {useContext} from "react";
import {MemoryRouter} from "react-router-dom";
import {act, cleanup, click, createElement, render, window} from "../helpers/renderHarness.js";
import {AlertProvider} from "@/common/contexts/Alert";
import {ConfigContext, ConfigProvider} from "@/common/contexts/Config";
import {request} from "@/common/utils/RequestUtil";
import {CONFIG_RETRY_BASE_MS, CONFIG_RETRY_MAX_MS} from "@/common/contexts/Config/configRetry";

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_SERVER_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;
const REPEATED_REFUSALS = 3;
const FLUSH_TURNS = 8;
const ONE_MS = 1;

const PASSWORD_TITLE = "Password required";
const API_TITLE = "API not reachable";
const RETRY_LABEL = "Try again";

/*
 * The provider as the app mounts it, with fetch answered from a table the test
 * rewrites as the "server" changes state, and the reload a successful login or
 * a manual retry asks for recorded instead of performed.
 */
const mount = (context, {config}) => {
    context.mock.timers.enable({apis: ["setTimeout"]});

    const state = {config, status: {status: HTTP_OK, body: {}}};
    const calls = {config: 0, reloads: 0};

    globalThis.fetch = async (url) => {
        const path = String(url);
        const answer = path.endsWith("/config") ? (calls.config++, state.config) : state.status;
        if (answer instanceof Error) throw answer;
        return {
            ok: answer.status >= HTTP_OK && answer.status < 300,
            status: answer.status,
            json: async () => answer.body,
            text: async () => JSON.stringify(answer.body),
            headers: {get: () => null}
        };
    };

    // jsdom's Location cannot be redefined; the reload is the boundary this
    // provider owns, so only it is replaced. Methods are bound to the real
    // window, which is what the listeners below are registered on.
    const location = {reload: () => calls.reloads++};
    globalThis.window = new Proxy(window, {get: (target, key) => {
        if (key === "location") return location;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
    }});

    const Probe = () => {
        const [loaded] = useContext(ConfigContext);
        return createElement("output", {"data-config": JSON.stringify(loaded)});
    };

    const view = render(createElement(MemoryRouter, null,
        createElement(AlertProvider, null,
            createElement(ConfigProvider, null, createElement(Probe)))));

    context.after(() => {
        try { cleanup(); }
        finally {
            globalThis.window = window;
            delete globalThis.fetch;
        }
    });

    const flush = async () => {
        for (let turn = 0; turn < FLUSH_TURNS; turn++)
            await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
    };

    return {
        ...view, state, calls, flush,
        tick: async (ms) => {
            act(() => context.mock.timers.tick(ms));
            await flush();
        },
        dialogs: (title) => [...window.document.querySelectorAll("[role=dialog]")]
            .filter((dialog) => dialog.getAttribute("aria-label") === title),
        loaded: () => JSON.parse(view.container.querySelector("output").dataset.config)
    };
};

const ok = (body) => ({status: HTTP_OK, body});
const refused = () => ({status: HTTP_UNAUTHORIZED, body: {}});
const unreachable = () => new TypeError("Failed to fetch");

describe("a session lost behind an open tab", () => {
    it("a 401 from a poll opens exactly one password prompt", async (context) => {
        const view = mount(context, {config: ok({viewMode: false})});
        await view.flush();
        assert.equal(view.calls.config, 1);

        // The server restarted: the session is gone and everything refuses.
        view.state.config = refused();
        view.state.status = refused();
        await request("/status");
        await view.flush();

        assert.equal(view.calls.config, 2, "the config is loaded again to learn what to ask");
        assert.equal(view.dialogs(PASSWORD_TITLE).length, 1);
    });

    it("further 401s while the prompt is open neither stack nor reload", async (context) => {
        const view = mount(context, {config: ok({viewMode: false})});
        await view.flush();
        view.state.config = refused();
        view.state.status = refused();

        await request("/status");
        await view.flush();
        for (let poll = 0; poll < REPEATED_REFUSALS; poll++) await request("/status");
        await view.flush();

        assert.equal(view.calls.config, 2);
        assert.equal(view.dialogs(PASSWORD_TITLE).length, 1);
    });

    it("the 401 of the first config load opens one prompt, not one per poll", async (context) => {
        const view = mount(context, {config: refused()});
        view.state.status = refused();
        await view.flush();
        assert.equal(view.dialogs(PASSWORD_TITLE).length, 1);

        for (let poll = 0; poll < REPEATED_REFUSALS; poll++) await request("/status");
        await view.flush();

        assert.equal(view.calls.config, 1);
        assert.equal(view.dialogs(PASSWORD_TITLE).length, 1);
    });

    for (const status of [HTTP_FORBIDDEN, HTTP_SERVER_ERROR]) {
        it(`a ${status} from a poll does not prompt`, async (context) => {
            const view = mount(context, {config: ok({viewMode: false})});
            await view.flush();
            view.state.status = {status, body: {}};

            await request("/status");
            await view.flush();

            assert.equal(view.calls.config, 1);
            assert.equal(view.dialogs(PASSWORD_TITLE).length, 0);
        });
    }

    // A read-only visitor is unauthenticated by design; a 401 from a control
    // they reached is expected and is no reason to reload anything.
    it("a 401 on a read-only view is left alone", async (context) => {
        const view = mount(context, {config: ok({viewMode: true})});
        await view.flush();
        view.state.status = refused();

        await request("/integrations");
        await view.flush();

        assert.equal(view.calls.config, 1);
        assert.equal(view.dialogs(PASSWORD_TITLE).length, 0);
    });

    it("stops listening once unmounted", async (context) => {
        const view = mount(context, {config: ok({viewMode: false})});
        await view.flush();
        view.unmount();
        view.state.status = refused();

        await request("/status");
        await view.flush();

        assert.equal(view.calls.config, 1);
    });
});

describe("a config load that cannot reach the server", () => {
    it("retries after the backoff and closes the dialog once it answers", async (context) => {
        const view = mount(context, {config: unreachable()});
        await view.flush();
        assert.equal(view.dialogs(API_TITLE).length, 1);
        assert.equal(view.calls.config, 1);

        await view.tick(CONFIG_RETRY_BASE_MS - ONE_MS);
        assert.equal(view.calls.config, 1, "retried before the backoff elapsed");
        await view.tick(ONE_MS);
        assert.equal(view.calls.config, 2);

        // Still down: the next wait is longer, and the dialog is not stacked.
        await view.tick(CONFIG_RETRY_BASE_MS);
        assert.equal(view.calls.config, 2, "the backoff did not grow");
        assert.equal(view.dialogs(API_TITLE).length, 1);

        view.state.config = ok({viewMode: false, interval: 1});
        await view.tick(CONFIG_RETRY_BASE_MS);
        assert.equal(view.calls.config, 3);
        assert.equal(view.dialogs(API_TITLE).length, 0, "the dialog stayed up after the server answered");
        assert.deepEqual(view.loaded(), {viewMode: false, interval: 1});
        assert.equal(view.calls.reloads, 0);

        await view.tick(CONFIG_RETRY_MAX_MS);
        assert.equal(view.calls.config, 3, "kept retrying after success");
    });

    it("treats a 5xx from a proxy like a server that is down", async (context) => {
        const view = mount(context, {config: {status: HTTP_BAD_GATEWAY, body: {}}});
        await view.flush();
        assert.equal(view.dialogs(API_TITLE).length, 1);

        await view.tick(CONFIG_RETRY_BASE_MS);
        assert.equal(view.calls.config, 2);
    });

    it("never waits longer than the cap", async (context) => {
        const view = mount(context, {config: unreachable()});
        await view.flush();

        // Long enough for the doubling to pass the cap several times over.
        let elapsed = 0;
        while (elapsed < CONFIG_RETRY_MAX_MS * REPEATED_REFUSALS) {
            await view.tick(CONFIG_RETRY_BASE_MS);
            elapsed += CONFIG_RETRY_BASE_MS;
        }
        const before = view.calls.config;
        await view.tick(CONFIG_RETRY_MAX_MS);
        assert.equal(view.calls.config, before + 1);
    });

    it("stops retrying once unmounted", async (context) => {
        const view = mount(context, {config: unreachable()});
        await view.flush();
        view.unmount();

        await view.tick(CONFIG_RETRY_MAX_MS);
        assert.equal(view.calls.config, 1);
    });

    for (const [name, raise] of [
        ["coming back online", () => window.dispatchEvent(new window.Event("online"))],
        ["the tab becoming visible", () => window.document.dispatchEvent(new window.Event("visibilitychange"))]
    ]) {
        it(`retries at once on ${name}`, async (context) => {
            const view = mount(context, {config: unreachable()});
            await view.flush();
            view.state.config = ok({viewMode: false});

            act(raise);
            await view.flush();

            assert.equal(view.calls.config, 2);
            assert.equal(view.dialogs(API_TITLE).length, 0);

            // And the scheduled retry it pre-empted does not fire as well.
            await view.tick(CONFIG_RETRY_MAX_MS);
            assert.equal(view.calls.config, 2);
        });
    }

    it("does not refetch on those events when nothing is failing", async (context) => {
        const view = mount(context, {config: ok({viewMode: false})});
        await view.flush();

        act(() => window.dispatchEvent(new window.Event("online")));
        act(() => window.document.dispatchEvent(new window.Event("visibilitychange")));
        await view.flush();

        assert.equal(view.calls.config, 1);
    });

    it("keeps the manual retry", async (context) => {
        const view = mount(context, {config: unreachable()});
        await view.flush();

        const [dialog] = view.dialogs(API_TITLE);
        const retry = [...dialog.querySelectorAll("button")].find((button) => button.textContent === RETRY_LABEL);
        click(retry);
        // The alert closes on its fade-out, which jsdom never plays.
        act(() => dialog.dispatchEvent(new window.AnimationEvent("animationend",
            {bubbles: true, animationName: "fadeOut"})));
        await view.flush();

        assert.equal(view.calls.reloads, 1);
    });
});
