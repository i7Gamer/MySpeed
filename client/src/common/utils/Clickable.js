/**
 * The keys a control is expected to answer when it is not a real button.
 *
 * Enter and Space are what the browser synthesises a click from on a <button>,
 * and what a screen reader tells its user to press on anything announced as one.
 */
const ACTIVATION_KEYS = ["Enter", " "];

/**
 * Makes an element that is not a button behave like one.
 *
 * A real <button> is the better answer wherever the control is a control - the
 * pagination and the integration menu are both buttons for that reason. It is
 * not available to the cards: the statistics tiles, the charts and the node
 * cards hold headings, canvases and whole panels, which a button may not
 * contain. So they take the other standard shape, and take it from here rather
 * than each writing out their own.
 *
 * Written out per component is exactly how it came to be missing: nine tiles on
 * /statistics open an expanded panel and every node card switches the app to
 * that node, all of them a bare div with an onClick and a pointer cursor, while
 * the overview row a page away had the whole shape hand-written. Tab walked past
 * every card, so the expanded charts and the node switcher could not be reached
 * without a mouse at all.
 *
 * Returns nothing for an element with no action: a tab stop that does nothing
 * when pressed is worse than no tab stop, because it promises one.
 */
export const clickable = (onClick) => {
    if (!onClick) return {};

    return {
        role: "button",
        tabIndex: 0,
        onClick,
        onKeyDown: (event) => {
            /*
             * Only the keys aimed at the card itself.
             *
             * A control inside it - a help button, a context menu - gets Enter
             * and Space of its own, and those bubble up here. Acting on one
             * would open the card instead of pressing the button, and the
             * preventDefault below would cancel the click the browser was about
             * to synthesise from that key, so the nested control's own handler
             * never ran either. SpeedtestComponent found this the hard way.
             */
            if (event.target !== event.currentTarget) return;
            if (!ACTIVATION_KEYS.includes(event.key)) return;

            // Space scrolls the page and Enter submits a form, unless the
            // handler says it has dealt with the key itself.
            event.preventDefault();
            onClick(event);
        }
    };
};
