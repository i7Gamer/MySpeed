// "deltas", not "delta": a sibling named delta.js is one case-insensitive
// resolution away from this file itself - `./Delta` in index.js tries
// "Delta.js" and Windows hands it "delta.js", which exports no component,
// and the build dies at render without naming any of this.
import {describeDelta} from "./deltas";
import "./styles.sass";

/**
 * A figure's change against the previous period, worn as an annotation beside
 * the figure rather than as a figure of its own - the same idiom as the jitter
 * value beside the ping.
 *
 * Renders nothing whenever describeDelta judges silence the honest answer, so
 * callers can write it unconditionally.
 */
export const Delta = ({current, previous, higherIsBetter, mode, unit}) => {
    const delta = describeDelta({current, previous, higherIsBetter, mode, unit});
    if (!delta) return null;

    return (
        <span className={`stat-delta stat-delta-${delta.tone}`}>
            <span className="stat-delta-arrow" aria-hidden="true">{delta.direction === "up" ? "▲" : "▼"}</span>
            {delta.label}
        </span>
    );
};

export default Delta;
