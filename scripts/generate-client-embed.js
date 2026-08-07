import fs from 'node:fs';
import path from 'node:path';

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

const imports = files
    .map((file, i) => `import f${i} from '../build/${file}' with { type: 'file' };`)
    .join('\n');

const entries = files.map((file, i) => {
    const mime = MIME_TYPES[path.extname(file)] || 'application/octet-stream';
    return `    ['/${file}', { path: f${i}, mime: '${mime}' }],`;
}).join('\n');

const indexIdx = files.indexOf('index.html');
const indexRef = indexIdx !== -1 ? `f${indexIdx}` : 'null';

const output = `import fs from 'node:fs';

${imports}

const cache = new Map([
${entries}
].map(([url, { path, mime }]) => [url, { content: fs.readFileSync(path), mime }]));

const indexHtml = ${indexRef === 'null' ? 'null' : `fs.readFileSync(${indexRef})`};

export const createEmbeddedMiddleware = () => (req, res, next) => {
    const entry = cache.get(req.path);
    if (!entry) return next();
    res.type(entry.mime).send(entry.content);
};

export const createEmbeddedFallback = () => (req, res) => {
    if (indexHtml) res.type('text/html').send(indexHtml);
    else res.status(404).send('Not found');
};

/** Reads an embedded asset by its url path. Returns null when it is not bundled. */
export const readEmbeddedFile = (url) => cache.get(url)?.content ?? null;
`;

fs.writeFileSync(outputFile, output);
console.log(`Generated ${outputFile} with ${files.length} embedded file(s)`);
