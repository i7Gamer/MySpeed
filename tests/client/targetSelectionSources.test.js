import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blockEnd, readSource } from "../helpers/source.js";
import { chipIsStale, NO_SELECTION } from "@/common/utils/TargetUtil.js";

const context = readSource("client/src/common/contexts/Targets/TargetsContext.jsx");
const toolbar = readSource("client/src/common/components/PageToolbar/PageToolbar.jsx");

/** The braced body containing `marker`, lifted out of a file node cannot parse. */
const bodyAround = (source, marker) => {
    const at = source.indexOf(marker);
    assert.notEqual(at, -1, `"${marker}" is not in this source`);

    const open = source.lastIndexOf("{", at);
    return source.slice(open, blockEnd(source, open) + 1);
};

/**
 * The one reader of the chip preference that writes.
 *
 * Every other consumer answers a render and is corrected by the next one. This
 * effect deletes the preference and persists it, and nothing brings it back -
 * so it is the one place where reading the stored chip against a target list
 * that belongs to a different instance is permanent rather than momentary. That
 * pair really does occur: switching nodes neither remounts this provider nor
 * empties the list during render, and the reset is an effect, so there is a
 * commit holding the destination node beside the node just left's targets.
 *
 * The effect is three lines inside a JSX file, which node cannot parse - so the
 * body is lifted out as text and run with its inputs supplied by hand, the way
 * loadRaces.test.js runs the fetch callbacks it is about. A scan would pass
 * against a call that had quietly lost its fourth argument; this does not,
 * because the helper it calls is the real one.
 */
describe("the effect that clears a dead chip", () => {
    const clearingEffect = bodyAround(context, "if (chipIsStale(");

    const runWith = ({preferences, targets, currentNode, targetsNode}) => {
        const written = [];
        const body = new Function(
            "chipIsStale", "NO_SELECTION", "preferences", "targets", "currentNode",
            "targetsNode", "updatePreferences", `return () => ${clearingEffect};`)(
            chipIsStale, NO_SELECTION, preferences, targets, currentNode, targetsNode,
            (partial) => written.push(partial));

        body();
        return written;
    };

    const chose = (id, node = null) => ({selectedTarget: id, selectedTargetNode: node});
    const twoTargets = [{id: 1}, {id: 2}];

    it("throws away a chip whose target this instance no longer has", () => {
        assert.deepEqual(runWith({
            preferences: chose(99), targets: twoTargets, currentNode: null, targetsNode: null
        }), [NO_SELECTION], "a dead chip narrows the first request of every load to a "
            + "target the page is about to stop filtering by");
    });

    it("leaves a chip that still names a target here", () => {
        assert.deepEqual(runWith({
            preferences: chose(2), targets: twoTargets, currentNode: null, targetsNode: null
        }), []);
    });

    it("writes nothing while no list has arrived", () => {
        assert.deepEqual(runWith({
            preferences: chose(99), targets: null, currentNode: null, targetsNode: null
        }), [], "a fetch in flight, or one that failed, is not proof a target is gone");
    });

    /**
     * The blocking case. Clicking another node's card calls setCurrentNode and
     * nothing else - no reload, no remount - so this effect's very next run
     * holds the new node beside the old node's list.
     */
    it("does not delete the destination node's chip against the list of the node just left", () => {
        assert.deepEqual(runWith({
            preferences: chose(9, "5"), targets: twoTargets, currentNode: "5", targetsNode: "4"
        }), [], "target 9 is alive on node 5; the list that said otherwise was node 4's");

        assert.deepEqual(runWith({
            preferences: chose(9, "5"), targets: [{id: 9}], currentNode: "5", targetsNode: "4"
        }), [], "and a source instance with one target deleted it whatever it named");
    });

    it("does not delete the local instance's chip on the way back to it", () => {
        assert.deepEqual(runWith({
            preferences: chose(2), targets: [{id: 1}], currentNode: null, targetsNode: "5"
        }), []);
    });

    it("judges again as soon as the list is the instance being looked at", () => {
        assert.deepEqual(runWith({
            preferences: chose(9, "5"), targets: twoTargets, currentNode: "5", targetsNode: "5"
        }), [NO_SELECTION], "the provenance guard must not become a way of never clearing "
            + "anything on a remote node - a chip that is genuinely dead there still goes");
    });

    it("does not re-fire on its own write", () => {
        assert.deepEqual(runWith({
            preferences: NO_SELECTION, targets: twoTargets, currentNode: null, targetsNode: null
        }), []);
    });
});

/**
 * What makes the pair above trustworthy: the node the list was fetched from is
 * written in exactly one place, beside the drop of the list itself.
 *
 * Cannot be executed - it is an ordering fact about one effect - but it is the
 * whole invariant. A targetsNode written anywhere else could describe a
 * different instance from the list beside it, which is the state the guard
 * exists to detect.
 */
describe("where the target list's node is recorded", () => {
    it("is written only where the list is dropped", () => {
        assert.equal(context.split("setTargetsNode(").length - 1, 1,
            "two writers of this value would be two chances for it to disagree with "
            + "the list it describes");

        const reset = bodyAround(context, "setTargets(null);");
        assert.match(reset, /setTargets\(null\);[\s\S]*setTargetsNode\(currentNode\);/,
            "and after the drop, so a pair somehow read apart says no-list-yet rather "
            + "than this node's name over the node just left's targets");
    });

    it("is state rather than a ref", () => {
        assert.match(context, /const \[targetsNode, setTargetsNode] = useState\(currentNode\)/,
            "it is read from an effect's closure next to the list it describes, and a "
            + "ref would hand that closure a value from a later commit");
        assert.match(context, /}, \[preferences, targets, currentNode, targetsNode, updatePreferences]\);/,
            "and the effect has to re-run when it moves");
    });
});

/**
 * The rest of the wiring this change rests on, none of which can be run: a
 * rename or a dropped argument in any of them puts the reported behaviour back
 * with every assertion above still green.
 */
describe("what the provider hands out", () => {
    it("narrows the pages by the stored chip while the list is still due", () => {
        assert.match(context, /selectedTarget: queryTargetId\(preferences, answerPending \? null : list, currentNode\)/);
        assert.match(context, /const answerPending = targets === null && !targetsFailed;/,
            "the guess is only allowed while something is due to correct it");
    });

    it("ends the guess when the fetch has failed", () => {
        const failure = context.slice(context.indexOf("} catch {"), context.indexOf("}, []);"));

        assert.match(failure, /if \(!superseded\(\)\) setTargetsFailed\(true\);/,
            "nothing retries that fetch, so an unended guess filters every page for the "
            + "session with no chip row on screen able to clear it");
        assert.match(context, /}, \[targets, targetsFailed, preferences, currentNode, reloadTargets]\);/,
            "and the value has to be rebuilt when it changes");
    });

    it("keeps the guess out of the one reader that cannot re-ask", () => {
        assert.match(context, /confirmedTarget: selectedTargetId\(preferences, list, currentNode\)/);
        assert.match(toolbar, /const exportTarget = confirmedTarget;/,
            "a download cannot be taken back, and a guessed filter naming a deleted "
            + "target would write an empty backup with the right name on it");
        assert.doesNotMatch(toolbar, /selectedTarget/,
            "reading the guessed value here is the whole defect");
    });
});
