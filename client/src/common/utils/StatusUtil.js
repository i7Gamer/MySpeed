// How often the status is asked for. A progress bar driven by the old fixed
// five seconds stepped through a run in fifths; polling that fast forever is
// pointless for a page sitting idle overnight.
//
// The fast full poll is the fallback only: a run is normally followed on the
// live route below, and RUNNING_POLL_MS survives for a server that does not
// answer it - a remote node on an older version, reached through the proxy.
export const IDLE_POLL_MS = 5000;
export const RUNNING_POLL_MS = 1000;

/**
 * How often a run is sampled from /status/live, which answers from memory.
 *
 * Any faster runs into the server's own arithmetic: the general API backstop
 * admits 300 requests a minute and cannot tell a progress poll from a person,
 * so the sampling has to leave most of that for the person - 500ms is 120 a
 * minute, which fits under the backstop twice over beside the idle poll. The
 * fill's transition is pinned to this figure, so the bar is always mid-glide
 * when the next sample lands and never visibly waits.
 */
export const LIVE_POLL_MS = 500;

/**
 * How often the *full* status is asked for. With the live route watching the
 * run, the full poll has nothing to hurry for - the last test, the failure
 * count and the schedule cannot change mid-run, and the falling edge refreshes
 * them the moment one ends - so it hurries only for a server without the
 * route.
 */
export const pollIntervalFor = (status, liveCarriesRun = false) =>
    status?.running && !liveCarriesRun ? RUNNING_POLL_MS : IDLE_POLL_MS;

/**
 * Whether a polled status says anything the last one did not.
 *
 * The provider stored every response it parsed, and `response.json()` is a new
 * object each time - so an idle instance re-rendered the whole tree every five
 * seconds saying exactly what it had said before, and every second while a test
 * ran. SpeedtestProvider consumes this context and rebuilds its own value on
 * that render, which reaches TestArea and every un-memoised row; each row calls
 * previousConnection, which walks the list. Three hundred rows on a history
 * from before the isp column is quadratic work to redraw an unchanged screen.
 *
 * Compared as serialised text rather than field by field. The payload is small,
 * flat except for `lastTest`, and both sides of the comparison come from the
 * same server serialising the same object, so the key order is stable - and a
 * field-by-field list is the kind that stops covering a field the day one is
 * added to the route.
 */
export const sameStatus = (previous, next) => JSON.stringify(previous) === JSON.stringify(next);

/**
 * A live sample, landed on the polled status: over it, without disturbing what
 * only the full route knows - the last test, the failure count, the schedule.
 *
 * The previous object is kept when the sample says nothing new, for the same
 * reason sameStatus exists at all: a fresh object twice a second would
 * re-render the whole tree to show what is already on screen. The merge keeps
 * the previous key order, so the serialised comparison holds.
 */
export const withLive = (previous, live) => {
    const next = {...previous, ...live};

    return sameStatus(previous, next) ? previous : next;
};

/**
 * Whether a run ended between two polled statuses.
 *
 * The tests list used to be refetched on a flat five-second interval, mostly
 * to notice finished cron runs - tens of thousands of requests a day on a
 * dashboard left open. A new row can only appear when a run ends, and the only
 * way the page learns about a cron or remote run is the polled `running` flag,
 * so its falling edge is the moment to refresh. A run that merely stops being
 * reported counts as ended: staying quiet there would show a stale list until
 * the next run finished.
 */
export const runJustFinished = (wasRunning, running) => wasRunning === true && running !== true;

const PERCENT = 100;

/**
 * How far through the run is, as a whole percentage, or null if the provider
 * does not say.
 *
 * Only the Ookla CLI reports progress: librespeed's --json suppresses its
 * verbose output and cfspeedtest's silences everything but the result. Those
 * runs must not be drawn as a bar sitting at zero for a minute, which reads as
 * a hung test rather than as an unknown one - so an absent progress is
 * deliberately not treated as zero.
 */
export const progressPercent = (status) => {
    if (typeof status?.progress !== "number" || !Number.isFinite(status.progress)) return null;

    return Math.round(Math.min(Math.max(status.progress, 0), 1) * PERCENT);
};

export const START_BLOCKED_PAUSED = "paused";
export const START_BLOCKED_RUNNING = "running";
export const START_BLOCKED_VIEW_MODE = "view_mode";

/**
 * Why a speedtest cannot be started right now, or null if it can.
 *
 * Shared by the header gauge and the status bar, which each used to decide this
 * for themselves. The server enforces all of it independently - this only
 * decides what the interface offers and what it says when it refuses.
 *
 * Read-only comes first: being told the schedule is paused is no use to someone
 * who could not have started a test either way.
 */
export const startBlockedReason = (status, config) => {
    if (config?.viewMode) return START_BLOCKED_VIEW_MODE;
    if (status?.running) return START_BLOCKED_RUNNING;
    if (status?.paused) return START_BLOCKED_PAUSED;

    return null;
};
