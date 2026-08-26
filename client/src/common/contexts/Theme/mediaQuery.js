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
