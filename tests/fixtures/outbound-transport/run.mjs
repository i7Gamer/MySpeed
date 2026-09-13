import {scenarios as mqttScenarios} from "./scenarios.js";
import {bootstrapNodemailer} from "./smtp/nodemailerHarness.js";
import {lifecycleScenarios} from "./smtp/lifecycleScenarios.js";
import {httpScenarios} from "./http/scenarios.js";
import {runHttpChild} from "./http/client.js";

await bootstrapNodemailer();
const {smtpScenarios} = await import("./smtp/scenarios.js");
const {resolverScenarios} = await import("./smtp/resolverScenarios.js");

const scenarios = [...mqttScenarios, ...resolverScenarios, ...lifecycleScenarios, ...smtpScenarios, ...httpScenarios];

// Run from the repository root, or set OUTBOUND_TLS_FIXTURE_DIR explicitly.
// No node:test dependency, so exactly these scenarios also run compiled.
if (process.env.OUTBOUND_HTTP_CASE) {
    // Compiled subprocesses execute their bundled HTTP client. Node hosts the
    // separate TLS peers, and NODE_EXTRA_CA_CERTS is set before this process starts.
    await runHttpChild();
} else {
    const skipped = [];
    for (const scenario of scenarios) {
        const result = await scenario.run();
        if (result?.skip) skipped.push({name: scenario.name, reason: result.skip});
    }
    console.log(JSON.stringify({runtime: process.versions.bun ?? process.version,
        passed: scenarios.length - skipped.length, skipped,
        nativeAttemptObservation: !process.versions.bun}));
}
