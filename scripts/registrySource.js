import { integrationIdentifier, migrationIdentifier, moduleName } from './identifiers.js';

/**
 * The ES module source each generator writes.
 *
 * All three used to build their string literals by interpolating a filename
 * between two single quotes. A filename holding a quote of its own -
 * `user's-webhook.js`, or any of the punctuation that ends up on an asset in
 * client/public - closed the literal early and emitted source that does not
 * parse. The build succeeded and the server then died on startup with a
 * SyntaxError pointing at a generated file nobody edits.
 *
 * Rendering lives here, apart from the generators, for the same reason
 * identifiers.js does: both of those do their readdirSync and writeFileSync at
 * module top level, so importing one to test it would rewrite the real registry
 * as a side effect.
 */

/**
 * A value as JS source.
 *
 * JSON.stringify rather than a hand-built literal: it is the only escaping in
 * reach that is already correct for quotes, backslashes, newlines and the
 * separators that are legal in a filename but not in source.
 */
export const literal = (value) => JSON.stringify(String(value));

export const integrationRegistrySource = (files) => {
    const imports = files.map((file) =>
        `import ${integrationIdentifier(file)} from ${literal(`./${file}`)};`).join('\n');

    // `name` stays exactly the filename stem: the controller keys its registry
    // off it, every stored IntegrationData row carries it, and the client
    // builds both its translation keys and its PUT route from it.
    const entries = files.map((file) =>
        `    { name: ${literal(moduleName(file))}, setup: ${integrationIdentifier(file)} },`).join('\n');

    return `${imports}

const integrations = [
${entries}
];

export default integrations;
`;
};

export const migrationRegistrySource = (files) => {
    const imports = files.map((file, i) =>
        `import { up as ${migrationIdentifier(file, i)} } from ${literal(`./${file}`)};`).join('\n');

    // The full filename, which is what the runner records to know what it has
    // already applied.
    const entries = files.map((file, i) =>
        `    { name: ${literal(file)}, up: ${migrationIdentifier(file, i)} },`).join('\n');

    return `${imports}

const migrations = [
${entries}
];

export default migrations;
`;
};

/**
 * @param files  build-relative paths, forward-slashed
 * @param mimeFor  the content type to serve a given file as
 */
export const embeddedClientSource = (files, mimeFor) => {
    const imports = files.map((file, i) =>
        `import f${i} from ${literal(`../build/${file}`)} with { type: 'file' };`).join('\n');

    const entries = files.map((file, i) =>
        `    [${literal(`/${file}`)}, { path: f${i}, mime: ${literal(mimeFor(file))} }],`).join('\n');

    const indexIdx = files.indexOf('index.html');

    return `import fs from 'node:fs';
import { decodeEmbedPath } from './util/embedPath.js';

${imports}

const cache = new Map([
${entries}
].map(([url, { path, mime }]) => [url, { content: fs.readFileSync(path), mime }]));

const indexHtml = ${indexIdx === -1 ? 'null' : `fs.readFileSync(f${indexIdx})`};

export const createEmbeddedMiddleware = () => (req, res, next) => {
    // Decoded first: the keys above are filenames as they sit on disk, and
    // req.path keeps whatever percent-encoding the browser sent. Without this
    // every asset with a space or a non-ascii character missed the cache and
    // was answered with index.html by the fallback below.
    const entry = cache.get(decodeEmbedPath(req.path));
    if (!entry) return next();
    res.type(entry.mime).send(entry.content);
};

export const createEmbeddedFallback = () => (req, res) => {
    if (indexHtml) res.type('text/html').send(indexHtml);
    else res.status(404).send('Not found');
};

/** Reads an embedded asset by its url path. Returns null when it is not bundled. */
export const readEmbeddedFile = (url) => cache.get(decodeEmbedPath(url))?.content ?? null;
`;
};
