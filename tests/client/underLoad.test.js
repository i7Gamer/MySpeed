import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as sass from "sass";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const CLIENT_SRC = path.join(ROOT, "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const pane = read("common/components/TestDetails/TestDetails.jsx");
const row = read("pages/Home/components/Speedtest/SpeedtestComponent.jsx");
const area = read("pages/Home/components/TestArea/TestAreaComponent.jsx");
const english = JSON.parse(fs.readFileSync(
    path.join(ROOT, "client", "public", "assets", "locales", "en.json"), "utf8"));

const css = sass.compile(path.join(CLIENT_SRC, "pages/Home/components/Speedtest/styles.sass"), {
    importers: [{
        findFileUrl: (url) => url.startsWith("@/") ? pathToFileURL(path.join(CLIENT_SRC, url.slice(2))) : null
    }]
}).css;

const factsAt = pane.indexOf('className="detail-facts"');
const facts = pane.slice(factsAt);
const beforeFacts = pane.slice(0, factsAt);

const metricsBlock = pane.match(/const metrics = \[([\s\S]*?)\n {4}];/)?.[1] ?? "";
const metricSource = (key) => metricsBlock.split(/key: "/).slice(1)
    .find((part) => part.startsWith(`${key}"`)) ?? "";

/**
 * The latency a direction shows while it is saturated belongs to that
 * direction.
 *
 * It sat in the facts grid as one row for both - "⬇ 24 / ⬆ 31 ms" - a line
 * away from the speeds it was measured beside, where the reader had to carry
 * the download's number back up to the download card themselves. The ping card
 * had already been given the two figures measured beside the ping; this is the
 * same move for the other two.
 */
describe("the loaded latency sits on the card it was measured on", () => {
    it("finds the cards to check", () => {
        for (const key of ["download", "upload"])
            assert.notEqual(metricSource(key), "", `the ${key} metric is gone`);
    });

    it("gives each direction its own figure", () => {
        assert.match(metricSource("download"), /downloadLatency/);
        assert.match(metricSource("upload"), /uploadLatency/);
    });

    // One direction's latency under the other's speed would be a plain lie, and
    // both under one is the facts row this replaces.
    it("does not put the download's latency on the upload card", () => {
        assert.doesNotMatch(metricSource("upload"), /downloadLatency/);
        assert.doesNotMatch(metricSource("download"), /uploadLatency/);
    });

    // A row recorded before the quality columns existed, or by a provider that
    // measures no latency under load, has no value rather than zero.
    // Built by one helper both cards call, so the gate is asserted where it
    // lives rather than once per direction.
    it("draws nothing for a test that never measured one", () => {
        const helper = beforeFacts.slice(beforeFacts.indexOf("const loadedLatency"));

        assert.match(helper.slice(0, helper.indexOf("\n    const")), /isMeasured\(value\)/);
    });

    it("gives up its row in the facts grid", () => {
        assert.doesNotMatch(facts, /test\.details\.loaded_latency/,
            "the latency under load still costs a row, and now says it twice");
    });

    // It is not the idle ping and must not borrow its glyph - see
    // metricIcons.test.js, which exists because one glyph covering two
    // measurements is how this went wrong before.
    it("has a glyph of its own", () => {
        assert.match(beforeFacts, /faStopwatch/);
    });

    it("explains itself the way every other figure on these cards does", () => {
        assert.match(beforeFacts, /loadedLatencyInfo/);
        assert.equal(typeof english.info.loaded_latency?.title, "string");
        assert.equal(typeof english.info.loaded_latency?.description, "string");
    });
});

/**
 * The pane is also the expanded latest test on the statistics page, where there
 * is no overview row to carry the grade - so the fact row stays, and the row on
 * the overview is an addition rather than a move.
 */
describe("the bufferbloat grade keeps its row in the pane", () => {
    it("is still a fact", () => {
        assert.match(facts, /test\.details\.bufferbloat/);
    });
});

/**
 * Two merges, each of two facts that were one fact printed twice.
 *
 * The duration hangs under the timestamp: `created` is always present, so the
 * figure can never be orphaned by the merge - which is not true of the other
 * candidate, the data used, that only exists when the provider counted bytes.
 *
 * The provider and the address are one fact more literally still: they are read
 * as a pair by connectionChange, they carry the same "changed" marker, and a
 * failover or a reassigned lease moves both at once. Two rows made that read as
 * two coincidences.
 */
describe("the facts grid stops printing one thing twice", () => {
    const factOf = (label) => {
        const at = facts.indexOf(label);
        return at === -1 ? "" : facts.slice(at, facts.indexOf("</DetailFact>", at));
    };

    it("hangs the duration under the timestamp", () => {
        const measured = factOf("test.details.measured_at");

        assert.notEqual(measured, "", "the timestamp is gone");
        assert.match(measured, /test\.details\.seconds/);
        assert.match(measured, /detail-secondary/);
    });

    it("leaves the duration no row of its own", () => {
        assert.doesNotMatch(facts, /DetailFact label=\{t\("test\.details\.duration"\)}/);
    });

    it("keeps a test that never recorded one from printing an empty line", () => {
        assert.match(facts, /isMeasured\(test\.time\)/);
    });

    it("reads the provider and the address as one connection", () => {
        const connection = factOf("test.details.connection");

        assert.notEqual(connection, "", "there is no connection fact");
        assert.match(connection, /test\.isp/);
        assert.match(connection, /test\.externalIp/);
        assert.equal(typeof english.test.details.connection, "string");
    });

    it("leaves the address no row of its own", () => {
        assert.doesNotMatch(facts, /DetailFact label=\{t\("test\.details\.external_ip"\)}/);
    });

    // Either half may be absent - the two providers that are not Ookla report
    // one, the other or neither - and the fact has to survive that.
    it("draws whichever half the test actually carries", () => {
        const connection = factOf("test.details.connection");

        assert.match(connection, /\{test\.isp &&/);
        assert.match(connection, /\{test\.externalIp &&/);
    });

    // The marker says which of the two moved. One marker for the pair would
    // report a changed address as a changed provider.
    it("keeps a changed marker on each half", () => {
        const connection = factOf("test.details.connection");

        assert.match(connection, /change\?\.isp/);
        assert.match(connection, /change\?\.externalIp/);
    });
});

/**
 * The grade on the overview row.
 *
 * It is the figure that explains a call breaking up while something uploads,
 * and it was invisible without opening a row - which is where a reader is least
 * likely to look for it, since nothing in the collapsed row suggested there was
 * anything to find.
 */
describe("the overview row shows the bufferbloat", () => {
    const columnAt = row.indexOf("speedtest-bufferbloat");
    const column = row.slice(columnAt, row.indexOf("</div>", columnAt));

    it("finds the column to check", () => {
        assert.notEqual(columnAt, -1, "the row draws no bufferbloat at all");
    });

    it("sits between the ping and the download", () => {
        assert.ok(row.indexOf("info.ping.title") < columnAt);
        assert.ok(columnAt < row.indexOf("info.down.title"));
    });

    // The three columns beside it are a number and a unit; a bare letter would
    // be the one value in the list that is not a measurement.
    it("shows the added latency rather than the letter", () => {
        assert.match(column, /increase/);
        assert.match(column, /speedtest-unit/);
        assert.doesNotMatch(column, /speedtest-text">\{[^}]*grade}/,
            "the grade stands where the other three columns put a number");
    });

    // Colour is not a reading a screen reader can take, and the grade is the
    // half of this figure that is worth reading at a glance.
    it("carries the grade in the label, not only in the colour", () => {
        assert.match(column, /bufferbloatColour/);
        assert.match(column, /grade/);
    });

    /**
     * The wrapper is unconditional. Grid items are placed in order, so a column
     * that renders nothing at all lets the download slide into its track - and
     * the numbers stop lining up down the list, which is the whole point of the
     * grid.
     */
    it("holds its column open on a test that has no grade", () => {
        assert.match(row, /<div className="speedtest-row speedtest-bufferbloat">\s*\{[\w.]+ &&/,
            "the column itself is conditional, so the columns after it shift");
    });

    it("is handed the grade rather than computing it per row", () => {
        assert.match(area, /bufferbloat=\{bufferbloat\(test\)}/);
    });

    it("explains itself like the other three", () => {
        assert.match(column, /HelpButton/);
        assert.match(row, /bufferbloatInfo/);
        assert.equal(typeof english.info.bufferbloat?.title, "string");
        assert.equal(typeof english.info.bufferbloat?.description, "string");
    });
});

describe("the row's grid makes room for it", () => {
    const bodyOf = (selector) => css.match(new RegExp(`${selector}\\s*\\{([^}]*)}`))?.[1] ?? "";

    it("has a track for every column", () => {
        const columns = bodyOf("\\.speedtest").match(/grid-template-columns:([^;]*);/)?.[1] ?? "";

        // The date, then four measurements, then the chevron. Written out
        // rather than counted: the date's own track carries a fraction too, and
        // counting "1fr" reads it as a measurement.
        assert.match(columns, /minmax\([^)]*\)\s+1fr\s+1fr\s+1fr\s+1fr\s+auto/,
            `four metric tracks expected, got "${columns.trim()}"`);
    });

    // A failed test shows a sentence where the measurements would be, and the
    // span has to cover the track that was just added or it stops short.
    it("spans the failure across all of them", () => {
        assert.match(bodyOf("\\.speedtest-failure"), /grid-column:\s*2\s*\/\s*6/);
    });

    // Four large numbers plus a date need more width than three did, and the
    // answer the row already has for too little width is to stack.
    it("stacks earlier than it used to", () => {
        const stacked = [...css.matchAll(/@media \(max-width: (\d+)px\)\s*\{([\s\S]*?)\n}/g)]
            .find(([, , body]) => /flex-direction:\s*column/.test(body));

        assert.notEqual(stacked, undefined, "the row no longer stacks at any width");
        assert.ok(Number(stacked[1]) > 605,
            `still stacking only below ${stacked[1]}px, where four columns do not fit`);
    });
});
