import fs from 'node:fs';
import path from 'node:path';
import { embeddedClientSource } from './registrySource.js';

const buildDir = path.join(import.meta.dirname, '..', 'build');
const outputFile = path.join(import.meta.dirname, '..', 'server', 'clientEmbed.js');

if (!fs.existsSync(buildDir)) {
    console.error('Build directory not found. Run "bun run build" first.');
    process.exit(1);
}

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.map': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.webm': 'video/webm',
    '.mp4': 'video/mp4',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.txt': 'text/plain',
    '.xml': 'application/xml',
};

const walkDir = (dir, base = '') => {
    const result = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) result.push(...walkDir(path.join(dir, entry.name), rel));
        else if (entry.isFile()) result.push(rel);
    }
    return result;
};

const files = walkDir(buildDir);

if (files.length === 0) {
    console.error('No files found in build directory.');
    process.exit(1);
}

const mimeFor = (file) => MIME_TYPES[path.extname(file)] || 'application/octet-stream';

fs.writeFileSync(outputFile, embeddedClientSource(files, mimeFor));
console.log(`Generated ${outputFile} with ${files.length} embedded file(s)`);
