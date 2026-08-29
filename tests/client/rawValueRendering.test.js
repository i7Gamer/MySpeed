import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { escapeRegExp } from "../helpers/source.js";

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
 *   "-1%"              the overview's loss row, for a proxied node's placeholder
 *
 * The server is honest - it returns an explicit null for anything it could not
 * compute - and the interpolation is what turns that into something that reads
 * like a measurement. The formatters in FormatUtil say "N/A" instead -
 * formatWithUnit, formatPercent, FigureWithUnit for a unit in its own span -
 * so the rule is simply that neither a unit nor a % is ever glued to a bare
 * value.
 *
 * Four spellings of the gluing, each added because a live site wore it while
 * the patterns before it were blind: adjacent interpolations, the
 * value-then-unit-span form, the unit template, and the percent template.
 * The value half admits one level of nested braces, because t("key", {opts})
 * is how half the values here are spelt - deeper nesting stays out, and is
 * the first place to look if a new offender scans clean.
 *
 * Three named hatches, so nobody rediscovers them: a className carried in a
 * braced BINDING (FigureWithUnit's own span - a binding cannot be judged
 * textually, and a new one is a new private renderer, which the
 * FigureWithUnit suite exists to make unnecessary); a percent inside a
 * `style={{…}}` line, which is a CSS length, not a reading; and a percent
 * inside a SENTENCE - the backtick anchor keeps label templates with a
 * leading interpolation out of reach, so the pane's loss label prints its
 * stored column beside the chip the exemption below already names.
 */

const UNIT_CALLS = ["speedUnit", 't("latest.ping_unit")', 't("latest.jitter_unit")',
    't("latest.speed_unit")', 't("latest.byte_speed_unit")'];

const UNIT_ALTERNATIVES = UNIT_CALLS.map(escapeRegExp).join("|");

// A JSX/template expression, one nested brace level deep.
const VALUE = "(?:[^{}]|\\{[^{}]*\\})+";

const CSS_LENGTH_LINE = (line) => line.includes("style={{");

const PATTERNS = [
    {
        form: "interpolation",
        // `{something} {unit}` inside JSX, the exact shape that first broke.
        pattern: new RegExp(`\\{${VALUE}\\}\\s*\\{(?:${UNIT_ALTERNATIVES})\\}`, "g")
    },
    {
        form: "unit span",
        // `{something}<span className="...unit...">` - in any quote spelling,
        // the braced-literal one included; only a braced BINDING stays out.
        pattern: new RegExp(`\\{${VALUE}\\}\\s*<span[^>]*className=(?:["']|\\{")[^"']*unit`, "g")
    },
    {
        form: "template",
        // `${something} ${unit}` inside a template literal - the spelling
        // that printed the literal "null Mbps".
        pattern: new RegExp(`\\$\\{${VALUE}\\}\\s*\\$\\{(?:${UNIT_ALTERNATIVES})\\}`, "g")
    },
    {
        form: "percent",
        // A template that is exactly value-then-% - the spelling that printed
        // "-1%". Backtick-anchored both ends, so a sentence with a leading
        // interpolation does not match; style={{…}} lines are CSS lengths.
        pattern: new RegExp("`\\$\\{" + VALUE + "\\}%`", "g"),
        skip: CSS_LENGTH_LINE
    }
];

