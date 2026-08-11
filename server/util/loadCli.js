import * as libreProvider from './providers/loadLibre.js';
import * as ooklaProvider from './providers/loadOokla.js';
import * as cloudflareProvider from './providers/loadCloudflare.js';

// All three are fetched regardless of which one is selected, so switching
// provider later costs nothing. Named so a failure can say which one it was.
const PROVIDERS = [
    {name: "librespeed", provider: libreProvider},
    {name: "Ookla", provider: ooklaProvider},
    {name: "Cloudflare", provider: cloudflareProvider}
];

/**
 * Downloads whichever provider CLIs are not on disk yet.
 *
 * A failure here is reported, never propagated. index.js awaits this before it
 * listens and exits 112 if it throws, so one unreachable download took the
 * whole instance down: a container upgrade during a brief github.com outage
 * left it crash-looping with its entire mounted history unreachable, and any
 * platform missing from the binary list could not start at all.
 *
 * Nothing is gained by being fatal. A missing binary is already handled where
 * it matters - the run path retries and then records a failed test, which is
 * visible and recoverable.
 *
 * The list is injectable so this is testable without the network.
 */
export const load = async (providers = PROVIDERS) => {
    const results = await Promise.allSettled(providers.map(({provider}) => provider.load()));

    results.forEach((result, index) => {
        if (result.status === "rejected")
            console.error(`Could not prepare the ${providers[index].name} CLI: `
                + (result.reason?.message ?? result.reason));
    });
};
