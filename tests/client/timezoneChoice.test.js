import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, tagHolding } from "../helpers/source.js";
import {
    TIMEZONE_OFF, browserTimezone, storedTimezoneToInput, timezoneOptions
} from "@/common/components/PauseDialog/timezoneChoice.js";

/**
 * The list the timezone picker offers.
 *
 * The setting itself already decides when the cron fires and which hours the
 * quiet window silences (upstream #1115, #748); until there is a control for it
 * the only way to set it is the config API, which is not an answer for the
 * people who asked.
 *
 * The names come from Intl rather than from a shipped table - some 400 of them,
 * and a table would be one more thing to keep current as the zone database
 * moves.
 */
describe("the zone list", () => {
    it("offers the zones this runtime knows", () => {
        const options = timezoneOptions();

        assert.ok(options.length > 100, `only ${options.length} zones were offered`);
        assert.ok(options.includes("Europe/Berlin"));
        assert.ok(options.includes("America/New_York"));
    });

    it("is sorted, so a long list can be read", () => {
        const options = timezoneOptions();

        assert.deepEqual(options, [...options].sort());
    });

    // The sentinel is not a zone. It is offered as its own choice by the dialog,
    // with a label saying what it means, rather than sitting in the list as a
    // name nobody would recognise.
    it("does not carry the off sentinel as if it were a zone", () => {
        assert.ok(!timezoneOptions().includes(TIMEZONE_OFF));
    });

    /**
     * `supportedValuesOf` answers canonical names only, and the stored value can
     * be an alias - "Europe/Kiev" for "Europe/Kyiv", "Asia/Calcutta" for
     * "Asia/Kolkata". A select whose value is not among its options renders as
     * something else entirely, so the operator would open the dialog and be
     * shown a zone they never chose, then save it by touching anything.
     */
    it("carries the stored zone even when it is an alias", () => {
        const options = timezoneOptions("Europe/Kiev");

        assert.ok(options.includes("Europe/Kiev"),
            "a stored alias is not in the list, so the picker silently shows a different zone");
    });

    it("does not repeat a stored zone that is already canonical", () => {
        const options = timezoneOptions("Europe/Berlin");

        assert.equal(options.filter((zone) => zone === "Europe/Berlin").length, 1);
    });

    it("is unbothered by a stored value that is not a zone at all", () => {
        for (const stored of [TIMEZONE_OFF, "", null, undefined, 5, {}]) {
            const options = timezoneOptions(stored);

            assert.ok(options.length > 100, `${JSON.stringify(stored)} emptied the list`);
            assert.ok(options.every((zone) => typeof zone === "string" && zone !== ""));
        }
    });
});

describe("the browser's own zone", () => {
    it("is a zone the list carries", () => {
        const own = browserTimezone();

        assert.equal(typeof own, "string");
        assert.ok(timezoneOptions().includes(own), `${own} is not among the offered zones`);
    });
});

describe("what the select is given as its value", () => {
    it("shows the stored zone", () => {
        assert.equal(storedTimezoneToInput("Europe/Berlin"), "Europe/Berlin");
    });

    /**
     * Absent means the same as the sentinel here, and it is not hypothetical:
     * /api/config withholds this key from an untrusted reader, so the dialog can
     * genuinely hold a config that has no timezone in it at all.
     */
    it("falls back to the sentinel for anything that names no zone", () => {
        for (const stored of [TIMEZONE_OFF, "", null, undefined, 5])
            assert.equal(storedTimezoneToInput(stored), TIMEZONE_OFF, `${JSON.stringify(stored)}`);
    });
});

/**
 * The dialog that has to render it. Read rather than run: it is JSX.
 */
describe("the pause dialog", () => {
    const source = readSource("client/src/common/components/PauseDialog/PauseDialog.jsx");

    it("offers the picker beside the hours it governs", () => {
        assert.match(source, /timezoneOptions/, "the zone list is never rendered");
        assert.match(source, /pause\.timezone/, "the control has no label");
    });

    it("seeds it from the stored setting when the dialog opens", () => {
        assert.match(source, /storedTimezoneToInput/,
            "the picker shows whatever it was left at rather than what is stored");
    });

    /**
     * Writing the key restarts the schedule - node-schedule compiles the zone
     * into the job - so saving a window without having touched the zone must not
     * tear the timer down and build it again for nothing.
     */
    it("only writes the zone when it actually changed", () => {
        const save = source.slice(source.indexOf("const saveQuietHours"));

        assert.match(save.slice(0, save.indexOf("};")), /!==\s*storedTimezoneToInput\(config\.timezone\)/,
            "every save of the quiet hours rebuilds the schedule as well");
    });

    it("labels the sentinel rather than showing it raw", () => {
        assert.match(source, /pause\.timezone_server/,
            '"none" is rendered as itself, which names nothing to a reader');
    });

    // The control is a labelled select, not a bare one: the dialog's other
    // inputs each carry their own label and a reader gets nothing from an
    // unlabelled combo box in the middle of them.
    it("gives the select an accessible name", () => {
        const tag = tagHolding(source, "timezone-select");

        assert.match(tag, /aria-label|id=/, "the zone picker announces as nothing");
    });
});
