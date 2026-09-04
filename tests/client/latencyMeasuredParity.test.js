import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {measuredPing} from "../../server/util/metricValue.js";
import {measuredLatency, getIconBySpeed, latencyIncrease} from "../../client/src/common/utils/TestUtil.js";
import {formatLatency, formatWhole, formatWithUnit, NOT_MEASURED} from "../../client/src/common/utils/FormatUtil.js";
import {readSource, withoutJsComments} from "../helpers/source.js";

/**
 * The client's reading of a latency nobody measured.
 *
 * A successful run whose latency block carried no average stores exactly 0 in
 * the NOT NULL ping column, and the server's readers were moved onto
 * measuredPing so that row draws a gap instead of a perfect score. The client
 * had only readableFigure, which passes 0 through as a real reading: the
 * result card printed "0 ms" in green, the detail sentence said the latency
 * was 0 ms, the node card graded it as the best line in the house. One
 * reader, mirrored from the server, sits in front of every place a single
 * row's ping reaches the screen.
 */
const FIXTURES = [0, "0", 0.0, 0.24, 12.4, "12.4", -1, "-1", null, undefined, NaN, "abc", "", true];

// The unmeasured sentinel, spelled once in each half. Pinned side by side so a
// change to one cannot go unnoticed by the other.
const UNMEASURED = 0;
const GOOD_LATENCY_LIMIT = 25;

describe("measuredLatency", () => {
    it("agrees with the server's measuredPing on every shape a row can carry", () => {
        for (const value of FIXTURES) {
            assert.deepEqual(measuredLatency(value), measuredPing(value), `the halves disagree on ${JSON.stringify(value)}`);
        }
    });

    it("reads the unmeasured sentinel as nothing, a real reading as itself", () => {
        assert.equal(measuredLatency(UNMEASURED), null);
        assert.equal(measuredLatency(12.4), 12.4);
        assert.equal(measuredLatency("12.4"), 12.4);
        assert.equal(measuredLatency(0.24), 0.24, "a tiny but real latency was thrown away");
    });

    it("turns the sentinel into a blue grade and an N/A figure, not 0 ms in green", () => {
        assert.equal(getIconBySpeed(formatLatency(measuredLatency(UNMEASURED)), GOOD_LATENCY_LIMIT, false), "blue");
        assert.equal(formatWithUnit(formatWhole(measuredLatency(UNMEASURED)), "ms"), NOT_MEASURED);
    });

    it("is the reader latencyIncrease already relied on", () => {
        assert.equal(latencyIncrease({ping: UNMEASURED, downloadLatency: 30}, "download"), null);
        const source = withoutJsComments(readSource("client/src/common/utils/TestUtil.js"));
        assert.match(source, /export function latencyIncrease\([^)]*\) \{[^}]*measuredLatency\(ping\)/,
            "latencyIncrease reads the ping without the shared reader");
    });
});

/**
 * Every place a single row's ping is printed or graded. A list, so a new
 * printer has to be added here to pass - and so a printer that reverts to the
 * raw column fails loudly.
 */
const PRINTERS = [
    {file: "client/src/pages/Home/components/TestArea/TestAreaComponent.jsx", raw: /\bping=\{test\.ping\}/, read: /ping=\{measuredLatency\(test\.ping\)\}/},
    {file: "client/src/pages/Home/components/TestArea/TestAreaComponent.jsx", raw: /formatLatency\(test\.ping\)/, read: /formatLatency\(measuredLatency\(test\.ping\)\)/},
    {file: "client/src/common/components/TestDetails/TestDetails.jsx", raw: /formatLatency\((test|earlier)\.ping\)/, read: /formatLatency\(measuredLatency\(test\.ping\)\)/},
    {file: "client/src/common/components/TestDetails/TestDetails.jsx", raw: /sentenceFigure: test\.ping\b/, read: /sentenceFigure: measuredLatency\(test\.ping\)/},
    {file: "client/src/pages/Statistics/charts/LatestTestChart/LatestTestChart.jsx", raw: /formatLatency\(props\.test\.ping\)/, read: /formatLatency\(measuredLatency\(props\.test\.ping\)\)/},
    {file: "client/src/pages/Statistics/charts/LatestTestChart/LatestTestChart.jsx", raw: /formatWhole\(props\.test\.ping\)/, read: /formatWhole\(measuredLatency\(props\.test\.ping\)\)/},
    {file: "client/src/pages/Nodes/components/NodeContainer/NodeContainer.jsx", raw: /formatLatency\(tests\[0\]\?\.ping\)/, read: /formatLatency\(measuredLatency\(tests\[0\]\?\.ping\)\)/},
    {file: "client/src/pages/Nodes/components/NodeContainer/NodeContainer.jsx", raw: /formatWhole\(tests\[0\]\?\.ping\)/, read: /formatWhole\(measuredLatency\(tests\[0\]\?\.ping\)\)/},
];

describe("a single row's ping reaches the screen", () => {
    for (const {file, raw, read} of PRINTERS) {
        it(`through measuredLatency in ${file.split("/").pop()} (${read.source})`, () => {
            const source = withoutJsComments(readSource(file));
            assert.doesNotMatch(source, raw, "the raw column is printed or graded");
            assert.match(source, read);
            assert.match(source, /import \{[^}]*\bmeasuredLatency\b[^}]*\} from "@\/common\/utils\/TestUtil"/,
                "measuredLatency is not imported");
        });
    }
});
