import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    convertSpeed, formatLatency, formatWhole, formatWithUnit, NOT_MEASURED, SPEED_UNIT_MBYTES
} from "@/common/utils/FormatUtil.js";
import { getIconBySpeed, isFailedTest } from "@/common/utils/TestUtil.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const card = fs.readFileSync(
    path.join(CLIENT_SRC, "pages", "Nodes", "components", "NodeContainer", "NodeContainer.jsx"), "utf8");

/**
 * The card's own statements, lifted out of the component and run.
 *
 * They are plain JavaScript - the JSX and the hooks around them are what node
 * cannot evaluate - so the alternative is asserting on their spelling, which
 * passes for any wording that happens to contain the right words. What matters
 * here is which figure reaches each place, and that is only visible by building
 * the card and reading the figures back. Same approach as
 * detailLatencyPrecision.test.js.
 */
const slice = (from, to) => {
    const start = card.indexOf(from);
    assert.notEqual(start, -1, `the card no longer contains "${from}"`);

    const end = card.indexOf(to, start);
    assert.notEqual(end, -1, `"${to}" no longer closes it`);

    return card.slice(start, end + to.length);
};

const CARD_END = "\n        });";

/** What the card stores about one test, built by its own setNodeData call. */
const dataFor = (test, config = {}) => {
    let captured = null;

    new Function("tests", "config", "setNodeData",
        "formatLatency", "formatWhole", "isFailedTest", "getIconBySpeed",
        slice("const ping = formatLatency", CARD_END))(
        [test], config, (data) => { captured = data; },
        formatLatency, formatWhole, isFailedTest, getIconBySpeed);

    assert.notEqual(captured, null, "the card never stored anything");
    return captured;
};

/** What one speed reads as, built by the card's own helper. */
const speedText = (mbps, preferences = {}, unit = "Mbps") => new Function(
    "preferences", "speedUnit", "formatWithUnit", "formatWhole", "convertSpeed",
    `${slice("const speedText =", ";")}\nreturn speedText;`)(
    preferences, unit, formatWithUnit, formatWhole, convertSpeed)(mbps);

/**
 * A node card is a list row like any other, and it prints whole numbers.
 *
 * It always rounded its two speeds and showed its ping at one decimal, which
 * was the precision the overview used at the time. The overview rows print
 * whole numbers now - see formatWhole - and a card that switches to that page
 * showing "12.6 ms" for the test the page itself calls "13 ms" is one figure
 * written two ways.
 */
describe("the figures a node card prints", () => {
    it("prints all three measurements as whole numbers", () => {
        const data = dataFor({ping: 12.64, download: 93.72, upload: 41.38});

        assert.equal(data.ping, 13);
        assert.equal(speedText(data.download), "94 Mbps");
        assert.equal(speedText(data.upload), "41 Mbps");
    });

    /**
     * The card used to round the stored figure and convert afterwards, so a
     * reader on MB/s got an eighth of a rounded number - decimals and all -
     * where the overview beside it prints a rounded eighth. The conversion has
     * to come first, which means the rounding cannot happen until the card is
     * rendered and the preference is known.
     */
    it("rounds the speed it prints, not the one it stores", () => {
        assert.equal(speedText(100, {speedUnit: SPEED_UNIT_MBYTES}, "MB/s"), "13 MB/s",
            "100 Mbps is 12.5 MB/s, which prints as 13");
        assert.equal(dataFor({download: 93.72}).download, 93.72,
            "the stored speed is rounded before anything can convert it");
    });

    /**
     * The colour has to agree with the overview's, and the overview grades the
     * ping at one decimal - getIconBySpeed floors a percentage, so a ping that
     * crosses a bucket boundary on its way to a whole number would wear one
     * colour on this card and another on the page the card switches to.
     */
    it("grades the ping at the decimal the page it switches to grades it at", () => {
        assert.equal(dataFor({ping: 12.5}, {ping: "10"}).pingIcon, "green");
        assert.equal(getIconBySpeed(formatWhole(12.5), "10", false), "orange",
            "a fixture both gradings agree on proves nothing here");
    });

    it("grades the speeds on what was measured rather than on what is shown", () => {
        const data = dataFor({download: 93.72, upload: 41.38}, {download: "100", upload: "40"});

        assert.equal(data.downloadIcon, getIconBySpeed(93.72, "100", true));
        assert.equal(data.uploadIcon, getIconBySpeed(41.38, "40", true));
    });

    // Math.round(null) is 0 and Math.round(undefined) is NaN. A node answers
    // with whatever its own API returns, so neither may become a reading.
    it("does not turn an absent figure into a reading of zero", () => {
        for (const absent of [null, undefined]) {
            assert.equal(dataFor({ping: absent}).ping, absent, `ping ${String(absent)}`);
            assert.equal(speedText(absent), NOT_MEASURED, `speed ${String(absent)}`);
        }
    });

    // The card marks a failure rather than printing the -1 placeholders as
    // readings, so the value it holds only has to stay recognisable.
    it("keeps a failed test recognisable", () => {
        const data = dataFor({ping: -1, download: -1, upload: -1});

        assert.equal(data.failed, true);
        assert.equal(data.ping, -1);
        assert.equal(data.pingIcon, "error");
    });

    // The tripwire for the two speeds drifting apart, which is what one-line
    // formatting at each of two call sites invites.
    it("formats both speeds through the one helper", () => {
        assert.ok(card.includes("{speedText(nodeData.download)}"), "the download is formatted inline again");
        assert.ok(card.includes("{speedText(nodeData.upload)}"), "the upload is formatted inline again");
    });
});
