import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ceilings, compile, mediaBlocks, read, rules } from "../helpers/sass.mjs";

const page = compile("pages/Statistics/styles.sass");
const statContainer = compile("pages/Statistics/components/StatisticContainer/styles.sass");
const chartContainer = compile("pages/Statistics/charts/SpeedChart/styles.sass");
const layoutSource = read("common/styles/layout.sass");
const statisticsSource = read("pages/Statistics/Statistics.jsx");

/**
 * The nine cards had two shapes and one figure deciding between them.
 *
 * Three to a row down to 900px and then one to a row, with that 900 written out
 * separately in the stat cards' stylesheet and in the chart cards'. Measured in
 * a headless browser in MB/s, where every figure gains a decimal and a wider
 * unit: the cards that were cut at 1300px were still being cut at 920, because
 * nothing between those widths changed - "Variation within a test" lost 97px,
 * "Download" 60, "Maximum" 33, while the summary beside them held 490px and the
 * hourly chart 526.
 */
describe("the statistics page's shape", () => {
    it("keeps its breakpoints in one place rather than one per stylesheet", () => {
        assert.match(layoutSource, /\$stats-two-column:\s*\d+px/,
            "the two-column stage has no shared constant");
        assert.match(layoutSource, /\$stats-one-column:\s*\d+px/,
            "the one-column stage has no shared constant");
    });

    // The figure they used to share by coincidence. Either card type keeping a
    // hardcoded ceiling is the page reflowing in two halves at two widths.
    it("leaves no card type reflowing on a width of its own", () => {
        for (const [name, css] of [["stat", statContainer], ["chart", chartContainer]])
            assert.ok(!ceilings(css).includes(900),
                `the ${name} cards still change width at their own hardcoded 900px`);
    });

    it("declares the two-column stage above the one-column stage", () => {
        const declared = ceilings(page);

        assert.equal(declared.length, 2, `the page declares ${declared.length} stages, expected two`);
        assert.deepEqual(declared, [...declared].sort((a, b) => b - a),
            "the narrower stage is declared first, so the wider one wins at every width they share");
    });

    /**
     * The cards are direct children of the same area the modal is a child of,
     * and the modal renders this very markup with the whole viewport to spend.
     * A descendant selector reflows the enlarged view along with the page
     * behind it - the trap OverviewChart already works around by hand.
     */
    it("reflows the page's own cards and not the modal's", () => {
        const staged = rules(page).filter(({selector}) =>
            /\.stats-container|\.chart-container/.test(selector));

        assert.ok(staged.length > 0, "the page no longer sizes the cards at all");

        for (const {selector} of staged)
            assert.match(selector, /\.statistic-area >/,
                `"${selector}" reaches into the modal, which has the whole viewport to spend`);
    });
});

/**
 * Three cards to a row share it equally.
 *
 * The bases were 35% for the summary, 15% for the panels beside it and 5% for
 * the value cards, with flex-grow: 1 on every one - so the leftover was split
 * equally and never corrected the lopsided start. Their contents want the same
 * room as each other: measured after, every card on the page is the same width
 * at every width, and the only thing still cut anywhere in the range is one
 * description sub-line by 7px, on an element whose whole job is to ellipsise.
 */
describe("what a card asks for while three share a row", () => {
    it("asks for one share, stated once, on the card itself", () => {
        const base = rules(statContainer).find(({selector}) => selector === ".stats-container");

        assert.ok(base, ".stats-container declares nothing");
        assert.match(base.body, /flex:\s*1 1 30%/,
            "the shared share is gone, so the cards are back to sizing themselves apart");
    });

    // The size classes name which card is which - the page's stages reflow on
    // them - but a width of their own is a second home for the same figure,
    // editable apart from the first: the base changes and the page still
    // renders from the copy.
    it("gives a size class no width of its own", () => {
        for (const size of [".container-small", ".container-normal", ".container-large"]) {
            const sized = rules(statContainer).filter(({selector, body}) =>
                selector.split(",").some((part) => part.trim() === size) && /flex:/.test(body));

            assert.equal(sized.length, 0,
                `${size} sets a width of its own again, which is what cut the labels`);
        }
    });

    // The old figures, named so a partial revert is caught rather than passing
    // as "some flex is set".
    it("has none of the three lopsided bases left", () => {
        for (const old of [/flex:\s*1 1 5%/, /flex:\s*1 1 15%/, /flex:\s*1 1 35%/])
            assert.doesNotMatch(statContainer, old,
                `a card still starts from ${old}, which is what cut the labels`);
    });
});

