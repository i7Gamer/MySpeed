import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

const source = readSource("client/src/pages/Statistics/Statistics.jsx");

/**
 * RequestUtil aims every request at the stored node selection at request time,
 * so the statistics page needs no plumbing to *reach* the right node - what it
 * needs is to notice the selection changing under it. That is reachable
 * without leaving the page: NodeContext's reconciliation drops a node deleted
 * from another browser, and the charts then kept showing the dropped node's
 * figures under the new node's header until the next range change happened to
 * re-ask.
 */
describe("statistics and the active node", () => {
    it("subscribes to the selection by position, the way SpeedtestContext does", () => {
        assert.match(source, /const \[, , currentNode\] = useContext\(NodeContext\)/,
            "the page no longer knows which node it is showing");
    });

    it("re-fetches when the selection changes", () => {
        assert.match(source, /\}, \[dateRange, currentNode\]\);/,
            "updateStats no longer re-runs when the active node changes");
    });
});
