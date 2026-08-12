import fs from 'node:fs';
import path from 'node:path';
import { migrationIdentifier } from './identifiers.js';

const migrationsDir = path.join(import.meta.dirname, '..', 'server', 'migrations');
const outputFile = path.join(migrationsDir, 'index.js');

const files = fs.readdirSync(migrationsDir)
    .filter(f => /^\d{4}-.+\.js$/.test(f))
    .sort();

if (files.length === 0) {
    console.error('No migration files found in server/migrations/');
    process.exit(1);
}

const imports = files.map((file, i) => {
    const varName = migrationIdentifier(file, i);
    return `import { up as ${varName} } from './${file}';`;
}).join('\n');

const entries = files.map((file, i) => {
    const varName = migrationIdentifier(file, i);
    return `    { name: '${file}', up: ${varName} },`;
}).join('\n');

const output = `${imports}

const migrations = [
${entries}
];

export default migrations;
`;

fs.writeFileSync(outputFile, output);
console.log(`Generated ${outputFile} with ${files.length} migration(s)`);
