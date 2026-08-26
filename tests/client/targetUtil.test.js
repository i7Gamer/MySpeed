import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import {
    ALL_TARGETS, pageTarget, previousOfTarget, resolveLimits, roundIndexById, selectedTargetId,
    targetColour
} from "@/common/utils/TargetUtil.js";

/**
 * The client half of the per-target grading, mirroring resolveLimits in
 * server/controller/targets.js: a target's own optimal values where set, the
 * instance-wide settings everywhere else - per metric, so a target can pin
 * its download and leave its ping global.
 */
describe("resolveLimits", () => {
    const config = {ping: "25", download: "100", upload: "50"};

    it("falls back to the config wholesale when there is no target", () => {
        assert.deepEqual(resolveLimits(undefined, config),
            {ping: "25", download: "100", upload: "50"});
        assert.deepEqual(resolveLimits(null, config),
            {ping: "25", download: "100", upload: "50"});
    });

    it("prefers the target's own values", () => {
        assert.deepEqual(resolveLimits(
            {optimalPing: 10, optimalDownload: 500, optimalUpload: 250}, config),
            {ping: 10, download: 500, upload: 250});
    });

    // The per-metric half: null means "inherit", it is how the editor stores
    // a blank field under an enabled own-optimals toggle.
    it("mixes per metric rather than per target", () => {
        assert.deepEqual(resolveLimits({optimalDownload: 500, optimalPing: null,
            optimalUpload: null}, config), {ping: "25", download: 500, upload: "50"});
    });

    // A configured zero is not a threshold anywhere else in the app, but the
    // resolver's job is only to choose whose value wins - the graders keep
    // their own guards.
    it("treats only null and undefined as inherit", () => {
        assert.equal(resolveLimits({optimalPing: 0}, config).ping, 0);
    });

    it("answers with undefineds before the config has loaded", () => {
        assert.deepEqual(resolveLimits(undefined, {}),
            {ping: undefined, download: undefined, upload: undefined});
    });
});

/**
 * The colours come from the chart series tokens, which exist in every palette
 * and both themes and are held legible by the palette-contrast tests - so a
 * dot never needs a palette of its own.
 */
describe("targetColour", () => {
    it("hands out chart series variables", () => {
        assert.equal(targetColour(0), "var(--chart-download)");
        assert.equal(targetColour(1), "var(--chart-upload)");
    });

    it("cycles rather than running out", () => {
        assert.equal(targetColour(6), targetColour(0));
        assert.equal(targetColour(13), targetColour(1));
    });

    // roundIndexById answers -1 for an unknown id, and the callers that guard
    // it imperfectly must still get a colour rather than an undefined token.
    it("survives a negative index", () => {
        assert.match(targetColour(-1), /^var\(--chart-[a-z]+\)$/);
    });
});

/**
 * Which earlier test a row is compared against.
 *
 * Every "since last time" figure in the detail pane is a difference between
 * two measurements, and a round now interleaves its targets in one list - so
 * the row before is routinely a different target. Comparing across them is
 * arithmetic on unrelated quantities: a LAN target's 940 Mbit/s against an
 * internet target's 95 reads as the line having lost ninety percent overnight.
 */
describe("previousOfTarget", () => {
    // Newest first, exactly as the list endpoint answers: two targets
    // alternating, which is what a two-target round writes.
    const interleaved = [
        {id: 6, targetId: 1}, {id: 5, targetId: 2},
        {id: 4, targetId: 1}, {id: 3, targetId: 2}
    ];

    it("skips the other target's rows to find a comparable one", () => {
        assert.equal(previousOfTarget(interleaved, 0).id, 4,
            "the newest row was compared against the other target's measurement");
        assert.equal(previousOfTarget(interleaved, 1).id, 3);
    });

    it("answers nothing when this target has no earlier test in the list", () => {
        assert.equal(previousOfTarget(interleaved, 2), undefined,
            "a wrong comparison is worse than no change figures");
        assert.equal(previousOfTarget([{id: 1, targetId: 1}], 0), undefined);
    });

    // A history recorded before targets existed carries no targetId at all,
    // and those rows are all of one kind - each being a category of one would
    // silently drop the change figures from every legacy row.
    it("keeps a history that names no target comparable with itself", () => {
        const legacy = [{id: 3}, {id: 2, targetId: null}, {id: 1}];

        assert.equal(previousOfTarget(legacy, 0).id, 2,
            "an absent column and a null column are the same absence");
        assert.equal(previousOfTarget(legacy, 1).id, 1);
    });

    // Deleting a target orphans its rows rather than removing them: they keep
    // the id of a target that is gone, so they stay comparable with each other
    // and stay apart from the rows of a target that still exists.
    it("keeps an orphaned target's rows to themselves", () => {
        const orphans = [{id: 3, targetId: 9}, {id: 2, targetId: 1}, {id: 1, targetId: 9}];

        assert.equal(previousOfTarget(orphans, 0).id, 1);
    });

    it("survives a list that is not there yet", () => {
        assert.equal(previousOfTarget(undefined, 0), undefined);
        assert.equal(previousOfTarget([], 0), undefined);
    });
});

