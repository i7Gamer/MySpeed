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

export const useFitStages = (ref, stages, controls) => {
    useLayoutEffect(() => {
        const row = ref.current;
        if (!row) return;

        let lastWidth = null;
        let disposed = false;

        /** The top edge of each control that is on screen, rounded off the sub-pixel. */
        const controlTops = () => controls.map((selector) => {
            const node = row.querySelector(selector);
            return node ? Math.round(node.getBoundingClientRect().top) : null;
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
        const mutationObserver = new MutationObserver(() => measure(true));
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
