import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as sass from "sass";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mediaBlocks } from "../helpers/sass.mjs";

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

    // The columns loop above already proves the pane reads every server
    // column; HOW the two server lines divide them - the fallback chain, the
    // dedupe, the host no longer gated on the name - is executed against
    // fixture rows in detailServerLine.test.js rather than pinned as source
    // text here, so a refactor of the expression answers to its behaviour in
    // one place instead of its spelling in two.
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

/**
 * Ping, jitter and packet loss are three readings of one thing - what the line
 * does before anything is asked of it - and the pane split them across a metric
 * card and two rows of a grid where a row costs a full line. Jitter was drawn
 * twice over on the overview besides: beside the ping in the row, and again as a
 * fact once the row was opened.
 *
 * Packet loss joins the ping rather than the two throughput cards because Ookla
 * reports one figure for the connection and neither other provider reports any -
 * printed under download and upload it would claim two measurements from one.
 */
describe("the connection's quality figures sit on the ping card", () => {
    // Either side of the facts grid, so "moved onto the card" is asserted as
    // something stronger than "mentioned somewhere in the file".
    const factsAt = pane.indexOf('className="detail-facts"');
    const beforeFacts = pane.slice(0, factsAt);
    const facts = pane.slice(factsAt);

    const metricsBlock = pane.match(/const metrics = \[([\s\S]*?)\n {4}];/)?.[1] ?? "";
    const metricSource = (key) => metricsBlock.split(/key: "/).slice(1)
        .find((part) => part.startsWith(`${key}"`)) ?? "";

    it("finds the metric cards to check", () => {
        assert.notEqual(factsAt, -1, "the pane no longer renders a facts grid");
        for (const key of ["ping", "download", "upload"])
            assert.notEqual(metricSource(key), "", `the ${key} metric is gone`);
    });

    it("gives jitter no row of its own", () => {
        assert.doesNotMatch(facts, /DetailFact label=\{t\("latest\.jitter"\)}/,
            "jitter still costs a row of the facts grid");
    });

    it("gives packet loss no row of its own", () => {
        assert.doesNotMatch(facts, /DetailFact label=\{t\("test\.details\.packet_loss"\)}/,
            "packet loss still costs a row of the facts grid");
    });

    it("hangs both on the ping card", () => {
        assert.match(metricSource("ping"), /sub:/, "the ping card takes no secondary figures");
        assert.match(beforeFacts, /test\.jitter/, "jitter never reaches the metric cards");
        assert.match(beforeFacts, /test\.packetLoss/, "packet loss never reaches the metric cards");
    });

    // The half that matters most: one figure shown under both directions would
    // read as two, and neither direction measured it.
    it("claims no packet loss for either direction", () => {
        for (const key of ["download", "upload"])
            assert.doesNotMatch(metricSource(key), /packetLoss/,
                `the ${key} card claims a packet loss of its own`);
    });

    // Zero loss is the best reading there is and the one most often seen, so a
    // truthiness check would hide exactly the result worth showing.
    it("treats a measured zero as a measurement", () => {
        assert.match(beforeFacts, /isMeasured\(test\.packetLoss\)/);
        assert.match(beforeFacts, /isMeasured\(test\.jitter\)/);
    });

    // The same icons the rest of the app draws these with - the wave beside the
    // ping on the overview row, the broken link on both packet loss cards.
    it("draws them the way every other card does", () => {
        assert.match(beforeFacts, /faWaveSquare/, "jitter is drawn with a different icon here");
        assert.match(beforeFacts, /faLinkSlash/, "packet loss is drawn with a different icon here");
        // Graded with the same functions the consistency panel and the
        // latest-test card use, so one figure cannot change colour between two
        // views of the same test.
        assert.match(beforeFacts, /packetLossColour\(test\.packetLoss\)/,
            "packet loss is not graded, so a lossy line reads the same as a clean one");
        assert.match(beforeFacts, /jitterColour\(formatLatency\(test\.jitter\)\)/,
            "jitter sits ungraded beside a graded packet loss");
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

    const escape = (selector) => selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const ruleFor = (selector) =>
        compiled.match(new RegExp(`(?:^|})\\s*${escape(selector)}\\s*\\{([^}]*)}`));

    // The body of every rule whose selector list mentions the given one, rather
    // than of the first that does. A property can legitimately be declared in
    // any of them - the tiers restate max-width in three separate queries - so
    // reading only the first match starts reading the wrong rule the moment
    // another is added beside it.
    const bodiesFor = (selector) => [...compiled.matchAll(
        new RegExp(`${escape(selector)}[^{}]*\\{([^}]*)}`, "g"))].map(([, body]) => body);

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

    /**
     * The dialog is shrink-to-fit, which a panel made of responsive grids cannot
     * survive: with no width to fit into, every `auto-fit` track collapses to one
     * column, and the dialog then sizes itself to that narrow result. It fed back
     * on itself - the latest test's whole record stood in a single 400px column,
     * the same at 1280px and at 2560px, pinned to the dialog's own min-width.
     */
    it("gives a grid panel a width to lay out in, not just charts", () => {
        const bodies = bodiesFor(".chart-modal-content.modal-wide");

        assert.ok(bodies.length > 0, "no .modal-wide rule, so the dialog still shrinks to fit");
        // Anchored, or `max-width` satisfies it and the panel goes back to
        // shrinking to fit with a ceiling it never reaches.
        assert.ok(bodies.some((body) => /(^|;)\s*width:\s*min\(/.test(body)),
            ".modal-wide sets no definite width");
    });

    /**
     * Eight rows in one column made the opened overview taller than most
     * screens, each row being a single line. Two columns halve it - but only
     * where two of them fit as they read. Bought below that, the second column
     * is paid for by wrapping every description and breaking "11 ms" across two
     * lines, which is worse than the tall column it replaced.
     */
    describe("the opened overview's two columns", () => {
        const TWO_COLUMNS = /grid-template-columns:\s*repeat\(2,/;

        // What the widest row of the enlarged overview measures, on the line it
        // reads on: the icon, the two gaps, "Average latency, between 4.8 ms and
        // 21 ms", and "10.6 ms" with its delta beside it. English; German wants
        // 601 for the same row and is the only other language whose overview
        // strings are translated at all.
        const WIDEST_ROW = 534;
        const WIDEST_ROW_TRANSLATED = 601;

        it("is one column before any width is known", () => {
            const base = compiled.match(/\.chart-modal-body \.overview-items \{([^}]*)}/);

            assert.notEqual(base, null, "the modal no longer lays the overview out");
            assert.match(base[1], /display:\s*grid/);
            assert.doesNotMatch(base[1], TWO_COLUMNS, "the second column is not gated on width at all");
        });

        /**
         * And a column is as wide as its longest row reads, not as wide as a
         * figure picked before those rows had descriptions.
         *
         * The cap was 32rem, and on a shrink-to-fit dialog a cap is also the
         * width the dialog settles at: measured from 768px to 1920px the track
         * came out at exactly 512px at every one of them, so the Ping row was
         * cut by 22px on a 4K display with 798px of screen sitting empty beside
         * the dialog. It is a maximum, not a width - the track still shrinks
         * into a narrow viewport - so raising it costs the small screens
         * nothing.
         */
        it("caps a column where its widest row stops needing the room", () => {
            // The fixed arm of the clamp below: what the column reaches when
            // the screen can give it that much.
            const cap = Number(compiled.match(/grid-template-columns:\s*minmax\(0,\s*min\(([\d.]+)rem/)?.[1]);

            assert.ok(Number.isFinite(cap), "the overview's column has no width to check");
            assert.ok(cap * 16 >= WIDEST_ROW_TRANSLATED,
                `a column stops at ${cap * 16}px, where its longest description needs ${WIDEST_ROW_TRANSLATED}`);
        });

        /**
         * And it asks for that width against the screen, not against nothing.
         *
         * A track given a bare length is sized in an intrinsic pass, where the
         * shrink-to-fit dialog has no width to offer yet - so the track takes
         * its full cap whatever the screen, the dialog is then clamped to the
         * viewport around it, and the difference is clipped by the dialog's own
         * overflow: hidden. Measured on a phone before this: a 512px grid inside
         * a 351px dialog, with every figure on the right-hand edge - the whole
         * point of the panel - drawn outside it and unreachable, since the body
         * scrolls vertically only.
         *
         * The cap stays a cap; it is the room actually available that decides
         * whether the track reaches it.
         */
        it("clamps a column against the screen rather than the dialog's guess", () => {
            const tracks = [...compiled.matchAll(/grid-template-columns:([^;}]*)/g)]
                .map(([, value]) => value.trim());

            assert.ok(tracks.length > 0, "the overview declares no columns at all");

            for (const track of tracks)
                assert.match(track, /100vw/,
                    `"${track}" sizes a column with no reference to the screen, `
                    + "so a narrow dialog clips whatever it cannot hold");
        });

        it("takes the second column only above a width that fits both", () => {
            const at = compiled.search(TWO_COLUMNS);
            assert.notEqual(at, -1, "the overview never reaches two columns");

            // The media query the rule sits in, i.e. the nearest one opened
            // before it.
            const queries = [...compiled.slice(0, at).matchAll(/@media([^{]*)\{/g)];
            const gate = queries.at(-1)?.[1] ?? "";

            const minWidth = gate.match(/min-width:\s*(\d+)px/);
            assert.notEqual(minWidth, null, `two columns are gated on "${gate.trim()}", not a minimum width`);

            // Two of those rows, the 3rem grid gap, the body's 1.25rem padding,
            // the content's 0.25rem and the dialog's 3rem gutter.
            const fits = 2 * WIDEST_ROW + 48 + 40 + 8 + 48;
            assert.ok(Number(minWidth[1]) >= fits,
                `gated at ${minWidth[1]}px, where two columns are bought by wrapping both of them`);
        });
    });

    /**
     * And where a column still cannot hold a description, a second line rather
     * than an ellipsis.
     *
     * The shared row cuts its sub-lines: on a card that is right, since a row
     * grown taller than its line-mates is what pushes a card past the height the
     * grid gave it. The enlarged view has no such height - it scrolls - so a
     * second line costs it nothing, while the ellipsis costs the reader the end
     * of the sentence. Reported against the German overview and then against the
     * English one: "Average latency, between 4.8 ms and ..." is where a reader
     * is told the average and not the range.
     */
    it("wraps a description the enlarged view cannot fit rather than cutting it", () => {
        const wrap = compiled.match(/\.chart-modal-body \.panel-row-description > \*\s*\{([^}]*)}/);

        assert.notEqual(wrap, null,
            "the enlarged view keeps the card's ellipsis, so a description ends in one on a scrolling dialog");
        assert.match(wrap[1], /white-space:\s*normal/);
    });

    /**
     * And its labels before its descriptions, which is the order they matter in.
     *
     * A cut description loses the end of a sentence; a cut label leaves the
     * reader guessing which measurement the figure beside it belongs to.
     * Measured on a 375px screen: the opened value cards cut "Maximum" by 16px
     * and "Minimum" by 2, so a phone read "Maximu..." over a number.
     */
    it("wraps a label there too, rather than leaving a measurement unnamed", () => {
        const wrap = compiled.match(/\.chart-modal-body \.panel-row-title\s*\{([^}]*)}/);

        assert.notEqual(wrap, null, "the enlarged view cuts a row's label like a card does");
        assert.match(wrap[1], /white-space:\s*normal/);
    });

    /**
     * Which a one-word label cannot use, so on a phone the value cards give
     * their figure back a step instead.
     *
     * Their own stylesheet steps the figure down on the card and exempts the
     * dialog - "opened, the card has the width of the dialog" - which holds only
     * while the dialog is the wider of the two. At the bottom of the range it is
     * not: at 375px the enlarged card is 317px inside its padding, and the
     * figure at full size leaves 78px for "Maximum", which wants 94. Wrapping
     * does not save a label with nowhere to break, so the room has to come from
     * the figure beside it - the same step the card itself takes, at the width
     * the card would be taking it.
     */
    it("gives the value cards' figure back a step where the dialog is that narrow", () => {
        const stepped = mediaBlocks(compiled)
            .filter(({body}) => /\.value-container \.panel-row-value\s*\{[^}]*font-size/.test(body));

        assert.equal(stepped.length, 1,
            "the enlarged value cards state one figure size at every width, including the phone's");

        const at = Number(stepped[0].condition.match(/max-width:\s*(\d+)px/)?.[1]);
        assert.ok(Number.isFinite(at) && at <= 520,
            `the figure holds its full size down to ${at}px, past where the label beside it is cut`);
        assert.match(stepped[0].body, /font-size:\s*1\.4rem/,
            "the enlarged card steps to a size of its own rather than the one the card uses");
    });

    /**
     * The dialog is allowed past the page's own width on a large display, which
     * is right for a plot and wrong for a panel. A plot gains resolution from
     * every pixel; the latest test is the same record the card behind it shows,
     * and at the widest tier it stood 840px wider than the overview's detail
     * view - the same two columns, pushed a hand's width further apart, on a
     * page whose every other box stops at 1400px.
     *
     * So the panel is capped where the page is, and only the plot keeps the
     * tiers. The cap carries across every tier on specificity: two classes beat
     * the single-class rule each media query restates.
     */
    describe("a panel is never wider than the page", () => {
        // Read from layout.sass rather than restated here: the whole point of
        // the cap is that the two agree, and a copy of the number could not
        // notice the page moving.
        const pageMaxWidth = Number(read("common/styles/layout.sass")
            .match(/\$page-max-width:\s*(\d+)px/)?.[1]);

        const maxWidthsOf = (selector) => bodiesFor(selector)
            .flatMap((body) => [...body.matchAll(/max-width:[^;]*?(\d+)px/g)])
            .map(([, px]) => Number(px));

        it("finds the width the page is given", () => {
            assert.ok(pageMaxWidth > 0, "layout.sass no longer states a page width");
        });

        it("caps the panel at it", () => {
            const widths = maxWidthsOf(".chart-modal-content.modal-wide");

            assert.ok(widths.length > 0, "no .modal-wide max-width, so the panel still takes every tier");
            assert.ok(Math.max(...widths) <= pageMaxWidth,
                `the panel reaches ${Math.max(...widths)}px against a page of ${pageMaxWidth}px`);
        });

        // The other half of it. Capping every tier would satisfy the assertion
        // above and quietly cost the charts the room the tiers were added for.
        it("leaves the plot the tiers it was given them for", () => {
            const widths = maxWidthsOf(".chart-modal-content");

            assert.ok(Math.max(...widths) > pageMaxWidth,
                "no tier is wider than the page any more, so the charts lost their room too");
        });
    });

    it("is asked for by the panel that needs it", () => {
        assert.match(statistics, /const WIDE_PANELS = \[[^\]]*'latest'/,
            "the latest test no longer asks for a width");
        assert.match(statistics, /wide=\{WIDE_PANELS\.includes\(expandedChart\)}/);

        const modal = read("common/components/ChartModal/ChartModal.jsx");
        assert.match(modal, /wide \? ' modal-wide' : ''/, "the modal ignores the wide prop");
    });
});

/**
 * The result link used to own a row of its own for one short link. In a grid
 * where every row costs a full line across three columns, it belongs under the
 * provider that produced it - the way the server's host sits under the server.
 */
describe("the provider's result link", () => {
    it("hangs under the provider's name rather than in a row of its own", () => {
        // The provider fact itself, up to the tag that closes it - a character
        // budget would only be measuring how long the comment inside it is.
        const providerFact = pane.match(/measured_with[\s\S]*?<\/DetailFact>/);

        assert.notEqual(providerFact, null, "the pane no longer names the provider");
        assert.match(providerFact[0], /ResultLink/,
            "the result link is not inside the provider fact");
    });

    // A row recorded before the provider column has a result id and no provider
    // to hang it under, and losing the link outright would be worse than the row
    // it used to cost.
    it("keeps its own row on a test that cannot name its provider", () => {
        assert.match(pane, /test\.resultId && !providerName\(test\.provider\)/,
            "a row with no provider has nowhere left to show its result link");
    });
});
