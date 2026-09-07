import * as config from '../controller/config.js';
import * as tests from '../controller/speedtests.js';
import { getByMode } from '../controller/servers.js';
import { degradedRun, isHopTable, runTrace, traceHost } from '../util/traceroute.js';
import { resolveLimits } from '../util/targetLimits.js';
import { toErrorMessage } from '../util/helpers.js';

/**
 * The config key that turns the hop diagnostics on. Off by default: a trace
 * spawns a tool on every degraded run, and an instance that never asked for
 * the table should not pay for one.
 */
export const TRACEROUTE_KEY = "traceroute";

/**
 * How many traces one round may run. Each is awaited inside the running
 * latch for up to its own deadline, so a round of five degraded members
 * would otherwise hold the latch for five deadlines and drop the scheduled
 * run that ticked meanwhile. Two: the first degraded member and one more,
 * which is where a fault common to the whole line has already been seen.
 */
export const MAX_TRACES_PER_ROUND = 2;

let tracesThisRound = 0;

/** Opens the round's budget. Called once per round, ahead of its members. */
export const resetTraceBudget = () => { tracesThisRound = 0; };

/**
 * Traces the route of a run that went badly and writes the table onto its row.
 *
 * Called at the tail of every member's run, success and failure alike, after
 * the row is written and the integrations are told: the trace takes seconds
 * and neither the row nor the notification waits on it. It decides for
 * itself whether the run was degraded - the switch first, so an instance that
 * left it off pays one config read and nothing more.
 *
 * Never throws. It sits at the end of a path whose catch measures the whole
 * member again and writes a second row, and a trace that could not run must
 * not turn a good measurement into a recorded failure.
 *
 * @param test   the row as written, {id, created}
 * @param target the round member, as stored
 * @param facts  what the run found: serverHost and ping on a success, the
 *               baseline verdict, and on a failure whether it was the
 *               provider's own refusal
 * @param deps   the collaborators, replaceable for the tests
 * @returns {{reason: string, host: string, hops: object[]}|null} what was traced, or null
 */
export const diagnoseRun = async (test, target,
    {serverHost = null, ping = null, baselineBreached = null, failed = false, rateLimited = false} = {},
    {getValue = config.getValue, trace = runTrace, save = tests.setHops, servers = getByMode, log = console} = {}) => {
    try {
        if (target?.provider === "preview") return null;
        if (await getValue(TRACEROUTE_KEY) !== "true") return null;

        const limits = resolveLimits(target, {ping: await getValue("ping")});
        const reason = degradedRun({failed, rateLimited, baselineBreached, ping, limits});
        if (reason === null) return null;

        const host = traceHost(target, {serverHost, servers: servers(target.provider) ?? {}});
        if (host === null) return null;

        // Counted whether or not a table comes back: the deadline is what
        // the budget measures, and a silent tool spends it all the same.
        if (tracesThisRound >= MAX_TRACES_PER_ROUND) {
            log.log(`Test #${test.id}: not traced (${reason}), the round's trace budget of ${MAX_TRACES_PER_ROUND} is spent`);
            return null;
        }
        tracesThisRound++;

        const hops = await trace(host);
        if (hops === null) return null;

        // The readers - the pane, both exports, the import - all run the
        // table through isHopTable and drop one it refuses without a word.
        // A table written that they will not read is logged here as a
        // success and then invisible, so it is refused on the way in.
        if (!isHopTable(hops)) {
            log.log(`Test #${test.id}: not traced (${reason}), the trace to ${host} produced no readable table`);
            return null;
        }

        await save(test.id, hops);
        log.log(`Test #${test.id}: traced ${hops.length} hops to ${host} (${reason})`);

        return {reason, host, hops};
    } catch (error) {
        log.error(`Could not trace the route for test #${test?.id}: ${toErrorMessage(error)}`);
        return null;
    }
};
