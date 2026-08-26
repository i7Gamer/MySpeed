/**
 * Whether the setup wizard should open itself.
 *
 * A pure function rather than a condition inside the effect, for the reason
 * configOutcome gives for the same move: this decides what an operator - or a
 * stranger on a public demo - meets in front of the whole dashboard, and the
 * historic bugs here were all in the *decision*, not in the rendering. A demo
 * once met a wizard it could not close, on every load, in every browser.
 *
 * "Not set up yet" used to be the config key provider === "none". It is now an
 * empty target list, which is why this lives beside the targets rather than
 * beside the config.
 *
 * @param config        the instance config, {} until it has loaded
 * @param firstRun      whether this instance has nothing to measure and never
 *                      has had: true, false, or null while unknown. Not simply
 *                      "the list is empty" - see below.
 * @param alreadyShown  whether this browser has already been shown the demo's
 *                      wizard
 */
export const welcomeOpens = ({config, firstRun, alreadyShown}) => {
    // Nothing is known yet: opening here would flash the wizard over an
    // instance that turns out to be perfectly configured.
    if (!config || Object.keys(config).length === 0) return false;

    // A demo has no configuration to write - its wizard is a tour, shown once
    // per browser and remembered in local storage. Answered before viewMode,
    // because a demo marks its visitors read-only too and the tour is still
    // worth showing them.
    if (config.previewMode) return !alreadyShown;

    // A read-only visitor cannot create a target, so walking them through a
    // setup whose final save is refused is a trap rather than a welcome.
    if (config.viewMode) return false;

    /*
     * Only a genuine first run, which is narrower than an empty list.
     *
     * The wizard cannot be dismissed - it is the one modal in the app with
     * disableClose - so every state that raises it must be one the only way
     * out of is finishing it. "The list is empty right now" is not: an
     * operator replacing their only target by the obvious route, deleting it
     * and adding another, emptied the list mid-workflow and was locked into a
     * wizard over the manager they were working in, which then left behind a
     * provider-named target they had to delete - emptying the list and raising
     * it again. null is a list that has not arrived, which is not emptiness.
     */
    return firstRun === true;
};
