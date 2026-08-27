import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ownsUnlabelledSeries } from "../../server/util/unlabelledSeries.js";

/**
 * The unlabelled Prometheus series - target="" provider="" - is the identity
 * every dashboard built before targets existed still follows, and the exporter
 * gives it to the primary target. primaryTarget() is the first *enabled*
 * target, so an instance whose targets all have "Scheduled" switched off has no
 * primary at all, and the exporter used to answer that with the newest row of
 * any target: a hand-started LAN run wearing the identity a WAN alert reads.
 *
 * This is the judgement that replaced the fallback. The question is not "does a
 * target exist" - that one deletes the series from the single-target instance
 * migration 0013 produces for every install that had chosen a provider, and
 * from an instance whose whole history belongs to no target - it is "could this
 * reading be a different line's".
 */
describe("ownsUnlabelledSeries", () => {
    const target = (id) => ({id, name: `target-${id}`, provider: "ookla"});
    const row = (targetId) => ({id: 1, download: 250, targetId});

    it("refuses when there is no reading at all", () => {
        assert.equal(ownsUnlabelledSeries([], undefined), false);
        assert.equal(ownsUnlabelledSeries([target(1)], undefined), false);
        assert.equal(ownsUnlabelledSeries([], null), false,
            "an instance that has never tested would export a series made of nothing");
    });

    /**
     * The instance the fallback was written for: it upgraded without ever
     * having chosen a provider, so migration 0013 seeded no target and left its
     * history unattributed. Nothing else exports a series here - the per-target
     * loop has nothing to iterate - so the reading cannot be mistaken for
     * another line, and cannot be exported twice either.
     */
    it("accepts anything on an instance with no targets", () => {
        assert.equal(ownsUnlabelledSeries([], row(null)), true);
        assert.equal(ownsUnlabelledSeries([], row(undefined)), true);

        // Every target deleted, its rows kept: the model says so in as many
        // words - "a deleted target's history is still history".
        assert.equal(ownsUnlabelledSeries([], row(7)), true,
            "deleting the last target takes the whole measurement export with it");
    });

    /**
     * Rows with no targetId are a line of their own, and one no named series
     * speaks for: importTests writes them for a restored history, and 0013
     * leaves them behind. The named targets export under their names, so the
     * unattributed pool is the only line the pre-1.4 identity can still mean.
     */
    it("accepts a reading that belongs to no target, whatever else is configured", () => {
        assert.equal(ownsUnlabelledSeries([target(1)], row(null)), true);
        assert.equal(ownsUnlabelledSeries([target(1), target(2)], row(null)), true);
        assert.equal(ownsUnlabelledSeries([target(1), target(2)], row(undefined)), true);
    });

    /**
     * One target is one line, which is the shape 0013 produces for every
     * install that had chosen a provider. Unticking Scheduled there must not
     * blank a pre-1.4 dashboard: the only defect in that state was that the
     * same row went out unlabelled *and* under its own name, and the caller
     * cures that by leaving this target out of the named loop.
     */
    it("accepts the sole target's own reading", () => {
        assert.equal(ownsUnlabelledSeries([target(4)], row(4)), true);
    });

    /**
     * The failure the branch exists for. With two targets and nothing leading
     * the round, whichever ran last is a guess between lines - and the guess
     * that started this was a 941 Mbit/s LAN run exported as the internet line
     * while the WAN was down.
     */
    it("refuses a reading that competes with another line", () => {
        assert.equal(ownsUnlabelledSeries([target(1), target(2)], row(2)), false);
        assert.equal(ownsUnlabelledSeries([target(1), target(2)], row(1)), false);
    });

    /**
     * An orphan is a deleted line's reading, not the instance's. While a target
     * still stands to own the identity honestly, handing it to a line the
     * operator removed is the same wrong-line claim in slower motion.
     */
    it("refuses an orphan while a target still stands", () => {
        assert.equal(ownsUnlabelledSeries([target(1)], row(99)), false);
    });
});
