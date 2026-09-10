import {scenarios as mqttScenarios} from "./scenarios.js";
import {smtpScenarios} from "./smtp/scenarios.js";
import {resolverScenarios} from "./smtp/resolverScenarios.js";
import {lifecycleScenarios} from "./smtp/lifecycleScenarios.js";

const scenarios = [...mqttScenarios, ...resolverScenarios, ...lifecycleScenarios, ...smtpScenarios];

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
