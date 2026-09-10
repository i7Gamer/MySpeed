import {scenarios} from "./scenarios.js";

// Run from the repository root, or set OUTBOUND_TLS_FIXTURE_DIR explicitly.
// No node:test dependency, so exactly these scenarios also run compiled.
const skipped = [];
for (const scenario of scenarios) {
    const result = await scenario.run();
    if (result?.skip) skipped.push({name: scenario.name, reason: result.skip});
}
console.log(JSON.stringify({runtime: process.versions.bun ?? process.version,
    passed: scenarios.length - skipped.length, skipped,
    nativeAttemptObservation: !process.versions.bun}));
