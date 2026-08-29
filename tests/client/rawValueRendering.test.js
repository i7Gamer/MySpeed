import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

/**
 * Gluing a value to its unit in the markup is the shape behind every one of
 * these, all found by eye rather than by any test:
 *
 *   "nulls"            the average duration, when nothing in the range succeeded
 *   " Mbps"            the min/max/avg tiles, same range
 *   "100% / ±0"        connection stability, scored from no measurements at all
 *   "-1 ms"            a node card, printing a failed test's placeholders
 *   "12 /  ms latency" the loaded latency, with one direction unmeasured
 *   "null Mbps"        the latest-test card, for a legacy row's absent column
 *
 * The server is honest - it returns an explicit null for anything it could not
 * compute - and the interpolation is what turns that into something that reads
 * like a measurement. The formatters in FormatUtil say "N/A" instead, and
 * FigureWithUnit is the same judgement for a value whose unit needs its own
 * span - so the rule is simply that a unit is never glued to a bare value.
 *
 * Three spellings of the gluing, because the first pattern alone missed five
 * live sites: the adjacent-interpolation form it was written for, the
 * value-then-unit-span form the Home row and the detail cards shipped, and
 * the template form the latest-test card shipped.
 */

const UNIT_CALLS = ["speedUnit", 't("latest.ping_unit")', 't("latest.jitter_unit")',
    't("latest.speed_unit")', 't("latest.byte_speed_unit")'];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const UNIT_ALTERNATIVES = UNIT_CALLS.map(escapeRegExp).join("|");

const PATTERNS = [
    {
        form: "interpolation",
        // `{something} {unit}` inside JSX, the exact shape that first broke.
        pattern: new RegExp(`\\{[^{}]+\\}\\s*\\{(?:${UNIT_ALTERNATIVES})\\}`, "g")
    },
    {
        form: "unit span",
        // `{something}<span className="...unit...">` - the two-line spelling
        // the first pattern never saw. FigureWithUnit's own span carries its
        // class in braces, not quotes, which is what keeps the one legitimate
        // adjacency out of this pattern's sight.
        pattern: /\{[^{}]+\}\s*<span[^>]*className="[^"]*unit/g
    },
    {
        form: "template",
        // `${something} ${unit}` inside a template literal - the spelling
        // that printed the literal "null Mbps".
        pattern: new RegExp(`\\$\\{[^{}]+\\}\\s*\\$\\{(?:${UNIT_ALTERNATIVES})\\}`, "g")
    }
];

/**
 * The adjacencies that are not measurements, each named by the line it sits on
 * and the reason it is allowed there. An entry names one construct - the
 * honesty check below fails an entry that stops matching, and one that
 * matches a line no pattern flags exempts nothing.
 */
const ALLOWED = new Map([
    ["common/components/TargetsDialog/TargetEditor.jsx", {
        pattern: /\{label\} <span className="target-optimal-unit">/,
        reason: "a form field's caption beside the unit the field is asked in - a label, not a measurement"
    }],
    ["pages/Statistics/charts/HourlyChart.jsx", {
        pattern: /\$\{item\.formattedValue\} \$\{speedUnit\}/,
        reason: "a Chart.js tooltip over the library's own formattedValue - no absent case reaches it"
    }],
    ["pages/Statistics/charts/ConsistencyChart/ConsistencyChart.jsx", {
        pattern: /±<\$\{LATENCY_STEP\} \$\{t\("latest\.ping_unit"\)\}/,
        reason: "a module constant stating the display floor, not a stored figure"
    }]
]);

const sourcesIn = (directory) => fs.readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourcesIn(full);

    return entry.name.endsWith(".jsx") ? [full] : [];
});

const files = sourcesIn(CLIENT_SRC).map((file) => ({
    file: path.relative(CLIENT_SRC, file).replaceAll(path.sep, "/"),
    text: fs.readFileSync(file, "utf8")
}));

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

