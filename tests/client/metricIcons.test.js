import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

/**
 * One measurement, one glyph, everywhere.
 *
 * Packet loss was drawn two different ways on the same page - a square wave on
 * the overview card, a satellite dish on the last-test card - and the square
 * wave is what jitter uses, so the same glyph stood for two unrelated
 * measurements a few centimetres apart. A reader has no way to tell those apart
 * except by the label, which defeats the icon.
 *
 * The square wave now means variation and nothing else: jitter, and the
 * standard deviation on the average cards, which is the same idea.
 */
const PACKET_LOSS_ICON = "faLinkSlash";
const VARIATION_ICON = "faWaveSquare";

const PACKET_LOSS_SITES = [
    "pages/Statistics/charts/OverviewChart/OverviewChart.jsx",
    "pages/Statistics/charts/LatestTestChart/LatestTestChart.jsx"
];

const VARIATION_SITES = [
    "pages/Home/components/Speedtest/SpeedtestComponent.jsx",
    "pages/Statistics/charts/LatestTestChart/LatestTestChart.jsx",
    "pages/Statistics/charts/ConsistencyChart/ConsistencyChart.jsx",
    "pages/Statistics/charts/AverageChart/AverageChart.jsx"
];

/** The block of source that draws one labelled row, so the icon beside a label is checked. */
const around = (source, anchor, before = 400, after = 400) => {
    const at = source.indexOf(anchor);
    assert.notEqual(at, -1, `could not find ${anchor}`);

    return source.slice(Math.max(0, at - before), at + after);
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

    it("the overview card uses it on the packet loss row", () => {
        const row = around(read(PACKET_LOSS_SITES[0]), "overview.packet_loss_title", 300, 100);

        assert.match(row, new RegExp(`icon: ${PACKET_LOSS_ICON}`));
        assert.doesNotMatch(row, new RegExp(`icon: ${VARIATION_ICON}`),
            "the packet loss row is back on the variation glyph");
    });

    it("the last-test card uses it on the packet loss row", () => {
        const row = around(read(PACKET_LOSS_SITES[1]), "latest.packet_loss", 100, 700);

        assert.match(row, new RegExp(`icon=\\{${PACKET_LOSS_ICON}\\}`));
    });

    // The dish said "receiving a signal", which is not what packet loss is.
    it("no card still reaches for the satellite dish", () => {
        for (const file of PACKET_LOSS_SITES)
            assert.doesNotMatch(read(file), /faSatelliteDish/,
                `${path.basename(file)} still draws packet loss as a dish`);
    });
});

describe("the square wave means variation and nothing else", () => {
    for (const file of VARIATION_SITES) {
        const name = path.basename(file, ".jsx");

        it(`${name} still uses it`, () => {
            assert.match(read(file), new RegExp(`\\b${VARIATION_ICON}\\b`),
                `${name} lost the variation glyph`);
        });
    }

    it("is not also standing in for packet loss", () => {
        const overview = read(PACKET_LOSS_SITES[0]);

        assert.doesNotMatch(overview, new RegExp(`\\b${VARIATION_ICON}\\b`),
            "the overview card imports the variation glyph again - it has no variation row");
    });
});
