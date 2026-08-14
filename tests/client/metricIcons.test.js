import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

/**
 * One measurement, one glyph, everywhere - and no glyph doing two jobs.
 *
 * The square wave had drifted into standing for three different things. Packet
 * loss borrowed it on the overview card while using a satellite dish on the
 * last-test card, so one measurement was drawn two ways and one glyph covered
 * two unrelated measurements a few centimetres apart. Consistency borrowed it
 * too: also variation, but throughput swinging across every test in a range,
 * where jitter is latency moving within a single test. Different numbers,
 * different units, same page.
 *
 * Settled as: a broken link is packet loss, a tight range is consistency, and
 * the square wave is jitter and nothing else.
 */
const PACKET_LOSS_ICON = "faLinkSlash";
const CONSISTENCY_ICON = "faCompress";
const JITTER_ICON = "faWaveSquare";

// The latency under load. It may not borrow the ping's paddle: the whole point
// of the figure is that it is not the idle ping, and a glyph standing for
// "latency" in general would say the same thing about two measurements taken
// under opposite conditions.
//
// Its grade has no glyph at all - see below.
const LOADED_LATENCY_ICON = "faStopwatch";

const PACKET_LOSS_SITES = [
    "pages/Statistics/charts/OverviewChart/OverviewChart.jsx",
    "pages/Statistics/charts/LatestTestChart/LatestTestChart.jsx",
    // The overview row and the panel it opens draw the figure beside the jitter,
    // which is the one place the two glyphs stand next to each other - and so
    // the one place borrowing the wrong one would be unmistakable.
    "pages/Home/components/Speedtest/SpeedtestComponent.jsx",
    "common/components/TestDetails/TestDetails.jsx"
];

// Every remaining place the wave is drawn. All four are jitter.
const JITTER_SITES = [
    "pages/Home/components/Speedtest/SpeedtestComponent.jsx",
    "common/components/TestDetails/TestDetails.jsx",
    "pages/Statistics/charts/LatestTestChart/LatestTestChart.jsx",
    "pages/Statistics/charts/ConsistencyChart/ConsistencyChart.jsx"
];

const CONSISTENCY_SITE = "pages/Statistics/charts/AverageChart/AverageChart.jsx";

