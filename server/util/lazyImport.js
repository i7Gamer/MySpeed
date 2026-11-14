/**
 * A module fetched on first use rather than at startup.
 *
 * For libraries most instances never touch - the share-image renderer, the
 * mailer - whose import alone costs tens of MiB of memory on every instance.
 * Measured in the 1.7.3 image, satori added ~42 MiB RSS and nodemailer ~19 MiB,
 * which is what left a server in a 100 MB container stalling (issue #135).
 *
 * `loader` must be a function wrapping an `import()` with a literal specifier,
 * so the compiled binary's bundler still sees and embeds the module.
 *
 * The promise is kept, not the module: a second caller during the first load
 * waits on the same import, and a failed load is retried rather than cached as
 * broken - a native binding can be absent because a volume was not mounted yet.
 */
export const lazyImport = (loader) => {
    let pending = null;

    return () => (pending ??= Promise.resolve().then(loader).catch((error) => {
        pending = null;
        throw error;
    }));
};
