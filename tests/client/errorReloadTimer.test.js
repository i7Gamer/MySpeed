import {it} from "node:test";
import assert from "node:assert/strict";
import {useState} from "react";
import {act, cleanup, createElement, render, window} from "../helpers/renderHarness.js";
import {Error as ErrorPage} from "../../client/src/pages/Error/Error.jsx";

const SECOND_MS = 1000;
const HALF_SECOND_MS = SECOND_MS / 2;
const INITIAL_COUNT = 5;

const page = (context, initialProps = {}) => {
    context.mock.timers.enable({apis: ["setTimeout", "setInterval"]});
    const navigations = [];
    let intervalTicks = 0;
    const scheduleInterval = globalThis.setInterval;
    context.mock.method(globalThis, "setInterval", (callback, delay, ...args) =>
        scheduleInterval(() => { intervalTicks++; callback(...args); }, delay));
    // jsdom treats assigning the current URL as a no-op. Observe the real
    // component's browser boundary without replacing its countdown or effects.
    globalThis.window = new Proxy(window, {
        set(target, key, value) {
            if (key === "location") {
                navigations.push(value);
                return true;
            }
            return Reflect.set(target, key, value, target);
        }
    });
    context.after(() => {
        try { cleanup(); }
        finally { globalThis.window = window; }
    });
    let update;
    const Wrapper = () => {
        const [props, setProps] = useState({text: "Connection lost", ...initialProps});
        update = (changes) => act(() => setProps((current) => ({...current, ...changes})));
        return createElement(ErrorPage, props);
    };
    const mounted = render(createElement(Wrapper));
    return {
        ...mounted, navigations,
        get intervalTicks() { return intervalTicks; },
        update: (changes) => update(changes),
        tick: (ms = SECOND_MS) => act(() => context.mock.timers.tick(ms)),
        counter: () => mounted.container.querySelector("h2 span")?.textContent
    };
};

it("counts down, shows now for one second and then requests one reload", (context) => {
    const view = page(context);
    assert.equal(view.counter(), String(INITIAL_COUNT));
    for (let remaining = INITIAL_COUNT - 1; remaining >= 0; remaining--) {
        view.tick();
        assert.equal(view.counter(), remaining === 0 ? "now" : String(remaining));
        assert.deepEqual(view.navigations, []);
    }
    view.tick(HALF_SECOND_MS);
    assert.deepEqual(view.navigations, []);
    view.tick(HALF_SECOND_MS);
    assert.deepEqual(view.navigations, [window.location.href]);
    view.tick();
    assert.equal(view.navigations.length, 1);
});

it("an unrelated rerender does not restart the current second", (context) => {
    const view = page(context);
    view.tick(HALF_SECOND_MS);
    view.update({text: "Still disconnected"});
    assert.equal(view.container.querySelector("h1").textContent, "Still disconnected");
    view.tick(HALF_SECOND_MS);
    assert.equal(view.counter(), String(INITIAL_COUNT - 1));
});

it("disableReload hides and stops the countdown until it is enabled", (context) => {
    const view = page(context, {disableReload: true});
    view.tick((INITIAL_COUNT + 1) * SECOND_MS);
    assert.equal(view.counter(), undefined);
    assert.deepEqual(view.navigations, []);
    view.update({disableReload: false});
    assert.equal(view.counter(), String(INITIAL_COUNT));
    view.tick();
    assert.equal(view.counter(), String(INITIAL_COUNT - 1));
});

it("disabling reload at zero cancels the pending navigation", (context) => {
    const view = page(context);
    for (let tick = 0; tick < INITIAL_COUNT; tick++) view.tick();
    assert.equal(view.counter(), "now");
    view.update({disableReload: true});
    const stoppedAt = view.intervalTicks;
    view.tick();
    assert.deepEqual(view.navigations, []);
    assert.equal(view.intervalTicks, stoppedAt, "disabled countdown must stop its interval");
});

for (const ticks of [0, INITIAL_COUNT]) {
    it(`unmount cancels countdown work after ${ticks} seconds`, (context) => {
        const view = page(context);
        for (let tick = 0; tick < ticks; tick++) view.tick();
        view.unmount();
        const stoppedAt = view.intervalTicks;
        view.tick((INITIAL_COUNT + 1) * SECOND_MS);
        assert.deepEqual(view.navigations, []);
        assert.equal(view.intervalTicks, stoppedAt, "unmount must stop interval callbacks, not merely ignore their state updates");
    });
}
