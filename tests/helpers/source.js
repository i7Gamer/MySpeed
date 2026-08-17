import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

/** A source file under the repository root, as text. */
export const readSource = (file) => fs.readFileSync(path.join(root, file), "utf8");

/**
 * The javascript files in a directory under the repository root.
 *
 * Resolved from this module rather than the working directory, like readSource
 * above: a runner launched from anywhere else finds the same files, or fails
 * loudly instead of scanning some other tree.
 */
export const listSources = (dir) =>
    fs.readdirSync(path.join(root, dir)).filter((name) => name.endsWith(".js"));

/**
 * The last comma at the outermost argument depth, which is where the handler
 * begins.
 *
 * Strings are skipped, because the refusal a guard is constructed with carries
 * commas of its own - "For security reasons, you can't ..." - and counting one
 * of those would cut the list in the middle of the very argument being looked
 * for. Comments inside an argument list are not skipped; nothing writes one,
 * and a scanner that handles them is a parser.
 *
 * Returns -1 when the mount takes a single argument, or when the parentheses
 * never close - a truncated file, where the caller keeps the whole window
 * rather than a slice of unknown meaning.
 */
const lastArgumentComma = (text) => {
    let depth = 0;
    let quote = null;
    let last = -1;

    for (let index = 0; index < text.length; index++) {
        const character = text[index];

        if (quote !== null) {
            if (character === "\\") index++;
            else if (character === quote) quote = null;
            continue;
        }

        if (character === '"' || character === "'" || character === "`") quote = character;
        else if (character === "(") depth++;
        else if (character === ")" && --depth === 0) return last;
        else if (character === "," && depth === 1) last = index;
    }

    return -1;
};

/**
 * The middleware list of one route mount, bounded by the mount that follows it.
 *
 * The scans that hold a route to its guard first sliced from the mount to the
 * next `=>` in the file, which is sound only while every handler is an arrow. A
 * route mounted with a named function has no arrow of its own, so that search
 * ran on into the *next* route and the slice came back carrying that route's
 * middleware - and a neighbour's guard then marks an unguarded route as
 * guarded, which is the one direction a security scan must not fail in.
 *
 * Trimming at the first arrow inside the window was no better in the other
 * direction: opengraph mounts `passwordWrapper(true, (req, res) => …)` ahead of
 * its handler, so the cut landed inside that argument and everything after it -
 * where a guard would sit - was invisible.
 *
 * So the window is closed at the next mount, and the handler is found for what
 * it is: the last argument. Everything before the last comma at the mount's own
 * paren depth is the middleware list.
 */
export const mountText = (source, at) => {
    const following = source.slice(at + 1).search(/^app\./m);
    const window = source.slice(at, following === -1 ? source.length : at + 1 + following);

    const handler = lastArgumentComma(window);

    return handler === -1 ? window : window.slice(0, handler);
};

/**
 * Every route mount in a file for the given verbs, with its own position.
 *
 * The position comes from the match rather than from a second search for the
 * matched text. `source.indexOf(match)` answers the *first* occurrence, so two
 * mounts sharing a matched prefix - the capture stops at the route string, so a
 * repeated path is enough - were both read at the first one's offset, and the
 * second was judged on the first one's middleware.
 */
export const findMounts = (source, verbs) => {
    const pattern = new RegExp(`^app\\.(${verbs.join("|")})\\(\\s*(["'\`])(.*?)\\2`, "gm");

    return [...source.matchAll(pattern)].map((match) => ({
        verb: match[1],
        route: match[3],
        at: match.index,
        text: mountText(source, match.index)
    }));
};

/**
 * The balanced body of a declaration, for the assertions that are about the
 * shape of a function rather than about running it.
 *
 * Several things here can only be checked by reading: whether a scheduled
 * callback catches, whether a release sits in a `finally`, whether a route
 * carries its guard. Firing them needs a database or a signal or a real socket,
 * which is usually the very thing the assertion is about not having.
 *
 * Balanced brace by brace rather than sliced up to the next declaration,
 * because what fills that gap is another function - so a `.catch` belonging to
 * *it* would satisfy an assertion about this one, which is exactly the
 * confusion these assertions exist to prevent. There were two copies of this
 * walker before, and they had already drifted into taking different arguments.
 *
 * Two limits, both of which fail loudly rather than quietly:
 *
 * Braces inside strings, comments and regex literals are not skipped. That is
 * fine for the declarations this is pointed at and would not survive a template
 * literal carrying an unbalanced `}` - which ends the body early or runs it to
 * the end of the file, either of which is visible in the assertion that follows.
 *
 * A declaration with no braces at all - an arrow whose body is one expression -
 * has nothing to balance, and is refused rather than answered. Refused
 * explicitly, because the obvious shape is quietly wrong: indexOf answers -1,
 * and a walk from there scans the file from its start and balances the first
 * pair it meets - an import's `{ … }`, several declarations above the one that
 * was asked for - then slices from -1, which JavaScript reads as one character
 * from the *end*. That returns an empty string, and every assertion made
 * against it passes.
 */
export const bodyOf = (source, declaration) => {
    const start = source.indexOf(declaration);
    if (start === -1) throw new Error(`"${declaration}" is not in this source`);

    const from = source.indexOf("{", start);
    if (from === -1) throw new Error(`"${declaration}" has no braced body`);

    let depth = 0;

    for (let index = from; index < source.length; index++) {
        if (source[index] === "{") depth++;
        else if (source[index] === "}" && --depth === 0) return source.slice(from, index + 1);
    }

    throw new Error(`"${declaration}" is never closed`);
};

/** The two together, which is how every caller but one uses them. */
export const bodyIn = (file, declaration) => bodyOf(readSource(file), declaration);
