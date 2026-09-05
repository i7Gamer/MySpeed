/**
 * The digest tick: aggregate the window, word it, hand it to the notifiers.
 *
 * Nothing is aggregated until somebody asked for it - the pre-scan keeps an
 * instance that never opted in from paying a whole-range scan every week.
 * The weekly kind leans on comparePrevious (seven days back IS the previous
 * week); the monthly kind aggregates its explicit compare month itself,
 * because an equal-length span before March 1st is Jan 29 - Feb 28 - see
 * digestRanges.
 *
 * A tick the process was down for is a digest that never goes out - accepted
 * for v1 and stated here rather than papered over: persisting a
 * last-digest marker in the config would announce itself to every subscribed
 * webhook as a configUpdated event on each run, which is a worse surprise
 * than a quiet missed week after an outage.
 *
 * The collaborators ride in as options so the matrix in
 * tests/server/digestTask.test.js can execute every branch without a
 * database; the defaults are the real thing.
 */
import { getActive, triggerEvent, wantsDigest } from "../controller/integrations.js";
import { listStatistics } from "../controller/speedtests.js";
import { digestRanges, digestText } from "../util/digestReport.js";
import { zoneFromName } from "../util/timezone.js";

export const runDigest = async (kind, {
    now = new Date(), timezone,
    aggregate = listStatistics, active = getActive, notify = triggerEvent
} = {}) => {
    const rows = await active();
    if (!rows.some(({data}) => wantsDigest(data, kind))) return null;

    const zone = zoneFromName(timezone);
    const {range, compare, comparePrevious, label} = digestRanges(kind, now, zone);

    // `compare`, which is what listStatistics gates the previous window on.
    // It was `comparePrevious` until the statistics grew named offsets and the
    // option was renamed with them; this call was not, so the digest went on
    // asking for a comparison nothing was listening for. The summary came back
    // without `previous`, digestText dropped the whole "vs previous week" line,
    // and nothing errored - see tests/integration/digestComparison.test.js,
    // which pins the two spellings against the function that reads them.
    const summary = await aggregate(range, {zone, now, ...(comparePrevious ? {compare: true} : {})});
    const compareSummary = comparePrevious
        ? summary.previous ?? null
        : await aggregate(compare, {zone, now});

    const payload = {
        kind,
        text: digestText(summary, compareSummary, kind, label, zone),
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        tests: summary.tests
    };

    await notify("digestReady", payload);
    return payload;
};
