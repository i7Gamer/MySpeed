/**
 * What a MediaQueryList actually answered, or undefined where it could not.
 *
 * An engine that has matchMedia but no prefers-color-scheme parses the query
 * to nothing, serialises its media as "not all", and then reports
 * `matches: false` forever. Bare, that false reads as "the machine prefers
 * light" - and resolveTheme's documented rule is the opposite: a machine that
 * cannot state a preference has not stated light, and stays dark. The same
 * distinction themeBoot.js draws inline, since a pre-paint script cannot
 * import - tests/client/themeBoot.test.js holds that copy to the same three
 * answers this one is held to.
 *
 * Only a serialised media of "not all" is that verdict: a list with no media
 * at all - a stub, a webview stranger still - is not thereby a machine that
 * prefers light.
 *
 * A change event carries matches and media the same way the list does, so the
 * subscription's handler reads through this too - a change event for an
 * unparseable query cannot fire, but one rule in one place beats a rule and
 * an exception.
 */
export const mediaQueryAnswer = (query) =>
    typeof query?.media === "string" && query.media !== "not all" ? query.matches === true : undefined;

/**
 * Subscribes to a MediaQueryList and hands back the unsubscribe.
 *
 * Safari before 14 - and the embedded webviews built on engines of that age,
 * which this context already guards for where prefersDark checks that
 * matchMedia exists at all - implements MediaQueryList without addEventListener.
 * Subscribing there threw a TypeError out of the provider's effect and took the
 * whole tree down, on exactly the browsers a wall-mounted dashboard tends to
 * run. addListener is the older spelling of the same subscription: deprecated,
 * but present everywhere the new one is missing.
 *
 * A list with neither spelling - a stub in a test, a webview stranger still -
 * is watched by nobody rather than thrown on: the theme then means "whatever
 * the machine said when the tab opened", which is what it meant for everyone
 * before the machine was watched at all.
 */
export const watchMediaQuery = (query, onChange) => {
    if (typeof query?.addEventListener === "function") {
        query.addEventListener("change", onChange);
        return () => query.removeEventListener("change", onChange);
    }

    if (typeof query?.addListener === "function") {
        query.addListener(onChange);
        return () => query.removeListener(onChange);
    }

    return () => undefined;
};
