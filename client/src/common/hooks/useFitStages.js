import {useLayoutEffect} from "react";

/**
 * Draw a row at the widest of its stages that holds one line.
 *
 * The stylesheet keys off the stage this hook writes to the row's data-compact
 * attribute; each stage is applied and then measured, and the first that keeps
 * every control on one line is kept. A viewport media query cannot make this
 * call - whether a row fits depends on the selected range, the translation and
 * which controls rendered at all - so the row itself is what gets asked.
 *
 * The measurement is only as honest as its triggers, and width is the least of
 * them. Everything that changes the answer re-runs the walk:
 *
 * - The row's width: a ResizeObserver, guarded on the *fractional* width -
 *   clientWidth rounds, and flex wrapping does not, so a sub-pixel change
 *   inside one integer could flip a line with a rounded guard asleep.
 * - The row's contents: a MutationObserver on the subtree. The start button
 *   mounts only once /config resolves, a test run swaps its label for
 *   "Running" and back, and a language change commits new label text - none of
 *   which moves the row's width. The observer watches the DOM commit itself,
 *   which is also the only moment the new labels are measurable: the old
 *   i18next listener here fired during the language *event*, before React had
 *   committed the translated labels, and measured the outgoing language.
 * - The fonts: the first walk on a cold cache measures fallback glyphs, and
 *   the swap to the real face changes label widths without a resize.
 *
 * While it walks, the row wears data-measuring and the stylesheet suspends
 * transitions under it: a transition answers a property change with its start
 * value at t=0, so a stage measured mid-ease would wear the previous stage's
 * box. The attribute is set and removed inside one frame, so nothing visible
 * ever misses its animation.
 *
 * The subtree observer is also the busiest trigger, because the status bar
 * lives in the row and commits new text on every status poll - the live speed,
 * the phase, the age of the last test - once a second for the length of a run.
 * Each firing used to walk the whole ladder from the top. So a mutation is
 * answered with a reading first, not a walk: the geometry the fit depends on
 * is the row's width and each child's used and scroll width, and the bar is
 * the row's only grower, so a text change inside its slack moves none of them
 * - while one that outgrows the slack cannot hide, because the bar's
 * min-width: max-content widens its own box. Unchanged geometry at the widest
 * stage is skipped outright; growth resumes from the stage the row wears; a
 * shrink, a moved row width or a changed child count re-proves from the top.
 * geometryShift and walkResponse below are that judgement.
 */

/**
 * Whether the controls have broken onto more than one line.
 *
 * Read off their top edges rather than by adding up widths: the row is a flex
 * container that already knows how to lay itself out, and the sum of the
 * natural widths is not something a laid-out row can be asked for - a control
 * that grows to fill its line says nothing about what it wanted.
 *
 * A control that is not on screen is null and is not counted. The start button
 * renders nothing at all for a read-only visitor, which used to need a rule of
 * its own in the stylesheet; here it is simply one fewer thing to fit.
 */
export const controlsWrapped = (tops) =>
    new Set(tops.filter((top) => typeof top === "number")).size > 1;

/**
 * The stage after the given one, or null when there is nothing narrower left -
 * including after a stage the list does not name, which must end the walk
 * rather than restart it.
 */
export const nextStage = (stages, stage) => {
    const index = stages.indexOf(stage);
    return index === -1 ? null : stages[index + 1] ?? null;
};

/**
 * Where a re-measure may pick up. A width that only shrank cannot make an
 * earlier - wider - stage fit, so the walk resumes from the stage the row
 * already wears instead of re-proving every stage above it. Anything the row
 * wears that the stages do not name falls back to the widest.
 */
export const resumeStage = (stages, stage) => stages.includes(stage) ? stage : stages[0];

const SUBPIXEL_TOLERANCE = 0.1;

/**
 * What a mutation moved, read against the last settled measurement.
 *
 * "shrink" is really "anything that could let a wider stage fit": an actual
 * loss of width, a changed child count - the start button mounting once
 * /config resolves - a moved row width, or a first reading with nothing to
 * compare against. Checked before growth so a mixed change re-proves rather
 * than resumes.
 *
 * Comparisons use SUBPIXEL_TOLERANCE to prevent subpixel rendering artifacts
 * from triggering spurious walks while accurately capturing true layout changes.
 */
