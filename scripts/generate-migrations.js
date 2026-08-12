import fs from 'node:fs';
import path from 'node:path';
import { migrationRegistrySource } from './registrySource.js';

const migrationsDir = path.join(import.meta.dirname, '..', 'server', 'migrations');
const outputFile = path.join(migrationsDir, 'index.js');

const files = fs.readdirSync(migrationsDir)
    .filter(f => /^\d{4}-.+\.js$/.test(f))
    .sort();

if (files.length === 0) {
    console.error('No migration files found in server/migrations/');
    process.exit(1);
}

fs.writeFileSync(outputFile, migrationRegistrySource(files));
console.log(`Generated ${outputFile} with ${files.length} migration(s)`);
