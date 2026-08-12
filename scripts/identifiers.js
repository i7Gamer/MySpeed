/**
 * The names the two registry generators write into their output.
 *
 * Both of them emit ES module source, so anything derived from a filename has
 * to survive the parser. `discord-webhook.js` was emitted as
 * `import discord-webhook from './discord-webhook.js';`, which is a syntax
 * error - one hyphen in one filename and the whole server refused to boot.
 *
 * This lives beside the generators rather than inside them because they both do
 * their readdirSync and writeFileSync at module top level: importing either one
 * to test this would rewrite the real registries as a side effect.
 */

// Anything outside this class cannot appear in a binding. `$` is kept because
// it is legal in an identifier and there is no reason to mangle a filename that
// happens to use it.
const IDENTIFIER_UNSAFE = /[^a-zA-Z0-9_$]/g;

/**
 * The filename without its extension.
 *
 * Anchored. The old `replace('.js', '')` was not, so `chart.js-helper.js` lost
 * its *first* `.js` and kept the real extension.
 *
 * For integrations this doubles as the emitted `name`, and it has to stay
 * exactly the filename: server/controller/integrations.js keys its registry off
 * it, every stored IntegrationData row carries it, and the client builds both
 * its translation keys and its PUT route from it. Sanitising the name would
 * silently orphan every saved row of a renamed integration.
 */
export const moduleName = (file) => file.replace(/\.js$/, '');

// Prefixed with the array index rather than the file's own 4-digit number: two
// migrations can be authored against the same prefix, and `m0007` declared
// twice is a duplicate binding that takes down the process it was meant to
// migrate.
export const migrationIdentifier = (file, index) => `m${index}_${moduleName(file).replace(IDENTIFIER_UNSAFE, '_')}`;

// Prefixed as well, so a filename starting with a digit - or one that sanitises
// down to a reserved word - still yields something the parser accepts. The
// identifier is local to the generated file; only `name` is load-bearing.
export const integrationIdentifier = (file) => `i_${moduleName(file).replace(IDENTIFIER_UNSAFE, '_')}`;
