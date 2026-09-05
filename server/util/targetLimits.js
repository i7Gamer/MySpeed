import { measuredPing, usableFigure } from './metricValue.js';

/**
 * Whether one test met its target, the way the screen says it did.
 *
 * The client grades every figure it prints against the optimal values - the
 * target's own where the operator set them, the instance-wide settings
 * everywhere else - and paints a green glyph on a figure that earns the good
 * grade. Nothing aggregated that verdict: the statistics said what share of
 * the target the average reached, and every row wore three colours, but how
 * OFTEN the line delivered was stated nowhere. This is the rule those colours
 * follow, mirrored from client/src/common/utils/TestUtil.js (getIconBySpeed)
 * and TargetUtil.js (resolveLimits) so a test counted as met here is exactly
 * a test with three green glyphs there. tests/client/targetMetParity.test.js
 * holds the two halves together; a change to either threshold breaks it.
 *
 * Duplicated rather than shared on purpose - see TECH_DEBT.md on the shared
 * directory that was reviewed and declined.
 */

// The share of the optimum at which a speed earns the good grade, and the share
// at which a latency stops earning it. The client's SPEED_GOOD and
// LATENCY_FAIR, whose names say which side of the line is good.
const SPEED_GOOD_PERCENT = 75;
const LATENCY_FAIR_PERCENT = 130;

// The client grades the latency it prints, trimmed to one decimal, so a raw
// reading a hundredth over the boundary earns the colour of the figure the
// reader sees. Graded raw here, the same test would count differently.
const LATENCY_DECIMALS = 1;

const PERCENT = 100;

// Number("") and Number(null) are both 0, which would read as a configured
// optimum of zero rather than as an absent one - the client's asTarget makes
// the same refusal.
const optimum = (value) => {
    if (value === null || value === undefined || value === "") return null;

    const figure = Number(value);
    return Number.isFinite(figure) && figure > 0 ? figure : null;
};

/**
 * What a test of this target is graded against, as numbers or null.
 *
 * The target's optimal values where set, the instance-wide settings otherwise -
 * and no target at all (a deleted one, or a row from before targets existed)
 * falls back to the settings wholesale, exactly as the client resolves it.
 * Coerced here where the client leaves the strings the config carries, because
 * the only reader of this copy compares numbers.
 */
export const resolveLimits = (target, config = {}) => ({
    ping: optimum(target?.optimalPing ?? config.ping),
    download: optimum(target?.optimalDownload ?? config.download),
    upload: optimum(target?.optimalUpload ?? config.upload)
});

/**
 * Whether one figure earns the good grade against its optimum.
 *
 * Floored to a whole percent before the comparison, as the client does, so the
 * boundary sits on the same reading in both halves.
 */
export const figureMeets = (figure, limit, higherIsBetter) => {
    const percent = Math.floor((figure / limit) * PERCENT);

    if (!Number.isFinite(percent)) return false;

    return higherIsBetter ? percent >= SPEED_GOOD_PERCENT : percent < LATENCY_FAIR_PERCENT;
};

const trimmedLatency = (ping) => parseFloat(ping.toFixed(LATENCY_DECIMALS));

/**
 * Whether a successful test met its target on every figure it measured.
 *
 * A figure with no optimum to judge against is not judged; neither is a latency
 * nobody measured, which the row stores as the sentinel measuredPing refuses.
 * Null when nothing on the row can be judged at all, which the caller keeps
 * out of both counts rather than reading as a miss.
 */
export const meetsLimits = (entry, limits) => {
    const verdicts = [];

    const ping = measuredPing(entry.ping);
    if (limits.ping !== null && ping !== null) verdicts.push(figureMeets(trimmedLatency(ping), limits.ping, false));

    const download = usableFigure(entry.download);
    if (limits.download !== null && download !== null) verdicts.push(figureMeets(download, limits.download, true));

    const upload = usableFigure(entry.upload);
    if (limits.upload !== null && upload !== null) verdicts.push(figureMeets(upload, limits.upload, true));

    if (verdicts.length === 0) return null;

    return verdicts.every(Boolean);
};

/**
 * How many of a range's successful tests met their target, out of how many
 * could be judged.
 *
 * @param entries   the successful rows - the caller has already dropped the
 *                  failures, whose placeholders are not readings
 * @param limitsFor (targetId) => the limits that row is graded against; null
 *                  for a row whose target left nothing to judge by
 * @returns {{met: number, measured: number}|null} null when no resolver was
 *          handed in - a caller built before targets could be graded here,
 *          which the client reads as a row that does not render
 */
export const targetMetOver = (entries, limitsFor) => {
    if (typeof limitsFor !== "function") return null;

    let met = 0;
    let measured = 0;

    for (const entry of entries) {
        const limits = limitsFor(entry.targetId ?? null);
        if (!limits) continue;

        const verdict = meetsLimits(entry, limits);
        if (verdict === null) continue;

        measured++;
        if (verdict) met++;
    }

    return {met, measured};
};
