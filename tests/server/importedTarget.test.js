import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { targetIndex, importedTargetId } from "../../server/controller/targets.js";

/**
 * Which target a restored history row belongs to.
 *
 * A history backup carries each row's targetId, and those ids belong to the
 * instance that wrote the file. Written back through, as the import used to do,
 * they did not merely fail to mean anything: a backup restored onto an instance
 * that already measures its own lines handed every row of the old "Ookla
 * Frankfurt" to whatever holds id 1 here - filtered under it, graded against
 * its optimal values, counted into its statistics and re-exported under its
 * name, with nothing anywhere saying so.
 *
 * The id is therefore not read at all. The export writes each row's target
 * *name* beside it, and the name is resolved against the targets this instance
 * holds - always, whatever else is true of the instance. Every rule that also
 * weighed the destination's state (an empty history read as "this is a
 * rebuild") gave one file two different answers, and a cron tick or a retried
 * import was enough to flip it in the middle of a recovery; the integration
 * suite drives those orders end to end.
 *
 * What is left is deterministic and idempotent, and the cost is disclosed: a
 * target renamed between the export and the import resolves to nothing, so its
 * rows land in the history unattributed rather than under a target that never
 * measured them.
 */
const localTargets = (...rows) => targetIndex(rows);

const WAN = {id: 1, name: "WAN"};
const LAN = {id: 7, name: "LAN iperf3"};

describe("importedTargetId", () => {
    it("attributes a row to the local target its exported name answers to", () => {
        assert.equal(importedTargetId({targetId: 1, targetName: "LAN iperf3"}, localTargets(WAN, LAN)), 7);
    });

    // The regression itself: the old import stored the file's 1, which is a
    // local target that never ran the measurement.
    it("refuses an id a local target of another name holds", () => {
        assert.equal(importedTargetId({targetId: 1, targetName: "Frankfurt"}, localTargets(WAN, LAN)), null);
    });

    /**
     * The id is not a tiebreak, a fallback, or a hint. Whatever it says, the
     * name decides - which is what makes two imports of one file agree.
     */
    it("reads nothing at all from the row's own id", () => {
        const local = localTargets(WAN, LAN);

        for (const targetId of [1, 7, 999, undefined, null, "7", -1, 0])
            assert.equal(importedTargetId({targetId, targetName: "LAN iperf3"}, local), 7,
                `a targetId of ${JSON.stringify(targetId) ?? "undefined"} moved the row off its name`);
    });

    /**
     * The disclosed cost of that, pinned rather than left to be rediscovered:
     * a target renamed since the export answers to nothing, so its rows are
     * imported with no target. They stay in the history and in every "all
     * targets" view, where an orphan is visible; the alternative was filing
     * them under whatever wears the name now, which is not.
     */
    it("orphans a row whose name no local target answers to", () => {
        assert.equal(importedTargetId({targetId: 1, targetName: "WAN (old ISP)"}, localTargets(WAN, LAN)), null);
        assert.equal(importedTargetId({targetId: 4, targetName: "WAN (old ISP)"}, localTargets(WAN, LAN)), null);
        assert.equal(importedTargetId({targetId: 1, targetName: "WAN"}, localTargets()), null);
    });

    /**
     * A file written before the export carried names - every backup taken by
     * an instance older than this column - has nothing here to resolve, so
     * every row of it is imported unattributed. There is no fallback to the
     * raw id, because that fallback is the re-attribution above.
     */
    it("orphans every row of a file that carries no target names", () => {
        const local = localTargets(WAN, LAN);

        for (const targetName of [undefined, null, 3, {name: "WAN"}, ["WAN"], ""])
            assert.equal(importedTargetId({targetId: 1, targetName}, local), null,
                `a targetName of ${JSON.stringify(targetName) ?? "undefined"} was read as a name`);
    });

    // exportTests carries targetName and no targetId at all, so a dashboard
    // export is placed by exactly the same rule as a backup.
    it("places a row that carries no id by its name", () => {
        assert.equal(importedTargetId({targetName: "LAN iperf3"}, localTargets(WAN, LAN)), 7);
        assert.equal(importedTargetId({targetName: "Frankfurt"}, localTargets(WAN, LAN)), null);
    });

    /**
     * Idempotence stated as an assertion, because it is the property the whole
     * rule was rewritten for: the answer is a function of the row and the
     * targets, so a retried or split import cannot attribute the second half
     * of a file differently from the first.
     */
    it("answers the same for one row however often it is asked", () => {
        const local = localTargets(WAN, LAN);
        const row = {targetId: 7, targetName: "WAN"};

        const answers = [importedTargetId(row, local), importedTargetId(row, local), importedTargetId(row, local)];

        assert.deepEqual(answers, [1, 1, 1]);
    });

    /**
     * The trap targetProblem, importConfig and the integrations controller were
     * each fixed for separately. On a plain object every one of these names is
     * present through Object.prototype, so a hand-edited backup would attribute
     * its rows to a function.
     */
    it("does not read a prototype name as a target", () => {
        for (const targetName of ["toString", "constructor", "__proto__", "hasOwnProperty"])
            assert.equal(importedTargetId({targetId: 1, targetName}, localTargets(WAN)), null,
                `${targetName} was read off the prototype as a target`);
    });

    it("still finds a target genuinely called that", () => {
        assert.equal(importedTargetId({targetId: 1, targetName: "toString"},
            localTargets(WAN, {id: 5, name: "toString"})), 5);
    });
});

describe("targetIndex", () => {
    const index = (...rows) => targetIndex(rows);

    it("indexes the targets both ways", () => {
        const {byName, byId} = index(WAN, LAN);

        assert.equal(byName.get("LAN iperf3"), 7);
        assert.equal(byId.get(7), "LAN iperf3");
    });

    // Nothing stops two targets sharing a name, so the answer must not depend
    // on the order the rows come back in: the first in round order wins.
    it("gives a duplicated name to the first target in round order", () => {
        const {byName} = index({id: 4, name: "WAN"}, {id: 9, name: "WAN"});

        assert.equal(byName.get("WAN"), 4);
    });

    it("holds an operator's prototype name as an ordinary key", () => {
        const {byName} = index({id: 3, name: "__proto__"});

        assert.equal(byName.get("__proto__"), 3);
        assert.equal(Object.getPrototypeOf(byName), Map.prototype);
    });

    it("is empty for an instance with no targets", () => {
        const {byName, byId} = index();

        assert.equal(byName.size, 0);
        assert.equal(byId.size, 0);
    });
});
