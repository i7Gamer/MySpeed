import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, tagHolding } from "../helpers/source.js";

/**
 * The schedule offset switch, which a pointer could set and a keyboard could
 * not.
 *
 * It was a bare div with an onClick: no tab stop, no role, no key handler. The
 * dialog around it does the opposite in both directions - its presets are
 * SelectableOption, which carries tabIndex, role and activateOnKey, and its
 * advanced disclosure is a real button - so the one control a keyboard could
 * not reach sat between two it could. The app has fixed this shape repeatedly
 * (the pagination, the storage tabs); this was the last one left.
 */
describe("the schedule offset switch", () => {
    const dialog = readSource("client/src/common/components/FrequencyDialog/FrequencyDialog.jsx");

    it("is not a bare div carrying an onClick", () => {
        assert.doesNotMatch(dialog, /<div className="frequency-option" onClick=/,
            "a keyboard cannot focus or operate the offset switch");
    });

    it("answers the keyboard the way the rest of the app does", () => {
        const option = tagHolding(dialog, "frequency-option");

        assert.match(option, /role="switch"/, "the control announces as nothing");
        assert.match(option, /aria-checked=\{scheduleOffset\}/, "a reader is never told whether it is on");
        // The tab stop and the key handling come from the shared helper rather
        // than being spelled out again - it is what every other reachable div
        // in the app uses, and it declines keys aimed at a nested control.
        assert.match(option, /\{\.\.\.clickable\(/, "Tab walks past it and Enter does nothing");
    });

    // The two controls beside it, which were always reachable - so the fix is
    // consistency rather than a new idea.
    it("leaves the presets and the disclosure as they were", () => {
        assert.match(dialog, /<SelectableOption key=\{preset\.id\}/);
        assert.match(dialog, /frequency-advanced-toggle/);
    });
});

/**
 * A statistics page that keeps what it managed to load.
 *
 * The aggregation and the recent-tests list were fetched in one Promise.all,
 * so either rejection set loadError and the page rendered the full-screen
 * error instead of the charts - discarding a statistics payload that had
 * arrived perfectly. Two independent requests gating one page doubles the
 * chance of showing nothing.
 */
describe("loading the statistics page", () => {
    const page = readSource("client/src/pages/Statistics/Statistics.jsx");

    it("does not let either request cancel the other", () => {
        assert.doesNotMatch(page, /Promise\.all\(\[\s*jsonRequest\(`\/speedtests\/statistics/,
            "one Promise.all still gates the whole page on both requests");
        assert.match(page, /Promise\.allSettled\(/,
            "the two loads are not settled independently");
    });

    it("still blanks the page when the statistics themselves fail", () => {
        assert.match(page, /setLoadError\(/,
            "a statistics failure no longer reports anything at all");
    });

    // The recent tests feed the latest-test card and the deltas beside it.
    // Their absence is a card that cannot draw, not a page that cannot load.
    it("keeps the page when only the recent tests fail", () => {
        assert.match(page, /tests\.status === "fulfilled"/,
            "the recent tests are read without asking whether they arrived");
        assert.doesNotMatch(page, /if \(tests\.status === "rejected"\)\s*\{?\s*setLoadError/,
            "a failed recent-tests fetch still blanks the page");
    });
});

/**
 * And a node card that stops asking while nobody is looking.
 *
 * Each card polls every ten seconds, and each tick is two requests - proxied
 * through the parent to the child for every remote node. Nothing checked
 * whether the tab was visible, so a dashboard left open on the node list kept
 * asking indefinitely: six nodes is some 4,300 proxied requests an hour into
 * idle children, all of it against the request budget the live poll's own
 * comment exists to protect. StatusContext has skipped hidden ticks all along.
 */
describe("the node card's poll", () => {
    const card = readSource("client/src/pages/Nodes/components/NodeContainer/NodeContainer.jsx");

    it("skips a tick while the tab is hidden", () => {
        assert.match(card, /document\.hidden/,
            "the card polls a background tab as hard as a visible one");
    });

    it("still polls on the interval it always did", () => {
        assert.match(card, /setInterval\(/);
        assert.match(card, /10000|POLL_INTERVAL/);
    });

    // The first load is not a tick: opening the page has to fill the card in
    // whether or not anything has changed since.
    it("still loads once when it mounts", () => {
        const effect = card.slice(card.indexOf("useEffect(() => {", card.indexOf("const load =") - 200));

        assert.match(effect.slice(0, effect.indexOf("setInterval")), /\bload\(\);/,
            "the card no longer loads until the first interval elapses");
    });
});
