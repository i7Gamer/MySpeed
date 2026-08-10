import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    CRON_PRESETS, DEFAULT_CRON, frequencyStateFrom
} from "../../client/src/common/components/FrequencyDialog/frequencyState.js";

/**
 * What the frequency dialog shows for a given stored configuration, as a pure
 * function - because showing something else is exactly the bug this replaces.
 *
 * The dialog used to capture the config in its state initialisers, once, at
 * mount. On an instance with read-level access the page mounts against the
 * visitor config, which deliberately omits cron and scheduleOffset - so after
 * logging in, the dialog still showed "custom, hourly, offset off" over a
 * stored "every half hour, offset off", and the operator concluded an update
 * had eaten their settings. What they then re-saved is what actually changed
 * them.
 */
describe("frequencyStateFrom", () => {
    it("recognises a stored preset", () => {
        const state = frequencyStateFrom({cron: "0,30 * * * *", scheduleOffset: "false"});

        assert.equal(state.selected, "frequent");
        assert.equal(state.customCron, "0,30 * * * *");
        assert.equal(state.showAdvanced, false);
    });

    it("recognises every preset it offers", () => {
        for (const preset of CRON_PRESETS)
            assert.equal(frequencyStateFrom({cron: preset.cron}).selected, preset.id,
                `${preset.cron} did not select ${preset.id}`);
    });

    it("shows a custom expression as custom, with the editor open", () => {
        const state = frequencyStateFrom({cron: "15 4 * * 2", scheduleOffset: "true"});

        assert.equal(state.selected, "custom");
        assert.equal(state.customCron, "15 4 * * 2");
        assert.equal(state.showAdvanced, true);
    });

    it("reads the offset as the boolean it is stored as", () => {
        assert.equal(frequencyStateFrom({cron: DEFAULT_CRON, scheduleOffset: "true"}).scheduleOffset, true);
        assert.equal(frequencyStateFrom({cron: DEFAULT_CRON, scheduleOffset: "false"}).scheduleOffset, false);
    });

    /**
     * The visitor config carries neither key. The dialog is not reachable in
     * view mode, so this is what the old mount-capture handed an admin who
     * logged in - documented here as the shape of the bug, not as a state
     * anyone should see again.
     */
    it("degrades to the defaults when the config carries no schedule at all", () => {
        const state = frequencyStateFrom({});

        assert.equal(state.selected, "custom");
        assert.equal(state.customCron, DEFAULT_CRON);
        assert.equal(state.scheduleOffset, false);
        assert.equal(state.showAdvanced, true);
    });
});
