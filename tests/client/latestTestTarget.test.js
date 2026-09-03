import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanup, createElement, render, window } from "../helpers/renderHarness.js";
import { escapeRegExp } from "../helpers/source.js";
import { ConfigContext } from "@/common/contexts/Config";
import { PreferencesContext } from "@/common/contexts/Preferences";
import { StatusContext } from "@/common/contexts/Status";
import { TargetsContext } from "@/common/contexts/Targets";
import { targetColour } from "@/common/utils/TargetUtil.js";
import LatestTestChart from "@/pages/Statistics/charts/LatestTestChart";

/**
 * Which target the newest test belongs to, on the card that shows its figures.
 *
 * The card states a ping, an upload and a download under the heading "Last
 * test" - and on an instance measuring several targets those figures belong to
 * exactly one of them, with nothing on the card saying which. The history rows
 * answered this long ago, with the coloured dot in the date cell; this is the
 * same mark, on the one card of the statistics page that shows a single test.
 *
 * The two gates are the history list's, and for its reasons: one target leaves
 * nothing to tell apart, and a chip narrowing the page has already answered the
 * question above every card on it. Both must leave the card exactly as it was.
 */
afterEach(cleanup);

const noop = () => undefined;

const TARGETS = [{id: 1, name: "Fritzbox"}, {id: 2, name: "Router"}];

// The newest test, measured by the second target - so the dot has to be the
// second colour of the cycle rather than merely present.
const TEST = {id: 9, ping: 12.3, download: 100, upload: 50, targetId: 2};

const SECOND_TARGET_COLOUR = targetColour(1);

const nest = (child, ...layers) =>
    layers.reduceRight((inner, [Provider, value]) => createElement(Provider, {value}, inner), child);

const mount = ({targets = TARGETS, selectedTarget = null, test = TEST} = {}) =>
    render(nest(createElement(LatestTestChart, {test}),
        [ConfigContext.Provider, [{ping: 30, download: 100, upload: 50}, noop, noop]],
        [StatusContext.Provider, [{paused: false, running: false}, noop, noop]],
        [PreferencesContext.Provider, [{}, noop]],
        [TargetsContext.Provider, {
            targets,
            byId: Object.fromEntries(targets.map((target) => [target.id, target])),
            selectedTarget,
            reloadTargets: noop
        }]));

const header = (container) => container.querySelector(".stats-header");
const dot = (container) => header(container).querySelector(".target-dot");

describe("the last-test card on an instance with several targets", () => {
    it("names the target the figures were measured against", () => {
        const {container} = mount();

        assert.match(header(container).textContent, /Last test/, "the card lost its own heading");
        assert.match(header(container).textContent, /Router/,
            "the card shows one target's figures and names no target");
    });

    /**
     * And the mark beside the name is the one the history rows already use, in
     * the colour that target wears everywhere else - the chip, the comparison
     * line and the dot on its own rows.
     */
    it("marks it with the dot that target wears everywhere else", () => {
        const {container} = mount();
        const mark = dot(container);

        assert.ok(mark, "the card names the target with no mark to recognise it by");
        assert.match(mark.getAttribute("style") ?? "", new RegExp(escapeRegExp(SECOND_TARGET_COLOUR)),
            "the dot is drawn in some colour other than the target's own");
    });

    // A generic span's title is commonly skipped by a screen reader, which
    // would leave the target as colour alone - the same finding the history
    // row's dot answered with role="img" and a name.
    it("gives the mark a name rather than only a tooltip", () => {
        const {container} = mount();
        const mark = dot(container);

        assert.equal(mark.getAttribute("role"), "img");
        assert.equal(mark.getAttribute("aria-label"), "Router");
        assert.equal(mark.getAttribute("title"), "Router");
    });
});

describe("the last-test card where the question does not arise", () => {
    it("says nothing about targets on an instance that has one", () => {
        const {container} = mount({targets: [TARGETS[0]], test: {...TEST, targetId: 1}});

        assert.equal(dot(container), null, "a single-target instance gained a dot it cannot need");
        assert.equal(header(container).textContent.trim(), "Last test",
            "the heading is no longer what a single-target instance has always read");
    });

    // The chip row says which target the whole page is showing, so a card
    // repeating it under every heading is the same answer twice.
    it("says nothing while a chip already narrows the page", () => {
        const {container} = mount({selectedTarget: 2});

        assert.equal(dot(container), null, "the card names the target the chip above it already names");
        assert.equal(header(container).textContent.trim(), "Last test");
    });

    // A row whose target has since been deleted resolves to no position in the
    // list, and a dot in var(--chart-undefined) is no colour at all.
    it("says nothing for a test whose target is gone", () => {
        const {container} = mount({test: {...TEST, targetId: 404}});

        assert.equal(dot(container), null, "a deleted target still draws a dot, in no colour");
    });
});

describe("the last-test card's own document", () => {
    it("renders exactly one heading for the card", () => {
        const {container} = mount();

        assert.equal(window.document.querySelectorAll(".stats-header").length, 1);
        assert.ok(container.querySelector(".info-container"), "the card no longer draws its rows");
    });
});
