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

// Both spellings: the overview card lists its rows as objects, the others
// render <FontAwesomeIcon icon={...}/>.
const ICON_REFERENCE = /icon(?:=\{|:\s*)(fa[A-Za-z]+)/g;

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
    const from = at(source, anchor);
    ICON_REFERENCE.lastIndex = from;

    return ICON_REFERENCE.exec(source)?.[1] ?? null;
};

const iconBefore = (source, anchor) => {
    const until = at(source, anchor);
    const head = source.slice(0, until);

    return [...head.matchAll(ICON_REFERENCE)].at(-1)?.[1] ?? null;
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

    // The overview card names the icon above the title, the last-test card below.
    it("the overview card uses it on the packet loss row", () => {
        assert.equal(iconBefore(read(PACKET_LOSS_SITES[0]), "overview.packet_loss_title"),
            PACKET_LOSS_ICON);
    });

    it("the last-test card uses it on the packet loss row", () => {
        assert.equal(iconAfter(read(PACKET_LOSS_SITES[1]), "latest.packet_loss"), PACKET_LOSS_ICON);
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
 * Consistency is variation too, which is what made it reach for the wave - but
 * it is throughput across a whole range, not latency inside one test, and the
 * two are read side by side.
 */
describe("consistency has a glyph of its own", () => {
    const source = read(CONSISTENCY_SITE);

    it("the expanded values pane uses it", () => {
        assert.equal(iconAfter(source, "statistics.values.consistency"), CONSISTENCY_ICON,
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
