import { BITS_PER_BYTE, roundSpeed } from './parseData.js';
import { IPERF_DURATION_SECONDS } from './registry.js';

// The phases a run moves through, in the order it runs them.
export const PHASE_ORDER = ["ping", "download", "upload"];

// The two that move data, which are the only ones a transfer's own progress
// records can describe.
export const TRANSFER_PHASES = ["download", "upload"];

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
 *
 * `durationSeconds` is how long this particular iperf3 invocation was asked to
 * measure for, which only the caller that built the arguments knows. Defaulted
 * to the shipped figure so every other provider's caller, and every reading of
 * an untuned target, is unchanged.
 */
export const parseProgressLine = (mode, line, phase, durationSeconds = IPERF_DURATION_SECONDS) => {
    if (typeof line !== "string" || !line.startsWith("{")) return null;
    if (mode !== "ookla" && mode !== "iperf3") return null;

    let data;
    try {
        data = JSON.parse(line);
    } catch {
        // A chunk boundary can split a line in half. The next read carries it.
        return null;
    }

    if (mode === "iperf3") return iperf3Progress(data, phase, durationSeconds);

    if (data.type === "testStart") return {phase: PHASE_START, progress: 0, speed: null};
    if (!PHASE_ORDER.includes(data.type)) return null;

    const detail = data[data.type] ?? {};
    const speed = Number.isFinite(detail.bandwidth) ? roundSpeed(detail.bandwidth) : null;

    return {phase: data.type, progress: clamp(detail.progress), speed};
};

/**
 * One line of iperf3's --json-stream output, as progress.
 *
 * Its records name no phase - an interval describes whichever direction this
 * invocation was started for, and only the runner knows which - so the phase
 * is passed in beside the line. A run with no phase is not one of the two
 * transfers and has nothing to report.
 *
 * How far through comes from the interval's own clock against the duration the
 * arguments asked for, because iperf3 states no fraction. The omitted warm-up
 * intervals are skipped: they run before the measurement and would take the
 * bar to a tenth and then back to nothing.
 *
 * That duration is a parameter rather than the registry constant it used to be,
 * because a target may name its own - and a minute-long run divided by the
 * ten-second default fills the bar in its first sixth and then sits at 100% for
 * the rest, which reads as a run that has hung. Defaulted to the shipped figure,
 * so a caller that has no target to ask behaves as it always did.
 */
export const iperf3Progress = (data, phase, durationSeconds = IPERF_DURATION_SECONDS) => {
    // The two transfer phases only. The latency phase is reported by the
    // runner itself - it is measured before the CLI is started at all - so an
    // interval record can never belong to it.
    if (!TRANSFER_PHASES.includes(phase) || data.event !== "interval") return null;

    const sum = data.data?.sum ?? {};
    if (sum.omitted) return null;

    // Bits per second, where roundSpeed takes bytes - see BITS_PER_BYTE. The
    // live readout and the stored figure have to be the same measurement, or
    // the bar reports eight times what the row ends up holding.
    const speed = Number.isFinite(sum.bits_per_second)
        ? roundSpeed(sum.bits_per_second / BITS_PER_BYTE) : null;
    const elapsed = Number(sum.end);

    return {
        phase,
        progress: Number.isFinite(elapsed) ? clamp(elapsed / durationSeconds) : 0,
        speed
    };
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
