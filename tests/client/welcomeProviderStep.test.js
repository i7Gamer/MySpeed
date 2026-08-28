import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import { requiresEndpoint } from "../../client/src/common/components/TargetsDialog/providerFields.js";
import {
    FIRST_STEP, LICENCE_STEP, PROVIDER_STEP, THRESHOLDS_STEP, canAdvance, lastStep
} from "../../client/src/common/components/WelcomeDialog/welcomeStep.js";

/**
 * The wizard offered a provider it could not create.
 *
 * The chooser draws whatever is in the shared `providers` list, which grew an
 * iperf3 entry when targets learned to measure against one - and finish() sent
 * `{name, provider}` and nothing else. The server refuses an iperf3 target with
 * no host, so Done threw, toasted, and returned before close().
 *
 * That is worse here than anywhere else in the application. This is the one
 * dialog mounted `disableClose`, and the only one with no way back to a
 * previous step: an operator who picked the fourth card on a fresh install had
 * a Done button that failed every time, naming a field the wizard never showed
 * them, and no way out but reloading the page. It is also the first screen a
 * new install draws.
 */

const chooser = readSource(
    "client/src/common/components/WelcomeDialog/steps/ProviderChooser/ProviderChooser.jsx");
const welcome = readSource("client/src/common/components/WelcomeDialog/WelcomeDialog.jsx");
const providerSource = readSource("client/src/common/components/TargetsDialog/providers.jsx");

/**
 * The provider ids the cards are drawn from, read rather than imported: that
 * module imports the three logos as .webp, which no test runner can load.
 */
