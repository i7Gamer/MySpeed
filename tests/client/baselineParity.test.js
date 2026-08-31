import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    baselineAccepted, BASELINE_BOUNDS, BASELINE_PERCENT_DEFAULT
} from "@/common/components/TargetsDialog/providerFields.js";
import { baselineOrNull, targetBody } from "@/common/components/TargetsDialog/targetBody.js";
import { baselinePercentProblem, BASELINE_PERCENT_MAX, BASELINE_PERCENT_MIN }
    from "../../server/util/baselineAlert.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSource } from "../helpers/source.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

/**
 * The baseline percentage, held to the same discipline the run-shape fields
 * are: the editor greys its button on the client's copy of the bounds and the
 * door refuses on the server's, so both are run over one table.
 *
 * The two sides judge different domains again - typed text here, a parsed
 * number there - so the property is the composition through targetBody, which
 * is the path a value really takes.
 */
const editorState = (over) => ({name: "LAN", provider: "ookla", serverId: "none", endpoint: "",
    alerts: true, ownOptimals: false, optimalPing: "", optimalDownload: "", optimalUpload: "",
    baselineAlerts: false, baselinePercent: "", ...over});

const doorTakes = (state) => baselinePercentProblem(targetBody(state).baselinePercent) === null;

describe("the baseline percentage the editor offers", () => {
    it("states the bounds the door enforces", () => {
        assert.equal(BASELINE_BOUNDS.min, BASELINE_PERCENT_MIN);
        assert.equal(BASELINE_BOUNDS.max, BASELINE_PERCENT_MAX);
    });

    // The default has to be inside them, or the toggle offers a value the
    // button then refuses the moment it is switched on.
    it("suggests a default the door already takes", () => {
        assert.equal(baselinePercentProblem(BASELINE_PERCENT_DEFAULT), null);
        assert.equal(baselineAccepted(String(BASELINE_PERCENT_DEFAULT), true), true);
    });

    // Everything targetBody can put on the wire as a number.
    const CARRIABLE = ["10", "70", "95", "9", "96", "0", "-5", "70.5", " 70 ", "1e2"];

    // And everything it cannot: blank, and text that is not a number. Both
    // reach the door as null.
    const UNCARRIABLE = ["", null, undefined, "abc", "seventy"];

    it("agrees with the door about every value a body can carry", () => {
        for (const on of [true, false])
            for (const value of CARRIABLE) {
                const state = editorState({baselineAlerts: on, baselinePercent: value});

                assert.equal(baselineAccepted(value, on), doorTakes(state),
                    `the two sides disagree about ${JSON.stringify(value)} with the toggle ${on}`);
            }
    });

    /**
     * And the one place they genuinely differ, stated rather than swept in.
     *
     * targetBody sends null for all of these, and null is exactly how a target
     * says it has no baseline - so the door takes it and is right to. The
     * editor refuses them and is also right to: under a switch that says the
     * target alerts, storing "no baseline" is the control not doing what it
     * says. The greyed button is the whole defence, so if it ever stops
     * refusing these, a typo silently turns the feature off.
     */
    it("refuses what no body can carry, which the door cannot see", () => {
        for (const value of UNCARRIABLE) {
            assert.equal(baselineAccepted(value, true), false,
                `the editor took ${JSON.stringify(value)} as a baseline`);
            assert.equal(baselineOrNull(true, value), null,
                `${JSON.stringify(value)} reached the body as something other than null`);
        }
    });

    // Switched off, none of them is a setting at all.
    it("holds a target with no baseline to none of it", () => {
        for (const value of [...CARRIABLE, ...UNCARRIABLE])
            assert.equal(baselineAccepted(value, false), true,
                `${JSON.stringify(value)} kept the button down on a target with no baseline`);
    });

    /**
     * Switched off, the column is null and nothing else is a setting - which is
     * the whole of how a target says it has no baseline. A value left in the
     * field must not travel, the way a bitrate left behind by a target that
     * went back to TCP must not.
     */
    it("sends nothing at all with the toggle off", () => {
        for (const left of ["", "70", "abc", "9999"])
            assert.equal(targetBody(editorState({baselineAlerts: false, baselinePercent: left}))
                .baselinePercent, null, `a target with no baseline carried ${JSON.stringify(left)}`);
    });

    it("sends what was typed with the toggle on", () => {
        assert.equal(targetBody(editorState({baselineAlerts: true, baselinePercent: "70"}))
            .baselinePercent, 70);
    });

    // A fraction is a legitimate share, unlike the run-shape fields: the column
    // is a DOUBLE and the door takes any finite number inside the bounds.
    it("keeps a fractional share rather than dropping it", () => {
        assert.equal(baselineAccepted("70.5", true), true);
        assert.equal(targetBody(editorState({baselineAlerts: true, baselinePercent: "70.5"}))
            .baselinePercent, 70.5);
    });

    // Blank with the toggle ON is the one refusal: the switch is the column,
    // so an empty field would store null and silently mean "off".
    it("refuses a blank share while the toggle is on", () => {
        for (const blank of ["", null, undefined])
            assert.equal(baselineAccepted(blank, true), false,
                `${JSON.stringify(blank)} was taken as a baseline`);
    });
});