// Both spellings: a card may list its rows as objects or pass the glyph to the
// shared row as a prop.
const ICON_REFERENCE = /icon(?:=\{|:\s*)(fa[A-Za-z]+)/;

/**
 * A fresh matcher per search.
 *
 * The pattern needs the `g` flag, and a global regex is stateful: `exec` leaves
 * `lastIndex` where it stopped, and `matchAll` starts its own scan from that
 * same `lastIndex`. Held in one shared object, an iconAfter therefore left the
 * next iconBefore starting halfway down the file - which answered null for a
 * glyph sitting directly above the label it was asked about.
 */
const references = () => new RegExp(ICON_REFERENCE.source, "g");

const at = (source, anchor) => {
    const index = source.indexOf(anchor);
    assert.notEqual(index, -1, `could not find ${anchor}`);
    return index;
};

/**
 * The icon nearest a label, searching in the direction the markup puts it.
 *
 * Nearest rather than "somewhere within N characters": a comment added above a
 * row would push its icon out of any fixed window, which is a test breaking on
 * prose rather than on the thing it guards.
 */
const iconAfter = (source, anchor) => {
    const matcher = references();
    matcher.lastIndex = at(source, anchor);

    return matcher.exec(source)?.[1] ?? null;
};

const iconBefore = (source, anchor) => {
    const head = source.slice(0, at(source, anchor));

    return [...head.matchAll(references())].at(-1)?.[1] ?? null;
};

describe("packet loss is drawn the same way everywhere", () => {
    for (const file of PACKET_LOSS_SITES) {
        const source = read(file);
        const name = path.basename(file, ".jsx");

        it(`${name} imports the packet-loss icon`, () => {
            assert.match(source, new RegExp(`\\b${PACKET_LOSS_ICON}\\b`),
                `${name} does not use ${PACKET_LOSS_ICON} for packet loss`);
        });
    }

    // Both cards name the icon before the title now: they draw the same shared
    // row, which takes the glyph first and what it is called second.
    it("the overview card uses it on the packet loss row", () => {
        assert.equal(iconBefore(read(PACKET_LOSS_SITES[0]), "overview.packet_loss_title"),
            PACKET_LOSS_ICON);
    });

    it("the last-test card uses it on the packet loss row", () => {
        assert.equal(iconBefore(read(PACKET_LOSS_SITES[1]), "latest.packet_loss"), PACKET_LOSS_ICON);
    });

    // The dish said "receiving a signal", which is not what packet loss is.
    it("no card still reaches for the satellite dish", () => {
        for (const file of PACKET_LOSS_SITES)
            assert.doesNotMatch(read(file), /faSatelliteDish/,
                `${path.basename(file)} still draws packet loss as a dish`);
    });
});

describe("the square wave means jitter and nothing else", () => {
    for (const file of JITTER_SITES) {
        const name = path.basename(file, ".jsx");

        it(`${name} still uses it for jitter`, () => {
            assert.match(read(file), new RegExp(`\\b${JITTER_ICON}\\b`),
                `${name} lost the jitter glyph`);
        });
    }

    it("is not also standing in for packet loss", () => {
        assert.doesNotMatch(read(PACKET_LOSS_SITES[0]), new RegExp(`\\b${JITTER_ICON}\\b`),
            "the overview card imports the jitter glyph again - it has no jitter row");
    });

    it("is not also standing in for consistency", () => {
        assert.doesNotMatch(read(CONSISTENCY_SITE), new RegExp(`\\b${JITTER_ICON}\\b`),
            "the average card imports the jitter glyph again - it has no jitter row");
    });
});

/**
 * What the line does once it is busy, drawn in two places that sit a click
 * apart: the latency each direction showed under load, on the pane's speed
 * cards, and the grade for the worse of them, on the overview row.
 */
describe("the figures measured under load have their own glyphs", () => {
    const pane = read("common/components/TestDetails/TestDetails.jsx");
    const row = read("pages/Home/components/Speedtest/SpeedtestComponent.jsx");

    it("draws the loaded latency with the stopwatch", () => {
        assert.equal(iconAfter(pane, "info.loaded_latency.title"), LOADED_LATENCY_ICON);
    });

    /**
     * The grade is the exception that proves the rule: it has never been drawn
     * as a glyph anywhere - the letter is the glyph, coloured by the grade, and
     * every view that shows one shows the same badge. Drawn as an icon with a
     * number beside it on the overview row, it took a full column's width to
     * say one character's worth and left a hole in every row whose provider
     * measures no latency under load.
     */
    it("draws the bufferbloat as its badge, not as a glyph", () => {
        assert.match(row, /bufferbloat-grade/);
        assert.doesNotMatch(row, /faGauge/, "the grade is back to borrowing a glyph");
    });

    it("uses that same badge in the panel", () => {
        assert.match(pane, /bufferbloat-grade/);
    });

    // The paddle is the idle ping. Latency under load is the measurement that
    // exists precisely because those two differ.
    it("leaves the ping's paddle to the ping", () => {
        const loaded = pane.slice(pane.indexOf("const loadedLatency"));

        assert.doesNotMatch(loaded.slice(0, loaded.indexOf("const metrics")), /faPingPongPaddleBall/);
    });

    it("gives each of the four measurements a glyph of its own", () => {
        const glyphs = [PACKET_LOSS_ICON, JITTER_ICON, CONSISTENCY_ICON, LOADED_LATENCY_ICON];

        assert.equal(new Set(glyphs).size, glyphs.length);
    });
});

/**
 * Consistency is variation too, which is what made it reach for the wave - but
 * it is throughput across a whole range, not latency inside one test, and the
 * two are read side by side.
 */
describe("consistency has a glyph of its own", () => {
    const source = read(CONSISTENCY_SITE);

    it("the expanded values pane uses it", () => {
        assert.equal(iconBefore(source, "statistics.values.consistency"), CONSISTENCY_ICON,
            "the Consistency row is not on the consistency glyph");
    });

    it("nothing else on the page claims it", () => {
        for (const file of [...JITTER_SITES, ...PACKET_LOSS_SITES]) {
            if (file === CONSISTENCY_SITE) continue;

            assert.doesNotMatch(read(file), new RegExp(`\\b${CONSISTENCY_ICON}\\b`),
                `${path.basename(file)} borrowed the consistency glyph`);
        }
    });
});
