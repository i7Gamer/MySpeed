import fs from 'node:fs';
import path from 'node:path';
import { integrationIdentifier, moduleName } from './identifiers.js';

const integrationsDir = path.join(import.meta.dirname, '..', 'server', 'integrations');
const outputFile = path.join(integrationsDir, 'index.js');

const files = fs.readdirSync(integrationsDir)
    .filter(f => f.endsWith('.js') && f !== 'index.js')
    .sort();

if (files.length === 0) {
    console.error('No integration files found in server/integrations/');
    process.exit(1);
}

const imports = files.map((file) => {
    const varName = integrationIdentifier(file);
    return `import ${varName} from './${file}';`;
}).join('\n');

const entries = files.map((file) => {
    const varName = integrationIdentifier(file);
    return `    { name: '${moduleName(file)}', setup: ${varName} },`;
}).join('\n');

const output = `${imports}

const integrations = [
${entries}
];

export default integrations;
`;

fs.writeFileSync(outputFile, output);
console.log(`Generated ${outputFile} with ${files.length} integration(s)`);