export const geometryShift = (previous, next) => {
    if (!previous || previous.children.length !== next.children.length
        || Math.abs(previous.row - next.row) > SUBPIXEL_TOLERANCE) return "shrink";

    const pairs = next.children.map((child, index) => [previous.children[index], child]);

    if (pairs.some(([was, is]) => is.used < was.used - SUBPIXEL_TOLERANCE || is.content < was.content - SUBPIXEL_TOLERANCE)) return "shrink";
    if (pairs.some(([was, is]) => is.used > was.used + SUBPIXEL_TOLERANCE || is.content > was.content + SUBPIXEL_TOLERANCE)) return "growth";

    return "none";
};

/**
 * What the observer does about it: nothing, a walk from the worn stage, or a
 * walk from the top.
 *
 * "none" is skipped at any stage to prevent layout thrashing on periodic status
 * updates. Growth resumes rather than re-proving: the ladder only ever takes
 * things away, so a stage that did not fit before the row grew fuller still
 * does not.
 */
export const walkResponse = (shift, _atWidestStage) => {
    if (shift === "none") return "skip";

    return shift === "growth" ? "resume" : "top";
};

export const useFitStages = (ref, stages, controls) => {
    useLayoutEffect(() => {
        const row = ref.current;
        if (!row) return;

        let lastWidth = null;
        let lastGeometry = null;
        let disposed = false;

        /** The top edge of each control that is on screen, rounded off the sub-pixel. */
        const controlTops = () => controls.map((selector) => {
            const node = row.querySelector(selector);
            return node ? Math.round(node.getBoundingClientRect().top) : null;
        });

        /**
         * Everything a mutation could have moved that the fit depends on, in
         * one layout pass. Taken after each walk while the layout the walk
         * forced is still clean, and compared before the next one is allowed
         * to start - geometryShift above for what the comparison can and
         * cannot see.
         */
        const rowGeometry = () => ({
            row: row.getBoundingClientRect().width,
            children: [...row.children].map((child) => ({
                used: child.getBoundingClientRect().width,
                content: child.scrollWidth
            }))
        });

        // Writing the attribute and reading a rect straight after is what
        // makes this work: the read forces the new stage's layout, so each
        // stage is measured as itself - transitions suspended, see above.
        const walk = (from) => {
            row.dataset.measuring = "true";

            for (let stage = from; stage !== null; stage = nextStage(stages, stage)) {
                row.dataset.compact = stage;
                if (!controlsWrapped(controlTops())) break;
            }

            delete row.dataset.measuring;
        };

        // A grown row can afford an earlier stage, so it re-proves them all;
        // a shrunk one cannot, so it resumes where it stands. Content changes
        // can cut either way and start from the top.
        const measure = (contentChanged) => {
            const width = row.getBoundingClientRect().width;
            const grew = lastWidth === null || width > lastWidth;
            lastWidth = width;

            walk(contentChanged || grew ? stages[0] : resumeStage(stages, row.dataset.compact));
            lastGeometry = rowGeometry();
        };

        measure(true);

        // Guarded on the width because the stage this callback picks changes
        // the row's *height* - a wrapped toolbar is a line taller - and an
        // unguarded observer would see its own effect and call itself back.
        const resizeObserver = new ResizeObserver(() => {
            if (row.getBoundingClientRect().width !== lastWidth) measure(false);
        });
        resizeObserver.observe(row);

        // Attributes are deliberately not watched: the walk's own writes are
        // attribute changes on this very row, and watching them would loop.
        //
        // A reading before the walk, because most mutations move nothing the
        // fit depends on: the speed figure is tabular, so most polls replace
        // its digits within the same width, and every other tick lands inside
        // the bar's slack. The reading costs one layout pass on a tree the
        // mutation had already dirtied; the walk it usually saves costs an
        // attribute flip, a subtree restyle and a layout per stage.
        const mutationObserver = new MutationObserver(() => {
            const response = walkResponse(geometryShift(lastGeometry, rowGeometry()),
                row.dataset.compact === stages[0]);

            if (response === "skip") return;
            measure(response === "top");
        });
        mutationObserver.observe(row, {childList: true, subtree: true, characterData: true});

        document.fonts?.ready.then(() => {
            if (!disposed) measure(true);
        });

        return () => {
            disposed = true;
            resizeObserver.disconnect();
            mutationObserver.disconnect();
        };
    }, [ref, stages, controls]);
};
