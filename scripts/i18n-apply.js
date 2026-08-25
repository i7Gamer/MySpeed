import fs from 'node:fs';
import path from 'node:path';
import { localeGaps, mergeLocale, serialise, sharedKeys } from './localeGaps.js';

/**
 * Writes a patch of translations into a locale file.
 *
 *   node scripts/i18n-apply.js fr fr-patch.json
 *
 * The patch is a flat object of dotted key -> translated value, as produced by
 * `i18n-audit.js <code>` and then filled in. Keys en.json does not have are
 * refused rather than written: a mistyped key otherwise lands in the file, no
 * component ever asks for it, and the string it was meant to translate is still
 * missing.
 *
 * The file is rewritten in English's key order, which for every Crowdin-managed
 * locale is the order it is already in - so the diff is the lines the patch
 * added and nothing else.
 */

const LOCALES_DIR = path.join(import.meta.dirname, '..', 'client', 'public', 'assets', 'locales');

const [code, patchFile] = process.argv.slice(2);

if (!code || !patchFile) {
    console.error('usage: node scripts/i18n-apply.js <locale> <patch.json>');
    process.exit(1);
}

const localeFile = path.join(LOCALES_DIR, `${code}.json`);

if (!fs.existsSync(localeFile)) {
    console.error(`no locale file at ${localeFile}`);
    process.exit(1);
}

const english = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'));
const raw = fs.readFileSync(localeFile, 'utf8');
const locale = JSON.parse(raw);
const patch = JSON.parse(fs.readFileSync(patchFile, 'utf8'));

const blank = Object.entries(patch).filter(([, value]) => String(value).trim() === '').map(([key]) => key);

if (blank.length) {
    console.error(`patch leaves ${blank.length} value(s) empty: ${blank.join(', ')}`);
    process.exit(1);
}

const merged = mergeLocale(english, locale, patch);

// Whatever the file already used, so a tree checked out CRLF on Windows or LF
// on Linux is not rewritten end to end by the act of adding a hundred strings.
fs.writeFileSync(localeFile, serialise(merged, raw.includes('\r\n') ? '\r\n' : '\n'));

const gaps = localeGaps(english, merged, sharedKeys(code));

console.log(`${code}.json: wrote ${Object.keys(patch).length} string(s); `
    + `${gaps.missing.length} missing and ${gaps.untranslated.length} still English remain`);
