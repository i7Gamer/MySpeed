// How often the status is asked for. A progress bar driven by the old fixed
// five seconds stepped through a run in fifths; polling that fast forever is
// pointless for a page sitting idle overnight.
export const IDLE_POLL_MS = 5000;
export const RUNNING_POLL_MS = 1000;

export const pollIntervalFor = (status) => status?.running ? RUNNING_POLL_MS : IDLE_POLL_MS;

const PERCENT = 100;

// The one route that renders the status bar, and so the one route whose header
// does not need its own start button.
const OVERVIEW_PATH = "/";

export const showsStatusBar = (pathname) => pathname === OVERVIEW_PATH;

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
    if (typeof status?.progress !== "number") return null;

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