describe("the baseline field on every provider", () => {
    // Unlike the iperf3 tuning, a baseline is about the measurements a target
    // records rather than about how it measures them - so every provider has
    // one, and nothing here is gated on which.
    it("travels on every provider", () => {
        for (const provider of ["ookla", "libre", "cloudflare", "iperf3"])
            assert.equal(targetBody(editorState({provider, endpoint: "nas.lan",
                baselineAlerts: true, baselinePercent: "70"})).baselinePercent, 70,
            `${provider} dropped its baseline`);
    });
});

/**
 * Where the two conditional blocks appear, which is under the toggles that
 * govern them.
 *
 * The editor draws three switches in a row - alerts, own optimal values,
 * baseline - and then the fields each switch reveals. Written in that order,
 * the optimal fields appeared after the baseline's, two switches below the one
 * that had just been turned on: an operator pressing "Own optimal values"
 * watched three inputs arrive under a different heading, with the baseline's
 * own field in between. The block that opens is the one directly beneath the
 * switch that opened it.
 */
describe("the fields a switch reveals", () => {
    const editor = readSource("client/src/common/components/TargetsDialog/TargetEditor.jsx");

    const at = (marker) => {
        const index = editor.indexOf(marker);
        assert.notEqual(index, -1, `${marker} is no longer in the editor; re-anchor this`);
        return index;
    };

    it("puts the optimal fields under the switch that reveals them", () => {
        assert.ok(at("{ownOptimals && (") > at('<h3>{t("targets.own_optimals")}</h3>'),
            "the optimal fields are drawn above their own switch");
        assert.ok(at("{ownOptimals && (") < at('<h3>{t("targets.baseline_alerts")}</h3>'),
            "the optimal fields are drawn past the baseline switch, under the wrong heading");
    });

    it("puts the baseline field under the switch that reveals it", () => {
        assert.ok(at("{baselineAlerts && (") > at('<h3>{t("targets.baseline_alerts")}</h3>'),
            "the baseline field is drawn above its own switch");
    });

    /**
     * And its label fits the column it is in. At "Share of the 30-day median
     * (%)" it was cut to "Share of the 30-day medi..." in a 12rem field - and
     * the sentence beside it says what the share is of, so the label only has
     * to name the field.
     */
    it("labels the baseline field in words its column can hold", () => {
        const english = JSON.parse(fs.readFileSync(
            path.join(ROOT, "client", "public", "assets", "locales", "en.json"), "utf8"));

        assert.ok(english.targets.baseline_percent.length <= 12,
            `"${english.targets.baseline_percent}" is too long for the field it labels`);
        assert.match(english.targets.baseline_desc, /median/,
            "the sentence beside the field no longer says what the share is of");
    });
});
