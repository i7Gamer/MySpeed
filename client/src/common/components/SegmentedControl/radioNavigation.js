/**
 * Where an arrow key moves a radiogroup's choice.
 *
 * The pattern is one tab stop and arrows within: left/up step back, right/down
 * step forward, and both wrap - a radiogroup cycles rather than stopping at
 * its ends. Both axes are synonyms so a vertical stack and a horizontal row
 * read the same. Pure and apart from the component so it can be run rather
 * than read.
 */
export const ARROW_STEPS = {ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1};

/**
 * The index the choice moves to, or -1 for a group with nothing in it.
 *
 * A value that matches no option - a stale preference, a removed choice -
 * steps from the first option, so the group answers the keyboard even then.
 */
export const nextIndex = (options, value, delta) => {
    if (options.length === 0) return -1;

    const current = options.findIndex((option) => option.id === value);

    return ((current === -1 ? 0 : current) + delta + options.length) % options.length;
};
