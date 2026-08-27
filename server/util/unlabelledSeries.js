/**
 * Whether the instance's newest row may carry the unlabelled Prometheus series
 * when no target leads the round.
 *
 * The unlabelled series - target="" provider="" - is the identity every
 * dashboard built before targets existed still follows, and the documented
 * convention is that it describes the primary target. primaryTarget() is the
 * first *enabled* target, so an instance whose targets all have "Scheduled"
 * switched off has no primary at all: an ISP outage on the WAN target, beside
 * the manual-only iperf3 box this feature exists to support, and nothing in
 * PATCH /targets/:id refuses the last one. The exporter then fell back to the
 * instance-wide newest row - the newest row of *any* target - and two things
 * went wrong at once. A hand-started LAN run at 941 Mbit/s was exported as
 * myspeed_download{target=""}, so a WAN throughput alert went green while the
 * WAN was down; and the same reading went out a second time under target="NAS",
 * because the loop that exports the other targets skips only a primary that
 * exists, so any sum() over the family counted it twice.
 *
 * The question this answers is not "does a target exist" but "could this
 * reading be a different line's". Every configured target exports its own
 * named series, and rows with no targetId are a line of their own - the
 * history of an instance from before targets, which migration 0013 leaves
 * unattributed when the config never named a provider, and what importTests
 * writes for a restored history. So a reading owns the unlabelled identity
 * exactly when nothing else in the instance could be mistaken for it:
 *
 *   - No target is configured. The named loop exports nothing, the rows belong
 *     to nobody, and unlabelled is precisely what this instance exported
 *     before targets existed. This is the case the fallback was written for.
 *   - The row belongs to no target. Same reasoning with targets present: the
 *     named lines are exported under their names, and the unattributed pool is
 *     the only line left for the pre-1.4 identity to mean.
 *   - The row belongs to the one and only target. There is a single line in
 *     the instance and this is it, which is the shape migration 0013 produces
 *     for every install that had chosen a provider. Its caller then leaves the
 *     row out of the named loop, so it is exported once rather than twice.
 *
 * Anything else is a guess between lines, and a guess here is a LAN reading
 * standing in for the internet line. That includes the orphan: a row whose
 * target has been deleted while another target still exists. Those instances
 * export a gap instead, which is what an absent series already means in this
 * exporter - and the named series of every target are still there.
 *
 * This is the distinction alertingScope() draws for the keep-alive, for the
 * same reason: "no target exists" and "no target qualifies" are different
 * questions and must not be spelled the same way.
 *
 * Pure and exported, because that distinction is the whole of the fix and
 * deserves a test that needs no database and no scrape.
 */
export const ownsUnlabelledSeries = (targets, latest) => {
    if (!latest) return false;

    // No named line can compete: the caller's per-target loop has nothing to
    // iterate, so this row cannot be exported twice either.
    if (targets.length === 0) return true;

    // Nullish rather than falsy: an id is never 0 here, but a row read back
    // from sqlite can carry null while a freshly built one carries undefined,
    // and both mean the row belongs to no target.
    if (latest.targetId === null || latest.targetId === undefined) return true;

    return targets.length === 1 && targets[0].id === latest.targetId;
};
