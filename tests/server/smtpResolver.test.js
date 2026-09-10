import {it} from 'node:test';
import {resolverScenarios} from '../fixtures/outbound-transport/smtp/resolverScenarios.js';
for (const scenario of resolverScenarios) it(scenario.name, scenario.run);