/**
 * Except the summary, which is not asking for the same room as the two beside
 * it.
 *
 * Its labels and descriptions are the page's only sentences - "Peak-hour
 * slowdown" over "Slowest around 8:00 PM, fastest around 4:00 AM" - where the
 * stability and latest-test cards beside it name a measurement in a word and
 * qualify it with "±3 Mbps". At an equal third of 1400px each card holds ~409px
 * of list, which leaves the packet-loss row ~222px for a sentence wanting 271
 * and the peak-hour row ~295 for one wanting 304: those two rows wrapped to two
 * lines while their line-mates sat on hundreds of spare pixels.
 *
 * Stated here rather than on the card, like the stages below it: this is the
 * one stylesheet that knows there are two other cards on that row.
 */
describe("the share the summary takes while three share a row", () => {
    const summary = rules(page.split("@media")[0])
        .find(({selector}) => selector.includes(".container-large"));

    it("asks for more of the row than the cards beside it", () => {
        assert.ok(summary, "the summary takes an equal third again, where its sentences wrap");

        const share = Number(summary.body.match(/flex:\s*1 1 (\d+)%/)?.[1]);

        assert.ok(Number.isFinite(share), "the summary's share is not a percentage of the row");
        assert.ok(share > 30, `the summary asks for ${share}%, which is no more than an equal third`);
    });

    // Two of them at that share and the row cannot hold three cards at all.
    it("leaves the two beside it a share each", () => {
        const share = Number(summary.body.match(/flex:\s*1 1 (\d+)%/)?.[1]);

        assert.ok(share <= 40, `the summary asks for ${share}%, which squeezes its line-mates below their own`);
    });

    /**
     * And it says so above the stages, which restate it at equal specificity -
     * the summary spans the whole row from the two-column stage down. Only
     * source order settles those, so a base rule written after them would win
     * back its third on every narrow screen.
     */
    it("declares that share before the stages that override it", () => {
        assert.ok(page.indexOf(".container-large") < page.indexOf("@media"),
            "the summary's own share is declared after the stages and outranks them by source order");
    });
});

/**
 * And the step that was missing between three across and one.
 *
 * The pairs fall out of the order the cards are already written in, once the
 * summary takes a row of its own: last test beside stability, the two speed
 * charts, ping beside the hourly average, and the two value cards. Measured:
 * 1+2+2+2+2 from 1000px to 760, with nothing cut on any card.
 */
