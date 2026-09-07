import * as tests from './speedtests.js';
import * as targetsController from './targets.js';
import { isFailedTest, measuredPing, usableFigure } from '../util/testOutcome.js';
import { BADGE_STATUS } from '../util/badge.js';

/**
 * What the status badge says about the instance: the newest test of the
 * headline line, as a status and three readings.
 *
 * The line is the one every other instance-wide surface names - the first of
 * headlineOrder that has measured anything - so the badge and the OpenGraph
 * card describe the same line. Only the second of the card's two walks,
 * though: the card wants a window with averages in it, where a badge wants
 * the newest row whatever its age, and that is one indexed read per target
 * rather than a statistics pass. An instance with rows attributed to no
 * target - a pre-target install, an import that could not resolve a name -
 * falls through to the instance-wide newest row, for the reason the card
 * does.
 *
 * Read through the same readers the card goes through: a run can carry a
 * placeholder in one column beside real figures, and a provider that
 * measured no latency stores the sentinel 0. Copied raw, the badge would
 * print "-1 Mbps" and "0 ms".
 */
export const readBadge = async () => {
    let latest;

    for (const target of await targetsController.headlineOrder()) {
        latest = await tests.getLatest(target.id);
        if (latest !== undefined) break;
    }

    latest ??= await tests.getLatest();

    if (latest === undefined) return {status: BADGE_STATUS.UNKNOWN};
    if (isFailedTest(latest)) return {status: BADGE_STATUS.DOWN};

    return {
        status: BADGE_STATUS.UP,
        download: usableFigure(latest.download),
        upload: usableFigure(latest.upload),
        ping: measuredPing(latest.ping)
    };
};
