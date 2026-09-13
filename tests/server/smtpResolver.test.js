import {it} from 'node:test';
import {bootstrapNodemailer} from '../fixtures/outbound-transport/smtp/nodemailerHarness.js';
await bootstrapNodemailer();
const {resolverScenarios} = await import('../fixtures/outbound-transport/smtp/resolverScenarios.js');
for (const scenario of resolverScenarios) it(scenario.name, scenario.run);
