import {afterEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {useState} from "react";
import {act, cleanup, createElement as h, render, settle, window} from "../helpers/renderHarness.js";
import {readSource} from "../helpers/source.js";
import * as languageChoice from "@/common/utils/LanguageChoice";
import {AboutDialog} from "@/common/components/AboutDialog/AboutDialog.jsx";
import TestArea from "@/pages/Home/components/TestArea/TestAreaComponent.jsx";
import {ConfigContext} from "@/common/contexts/Config";
import {SpeedtestContext} from "@/common/contexts/Speedtests";
import {TargetsContext} from "@/common/contexts/Targets";

const noop = () => {};
const fetchBefore = globalThis.fetch;
const rafBefore = globalThis.requestAnimationFrame;
const cancelBefore = globalThis.cancelAnimationFrame;
afterEach(() => {cleanup(); globalThis.fetch = fetchBefore; globalThis.requestAnimationFrame = rafBefore; globalThis.cancelAnimationFrame = cancelBefore;});
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const answer = local => new Response(JSON.stringify({local}));

describe("browser language seeding", () => {
    const languages = ["en", "de", "zh", "zh-tw"].map(code => ({code}));
    const source = readSource("client/src/i18n.js");
    const seed = source.slice(source.indexOf("if (readStored('language')"), source.indexOf("i18n.use("));
    for (const [browser, expected] of [["zh-TW", "zh-tw"], ["ZH-tw", "zh-tw"], ["zh-CN", "zh"], ["de-DE", "de"], ["xx", "en"], [undefined, "en"], [null, "en"], [42, "en"], ["", "en"], ["zh-Hant", "zh"], ["zh-Hant-HK", "zh"], ["zh-HK", "zh"]]) {
        it(`${String(browser)} seeds ${expected} and the dialog recognizes it`, () => {
            let stored = null;
            vm.runInNewContext(seed, {...languageChoice, languages, navigator: {language: browser}, readStored: () => stored, writeStored: (_, value) => {stored = value;}});
            assert.equal(stored, expected);
            assert.equal(languageChoice.supportedLanguage(stored, languages), expected);
        });
    }
    it("retains an explicit saved choice", () => {
        vm.runInNewContext(seed, {...languageChoice, languages, navigator: {language: "zh-TW"}, readStored: () => "de", writeStored: () => assert.fail("overwrote choice")});
    });
    it("handles an absent browser global", () => {
        let stored = null;
        vm.runInNewContext(seed, {...languageChoice, languages, readStored: () => stored, writeStored: (_, value) => {stored = value;}});
        assert.equal(stored, "en");
    });
});

describe("About request currentness", () => {
    const mount = (initial = {}) => {
        let change;
        const Harness = () => {const [state, setState] = useState({open: true, viewMode: false, ...initial}); change = value => setState(prev => ({...prev, ...value}));
            return h(ConfigContext.Provider, {value: [{viewMode: state.viewMode}, noop]}, h(AboutDialog, {open: state.open, onClose: noop}));};
        render(h(Harness)); return value => act(() => change(value));
    };
    for (const fails of [false, true]) it(`ignores old ${fails ? "failure" : "success"} after reopening`, async () => {
        const old = deferred(), fresh = deferred(); let calls = 0;
        globalThis.fetch = () => ++calls === 1 ? old.promise : fresh.promise;
        const change = mount(); change({open: false}); change({open: true});
        fresh.resolve(answer("NEW")); await settle();
        if (fails) old.reject(new Error("old")); else old.resolve(answer("OLD"));
        await settle(); assert.equal(window.document.querySelector(".about-version").textContent, "vNEW");
    });
    it("retires a pending request when access becomes read-only", async () => {
        const held = deferred(); globalThis.fetch = () => held.promise;
        const change = mount(); change({viewMode: true}); held.resolve(answer("OLD")); await settle();
        assert.equal(window.document.querySelector(".about-version"), null);
    });
    it("keeps ordinary success, failure and read-only no-request behavior", async () => {
        let calls = 0; globalThis.fetch = async () => {calls++; return answer("1.2.3");};
        const change = mount(); await settle(); assert.equal(window.document.querySelector(".about-version").textContent, "v1.2.3");
        change({open: false}); globalThis.fetch = async () => {calls++; throw new Error("offline");}; change({open: true}); await settle();
        assert.equal(window.document.querySelector(".about-version"), null);
        change({open: false, viewMode: true}); change({open: true}); await settle(); assert.equal(calls, 2);
    });
    it("does not request the version for an initially read-only visitor", async () => {
        globalThis.fetch = () => assert.fail("read-only version request"); mount({viewMode: true}); await settle();
        assert.equal(window.document.querySelector(".about-version"), null);
    });
});

describe("pending pagination animation frames", () => {
    const mount = () => {
        const queue = new Map(); let next = 0, oldCalls = 0, newCalls = 0, replace;
        globalThis.requestAnimationFrame = callback => {const id = next++; queue.set(id, callback); return id;};
        globalThis.cancelAnimationFrame = id => queue.delete(id);
        const first = () => oldCalls++, second = () => newCalls++;
        const tests = [{id: 1, created: "2026-09-01T00:00:00Z"}];
        const Harness = () => {const [replaced, setReplaced] = useState(false); replace = () => setReplaced(true);
            return h(ConfigContext.Provider, {value: [{}, noop]}, h(TargetsContext.Provider, {value: {targets: [], byId: {}}},
                h(SpeedtestContext.Provider, {value: {speedtests: tests, loading: false, hasMore: true, loadMoreTests: replaced ? second : first}}, h(TestArea))));};
        const view = render(h(Harness));
        return {...view, queue, calls: () => [oldCalls, newCalls], replace: () => act(replace), scroll: () => act(() => window.dispatchEvent(new window.Event("scroll"))),
            flush: () => act(() => {const callbacks = [...queue.values()]; queue.clear(); callbacks.forEach(fn => fn());})};
    };
    it("cancels frame zero on unmount before it can paginate", () => {
        const view = mount(); view.scroll(); assert.ok(view.queue.has(0)); view.unmount(); view.flush(); assert.deepEqual(view.calls(), [0, 0]);
    });
    it("cancels obsolete closures when dependencies change", () => {
        const view = mount(); view.scroll(); view.replace(); view.flush(); assert.deepEqual(view.calls(), [0, 0]);
        view.scroll(); view.flush(); assert.deepEqual(view.calls(), [0, 1]);
    });
    it("coalesces scroll events into one mounted pagination call", () => {
        const view = mount(); view.scroll(); view.scroll(); assert.equal(view.queue.size, 1); view.flush(); assert.deepEqual(view.calls(), [1, 0]);
    });
});
