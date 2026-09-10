import {it} from "node:test";
import {scenarios} from "../fixtures/outbound-transport/scenarios.js";

// Sequential within this process: each fixture restores its DNS/transport seams.
for (const scenario of scenarios) it(scenario.name, async (t) => {
    const result = await scenario.run();
    if (result?.skip) t.skip(result.skip);
});
