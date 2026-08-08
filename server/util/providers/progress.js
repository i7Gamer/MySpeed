import { roundSpeed } from './parseData.js';

// The phases a run moves through, in the order it runs them.
export const PHASE_ORDER = ["ping", "download", "upload"];

// What the run reports before it has entered the first phase.
export const PHASE_START = "start";

/**
 * How much of a whole run each phase accounts for.
 *
 * Measured rather than guessed: in a real run the latency phase takes about a
 * second against roughly ten for each transfer. A bar weighted evenly would sit
 * at a third before the download had begun.
 */
const PHASE_SHARE = {ping: 0.1, download: 0.45, upload: 0.45};

const clamp = (value) => {
    if (!Number.isFinite(value)) return 0;
    return Math.min(Math.max(value, 0), 1);
};

/**
 * Turns one line of a provider's streamed output into what the interface needs
 * to describe the run: which phase it is in, how far through that phase it is,
 * and what it is currently measuring.
 *
 * Only Ookla streams. Librespeed and Cloudflare report once, at the end, so
 * nothing may be reported for them - a bar that advances on its own would be
 * worse than no bar at all.
 *
 * Returns null for anything that is not progress, including the result line:
 * that is the outcome, and announcing it here would have the interface call the
 * run finished before the row had been written.
 */
export const parseProgressLine = (mode, line) => {
    if (mode !== "ookla" || typeof line !== "string" || !line.startsWith("{")) return null;

    let data;
    try {
        data = JSON.parse(line);
    } catch (e) {
        // A chunk boundary can split a line in half. The next read carries it.
        return null;
    }

    if (data.type === "testStart") return {phase: PHASE_START, progress: 0, speed: null};
    if (!PHASE_ORDER.includes(data.type)) return null;

    const detail = data[data.type] ?? {};
    const speed = Number.isFinite(detail.bandwidth) ? roundSpeed(detail.bandwidth) : null;

    return {phase: data.type, progress: clamp(detail.progress), speed};
};

/**
 * Where a run is overall, as a fraction, counting the phases already behind it.
 */
export const overallProgress = (phase, progress) => {
    if (phase === PHASE_START) return 0;

    const index = PHASE_ORDER.indexOf(phase);
    if (index === -1) return 0;

    const completed = PHASE_ORDER.slice(0, index).reduce((total, done) => total + PHASE_SHARE[done], 0);

    return clamp(completed + PHASE_SHARE[phase] * clamp(progress));
};
