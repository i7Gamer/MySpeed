import { REGISTRY } from './providers/registry.js';

/**
 * The CLIs fetched at boot, regardless of which ones the targets use, so
 * adding a target later costs nothing. Named so a failure can say which one it
 * was.
 *
 * Except the ones that ask to be left until they are wanted - see
 * downloadedOnDemand. A provider that most instances will never measure with
 * is a download most instances should not pay for, and ensureBinary fetches it
 * before the first run that needs it.
 */
const PROVIDERS = Object.values(REGISTRY)
    .filter((entry) => !entry.downloadedOnDemand)
    .map((entry) => ({name: entry.listName, provider: entry.loader}));

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
