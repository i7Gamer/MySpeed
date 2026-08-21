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
 * for.
 *
 * Comments are skipped for a sharper reason. This one first claimed nothing
 * writes a comment inside an argument list, which opengraph does - and one
 * contraction in it, "don't", opened a quote state that never closed. The
 * mount's own closing paren was then skipped, this answered -1, and the window
 * swallowed the handler body: a scan asking only whether the guard appears
 * somewhere in that text is satisfied by a comment in the body mentioning it.
 * Only the accident that opengraph's comment has no apostrophe kept it working.
 *
 * A comment marker inside a string is not a comment, which is why the string
 * check comes first: a refusal carrying a URL would otherwise swallow the rest
 * of the list at its "//".
 *
 * Braces and brackets are counted alongside the parens, because paren depth
 * alone does not say where the argument list ends: the handler's own parameter
 * list closes, and from there every comma in its body is back at the mount's
 * depth. `const { from, to } = req.query` is one of those, and it put the bound
 * inside the handler - which is how four of the speedtest mounts came back
 * carrying most of their own bodies while every synthetic test passed.
 *
 * Returns -1 when the mount takes a single argument, or when the parentheses
 * never close - a truncated file, where the caller keeps the whole window
 * rather than a slice of unknown meaning.
 */
const lastArgumentComma = (text) => {
    let depth = 0;
    let nested = 0;
    let quote = null;
    let comment = null;
    let last = -1;

    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        const next = text[index + 1];

        if (comment === "line") {
            if (character === "\n") comment = null;
            continue;
        }

        if (comment === "block") {
            if (character === "*" && next === "/") {
                comment = null;
                index++;
            }
            continue;
        }

        if (quote !== null) {
            if (character === "\\") index++;
            else if (character === quote) quote = null;
            continue;
        }

        if (character === "/" && (next === "/" || next === "*")) {
            comment = next === "/" ? "line" : "block";
            index++;
            continue;
        }

        if (character === '"' || character === "'" || character === "`") quote = character;
        else if (character === "{" || character === "[") nested++;
        else if (character === "}" || character === "]") nested--;
        else if (character === "(") depth++;
        else if (character === ")" && --depth === 0) return last;
        else if (character === "," && depth === 1 && nested === 0) last = index;
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
 * Mounts that look like mounts but that findMounts cannot read.
 *
 * The pattern above needs two things the language does not: `app.` at the very
 * start of a line, and a quote as the first argument. A mount that is indented -
 * inside an `if`, a loop, a helper - or whose path is a `const` matches nothing
 * and is silently absent from every scan built on it. The security assertions
 * derived from those scans then pass, because a route that was never found is
 * never unclassified and never missing; their only defence is a floor on the
 * count, and a floor with slack in it cannot notice one route going quiet.
 *
 * That is the one direction a security scan must not fail in, and it is exactly
 * the failure the guard being scanned for was written to end: a rule that is
 * reproduced by hand is a rule something forgets. So the scan says what it could
 * not read instead of skipping it, and the caller fails on that.
 *
 * Deliberately a *count* of the difference rather than a cleverer parser. The
 * strict pattern is what the assertions are built on; anything this notices is
 * something they cannot see, whatever the reason.
 */
export const unreadableMountCount = (source, verbs) => {
    // Any indentation, any first argument - but still a call, so the prose in a
    // comment that names `app.all` without calling it is not counted.
    const naive = new RegExp(`\\bapp\\.(?:${verbs.join("|")})\\s*\\(`, "g");

    return [...source.matchAll(naive)].length - findMounts(source, verbs).length;
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
export const blockEnd = (source, from = 0) => {
    let depth = 0;

    for (let index = from; index < source.length; index++) {
        if (source[index] === "{") depth++;
        else if (source[index] === "}" && --depth === 0) return index;
    }

    throw new Error("a block is never closed");
};

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

/**
 * The opening tag of the JSX element carrying `marker`, attributes and all.
 *
 * Walking back to the nearest `<` rather than matching an opening tag, because
 * these tags carry arrow functions - `onClick={() => …}` - and any pattern
 * written as "everything up to the closing angle bracket" stops inside the
 * first arrow it meets. Forward to the first `>` after the marker, which is
 * the end of the tag only while the attributes *after* the marker hold no
 * arrow function - so callers point it at a className or a ref, not at a
 * handler.
 *
 * One home rather than a copy per test file: the review that moved it here
 * found three drifting copies, which is how a fix to the walk reaches one
 * suite and misses two.
 */
export const tagHolding = (source, marker) => {
    const at = source.indexOf(marker);
    if (at === -1) throw new Error(`${marker} is not in this source`);

    return source.slice(source.lastIndexOf("<", at), source.indexOf(">", at) + 1);
};

/**
 * Shell-style sources with their comment lines removed, for the assertions
 * that must not be satisfied by prose. Whole lines only: a `#` mid-line is
 * more often a fragment of something real than a trailing comment.
 */
export const withoutHashComments = (source) => source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/**
 * JS/JSX sources with their comments removed, for the same reason. Block
 * comments go whole; line comments only from `//` that does not follow a
 * colon, so a URL inside a string survives.
 */
export const withoutJsComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