const providerIds = [...providerSource.matchAll(/\{id: "([a-z0-9]+)"/g)].map((match) => match[1]);

describe("the providers the wizard offers", () => {
    it("finds the shared list at all", () => {
        assert.ok(providerIds.length >= 4,
            `read ${providerIds.length} providers out of the shared list`);
        assert.ok(providerIds.includes("iperf3"), "the list no longer carries the case that broke");
    });

    /**
     * The general form of the bug, so the next provider that needs a value
     * cannot repeat it: whatever the shared list offers, the wizard either
     * completes it or refuses to move on until it can.
     */
    it("refuses to move on from a provider it cannot complete", () => {
        for (const id of providerIds)
            assert.equal(canAdvance({step: PROVIDER_STEP, provider: id, endpoint: ""}),
                !requiresEndpoint(id),
                `provider ${id} with no address`);
    });

    it("moves on once the address it needs is filled in", () => {
        assert.equal(canAdvance({step: PROVIDER_STEP, provider: "iperf3", endpoint: "10.0.0.5:5201"}),
            true);
    });

    /**
     * Held to the server's shape rule, not just to non-emptiness. Any host the
     * server refuses used to walk past this step and trap the operator behind
     * a Done that always fails, on a step where the offending field is no
     * longer rendered and there is no Back.
     */
    it("refuses a host the server would refuse", () => {
        for (const host of ["http://iperf.lan:5201", "10.0.0.5:0", "10.0.0.5:65536",
            "nas lan", "user@nas.lan", "[]"])
            assert.equal(canAdvance({step: PROVIDER_STEP, provider: "iperf3", endpoint: host}),
                false, `${host} walked past the chooser and can only fail at Done`);
    });

    // The worse direction to get wrong: a rule tighter than the server's holds
    // a legitimate operator behind a dead button.
    it("accepts every host the server accepts", () => {
        for (const host of ["fd00::1", "[fd00::1]", "[fd00::1]:5201", "localhost",
            "nas.lan:5201", "10.0.0.5:65535"])
            assert.equal(canAdvance({step: PROVIDER_STEP, provider: "iperf3", endpoint: host}),
                true, `an operator whose iperf3 server is at ${host} is held behind a dead button`);
    });

    // A name of spaces is not an address, and the server trims before judging.
    it("does not accept whitespace as an address", () => {
        assert.equal(canAdvance({step: PROVIDER_STEP, provider: "iperf3", endpoint: "   "}), false);
    });

    // Nothing has been chosen yet on step one, and the licence step asks for
    // nothing - the endpoint gate belongs to the card step alone, and the
    // thresholds step has a gate of its own below.
    it("does not hold the endpoint against any other step", () => {
        for (const step of [FIRST_STEP, THRESHOLDS_STEP, LICENCE_STEP])
            assert.equal(canAdvance({step, provider: "iperf3", endpoint: "",
                ping: 12, download: 100, upload: 50}), true, `step ${step}`);
    });

    it("survives an endpoint that was never set", () => {
        assert.equal(canAdvance({step: PROVIDER_STEP, provider: "iperf3"}), false);
        assert.equal(canAdvance({step: PROVIDER_STEP, provider: "ookla"}), true);
    });
});

/**
 * The thresholds step, held to the shape the server holds a threshold to.
 *
 * The three inputs carry no min and were not gated at all, and the refusal
 * lands where finish() PATCHes them - which for ookla is one step later, on
 * the licence: a single Done button, disableClose, the offending fields no
 * longer rendered and no way back. The wedge the endpoint gate above was
 * written for, reachable through an emptied number field instead.
 */
describe("the thresholds the wizard may leave with", () => {
    const at = (overrides) => canAdvance({step: THRESHOLDS_STEP, provider: "ookla",
        endpoint: "", ping: 12, download: 100, upload: 50, ...overrides});

    it("refuses an emptied field", () => {
        assert.equal(at({ping: ""}), false);
        assert.equal(at({download: ""}), false);
        assert.equal(at({upload: ""}), false);
    });

    it("refuses what the server's shape rule refuses", () => {
        assert.equal(at({ping: "abc"}), false);
        assert.equal(at({download: "-5"}), false);
        assert.equal(at({upload: "1.2.3"}), false);
    });

    // The worse direction to get wrong, as with the hosts above: a rule
    // tighter than the server's holds the operator behind a dead button.
    it("accepts everything the server accepts", () => {
        assert.equal(at({}), true);
        assert.equal(at({ping: "0.4"}), true, "the recommended ping on a fast line");
        assert.equal(at({ping: 0}), true, "zero is the server's own lower bound");
        assert.equal(at({download: "25.9"}), true);
    });
});

/**
 * Only Ookla has a licence to show, so it is the one provider with a fourth
 * step. Read from one place rather than repeated as `provider === "ookla" ? 4
 * : 3` beside both the button's label and the step counter.
 */
describe("how many steps the wizard has", () => {
    it("shows the licence step for Ookla and no other", () => {
        assert.equal(lastStep("ookla"), 4);
        for (const id of providerIds.filter((current) => current !== "ookla"))
            assert.equal(lastStep(id), 3, `provider ${id}`);
    });
});

describe("the provider cards", () => {
    /**
     * iperf3 carries a glyph rather than a logo. The chooser passed
     * `image={{src: current.image, ...}}` unconditionally and never `icon`, so
     * its card rendered `<img src={undefined}>` - a broken image where the
     * target editor, fixed for this in the same commit, draws a server.
     */
    it("draws a glyph for a provider that has no logo", () => {
        assert.match(chooser, /icon=\{current\.icon\}/,
            "a provider carrying a glyph instead of a logo has nothing drawn for it");
    });

    it("does not draw an image for a provider that has none", () => {
        assert.match(chooser, /image=\{current\.image\s*\n?\s*\?/,
            "every card is given an <img>, including the ones with no logo to put in it");
    });

    /**
     * The field that makes the offer real. Reusing the editor's own label and
     * placeholder, so the two screens name the same thing the same way - and
     * so no new key has to be translated into twenty-three locales to say
     * something already said.
     */
    it("asks for the address a provider cannot do without", () => {
        assert.match(chooser, /requiresEndpoint\(provider\)/,
            "the chooser never asks for an address, whichever provider is picked");
        assert.match(chooser, /dialog\.provider\.iperf_host/,
            "the field has no label");
        assert.match(chooser, /IPERF_HOST_PLACEHOLDER/,
            "the empty field does not show the shape it takes");
    });
});

describe("the wizard's continue button", () => {
    it("is dead while the step cannot be completed", () => {
        const button = welcome.slice(welcome.indexOf("<button"), welcome.indexOf("</button>"));

        // The name it is disabled by, then where that name comes from: asked
        // in two steps because a `disabled` bound to any old flag would
        // satisfy the first assertion on its own. The button is dead for two
        // reasons now - the step gate and the in-flight lock - so the pattern
        // tolerates a second term; the teeth are in the follow-up assertion,
        // which resolves the captured name back to canAdvance and must not be
        // dropped.
        const disabledBy = /disabled=\{[^}]*!(\w+)/.exec(button);
        assert.notEqual(disabledBy, null,
            "the button is pressable on a step the server will refuse");

        assert.match(welcome, new RegExp(`const ${disabledBy[1]} = canAdvance\\(`),
            `the button is disabled by ${disabledBy[1]}, which is not the step gate`);
    });

    /**
     * Belt and braces, because the button is not the only way in: the gate is
     * asked again by the handler, so a step that cannot be completed cannot be
     * left however continueStep comes to be called.
     */
    it("is checked again by the handler behind it", () => {
        const start = welcome.indexOf("const continueStep");
        assert.notEqual(start, -1, "the wizard no longer has a continue step");

        assert.match(welcome.slice(start, welcome.indexOf("};", start)), /canAdvance\(/,
            "only the button's disabled attribute stands between the operator and a refused save");
    });
});
