import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

/** A source file under the repository root, as text. */
export const readSource = (file) => fs.readFileSync(path.join(root, file), "utf8");

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
