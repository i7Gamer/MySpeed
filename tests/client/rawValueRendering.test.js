import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escapeRegExp, walkSources } from "../helpers/source.js";

const CLIENT_SRC = "client/src";

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
 * Six spellings of the gluing. Four shipped on a live site while the patterns
 * before them were blind: adjacent interpolations, the value-then-unit-span
 * form, the unit template, and the percent template. Two more were probe
 * shapes that walked clean past those four - a percent glued in JSX text
 * (`{props.packetLoss}%`) and one glued by concatenation, in any quote the
 * backtick included. The percent template is unanchored: the anchored form
 * saw only a template that was EXACTLY value-then-%, so a percent later in
 * a longer sentence - one shipped, gated only by its own ternary - and a
 * spaced one walked past it. The one label template the anchor used to
 * excuse now reads its chip's hoisted glue site - a fixed form, not an
 * exemption. The value half admits one level of
 * nested braces, because t("key", {opts}) is how half the values here are
 * spelt - deeper nesting stays out, and is the first place to look if a new
 * offender scans clean.
 *
 * The walk covers .jsx and .js alike: a chart helper or a context is as able
 * to glue a percent as a component, and the .js half being unwalked was an
 * unnamed hatch.
 *
 * Two named hatches, so nobody rediscovers them: a className carried in a
 * braced BINDING (FigureWithUnit's own span - a binding cannot be judged
 * textually, and a new one is a new private renderer, which the
 * FigureWithUnit suite exists to make unnecessary); and a percent inside a
 * `style={{…}}` line, which is a CSS length, not a reading - the template
 * and concat forms share that skip, and the JSX-text form needs none
 * because it structurally cannot match a template's percent.
 */

const UNIT_CALLS = ["speedUnit", 't("latest.ping_unit")', 't("latest.jitter_unit")',
    't("latest.speed_unit")', 't("latest.byte_speed_unit")'];

const UNIT_ALTERNATIVES = UNIT_CALLS.map(escapeRegExp).join("|");

