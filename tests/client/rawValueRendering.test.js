import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

/**
 * Interpolating a value straight next to its unit - `{value} {unit}` - is the
 * shape behind every one of these, all found by eye rather than by any test:
 *
 *   "nulls"            the average duration, when nothing in the range succeeded
 *   " Mbps"            the min/max/avg tiles, same range
 *   "100% / ±0"        connection stability, scored from no measurements at all
 *   "-1 ms"            a node card, printing a failed test's placeholders
 *   "12 /  ms latency" the loaded latency, with one direction unmeasured
 *
 * The server is honest - it returns an explicit null for anything it could not
 * compute - and the interpolation is what turns that into something that reads
 * like a measurement. The formatters in FormatUtil say "N/A" instead, so the
 * rule is simply that a unit is never glued to a bare value.
 */

const UNIT_CALLS = ["speedUnit", 't("latest.ping_unit")', 't("latest.jitter_unit")',
    't("latest.speed_unit")', 't("latest.byte_speed_unit")'];

// `{something} {unit}` inside JSX, which is the exact shape that broke.
const RAW_INTERPOLATION = new RegExp(
    "\\{[^{}]+\\}\\s*\\{(" + UNIT_CALLS.map(unit => unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\}"
);

const sourcesIn = (directory) => fs.readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourcesIn(full);

    return entry.name.endsWith(".jsx") ? [full] : [];
});

const offenders = sourcesIn(CLIENT_SRC).flatMap((file) =>
    fs.readFileSync(file, "utf8").split("\n")
        .map((line, index) => ({file: path.relative(CLIENT_SRC, file), line: index + 1, text: line.trim()}))
        .filter((entry) => RAW_INTERPOLATION.test(entry.text)));

describe("rendering a measurement next to its unit", () => {
    it("finds sources to check", () => {
        assert.ok(sourcesIn(CLIENT_SRC).length > 10, "the component scan found almost nothing - has the path moved?");
    });

    /**
     * Deliberately a source scan: this cannot be caught by rendering, because
     * every one of these bugs rendered perfectly - it simply rendered a value
     * that was never measured. If a case ever genuinely needs the raw form, the
     * fix is to leave it out of UNIT_CALLS rather than to weaken this.
     */
    it("always goes through a formatter, never straight into the markup", () => {
        const listed = offenders.map((entry) => `${entry.file}:${entry.line}  ${entry.text}`).join("\n");

        assert.equal(offenders.length, 0,
            `a value is interpolated next to its unit - use formatWithUnit, which says "N/A" ` +
            `when the value is absent rather than leaving a bare unit:\n${listed}`);
    });

    // The scan is worthless if its own pattern stops matching the thing it
    // hunts, so it is checked against the shape that actually shipped broken.
    it("still recognises the shape it exists to catch", () => {
        assert.match("<p>{props.data.min} {speedUnit}</p>", RAW_INTERPOLATION);
        assert.match('<h1>{nodeData.ping} {t("latest.ping_unit")}</h1>', RAW_INTERPOLATION);
    });

    it("does not object to a formatted value", () => {
        assert.doesNotMatch("<p>{formatWithUnit(props.data.min, speedUnit)}</p>", RAW_INTERPOLATION);
        assert.doesNotMatch("<span>{speedUnit}</span>", RAW_INTERPOLATION);
    });
});
