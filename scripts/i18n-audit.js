import fs from 'node:fs';
import path from 'node:path';
import { flatten, localeGaps, sharedKeys } from './localeGaps.js';

/**
 * What every locale is still missing, measured against en.json.
 *
 * Run with no argument for the table; run with a language code to get that
 * language's outstanding work as a JSON object of key -> English source, which
 * is the shape scripts/i18n-apply.js takes back once the values are translated.
 *
 *   node scripts/i18n-audit.js
 *   node scripts/i18n-audit.js fr > fr-patch.json
 */

const LOCALES_DIR = path.join(import.meta.dirname, '..', 'client', 'public', 'assets', 'locales');
const SOURCE = 'en';

const read = (code) => JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${code}.json`), 'utf8'));

const codes = fs.readdirSync(LOCALES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => path.basename(file, '.json'))
    .filter((code) => code !== SOURCE)
    .sort();

const english = read(SOURCE);
const source = flatten(english);
const [requested] = process.argv.slice(2);

if (requested && !codes.includes(requested)) {
    console.error(`unknown locale "${requested}" - have: ${codes.join(', ')}`);
    process.exit(1);
}

if (requested) {
    const gaps = localeGaps(english, read(requested), sharedKeys(requested));
    const work = [...gaps.missing, ...gaps.untranslated];

    // The English source rather than the current value, because for an
    // untranslated key those are the same string and the point is to translate
    // it. Ordered as en.json orders it, so neighbouring keys stay neighbours and
    // whoever fills it in can see the context a label sits in.
    console.log(JSON.stringify(Object.fromEntries(
        Object.keys(source).filter((key) => work.includes(key)).map((key) => [key, source[key]])
    ), null, 2));

    process.exit(0);
}

const words = (value) => String(value).trim().split(/\s+/).filter(Boolean).length;

const rows = codes.map((code) => {
    const gaps = localeGaps(english, read(code), sharedKeys(code));
    const outstanding = [...gaps.missing, ...gaps.untranslated];

    return {
        locale: code,
        missing: gaps.missing.length,
        'still English': gaps.untranslated.length,
        stale: gaps.extra.length,
        'words to write': outstanding.reduce((total, key) => total + words(source[key]), 0),
        translated: `${(((Object.keys(source).length - outstanding.length) / Object.keys(source).length) * 100).toFixed(1)}%`
    };
});

console.log(`${SOURCE}.json: ${Object.keys(source).length} keys, ${Object.values(source).reduce((total, value) => total + words(value), 0)} words\n`);
console.table(rows);

const outstanding = rows.reduce((total, row) => total + row.missing + row['still English'], 0);
console.log(`\n${outstanding} string(s) outstanding across ${codes.length} locales, `
    + `${rows.reduce((total, row) => total + row['words to write'], 0)} source words`);
