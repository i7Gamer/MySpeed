import {it} from 'node:test';
import {lifecycleScenarios} from '../fixtures/outbound-transport/smtp/lifecycleScenarios.js';
for (const scenario of lifecycleScenarios) it(scenario.name, scenario.run);
