import { readSource } from "../helpers/source.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { exportFilename } from "../../client/src/common/components/ExportButton/filename.js";

/**
 * All-time has to reach the export endpoint as a concrete range, because that
 * endpoint takes one - so it is sent as a window wide enough to contain
 * anything the server still keeps. Naming the file after that window produced
 * "myspeed-export-1999-03-26-to-2026-08-10.csv", which reads as a strangely
 * specific request rather than as "everything".
 */
describe("exportFilename", () => {
    it("names a bounded export after the range it covers", () => {
        assert.equal(exportFilename({from: "2026-07-01", to: "2026-07-15", format: "csv"}),
            "myspeed-export-2026-07-01-to-2026-07-15.csv");
    });

    it("says all time instead of the window that stands in for it", () => {
        assert.equal(exportFilename({allTime: true, from: "1999-03-26", to: "2026-08-10", format: "csv"}),
            "myspeed-export-all-time.csv");
    });

    it("keeps the format it was asked for", () => {
        assert.equal(exportFilename({allTime: true, format: "json"}), "myspeed-export-all-time.json");
        assert.equal(exportFilename({from: "2026-07-01", to: "2026-07-15", format: "json"}),
            "myspeed-export-2026-07-01-to-2026-07-15.json");
    });

    // The rows are one target's, and the name said nothing of it: the same
    // name for every target's rows and for one's.
    it("names the target the export is narrowed to", () => {
        assert.equal(exportFilename({allTime: true, format: "csv", target: 3}),
            "myspeed-export-target-3-all-time.csv");
        assert.equal(exportFilename({from: "2026-07-01", to: "2026-07-15", format: "json", target: 3}),
            "myspeed-export-target-3-2026-07-01-to-2026-07-15.json");
    });

    it("names no target when the export is of all of them", () => {
        assert.equal(exportFilename({allTime: true, format: "csv", target: null}), "myspeed-export-all-time.csv");
        assert.equal(exportFilename({allTime: true, format: "csv", target: undefined}), "myspeed-export-all-time.csv");
    });

    it("is handed the target the button narrows the request to", () => {
        const button = readSource(new URL("../../client/src/common/components/ExportButton/ExportButton.jsx", import.meta.url));

        assert.match(button, /exportFilename\(\{[^}]*\btarget\b[^}]*\}\)/,
            "the request is narrowed to a target the filename does not name");
    });

    // The name reaches a filesystem, so nothing in it may steer a path.
    it("never contains a path separator", () => {
        for (const name of [
            exportFilename({allTime: true, format: "csv"}),
            exportFilename({from: "2026-07-01", to: "2026-07-15", format: "csv"}),
            exportFilename({allTime: true, format: "csv", target: 3})
        ]) assert.doesNotMatch(name, /[/\\]/);
    });
});