/**
 * The adjacencies that are not measurements, each named by the line it sits on
 * and the reason it is allowed there. An entry names one construct - the
 * honesty check below fails an entry that stops matching, and one whose
 * pattern covers a second flagged line is a file-wide skip in narrow clothes.
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
    }],
    ["pages/Home/components/Speedtest/SpeedtestComponent.jsx", {
        pattern: /`\$\{props\.packetLoss\}%`/,
        reason: "the loss chip prints its stored column raw by policy, behind a readableFigure gate that "
            + "overviewQuality.test.js executes across measured, text, placeholder and absent spellings"
    }],
    ["common/components/TestDetails/TestDetails.jsx", {
        pattern: /text: `\$\{test\.packetLoss\}%`/,
        reason: "the pane's loss chip, same stored-column-raw policy behind the same gate"
    }],
    ["pages/Statistics/charts/LatestTestChart/LatestTestChart.jsx", {
        pattern: /`\$\{props\.test\.packetLoss\}%`/,
        reason: "the card's loss row, same stored-column-raw policy behind the same gate"
    }],
    ["pages/Statistics/charts/OverviewChart/OverviewChart.jsx", {
        pattern: /`\$\{peak\.slowdown\}%`/,
        reason: "peakSlowdown computes the figure and the row is gated on it existing - no stored column involved"
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

const flaggedIn = ({text}) => {
    const lines = text.split("\n");

    return PATTERNS.flatMap(({form, pattern, skip}) => [...text.matchAll(pattern)].flatMap((match) => {
        const line = lineOf(text, match.index);
        const source = lines[line - 1].trim();

        return skip?.(source) ? [] : [{line, form, source}];
    }));
};

const offenders = files.flatMap(({file, text}) => {
    const allowed = ALLOWED.get(file);

    return flaggedIn({text})
        .filter(({source}) => !allowed?.pattern.test(source))
        .map((entry) => ({file, ...entry}));
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
     * a value guarded a line earlier is not an exemption - the guarded shapes
     * are formatWithUnit, formatPercent and FigureWithUnit, and code that
     * needs one belongs behind them.
     */
    it("always goes through a formatter, never straight into the markup", () => {
        const listed = offenders.map(({file, line, form, source}) =>
            `${file}:${line}  [${form}]  ${source}`).join("\n");

        assert.equal(offenders.length, 0,
            `a value is glued to its unit or its % - use formatWithUnit or formatPercent, or FigureWithUnit ` +
            `where the unit needs its own span: all say "N/A" when the value is absent, junk or negative ` +
            `rather than printing it as a reading (a SIGNED reading like the change row's difference renders ` +
            `its own sign instead):\n${listed}`);
    });

    // The scan is worthless if its own patterns stop matching what they hunt,
    // so each is checked against the shapes that actually shipped broken or
    // were proven to slip past an earlier pattern.
    it("still recognises the shapes it exists to catch", () => {
        const shipped = {
            interpolation: [
                "<p>{props.data.min} {speedUnit}</p>",
                '<h1>{nodeData.ping} {t("latest.ping_unit")}</h1>',
                '<p>{t("x", {count: n})} {speedUnit}</p>'
            ],
            "unit span": [
                '{pingValue}\n<span className="speedtest-unit">{t("latest.ping_unit")}</span>',
                '{value}<span className="detail-metric-unit">{unit}</span>',
                "{nodeData.ping}<span className='node-unit'>ms</span>",
                '{nodeData.ping}<span className={"node-unit"}>ms</span>',
                '{t("x", {count: n})}<span className="node-unit">ms</span>'
            ],
            template: [
                "`${wholeSpeed(mbps, preferences)} ${speedUnit}`",
                '`${formatWhole(props.test.ping)} ${t("latest.ping_unit")}`'
            ],
            percent: [
                "`${packetLoss}%`",
                "`${props.packetLoss}%`"
            ]
        };

        for (const {form, pattern} of PATTERNS)
            for (const shape of shipped[form])
                assert.ok(new RegExp(pattern.source).test(shape),
                    `the ${form} pattern no longer recognises the shape that shipped broken:\n${shape}`);
    });

    it("does not object to the formatted forms or the named hatches", () => {
        const fixed = [
            "<p>{formatWithUnit(props.data.min, speedUnit)}</p>",
            "<span>{speedUnit}</span>",
            "value: formatPercent(packetLoss),",
            '<FigureWithUnit value={pingValue} unit={speedUnit} unitClass="speedtest-unit"/>',
            // The component's own span: the class is a braced BINDING, which
            // no textual pattern can judge - the named hatch.
            "<>{value}<span className={unitClass}>{unit}</span></>",
            // A sentence with a leading interpolation is not a bare percent.
            '`${t("test.details.packet_loss")} ${test.packetLoss}%`'
        ];

        for (const shape of fixed)
            for (const {form, pattern} of PATTERNS)
                assert.equal(new RegExp(pattern.source).test(shape), false,
                    `the ${form} pattern reports the fixed form:\n${shape}`);

        // The CSS-length hatch is a line skip, not a pattern gap: the percent
        // pattern sees the shape and the skip names why it is no reading.
        const width = 'style={{width: `${Math.min(percent, MAX_BAR_PERCENT)}%`}}';
        assert.ok(new RegExp(PATTERNS.find(({form}) => form === "percent").pattern.source).test(width));
        assert.ok(CSS_LENGTH_LINE(width), "a CSS bar width is reported as a reading again");
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

            const flagged = flaggedIn(source).map(({source: line}) => line);

            // Exactly one, the -1 budget's rule: an entry names one
            // construct, and a pattern covering a second flagged line is a
            // file-wide skip wearing a narrow entry's clothes.
            assert.equal(flagged.filter((line) => pattern.test(line)).length, 1,
                `${file}'s exemption covers ${flagged.filter((line) => pattern.test(line)).length} flagged lines ` +
                "where one construct was granted - drop the entry or narrow the pattern");
        }
    });
});
