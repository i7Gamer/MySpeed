import {it} from "node:test";
import {scenarios as mqttScenarios} from "../fixtures/outbound-transport/scenarios.js";
import {smtpScenarios} from "../fixtures/outbound-transport/smtp/scenarios.js";
import {resolverScenarios} from "../fixtures/outbound-transport/smtp/resolverScenarios.js";
import {lifecycleScenarios} from "../fixtures/outbound-transport/smtp/lifecycleScenarios.js";

const scenarios = [...mqttScenarios, ...resolverScenarios, ...lifecycleScenarios, ...smtpScenarios];

// Sequential within this process: each fixture restores its DNS/transport seams.
for (const scenario of scenarios) it(scenario.name, async (t) => {
    const result = await scenario.run();
    if (result?.skip) t.skip(result.skip);
});
