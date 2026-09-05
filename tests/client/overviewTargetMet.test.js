import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanup, createElement, render } from "../helpers/renderHarness.js";
import { readLocale } from "../helpers/source.js";
import { PreferencesContext } from "@/common/contexts/Preferences";
import { OverviewChart } from "@/pages/Statistics/charts/OverviewChart/OverviewChart.jsx";

/**
 * The two rows the enlarged overview gained, rendered.
 *
 * "Target met" counts the tests whose three figures all earned the good
 * grade, out of those the server could judge; "Last failure" dates the newest
 * failed test. Rendered rather than lifted, because what matters here is what
 * reaches the screen: the row's presence, its printed share, and that the two
 * failure rows come and go together - the dialog lays its rows out in two
 * columns, and a row that appears alone leaves the corner beside it empty.
 */
const english = readLocale("en");
const overview = english.statistics.overview;

const noop = () => {};

// A payload the card can draw with nothing else in it: the four base rows read
// these, and every row this file is about is gated on its own block.
const BASE = {
    tests: {total: 10, failed: 0},
    time: {avg: 14, min: 8, max: 29},
    packetLoss: 0,
    ping: {avg: 4.6, min: 4, max: 13, median: 4.5},
    hourlyAverages: [],
    dataUsed: {download: null, upload: null, total: null},
    reliability: {longestFailureStreak: null, lastFailureAt: null, largestGap: null},
    dateRange: {from: "2026-08-29T00:00:00.000Z", to: "2026-09-05T23:59:59.999Z", days: 8},
    previous: null
};

const FAILED = {
    tests: {total: 10, failed: 2},
    reliability: {
        longestFailureStreak: {count: 2, from: "2026-09-01T10:00:00.000Z", to: "2026-09-01T11:00:00.000Z"},
        lastFailureAt: "2026-09-01T11:00:00.000Z",
        largestGap: null
    }
};

const mount = (props) => render(createElement(PreferencesContext.Provider, {value: [{}, noop]},
    createElement(OverviewChart, {...BASE, ...props, expanded: true})));

const rows = (container) => [...container.querySelectorAll(".panel-row")].map((row) => ({
    title: row.querySelector(".panel-row-title")?.textContent,
    value: row.querySelector(".panel-row-value")?.textContent
}));

const row = (container, title) => rows(container).find((item) => item.title === title);

afterEach(cleanup);

describe("the target-met row", () => {
    it("prints the share of judged tests that met their target", () => {
        const {container} = mount({targetMet: {met: 9, measured: 10}});
        const item = row(container, overview.target_met_title);

        assert.notEqual(item, undefined, "the row did not render");
        assert.match(item.value, /^90%/, "the share is not the met count over the judged one");
    });

    it("says how many were judged, in the caption", () => {
        const {container} = mount({targetMet: {met: 9, measured: 10}});

        assert.ok(container.textContent.includes(overview.target_met_description
            .replace("{{met}}", "9").replace("{{measured}}", "10")), "the caption does not carry the counts");
    });

    it("hangs a delta off the share in points of the percentage", () => {
        const {container} = mount({targetMet: {met: 9, measured: 10},
            previous: {tests: {total: 10, failed: 0}, targetMet: {met: 8, measured: 10}}});

        assert.match(row(container, overview.target_met_title).value, /10%$/,
            "ninety over eighty is ten points, not a 12.5% improvement");
    });

    it("does not render for a node that answers no count", () => {
        assert.equal(row(mount({}).container, overview.target_met_title), undefined);
        assert.equal(row(mount({targetMet: null}).container, overview.target_met_title), undefined);
    });

    it("does not render as 0% when nothing could be judged", () => {
        assert.equal(row(mount({targetMet: {met: 0, measured: 0}}).container, overview.target_met_title), undefined);
    });

    it("refuses a placeholder a proxied node might send", () => {
        assert.equal(row(mount({targetMet: {met: -1, measured: -1}}).container, overview.target_met_title), undefined);
    });
});

describe("the last-failure row", () => {
    it("dates the newest failure beside the streak", () => {
        const {container} = mount(FAILED);

        assert.notEqual(row(container, overview.streak_title), undefined, "the streak row is missing");
        const item = row(container, overview.last_failure_title);
        assert.notEqual(item, undefined, "the last-failure row did not render");
        assert.match(item.value, /2026/, "the value is not the failure's date");
    });

    it("comes and goes with the streak row", () => {
        const clean = mount({}).container;

        assert.equal(row(clean, overview.streak_title), undefined);
        assert.equal(row(clean, overview.last_failure_title), undefined);
    });

    it("stays off when the streak is present but the instant is not", () => {
        const {container} = mount({...FAILED,
            reliability: {...FAILED.reliability, lastFailureAt: null}});

        assert.notEqual(row(container, overview.streak_title), undefined);
        assert.equal(row(container, overview.last_failure_title), undefined);
    });
});

describe("the enlarged view's row count", () => {
    // The dialog lays its rows out in two columns, so an odd count leaves the
    // bottom-right cell empty. Which optional rows a range draws depends on
    // its payload, so the count itself is not the invariant - what is, is
    // that a failure adds its two rows together: a range that comes out even
    // without one comes out even with one.
    it("grows by exactly two when there is a failure to report", () => {
        const full = {
            ...BASE,
            targetMet: {met: 9, measured: 10},
            reliability: {...BASE.reliability, largestGap: {seconds: 3600, from: "2026-09-01T10:00:00.000Z",
                to: "2026-09-01T11:00:00.000Z"}}
        };

        const clean = rows(mount(full).container).length;
        const failed = rows(mount({...full, ...FAILED,
            reliability: {...FAILED.reliability, largestGap: full.reliability.largestGap}}).container).length;

        assert.equal(failed - clean, 2, `${clean} rows on a clean range, ${failed} with a failure`);
    });
});
