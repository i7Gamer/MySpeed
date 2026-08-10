import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as sass from "sass";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const CLIENT_SRC = path.join(ROOT, "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const PANE = "common/components/TestDetails/TestDetails.jsx";

const pane = read(PANE);
const speedtestRow = read("pages/Home/components/Speedtest/SpeedtestComponent.jsx");
const latestChart = read("pages/Statistics/charts/LatestTestChart/LatestTestChart.jsx");
const statistics = read("pages/Statistics/Statistics.jsx");
const model = fs.readFileSync(path.join(ROOT, "server", "models", "Speedtests.js"), "utf8");

/**
 * The detail pane used to live inside the overview's expandable row, so only
 * that page could show what a test actually recorded. The statistics opened the
 * same three summary rows the card already showed - clicking the card gained
 * the reader nothing at all.
 *
 * Both now render one component, against the stored row rather than against
 * either page's props, which is what keeps the two from drifting back apart.
 */
describe("the shared detail pane", () => {
    it("is what the overview row expands to", () => {
        assert.match(speedtestRow, /import TestDetails from "@\/common\/components\/TestDetails"/);
        assert.match(speedtestRow, /<TestDetails\s/);
    });

    it("is what the statistics open for the latest test", () => {
        assert.match(latestChart, /import TestDetails from "@\/common\/components\/TestDetails"/);
        assert.match(latestChart, /<TestDetails\s/);
    });

    // The row's own three columns stay in the row; the panel below them is the
    // one place either page describes a test in full.
    it("leaves neither page rendering a detail grid of its own", () => {
        for (const [name, source] of [["the overview row", speedtestRow], ["the latest chart", latestChart]])
            assert.doesNotMatch(source, /className="detail-(metrics|facts)"/, `${name} builds its own grid`);
    });

    // The delete button is the row's, not the pane's: the statistics show the
    // latest test as a reading, and nothing there deletes anything.
    it("still lets the overview row put its own actions inside the pane", () => {
        assert.match(speedtestRow, /<TestDetails[\s\S]*?detail-delete[\s\S]*?<\/TestDetails>/);
        assert.doesNotMatch(latestChart, /detail-delete/);
    });
});

/**
 * "Everything the test recorded" has to be checked against what a test *can*
 * record, or a column added to the model quietly never reaches the pane - which
 * is exactly how the loaded latencies spent a release invisible.
 */
describe("the pane shows every stored column", () => {
    // The model's own field names, taken from its definition rather than
    // restated here, so a new column shows up in this test the day it is added.
    const columns = [...model.matchAll(/^ {4}([a-zA-Z]+): \{/gm)].map(([, name]) => name);

    // `id` is the primary key: a row number is not a measurement, and nothing a
    // reader can do with it.
    const INTERNAL = ["id"];

    it("finds the model's columns to check", () => {
        assert.ok(columns.length > 10, `expected the model's columns, got ${columns.join(", ")}`);
        assert.ok(columns.includes("downloadLatency"), "the column scan missed downloadLatency");
    });

    for (const column of columns.filter((name) => !INTERNAL.includes(name))) {
        it(`reads ${column} off the test`, () => {
            assert.match(pane, new RegExp(`test\\.${column}\\b`), `${column} is stored but never shown`);
        });
    }

    it("shows the server's address and number beside its name rather than instead of it", () => {
        assert.match(pane, /serverName \? test\.serverHost : null/);
        assert.match(pane, /test\.serverId \? `#\$\{test\.serverId}` : null/);
    });
});

/**
 * Every "since last time" figure needs the test before the latest one, and the
 * connection marker needs the nearest earlier test that names a connection at
 * all - the row immediately before may name none. The statistics used to fetch
 * exactly one test, so the pane would have rendered without a single comparison.
 */
describe("the statistics fetch enough tests to compare against", () => {
    it("asks for more than the newest row", () => {
        const limit = statistics.match(/const RECENT_TESTS = (\d+)/);

        assert.notEqual(limit, null, "the statistics declare no recent-test count");
        assert.ok(Number(limit[1]) > 1, `RECENT_TESTS is ${limit[1]}, which leaves nothing to compare against`);
        assert.match(statistics, /\/speedtests\?limit=\$\{RECENT_TESTS}/);
    });

    it("passes the earlier test and the earlier connection to the pane", () => {
        assert.match(statistics, /previous=\{previousTest}/);
        assert.match(statistics, /previousConnection=\{latestConnection}/);
    });

    // Not simply recentTests[1]: that row may carry no identity, and comparing
    // against it reports "no change" across the very gap a change hides in.
    it("walks back for the earlier connection rather than taking the row before", () => {
        assert.match(statistics, /previousConnection\(recentTests, 0\)/);
    });
});

describe("the chart modal", () => {
    const aliasImporter = {
        findFileUrl(url) {
            if (!url.startsWith("@/")) return null;
            return pathToFileURL(path.join(CLIENT_SRC, url.slice(2)));
        }
    };

    const compiled = sass.compile(path.join(CLIENT_SRC, "common/components/ChartModal/styles.sass"),
        {importers: [aliasImporter]}).css;

    const ruleFor = (selector) =>
        compiled.match(new RegExp(`(?:^|})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)}`));

    /**
     * The dialog clips at 90vh with overflow hidden. Nothing it opened used to
     * be taller than that, so nothing scrolled - and the full record of a test
     * is comfortably taller on a laptop, which would have put the server, the
     * address and the link past the bottom edge with no way to reach them.
     */
    it("scrolls a panel taller than the dialog instead of clipping it", () => {
        const body = ruleFor(".chart-modal-body");

        assert.notEqual(body, null, "the modal body has no rule");
        assert.match(body[1], /overflow-y:\s*auto/);
        // Without this a flex item refuses to shrink below its content, so the
        // body grows past the dialog rather than scrolling inside it.
        assert.match(body[1], /min-height:\s*0/);
    });

    it("lays the dialog out as a column so the body can take what is left", () => {
        const content = ruleFor(".chart-modal-content");

        assert.match(content[1], /flex-direction:\s*column/);
    });

    it("never squeezes the toolbar to make room", () => {
        const toolbar = ruleFor(".chart-modal-toolbar");

        assert.match(toolbar[1], /flex-shrink:\s*0/);
    });
});
