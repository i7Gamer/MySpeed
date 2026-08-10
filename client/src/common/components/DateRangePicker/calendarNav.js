/**
 * The calendar's navigation arithmetic, pure so the clamp can be tested.
 *
 * Every step answers with the first of a month - the view only ever shows
 * whole months, and anchoring to day one keeps a step from month 31 rolling
 * an extra month on the short ones.
 */

const monthStart = (year, month) => new Date(year, month, 1);

/**
 * The month the calendar should be showing for a given selection.
 *
 * The view used to be seeded once, in a useState initialiser, from the range
 * the picker happened to be mounted with - so it never followed a later
 * selection. Opening the picker on a January 2025 range and then choosing
 * "Last 7 days" left the calendar on January 2025, nineteen presses of the
 * month arrow away from the range it was describing.
 *
 * All time selects no dates at all, so an absent or unusable `to` answers with
 * the current month - the only month there is anything to say about.
 */
export const monthToShow = (to, now = new Date()) => {
    if (!(to instanceof Date) || Number.isNaN(to.getTime()))
        return monthStart(now.getFullYear(), now.getMonth());

    return monthStart(to.getFullYear(), to.getMonth());
};

export const monthBack = (view) => monthStart(view.getFullYear(), view.getMonth() - 1);

export const monthForward = (view) => monthStart(view.getFullYear(), view.getMonth() + 1);

export const yearBack = (view) => monthStart(view.getFullYear() - 1, view.getMonth());

/**
 * A year forward, clamped to the current month.
 *
 * The calendar never shows a month after the current one - there are no future
 * tests - but a hard disable would strand December a whole year short of today
 * with no jump at all. Overshooting lands on the current month instead, so the
 * button always moves as far as there is anywhere to go.
 */
export const yearForward = (view, now) => {
    const jumped = monthStart(view.getFullYear() + 1, view.getMonth());
    const ceiling = monthStart(now.getFullYear(), now.getMonth());

    return jumped > ceiling ? ceiling : jumped;
};

/** Both forward buttons disable on this one judgement. */
export const isCurrentMonth = (view, now) =>
    view.getFullYear() === now.getFullYear() && view.getMonth() === now.getMonth();
