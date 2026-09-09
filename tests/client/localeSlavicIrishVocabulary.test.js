import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {readLocale} from "../helpers/source.js";
import {flatten} from "../../scripts/localeGaps.js";

describe("Slavic and Irish measurement terminology", () => {
    it("keeps Russian upload distinct from downloading across metric views", () => {
        const russian = flatten(readLocale("ru"));
        const uploadKeys = [
            "latest.up", "statistics.targets.chart.upload",
            "notification.upload", "notification.metric_upload"
        ];

        for (const key of uploadKeys) {
            assert.match(russian[key], /отдач/i, `${key} must name outgoing data`);
            assert.doesNotMatch(russian[key], /загруз/i, `${key} must not name downloading`);
        }
    });

    it("describes the Irish baseline as a median rather than a mean", () => {
        const irish = readLocale("ga");
        assert.match(irish.targets.baseline_desc, /airmheán/i);
        assert.match(irish.statistics.values.median, /airmheán/i);
    });
});