const offenders = files.flatMap(({file, text}) => {
    const lines = text.split("\n");
    const allowed = ALLOWED.get(file);

    return PATTERNS.flatMap(({form, pattern}) => [...text.matchAll(pattern)].flatMap((match) => {
        const line = lineOf(text, match.index);
        const source = lines[line - 1].trim();

        return allowed?.pattern.test(source) ? [] : [{file, line, form, source}];
    }));
});

describe("rendering a measurement next to its unit", () => {
    it("finds sources to check", () => {
        assert.ok(files.length > 10, "the component scan found almost nothing - has the path moved?");
    });

    /**
     * Deliberately a source scan: this cannot be caught by rendering, because
     * every one of these bugs rendered perfectly - it simply rendered a value
     * that was never measured. The scan reads raw source, so a comment or a
     * string carrying the shape would be reported too; that is accepted, and
     * a value guarded a line earlier is not an exemption - the guarded shape
     * is FigureWithUnit, and code that needs one belongs behind it.
     */
    it("always goes through a formatter, never straight into the markup", () => {
        const listed = offenders.map(({file, line, form, source}) =>
            `${file}:${line}  [${form}]  ${source}`).join("\n");

        assert.equal(offenders.length, 0,
            `a value is glued to its unit - use formatWithUnit, or FigureWithUnit where the unit needs its own ` +
            `span: both say "N/A" when the value is absent, junk or negative rather than printing it as a reading ` +
            `(a SIGNED reading like the change row's difference renders its own sign instead):\n${listed}`);
    });

    // The scan is worthless if its own patterns stop matching what they hunt,
    // so each is checked against the shape that actually shipped broken.
    it("still recognises the shapes it exists to catch", () => {
        const shipped = {
            interpolation: [
                "<p>{props.data.min} {speedUnit}</p>",
                '<h1>{nodeData.ping} {t("latest.ping_unit")}</h1>'
            ],
            "unit span": [
                '{pingValue}\n<span className="speedtest-unit">{t("latest.ping_unit")}</span>',
                '{value}<span className="detail-metric-unit">{unit}</span>'
            ],
            template: [
                "`${wholeSpeed(mbps, preferences)} ${speedUnit}`",
                '`${formatWhole(props.test.ping)} ${t("latest.ping_unit")}`'
            ]
        };

        for (const {form, pattern} of PATTERNS)
            for (const shape of shipped[form])
                assert.ok(new RegExp(pattern.source).test(shape),
                    `the ${form} pattern no longer recognises the shape that shipped broken:\n${shape}`);
    });

    it("does not object to the formatted forms", () => {
        const fixed = [
            "<p>{formatWithUnit(props.data.min, speedUnit)}</p>",
            "<span>{speedUnit}</span>",
            '<FigureWithUnit value={pingValue} unit={speedUnit} unitClass="speedtest-unit"/>',
            // The component's own span: the class is in braces, so the
            // unit-span pattern cannot see the one legitimate adjacency.
            "<>{value}<span className={unitClass}>{unit}</span></>"
        ];

        for (const shape of fixed)
            for (const {form, pattern} of PATTERNS)
                assert.equal(new RegExp(pattern.source).test(shape), false,
                    `the ${form} pattern reports the fixed form:\n${shape}`);
    });

    /**
     * An exemption that no longer covers a flagged line has stopped meaning
     * anything - either the construct moved, and the entry silently exempts
     * whatever lands on a matching line next, or it was fixed and the entry
     * is dead weight.
     */
    it("keeps the allowed list honest", () => {
        for (const [file, {pattern}] of ALLOWED) {
            const source = files.find((entry) => entry.file === file);
            assert.ok(source, `${file} is no longer in the tree; drop it from ALLOWED`);

            const flagged = PATTERNS.flatMap(({pattern: shape}) =>
                [...source.text.matchAll(shape)].map((match) =>
                    source.text.split("\n")[lineOf(source.text, match.index) - 1]));

            assert.ok(flagged.some((line) => pattern.test(line)),
                `${file} carries no flagged line the exemption covers; drop the entry so the list stays a list ` +
                "of facts");
        }
    });
});
