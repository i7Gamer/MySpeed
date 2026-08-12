import fs from 'node:fs';
import path from 'node:path';
import { integrationRegistrySource } from './registrySource.js';

const integrationsDir = path.join(import.meta.dirname, '..', 'server', 'integrations');
const outputFile = path.join(integrationsDir, 'index.js');

const files = fs.readdirSync(integrationsDir)
    .filter(f => f.endsWith('.js') && f !== 'index.js')
    .sort();

if (files.length === 0) {
    console.error('No integration files found in server/integrations/');
    process.exit(1);
}

fs.writeFileSync(outputFile, integrationRegistrySource(files));
console.log(`Generated ${outputFile} with ${files.length} integration(s)`);
