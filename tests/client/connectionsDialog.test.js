import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, withoutJsComments } from "../helpers/source.js";
import { cleanup, click, createElement, render, settle, window } from "../helpers/renderHarness.js";
import { AlertProvider } from "@/common/contexts/Alert";
import { ConfigContext } from "@/common/contexts/Config";
import { ToastNotificationContext } from "@/common/contexts/ToastNotification";
import { PreferencesContext } from "@/common/contexts/Preferences";
import { TargetsContext } from "@/common/contexts/Targets";
import ConnectionsDialog from "@/common/components/ConnectionsDialog";

/*
 * The dialog that shows when the address or the provider changed. Rendered
 * against a scripted fetch: what matters is that every change the server
 * holds is on screen, that each says what changed and for which member, and
 * that the reader is told when there is nothing yet.
 */

afterEach(() => {
    globalThis.fetch = realFetch;
    cleanup();
});

const realFetch = globalThis.fetch;
const noop = () => undefined;

const answer = (body, status = 200) =>
    new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json"}});

const ROWS = [
    {id: 2, created: "2026-09-07T08:00:00.000Z", testId: 40, targetId: 1, provider: "ookla",
        previousIp: "203.0.113.10", ip: "203.0.113.20", previousIsp: null, isp: null},
    {id: 1, created: "2026-09-01T10:00:00.000Z", testId: 12, targetId: 9, provider: "libre",
        previousIp: null, ip: null, previousIsp: "Old Net", isp: "New Net"}
];

const scripted = (rows = ROWS) => {
    const requests = [];
    globalThis.fetch = async (url) => {
        requests.push(String(url));
        return String(url).endsWith("/api/speedtests/connections") ? answer(rows) : answer({}, 404);
    };
    return {requests};
};

const targets = {targets: [{id: 1, name: "WAN"}], byId: {1: {id: 1, name: "WAN"}}, reloadTargets: noop};

const mount = async () => {
    render(createElement(AlertProvider, null,
        createElement(ConfigContext.Provider, {value: [{viewMode: false, previewMode: false}, noop, noop]},
            createElement(ToastNotificationContext.Provider, {value: noop},
                createElement(PreferencesContext.Provider, {value: [{}, noop]},
                    createElement(TargetsContext.Provider, {value: targets},
                        createElement(ConnectionsDialog, {open: true, onClose: noop})))))));
    await settle();
    await settle();

    return window.document;
};

const rowsOf = (document) => [...document.querySelectorAll(".connection-row")];

describe("the connection changes dialog", () => {
    it("shows a failed load and retries without claiming the log is empty", async (context) => {
        const errors = context.mock.method(console, "error", noop);
        globalThis.fetch = async () => {throw new Error("Connection log unavailable");};
        const document = await mount();
        assert.ok(document.querySelector(".connections-empty") === null, "failed load must not say no changes");
        assert.match(document.querySelector(".connections-content").textContent, /Connection log unavailable/);
        assert.equal(errors.mock.calls.length, 1);
        scripted();
        const retry = document.querySelector('[role="alert"] button');
        assert.ok(retry);
        click(retry);
        await settle();
        assert.equal(rowsOf(document).length, ROWS.length);
        assert.doesNotMatch(document.querySelector(".connections-content").textContent, /Connection log unavailable/);
    });

    it("asks the server once when opened", async () => {
        const {requests} = scripted();
        await mount();

        assert.equal(requests.filter((url) => url.endsWith("/api/speedtests/connections")).length, 1);
    });

    it("lists every change the server holds, newest first", async () => {
        scripted();
        const document = await mount();

        const rows = rowsOf(document);
        assert.equal(rows.length, 2);
        assert.match(rows[0].textContent, /203\.0\.113\.10/);
        assert.match(rows[0].textContent, /203\.0\.113\.20/);
        assert.match(rows[1].textContent, /Old Net/);
        assert.match(rows[1].textContent, /New Net/);
    });

    it("says only what changed on each row", async () => {
        scripted();
        const document = await mount();

        const [address, provider] = rowsOf(document);
        assert.doesNotMatch(address.textContent, /Provider/);
        assert.doesNotMatch(provider.textContent, /IP/);
    });

    it("names the member that saw it, and says so when that member is gone", async () => {
        scripted();
        const document = await mount();

        const [known, gone] = rowsOf(document);
        assert.match(known.textContent, /WAN/);
        assert.match(gone.textContent, /Removed target/);
    });

    it("prints null for nothing", async () => {
        scripted();
        const document = await mount();

        assert.doesNotMatch(document.querySelector(".connections-content").textContent, /null/);
    });

    it("says so when there is nothing yet", async () => {
        scripted([]);
        const document = await mount();

        assert.equal(rowsOf(document).length, 0);
        assert.match(document.querySelector(".connections-content").textContent, /No changes recorded yet/);
    });
});

describe("the dropdown entry", () => {
    const dropdown = withoutJsComments(readSource("client/src/common/components/Dropdown/DropdownComponent.jsx"));

    // Refused on a demo rather than hidden, the way every other sealed
    // setting is - and the route behind it answers a demo with a 403.
    it("is offered, and refused on a demo", () => {
        const line = dropdown.split("\n").find((candidate) => candidate.includes('key: "connections"'));

        assert.ok(line, "the dropdown has no connections entry");
        assert.match(line, /previewDisabled: true/);
        assert.match(line, /t\("dropdown\.connections"\)/);
        assert.doesNotMatch(line, /allowView/, "a viewer is offered the connection log");
    });

    it("mounts the dialog", () => {
        assert.match(dropdown, /<ConnectionsDialog open=\{showConnectionsDialog\} onClose=\{\(\) => setShowConnectionsDialog\(false\)\}\/>/);
    });
});