/**
 * And both views that show change figures walk that way, rather than taking
 * the row before - which is the spelling that was wrong.
 */
describe("the views that compare one test against an earlier one", () => {
    it("the overview list", () => {
        const area = readSource("client/src/pages/Home/components/TestArea/TestAreaComponent.jsx");

        assert.match(area, /previous=\{previousOfTarget\(speedtests, index\)\}/,
            "a row is compared against whichever target the round measured next");
    });

    it("the statistics latest-test card", () => {
        const statistics = readSource("client/src/pages/Statistics/Statistics.jsx");

        assert.match(statistics, /previousOfTarget\(recentTests, 0\)/,
            "the latest test is compared against another target's measurement");
    });
});

describe("roundIndexById", () => {
    const targets = [{id: 7}, {id: 3}];

    it("answers the position in round order", () => {
        assert.equal(roundIndexById(targets, 7), 0);
        assert.equal(roundIndexById(targets, 3), 1);
    });

    it("answers -1 for a target that is gone", () => {
        assert.equal(roundIndexById(targets, 99), -1);
        assert.equal(roundIndexById([], 7), -1);
    });
});

/**
 * Which target the views are narrowed to. Null is "all of them", and it is
 * also every answer the stored preference cannot honestly give: a deleted
 * target, or an instance where the chips are not even drawn - filtering there
 * would leave no visible way to unfilter.
 */
describe("selectedTargetId", () => {
    const targets = [{id: 1}, {id: 2}];
    // The node the chip was clicked on travels with the choice - see below.
    const chose = (id, node = null) => ({selectedTarget: id, selectedTargetNode: node});

    it("answers the stored selection while it exists", () => {
        assert.equal(selectedTargetId(chose(2), targets, null), 2);
    });

    it("answers null for the all-targets chip", () => {
        assert.equal(selectedTargetId(chose(ALL_TARGETS), targets, null), null);
    });

    it("answers null for a selection that was deleted", () => {
        assert.equal(selectedTargetId(chose(99), targets, null), null);
    });

    it("answers null when there are not two targets to choose between", () => {
        assert.equal(selectedTargetId(chose(1), [{id: 1}], null), null);
        assert.equal(selectedTargetId(chose(1), [], null), null);
    });

    it("answers null before any preference exists", () => {
        assert.equal(selectedTargetId(undefined, targets, null), null);
        assert.equal(selectedTargetId({}, targets, null), null);
    });

    /**
     * The preference is one value in one browser, and target ids are
     * per-instance: id 2 on the node being looked at is a different target
     * from the id 2 the chip was clicked on. Carried across, the filter
     * re-aimed itself at an unrelated target and hid most of that node's
     * history - and because the chip row relabels itself, the page stayed
     * internally consistent and said nothing about it.
     */
    it("does not carry a choice made on another instance", () => {
        assert.equal(selectedTargetId(chose(2, "7"), targets, "7"), 2,
            "the node it was chosen on is the node it applies to");
        assert.equal(selectedTargetId(chose(2, "7"), targets, "9"), null,
            "another node's chip selection re-aimed itself by id");
        assert.equal(selectedTargetId(chose(2, "7"), targets, null), null,
            "a remote node's choice followed the viewer back to the local instance");
    });

    // The local instance is the absent selection rather than an id, and a
    // preference written before this rule existed carries no node at all -
    // both are "no node", and neither may match a real one.
    it("treats a missing node and the local instance as the same instance", () => {
        assert.equal(selectedTargetId({selectedTarget: 2}, targets, null), 2);
        assert.equal(selectedTargetId({selectedTarget: 2}, targets, undefined), 2);
        assert.equal(selectedTargetId({selectedTarget: 2}, targets, "7"), null,
            "a preference from before the node was recorded was applied to a node");
    });
});

/**
 * The target a whole page is showing, which is not quite the chip selection:
 * an instance with one target draws no chips, so nothing is selected - but
 * every row on the page still belongs to that target, and the page's own
 * summaries have to be judged the same way its rows are.
 */
describe("pageTarget", () => {
    const one = [{id: 1, optimalDownload: 500}];
    const two = [{id: 1, optimalDownload: 500}, {id: 2}];

    it("is the sole target of an instance that draws no chips", () => {
        assert.deepEqual(pageTarget(one, {}, null), one[0],
            "the statistics cards graded against the global optima while every "
            + "row beside them was graded against this target's own");
    });

    it("is the chipped target when there are chips", () => {
        assert.deepEqual(pageTarget(two, {selectedTarget: 1, selectedTargetNode: null}, null), two[0]);
    });

    it("is nothing when the page is showing a mixture", () => {
        assert.equal(pageTarget(two, {}, null), null,
            "an average across targets can only be judged by the global settings");
    });

    it("is nothing before any target has arrived", () => {
        assert.equal(pageTarget([], {}, null), null);
    });
});