// A JSX/template expression, one nested brace level deep - and one LINE
// deep: every match is attributed, skipped and exempted against the line it
// STARTS on, so a match that could span lines would be judged against a
// line holding neither the % nor the construct. The cross-line CLASS is not
// given up for that: the spanning detector below owns the wrapped-VALUE
// half - a prettier-wrapped ternary glued to its unit is the shipped bug in
// its most idiomatic modern spelling - and the \s* connectors keep a
// percent split from its value in the one-line forms' own reach.
const VALUE = "(?:[^{}\\n]|\\{[^{}\\n]*\\})+";

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
        // A value-then-% anywhere in a template - the spelling that printed
        // "-1%". Unanchored, because the anchored form saw only a template
        // that was EXACTLY value-then-%: a percent later in a longer
        // sentence, or spaced the way some locales want, walked past it.
        // The chip values that glue a stored column by policy are named
        // exemptions below - the one label the anchor excused reads its
        // chip's glue site now; style={{…}} lines are CSS lengths.
        // \s*, not \s?: on this CRLF tree a percent on the next line sits
        // behind TWO whitespace characters, and one optional \s let exactly
        // that spelling walk out of both this form and its spanning twin.
        pattern: new RegExp("\\$\\{" + VALUE + "\\}\\s*%", "g"),
        skip: CSS_LENGTH_LINE
    },
    {
        form: "percent (jsx)",
        // The same gluing in JSX text - `{props.packetLoss}%` - which has no
        // backtick for the pattern above to anchor on. The lookbehind keeps
        // template interpolations out: those are the previous pattern's. The
        // connector is \s*, like the template form's: `{props.packetLoss} %`
        // and the value with its % on the NEXT line both render the glued
        // reading (JSX strips a text node's leading newline), and both
        // walked past an exact `}%`. No CSS skip here: a style value in
        // braces is template- or concat-spelled, so a JSX-text percent on a
        // style line is a reading that happens to share the line.
        pattern: new RegExp(`(?<!\\$)\\{${VALUE}\\}\\s*%`, "g")
    },
    {
        form: "percent (concat)",
        // And the spelling with no braces at all: a value concatenated with
        // its percent sign, in any quote including the backtick - the
        // backreference keeps mismatched quotes from reading as the shape.
        pattern: /\+\s*(["'`])%\1/g,
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
    ["common/utils/FormatUtil.js", {
        pattern: /return figure === null \? NOT_MEASURED : `\$\{figure\}%`;/,
        reason: "the formatter the whole rule points at: formatPercent's own body is where the % is finally glued, "
            + "behind the refusal the rule exists to route values through"
    }],
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
        pattern: /const lossText = `\$\{test\.packetLoss\}%`;/,
        reason: "the pane's loss chip and its label share one glue site, same stored-column-raw policy behind "
            + "the same gate - one construct, which is all a file can be granted"
    }],
    ["common/components/IntegrationDialog/templateVariables.js", {
        pattern: /`%\$\{name\}%`/,
        reason: "not a percentage: the token's % signs are the delimiters the server substitutes on - "
            + "%ping% is a name, not a reading"
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

// The shared walk - .js as well as .jsx is its default, because a chart
// helper glues a percent as readily as a component - and the RAW source: the
// scan reads comments and strings deliberately (see the docblock below).
const files = walkSources(CLIENT_SRC).map(({path, source}) => ({
    file: path.slice(CLIENT_SRC.length + 1),
    text: source
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

/**
 * The same forms with the value free to span lines. Not used to REPORT
 * offenders - a spanning match's construct straddles lines - but to DETECT
 * them: any gluing these see that the one-line forms do not is a gluing
 * whose VALUE was written across lines. The CSS skip transfers to the
 * OPENING line, where the style marker actually sits, so a wrapped bar
 * width is not a forced reflow. An ALLOWED grant deliberately does NOT
 * transfer: an exemption's pattern names the whole construct, which no
 * single line of a wrap can carry - so granting by opening line was
 * unreachable for real grants and only ever excused offenders that wrapped
 * onto a granted line. A granted construct that must wrap is a new review,
 * not an inherited grant. The stated bound stays the value half's nesting:
 * braces two deep are out of both pattern sets alike.
 */
const SPANNING_PATTERNS = PATTERNS.map(({form, pattern}) => ({
    form,
    pattern: new RegExp(pattern.source.replaceAll("[^{}\\n]", "[^{}]"), "g")
}));

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
                "`${props.packetLoss}%`",
                // The two shapes the anchored form walked past: a percent
                // inside a longer sentence, and one spaced off its value.
                "`${props.tests.failed} (${rate}%)`",
                "`${rate} %`"
            ],
            "percent (jsx)": [
                '<span className="loss">{props.packetLoss}%</span>',
                "<p>{readableLoss}%</p>",
                '<span>{t("x", {count: n})}%</span>',
                // The spaced and the line-split spellings render the same
                // glued reading - JSX strips a text node's leading newline.
                '<span className="loss">{props.packetLoss} %</span>',
                "<span>{props.packetLoss}\n%</span>"
            ],
            "percent (concat)": [
                '{props.packetLoss + "%"}',
                "score + '%'",
                'text: loss + "%"',
                "text: loss + `%`"
            ]
        };

        // Driven off the shapes, not off PATTERNS: a pattern deleted from the
        // list must fail here as "gone", not leave its shapes silently
        // unwatched while the loop walks the patterns that remain.
        for (const [form, shapes] of Object.entries(shipped)) {
            const entry = PATTERNS.find((candidate) => candidate.form === form);
            assert.ok(entry, `the ${form} pattern is gone, and the shapes it caught are unwatched`);

            for (const shape of shapes)
                assert.ok(new RegExp(entry.pattern.source).test(shape),
                    `the ${form} pattern no longer recognises the shape that shipped broken:\n${shape}`);
        }

        assert.equal(Object.keys(shipped).length, PATTERNS.length,
            "a pattern has no shipped shapes pinned, so nothing notices when it stops matching them");
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
            // The pane's label reads the hoisted glue site rather than
            // gluing a second time - the fixed form of the sentence shape.
            '`${t("test.details.packet_loss")} ${lossText}`',
            // A modulo is arithmetic, not a glued percent sign.
            "const remainder = (value + offset) % steps;"
        ];

        for (const shape of fixed)
            for (const {form, pattern} of PATTERNS)
                assert.equal(new RegExp(pattern.source).test(shape), false,
                    `the ${form} pattern reports the fixed form:\n${shape}`);

        // The CSS-length hatch is a line skip, not a pattern gap: the percent
        // pattern sees the shape and the skip names why it is no reading. The
        // JSX spelling structurally cannot match a template's `${x}%` - the
        // nested-brace arm consumes the closer - which is why it needs no
        // skip of its own.
        const width = 'style={{width: `${Math.min(percent, MAX_BAR_PERCENT)}%`}}';
        assert.ok(new RegExp(PATTERNS.find(({form}) => form === "percent").pattern.source).test(width));
        assert.equal(new RegExp(PATTERNS.find(({form}) => form === "percent (jsx)").pattern.source).test(width), false,
            "the JSX percent form has started matching template interpolations, which are the percent pattern's");
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

            // MATCH count, not distinct lines: the scan itself exempts by
            // line text, so a second construct grown onto a granted line is
            // invisible everywhere but here - this count is the only net
            // under a granted line. (A single construct tripping two
            // patterns would double-count; none of the nine does, and the
            // day one legitimately must, this widens deliberately.)
            const flagged = flaggedIn(source).map(({source: line}) => line);

            // Exactly one, the -1 budget's rule: an entry names one
            // construct, and a pattern covering a second flagged match is a
            // file-wide skip wearing a narrow entry's clothes.
            assert.equal(flagged.filter((line) => pattern.test(line)).length, 1,
                `${file}'s exemption covers ${flagged.filter((line) => pattern.test(line)).length} flagged ` +
                "matches where one construct was granted - drop the entry or narrow the pattern");
        }
    });

    /**
     * And nothing glues across lines at all: the one-line VALUE keeps
     * attribution honest, and this is what keeps it from being a blind
     * spot. Any gluing the spanning forms see that the one-line forms do
     * not was written across lines - and there is no legitimate one: split
     * it onto one line or route it through a formatter.
     */
    it("lets no gluing span lines", () => {
        for (const {file, text} of files) {
            const lines = text.split("\n");

            for (const [at, {form, pattern, skip}] of PATTERNS.entries()) {
                const singleAt = new Set([...text.matchAll(pattern)].map(({index}) => index));
                const spanning = [...text.matchAll(SPANNING_PATTERNS[at].pattern)]
                    .filter(({index}) => !singleAt.has(index))
                    .find(({index}) => !skip?.(lines[lineOf(text, index) - 1].trim()));

                assert.equal(spanning, undefined,
                    `${file} glues a value to its ${form} target across lines, starting at line `
                    + `${spanning && lineOf(text, spanning.index)} - split it onto one line or route it `
                    + "through a formatter");
            }
        }
    });

    // The spanning detector's own recognition: the wrapped percent the
    // one-line patterns cannot see must be exactly what the spanning forms
    // still catch.
    it("recognises a gluing written across lines", () => {
        const wrapped = "`${\n  value\n}%`";
        const percentAt = PATTERNS.findIndex(({form}) => form === "percent");

        assert.ok(new RegExp(SPANNING_PATTERNS[percentAt].pattern.source).test(wrapped),
            "the spanning percent form no longer sees a value wrapped across lines");
        assert.equal(new RegExp(PATTERNS[percentAt].pattern.source).test(wrapped), false,
            "the one-line form matches a spanning value, so the detector cannot tell the two apart");
    });
});
