/**
 * The calendar's navigation arithmetic, pure so the clamp can be tested.
 *
 * Every step answers with the first of a month - the view only ever shows
 * whole months, and anchoring to day one keeps a step from month 31 rolling
 * an extra month on the short ones.
 */

const monthStart = (year, month) => new Date(year, month, 1);

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
