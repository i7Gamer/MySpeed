import {afterEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {useState} from "react";
import i18n from "i18next";
import {act, cleanup, click, createElement as h, render, settle, window} from "../helpers/renderHarness.js";
import {TargetEditor} from "@/common/components/TargetsDialog/TargetEditor.jsx";
import {targetBody} from "@/common/components/TargetsDialog/targetBody.js";
import * as fields from "@/common/components/TargetsDialog/providerFields.js";
import {ConfigContext} from "@/common/contexts/Config";
import {TargetsContext} from "@/common/contexts/Targets";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";

const originalFetch = globalThis.fetch;
const noop = () => {};
const document = window.document;
const endpoint = "https://speed.lan:3001";
const stored = {id: 1, name: "Local HTTPS", provider: "openspeedtest", endpoint, alerts: true};
const control = () => document.querySelector(`[aria-label="${i18n.t("dialog.provider.ost_skip_tls_verification")}"]`);
const endpointInput = () => document.querySelector(`[aria-label="${i18n.t("dialog.provider.custom_url")}"]`);
const type = (element, value) => act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(element, value);
    element.dispatchEvent(new window.Event("input", {bubbles: true}));
});
const mount = (target = stored) => {
    let setOpen;
    const Harness = () => {
        const [open, updateOpen] = useState(true);
        setOpen = updateOpen;
        return h(ConfigContext.Provider, {value: [{}, noop]},
            h(TargetsContext.Provider, {value: {targets: [stored], reloadTargets: noop}},
                h(ToastNotificationContext.Provider, {value: noop},
                    h(TargetEditor, {open, onClose: noop, target}))));
    };
    render(h(Harness));
    return value => act(() => setOpen(value));
};
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

describe("OpenSpeedTest certificate exception", () => {
    it("serializes an explicit opt-in only for a valid HTTPS OpenSpeedTest destination", () => {
        for (const flag of [undefined, false, 0, 1, "true", null])
            assert.equal(targetBody({...stored, ostSkipCertificateVerification: flag}).ostSkipCertificateVerification,
                false);
        assert.equal(targetBody({...stored, ostSkipCertificateVerification: true}).ostSkipCertificateVerification, true);
        for (const value of [{provider: "libre"}, {endpoint: "http://speed.lan"}, {endpoint: "not a URL"}])
            assert.equal(targetBody({...stored, ...value, ostSkipCertificateVerification: true})
                .ostSkipCertificateVerification, false);
    });

    it("recognizes only valid HTTPS endpoints as supporting the exception", () => {
        assert.equal(fields.ostSupportsCertificateBypass("openspeedtest", `  ${endpoint}  `), true);
        for (const [provider, value] of [["libre", endpoint], ["openspeedtest", "http://speed.lan"],
            ["openspeedtest", null], ["openspeedtest", "https://user@speed.lan"]])
            assert.equal(fields.ostSupportsCertificateBypass(provider, value), false);
    });

    it("defaults off, explains the risk, and sends a deliberate boolean opt-in", async () => {
        const writes = [];
        globalThis.fetch = async (_url, options) => {
            if (options?.method === "PATCH") writes.push(JSON.parse(options.body));
            return new Response(JSON.stringify({}));
        };
        mount(); await settle();
        assert.ok(control(), "HTTPS target has an accessible certificate toggle");
        assert.equal(control().checked, false);
        assert.match(document.body.textContent, /redirects/i);
        assert.match(document.body.textContent, /man-in-the-middle/i);
        click(control());
        const saveButton = [...document.querySelectorAll("button")]
            .find(button => button.textContent === i18n.t("dialog.update"));
        assert.ok(saveButton, "target editor exposes its save action");
        assert.equal(saveButton.disabled, false);
        click(saveButton);
        await settle();
        assert.equal(writes.length, 1);
        assert.equal(writes[0].ostSkipCertificateVerification, true);
    });

    it("restores only persisted opt-ins on reopen and clears them on destination/provider edits", async () => {
        globalThis.fetch = async () => new Response(JSON.stringify({}));
        const open = mount({...stored, ostSkipCertificateVerification: 1}); await settle();
        assert.ok(control());
        assert.equal(control().checked, true);
        type(endpointInput(), "https://different.lan:3001");
        assert.equal(control().checked, false);
        click(control()); type(endpointInput(), "http://different.lan:3000");
        assert.equal(control(), null);
        type(endpointInput(), endpoint);
        assert.equal(control().checked, false);
        open(false); open(true); await settle();
        assert.equal(control().checked, true);
        click([...document.querySelectorAll('[role="radio"]')].find(row => row.textContent.includes("LibreSpeed")));
        assert.equal(control(), null);
        click([...document.querySelectorAll('[role="radio"]')].find(row => row.textContent.includes("OpenSpeedTest")));
        assert.equal(control().checked, false);
    });
});
