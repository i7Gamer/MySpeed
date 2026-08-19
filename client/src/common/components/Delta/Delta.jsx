// "deltas", not "delta": a sibling named delta.js is one case-insensitive
// resolution away from this file itself - `./Delta` in index.js tries
// "Delta.js" and Windows hands it "delta.js", which exports no component,
// and the build dies at render without naming any of this.
import {t} from "i18next";
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
        /*
         * Labelled, because the whole of the direction is the glyph below and
         * the glyph is hidden - rightly: "▲" is not something to announce. What
         * that left was a bare magnitude, and "5%" is not a reading. On ping and
         * packet loss the two directions are opposite verdicts, so the part that
         * says which one was the part being withheld.
         *
         * The label replaces the contents rather than adding to them, so the
         * figure is announced once, with its direction, instead of twice.
         *
         * Not the tone: "better" and "worse" are this app's judgement, and the
         * glyph's colour states them for a reader who can see it. The direction
         * is the measurement, and it is what a reader needs to hear.
         */
        <span className={`stat-delta stat-delta-${delta.tone}`} role="img"
              aria-label={t(`statistics.delta.${delta.direction}`, {value: delta.label})}>
            <span className="stat-delta-arrow" aria-hidden="true">{delta.direction === "up" ? "▲" : "▼"}</span>
            {delta.label}
        </span>
    );
};

export default Delta;