describe("the two-column stage", () => {
    // Anchored to the widest ceiling rather than to "the first @media": an
    // unrelated query added above the stages must not silently retarget this.
    const twoColumn = () => {
        const declared = ceilings(page);
        assert.ok(declared.length > 0, "the page declares no stages at all");

        const widest = Math.max(...declared);
        return mediaBlocks(page).find(({condition}) => condition.includes(`${widest}px`)).body;
    };

    it("puts two cards on a row", () => {
        assert.match(twoColumn(), /flex:\s*1 1 calc\(50%/,
            "the cards do not take half a row each, so there is no two-column stage");
    });

    it("spans the summary across both of them", () => {
        const spanning = rules(twoColumn()).find(({selector}) => selector.includes(".container-large"));

        assert.ok(spanning, "the summary card takes half a row like the rest, which leaves nine cards unpaired");
        assert.match(spanning.body, /flex:\s*1 1 100%/,
            "the summary does not span the row, so the pairs below it are off by one");
    });
});

/**
 * A card's border is part of its width.
 *
 * The reset in default.sass reaches `main > *`, which is the area around these
 * rather than the cards themselves, so a full-width card measured 100% plus its
 * two 1px borders - and 100% plus 18px below 500px, where the chart card also
 * takes padding. Measured: every card overhung the area by 2px from 900px down
 * and by 18px from 500, which is the page's right-hand gutter gone.
 */
describe("a card that has the row to itself", () => {
    for (const [name, css] of [["stat", statContainer], ["chart", chartContainer]])
        it(`counts the ${name} card's border inside its width`, () => {
            const container = rules(css).find(({selector}) =>
                selector === `.${name === "stat" ? "stats" : "chart"}-container`);

            assert.ok(container, `.${name} card has no base rule`);
            assert.match(container.body, /box-sizing:\s*border-box/,
                "the card is its stated width plus its border, so it overhangs the page");
        });
});

/**
 * The loading page keeps the loaded page's shape.
 *
 * The three shimmer cards are direct children of the same area, so a stage
 * that reflows `> .stats-container` and misses `> .skeleton-chart` is a page
 * that loads three-across and then jumps into summary-plus-pairs the moment
 * the content lands - a full-page reflow on every visit in the band.
 */
describe("the loading skeletons follow the page's stages", () => {
    const stage = (ceiling) => {
        const block = mediaBlocks(page).find(({condition}) => condition.includes(`${ceiling}px`));
        assert.ok(block, `no stage reflows at ${ceiling}px`);
        return block.body;
    };

    const declared = () => {
        const widths = ceilings(page);
        assert.equal(widths.length, 2, "the page no longer declares exactly two stages");
        return {two: Math.max(...widths), one: Math.min(...widths)};
    };

    it("pairs the shimmers at the two-column stage", () => {
        const paired = rules(stage(declared().two)).filter(({selector, body}) =>
            selector.includes("> .skeleton-chart") && /flex:\s*1 1 calc\(50%/.test(body));

        assert.ok(paired.length > 0,
            "the shimmers keep three-across while the content behind them loads as pairs");
    });

    // The first shimmer stands where the summary will: the card after the
    // toolbar, spanning its row so the two below it pair up like the content.
    it("spans the first shimmer like the summary it stands for", () => {
        const spanning = rules(stage(declared().two)).find(({selector, body}) =>
            selector.includes(".page-toolbar + .skeleton-chart") && /flex:\s*1 1 100%/.test(body));

        assert.ok(spanning,
            "every shimmer takes half a row, so the loading page pairs where the loaded one spans");
    });

    it("stacks the shimmers at the one-column stage", () => {
        const stacked = rules(stage(declared().one)).filter(({selector, body}) =>
            selector.includes("> .skeleton-chart") && /flex:\s*1 1 100%/.test(body));

        assert.ok(stacked.length > 0,
            "the shimmers sit three-across on a width whose content loads single-file");
    });

    // The base rule is what the stages override; equal specificity means the
    // stages must come later in the file, so the base cannot silently win.
    it("declares the shimmer's own share before the stages", () => {
        const base = page.search(/\.statistic-loading[^{]*\.skeleton-chart|\.skeleton-chart[^{]*\{/);
        const firstStage = page.indexOf("@media");

        assert.notEqual(base, -1, "the shimmer cards have no base rule at all");
        assert.ok(base < firstStage,
            "the shimmer base rule follows the stages and outranks them by source order");
    });
});

/**
 * Which card lands under which, while three share a row.
 *
 * A wrapping row has columns whether anyone designed them or not, and the page
 * had drawn a set nobody meant: with the hourly chart leading the third row,
 * "Download" averages sat under the *upload* chart and "Upload" averages under
 * the ping. Two cards about the same metric, one directly above the other,
 * naming different ones.
 *
 * The order is the only thing that decides this - every card takes the same
 * share - so the pairing is a property of the render, not of the stylesheet,
 * and this is where it is held.
 */
describe("the columns the second and third rows fall into", () => {
    const COLUMNS = 3;

    /** The nine cards in render order, each under the metric it is about. */
    const cards = () => {
        const body = statisticsSource.slice(statisticsSource.lastIndexOf("statistic-area${isStale"));
        const named = [...body.slice(0, body.indexOf("<ChartModal"))
            .matchAll(/<(OverviewChart|LatestTestChart|ConsistencyChart|PingChart|SpeedChart|HourlyChart|AverageChart)\b([^>]*)>/g)];

        return named.map(([, name, props]) => {
            if (name === "SpeedChart") return `speed:${props.match(/dataKey="(\w+)"/)?.[1]}`;
            if (name === "AverageChart") return `average:${props.match(/statistics\.values\.(\w+)/)?.[1]}`;
            return name;
        });
    };

    it("renders the nine the page is made of", () => {
        assert.equal(cards().length, 9, `the page renders ${cards().length} cards, so the rows are not three deep`);
    });

    // down/up on the value cards, download/upload on the charts - the two
    // names for one metric, which is the pairing this is about.
    for (const [chart, panel] of [["speed:download", "average:down"], ["speed:upload", "average:up"]])
        it(`puts ${panel} directly under ${chart}`, () => {
            const order = cards();
            const above = order.indexOf(chart);
            const below = order.indexOf(panel);

            assert.ok(above >= 0 && below >= 0, `${chart} or ${panel} is no longer rendered`);
            assert.equal(below % COLUMNS, above % COLUMNS,
                `${panel} sits in column ${below % COLUMNS} under a chart in column ${above % COLUMNS}`);
            assert.equal(Math.floor(below / COLUMNS), Math.floor(above / COLUMNS) + 1,
                `${panel} is not on the row below ${chart}, so the pair is not read as one`);
        });

    // What makes the two above work: the latency chart leads the row the speed
    // charts are on, so they start at the second column and the value cards
    // below them start at the second column too.
    it("leads the second row with the latency chart", () => {
        const order = cards();

        assert.equal(order.indexOf("PingChart") % COLUMNS, 0,
            "the ping chart no longer starts a row, which shifts the speed charts off their panels");
        assert.ok(order.indexOf("PingChart") < order.indexOf("speed:download"),
            "the ping chart follows the speed charts again");
    });
});

// The summary's own trims - container-keyed now, so its full-row and modal
// copies keep their detail - are pinned in overviewModalStyles.test.js, the
// file that owns that stylesheet's contract.
