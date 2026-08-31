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
 * Every .js/.jsx file under a directory, recursively, as repo-relative posix
 * paths with their text.
 *
 * Its own export rather than a widening of listSources, which a dozen suites
 * read at its flat, .js-only contract. Three suites grew a private copy of
 * this walk within one review, each starting with the same fifteen lines.
 */
export const walkSources = (dir, match = /\.jsx?$/) =>
    fs.readdirSync(path.join(root, dir), {withFileTypes: true})
        .flatMap((entry) => {
            const relative = `${dir}/${entry.name}`;

            if (entry.isDirectory()) return walkSources(relative, match);
            return match.test(entry.name) ? [{path: relative, source: readSource(relative)}] : [];
        });

const LOCALES_DIR = "client/public/assets/locales";

/** The locale files that ship, by code. */
export const localeCodes = () =>
    fs.readdirSync(path.join(root, LOCALES_DIR)).map((file) => path.basename(file, ".json"));

/** One locale file, parsed. */
export const readLocale = (code) => JSON.parse(readSource(`${LOCALES_DIR}/${code}.json`));

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
/**
 * The characters of a source that are code, with their positions - strings,
 * templates and both comment forms skipped, quotes and all.
 *
 * Extracted because a second walker needed exactly this discipline and the
 * file already carries the lesson about what happens when such a walk is
 * copied: "There were two copies of this walker before, and they had already
 * drifted into taking different arguments." A quote or a comment marker that
 * one copy honours and the other does not is a structural read that is right
 * in one caller and wrong in the next, silently.
 *
 * Deliberately not a parser and deliberately not `withoutJsComments`. That one
 * answers text, which loses the positions every caller here needs, and it
 * settles the regex-literal question - which this does not, because none of
 * the structure these callers count can appear inside a literal without also
 * appearing balanced in the code around it.
 *
 * The quote characters themselves are not yielded, which is what the walker
 * this came from did by writing its quote check first in an else-if chain.
 */
function* codeCharacters(text, from = 0) {
    let quote = null;
    let comment = null;

    for (let index = from; index < text.length; index++) {
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
        else yield {index, character};
    }
}

const lastArgumentComma = (text) => {
    let depth = 0;
    let nested = 0;
    let last = -1;

    for (const {index, character} of codeCharacters(text)) {
        if (character === "{" || character === "[") nested++;
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

/**
 * A literal, made safe to travel inside a RegExp.
 *
 * For the scans that build a pattern around a value - a translation key, a
 * version string, a binary name. Three of them were escaping by hand, each
 * covering only the dot, which holds exactly until the first value carrying a
 * `(`, `$` or `|` builds a pattern that matches something else. The character
 * class is the whole set RegExp assigns meaning to.
 */
export const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The `)` closing the `(` at `from`, or -1 when it never closes. */
const closingParen = (source, from) => {
    let depth = 0;

    for (const {index, character} of codeCharacters(source, from)) {
        if (character === "(") depth++;
        else if (character === ")" && --depth === 0) return index;
    }

    return -1;
};

/**
 * Whether the paren group closing at `close` is a parameter list.
 *
 * Decided by what follows it, which is the only thing that separates the two
 * cases without parsing: a parameter list is followed by `=>` or by the body
 * brace, and a call's argument list is followed by whatever the expression
 * around it wants next - `;`, `,`, `)`, `.`.
 *
 * That distinction is the whole rule. `(mode, tuning = {})` is followed by an
 * arrow, so its braces are parameters and the walk steps over them.
 * `rows.create({...})` is followed by a semicolon, so the walk goes into it -
 * and the object literal is answered, which is what the callers pointed at an
 * arrow whose body is a single call are asking for.
 */
/** The first `count` significant code characters at or after `from`. */
const codeAhead = (source, from, count) => {
    const found = [];

    for (const {index, character} of codeCharacters(source, from)) {
        if (/\s/.test(character)) continue;

        found.push({index, character});
        if (found.length === count) break;
    }

    return found;
};

/**
 * What kind of paren group closes at `close`, decided by what follows it.
 *
 * A parameter list is followed by `=>` or by the body brace; a call's argument
 * list is followed by whatever the expression around it wants next - `;`, `,`,
 * `)`, `.`. That distinction is the whole rule.
 *
 * The arrow is read as two adjacent characters rather than as a substring: out
 * of the raw source, a `=` and a `>` with a comment between them would pass,
 * and so would `= >`.
 */
const parameterListAfter = (source, close) => {
    const after = codeAhead(source, close + 1, 3);

    if (after.length === 0) return null;
    if (after[0].character === "{") return {arrow: false};

    const arrow = after.length >= 2 && after[0].character === "=" && after[1].character === ">"
        && after[1].index === after[0].index + 1;

    return arrow ? {arrow: true, body: after[2] ?? null} : null;
};

/**
 * The brace that opens the body of the declaration beginning at `start`, or -1
 * when there is none.
 *
 * Not `indexOf("{", start)`, which is the first brace and not the body's
 * whenever a parameter carries one: an object default, a destructured
 * argument. That answered the parameter's own pair - `tuning = {}` in the
 * runner handed six suites the two characters `{}` as a two-hundred-line
 * function's body. They failed loudly because they ask `assert.match`; a
 * `doesNotMatch` scan in their place would have been *satisfied* by `{}` and
 * proved nothing in green, which is the direction these scans must not fail
 * in.
 *
 * So parameter lists are stepped over and everything else is walked into. -1
 * is answered for a list that never closes as well as for a declaration with
 * no brace at all, because both are a body of unknown meaning and the caller
 * refuses rather than answers those.
 */
const bodyBrace = (source, start) => {
    let at = start;

    while (at < source.length) {
        let jumped = false;

        for (const {index, character} of codeCharacters(source, at)) {
            if (character === "{") return index;

            if (character === "(") {
                const close = closingParen(source, index);
                if (close === -1) return -1;

                const list = parameterListAfter(source, close);
                if (list === null) continue;

                /*
                 * An arrow whose body is a parenthesised expression, which is
                 * two different things and only one of them has an answer.
                 *
                 * `=> ({...})` wraps an object literal, and that literal IS
                 * what the callers pointed at such a declaration are asking
                 * for - config.js's restored-target rebuild and the round's
                 * own outcome are both this shape. So the walk goes on and
                 * finds it.
                 *
                 * `=> (<div data-grade={level}/>)` wraps JSX, and there is no
                 * body in it at all. The walk used to step over the parameters
                 * correctly, go into the body paren because a `;` follows it,
                 * and answer the twenty characters of an attribute as the
                 * component's body - the commonest declaration shape in this
                 * client, answered with something no doesNotMatch scan could
                 * ever fail against. Refused, which is what this walk promises
                 * for a declaration with no braced body.
                 */
                if (list.arrow && list.body?.character === "(") {
                    const inner = codeAhead(source, list.body.index + 1, 1);

                    if (inner.length === 0 || inner[0].character !== "{") return -1;
                }

                at = close + 1;
                jumped = true;
                break;
            }
        }

        if (!jumped) return -1;
    }

    return -1;
};

export const bodyOf = (source, declaration) => {
    const start = source.indexOf(declaration);
    if (start === -1) throw new Error(`"${declaration}" is not in this source`);

    const from = bodyBrace(source, start);
    if (from === -1) throw new Error(`"${declaration}" has no braced body`);

    let depth = 0;

    // Through the lexer, not a raw scan of every character: a brace inside a
    // string, a template or a comment is not a brace this body is counting, and
    // one of those closes the walk early - handing back a slice that ends
    // mid-function, which an assert.match against it then passes or fails for
    // the wrong reason. bodyBrace above already reads the source this way.
    for (const {index, character} of codeCharacters(source, from)) {
        if (character === "{") depth++;
        else if (character === "}" && --depth === 0) return source.slice(from, index + 1);
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

/** A whole line that is nothing but a comment. */
const HASH_COMMENT = /^\s*#/;

/**
 * The whole of a block scalar's header, which is more than `|` and `>`.
 *
 * YAML lets it carry an indentation indicator beside the chomping one, in either
 * order - `|2`, `>2-`, `|-2`. A header carrying a digit matched nothing, so it
 * was taken for a one-liner and the indicator came back as the body's own first
 * line, with the real body appended underneath.
 *
 * And a comment after it, which YAML 1.2 §8.1.1 allows: `run: | # bump the
 * version` opens a block like any other. Anchored at the end of the line, a
 * header with one failed the same way and cost more, because a plain scalar's
 * continuation lines have their comments stripped - so every `#` line of the
 * body went with it, and an expression spliced into a shell comment became
 * invisible to the scan written to find exactly that. A comment, though, and
 * nothing else, and only one with whitespace in front of it: YAML needs a space
 * before a `#` for a comment to begin there at all, so `|#x` is not a header
 * carrying one - it is not a node any parser will load. `| 2` is not YAML's way
 * of writing `|2` either, and a header followed by anything else is still not
 * one.
 */
const BLOCK_INDICATOR = /^\s*[|>](?:[1-9][-+]?|[-+][1-9]?)?(?:\s+#.*)?\s*$/;

/**
 * Shell-style sources with their comment lines removed, for the assertions
 * that must not be satisfied by prose. Whole lines only: a `#` mid-line is
 * more often a fragment of something real than a trailing comment.
 */
export const withoutHashComments = (source) => source
    .split("\n")
    .filter((line) => !HASH_COMMENT.test(line))
    .join("\n");

/**
 * Every `run:` body in a workflow, each as its own lines and as one text.
 *
 * For the assertions that hold a workflow to keeping values out of a shell: a
 * `${{ }}` expression is substituted into the source before bash parses it, so
 * one that reaches a run: body is code rather than data, and the way to pass it
 * is to bind it through `env:` and read the shell variable.
 *
 * Which is exactly why the bound has to be the block scalar's own end, and not
 * the next `- name:`. An `env:` block is what a body is supposed to read instead
 * of splicing, so a walk that runs on into one reports every fix as the bug it
 * fixes.
 *
 * Comments are stripped here rather than by the caller, because a caller that
 * forgets is not visibly wrong: these workflows explain, in prose directly above
 * the line, why a `${{` must not appear in a run body - and an assertion looking
 * for one then finds the sentence saying it must not be there. Two copies of
 * this walk stripped at different places, and only one of them here.
 *
 * Outside a block scalar only, which is where YAML's comments are. Inside one
 * there is no YAML left to comment: the block is a single string, and a `${{ }}`
 * on any line of it is substituted into that string long before bash - or the
 * `#` standing in front of it - is anywhere near the value. Stripping those
 * lines with the rest handed the scan that exists to find such a splice a body
 * it had already been taken out of: a shell comment carrying
 * `${{ github.event.pull_request.title }}` came back clean, which is the one
 * carrier nobody would think to look for reported safe by the check written for
 * it. Body lines come back verbatim now, and a caller that wants them without
 * prose has withoutHashComments above.
 *
 * There were two copies, and they had drifted on every rule that matters: where
 * a block ends, whether a `run:` with no `|` or `>` is followed at all, and what
 * is handed back. Both are answered here the wider way - a plain one-liner is
 * walked like any other body, and a body comes back as its lines and as one text
 * - so neither caller loses anything it was reading before.
 */
export const runBodies = (source) => {
    const lines = source.split("\n");
    const bodies = [];

    for (let index = 0; index < lines.length; index++) {
        // Out here a `#` line is YAML's own, and it is the prose these
        // assertions must not be satisfied by.
        if (HASH_COMMENT.test(lines[index])) continue;

        const opened = /^(\s*)(-\s+)?run:(.*)$/.exec(lines[index]);
        if (!opened) continue;

        // The column of the key, not of the dash in front of it. A block scalar
        // ends where the indentation drops back to the key that opened it, and
        // in `- run:` the dash sits two columns to the left of that key - so a
        // bound taken from the dash keeps reading, and every sibling key of the
        // step comes back as part of the shell body. `env:` is one of those, and
        // binding a value through env: is the correct shape these bodies are
        // read to insist on.
        const column = opened[1].length + (opened[2] ?? "").length;

        // The block indicator is not part of the body; anything else on the line
        // is a one-liner and is.
        const block = BLOCK_INDICATOR.test(opened[3]);
        const opener = block ? "" : opened[3];
        const body = opener.trim() === "" ? [] : [opener];

        while (index + 1 < lines.length) {
            const line = lines[index + 1];

            // A blank line inside a block scalar is still part of it.
            if (line.trim() !== "" && line.length - line.trimStart().length <= column) break;

            index++;

            // And a `#` line inside one is shell rather than YAML, so it stays.
            // A plain scalar's continuation lines are still YAML, and a comment
            // among those is one.
            if (!block && HASH_COMMENT.test(line)) continue;

            body.push(line);
        }

        bodies.push({lines: body, text: body.join("\n")});
    }

    return bodies;
};

/**
 * What stands in front of a slash that makes it the start of a regex literal
 * rather than a division.
 *
 * Not a parse - that question is genuinely ambiguous in JavaScript and is
 * settled by the grammar, which this is not. It is the set of positions where a
 * value cannot already have been produced, so a slash there cannot be dividing
 * one. Line-start is in the set as well, and is spelled by `prev` being null.
 */
const REGEX_OPENERS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", ";", "{", "}", "+", "*", "%"]);

/** And the words that leave the same position, where a character cannot. */
const REGEX_WORDS = new Set(["return", "typeof", "case", "in", "of", "instanceof", "new", "do", "else"]);

const IDENTIFIER = /[\w$]/;

/** Whitespace that is not the end of a line, which is the thing being counted. */
const INLINE_SPACE = /[ \t\r\v\f]/;

/**
 * The end of the regex literal opening at `from`, or -1 if there is none.
 *
 * A literal cannot span a line, so a scan that reaches one has misread a
 * division and says so rather than running to the far end of the file looking
 * for a closer. A slash inside a character class is not the closer either -
 * `[/]` is one slash of data - so the classes are tracked alongside the escapes.
 */
const regexEnd = (source, from) => {
    let inClass = false;

    for (let index = from + 1; index < source.length; index++) {
        const character = source[index];

        if (character === "\n") return -1;
        if (character === "\\") index++;
        else if (character === "[") inClass = true;
        else if (character === "]") inClass = false;
        else if (character === "/" && !inClass) return index;
    }

    return -1;
};

/**
 * JS/JSX sources with their comments removed, for the same reason the shell
 * ones above have theirs: an assertion must not be satisfied by prose about the
 * thing it is looking for.
 *
 * This was two regular expressions - one for the block form, one for the line
 * form - and both were wrong in the one direction a source scan must not be
 * wrong in. They dropped code, and a scan whose input has quietly lost the code
 * it is scanning cannot fail at all.
 *
 * The block pattern opened on the two characters that spell an opener wherever
 * they landed, a glob inside a string included, and then ran to the next closer
 * anywhere in the file: i18n.js declares its flags with an eager glob whose path
 * ends in one, and the sixteen languages between that line and the next closer
 * thirty-seven lines below were gone from every scan that read this file. The
 * line pattern opened on any two adjacent slashes not preceded by a colon, which
 * a regex literal ending in an escaped slash is - NodeContainer strips a scheme
 * with one - and which a template holding an address is, twice in server/util.
 *
 * So it is a walk now, with the state a stripper actually needs: strings in all
 * three quotes with their escapes, a template's substitutions back in code state
 * to whatever depth they nest, regex literals, and both comment forms. The state
 * carries across lines, because a block comment does - FormatUtil names the -1
 * placeholder in the middle of one, in a tree the placeholder tripwire scans.
 *
 * One newline comes back for each one removed, and the newline after a stripped
 * line comment stays. That is not tidiness: half the consumers are anchored
 * per-line, and the tripwire's allowlist exempts a line rather than a file, so a
 * walk that closed the gaps would move every one of those readings.
 *
 * And it fails closed where the heuristic can be wrong. Whether a slash opens a
 * literal or divides is decided by what stands in front of it; read as a
 * division when it was a literal, the walk is inside that literal's text, and
 * two slashes in there would be stripped as a comment - taking real code to the
 * end of the line with it, which is the failure this replaced. So a line that
 * has already divided keeps whatever follows. The cost is a comment surviving on
 * such a line, which is the direction that is merely noisy.
 *
 * Fails loudly at the far end too. A misread that puts the walk into a
 * template it never leaves drops nothing - the text comes back verbatim, only
 * never stripped again - which is exactly the kind of quiet wrongness no
 * suite notices. Valid JavaScript cannot end inside a template, a
 * substitution or a block comment, so ending in one of those states throws,
 * naming the state. A file may end in a line comment, and a stray apostrophe
 * stays tolerated - the string states die at each newline by design. A
 * caller handing this a SLICE rather than a file gets the same throw as a
 * truncation detector: a slice cut inside one of those states is a slice no
 * scan should trust either, and the message says both readings.
 */
export const withoutJsComments = (source) => {
    let out = "";
    let state = "code";

    // The brace depth of each substitution the walk is currently inside, so a
    // template nested in one of its own substitutions still closes correctly.
    const templates = [];

    let prev = null;    // the last significant code character on this line
    let word = "";      // the identifier ending at it, when it is one
    let last = null;    // the previous code character, whitespace included
    let divided = false;
    let arrow = false;  // whether that character closed a `=>`

    const code = (character) => {
        out += character;

        if (character === "\n") {
            prev = null;
            word = "";
            last = null;
            divided = false;
            arrow = false;
            return;
        }

        if (INLINE_SPACE.test(character)) {
            last = character;
            return;
        }

        word = !IDENTIFIER.test(character) ? ""
            : last !== null && IDENTIFIER.test(last) ? word + character
                : character;
        arrow = character === ">" && prev === "=";
        prev = character;
        last = character;
    };

    // A construct handed back whole - a string, a template, a literal - counts
    // as its closing character and nothing else.
    const closed = (character) => {
        prev = character;
        word = "";
        last = character;
        arrow = false;
    };

    const opensRegex = () => {
        // The arrow leaves the same position a `(` does, and it is two
        // characters, which is why the set of single ones below cannot hold
        // it: read as a division instead, the walk is inside the literal's
        // text, where a stray backtick opens a template that never closes -
        // modelNullability's filter ended every scan of itself that way.
        if (arrow) return true;
        if (prev === null) return true;
        if (IDENTIFIER.test(prev)) return REGEX_WORDS.has(word);

        return REGEX_OPENERS.has(prev);
    };

    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        const next = source[index + 1];

        // The line ending is handed back rather than eaten, and a carriage
        // return is part of it: `.*$` left one behind, and so does this.
        if (state === "line") {
            if (character === "\n" || character === "\r") {
                state = "code";
                code(character);
            }
            continue;
        }

        if (state === "block") {
            if (character === "\n") {
                out += "\n";
                divided = false;
            } else if (character === "\r") {
                // The newline rule includes the carriage return: half the
                // tree is CRLF, and a comment spanning lines there handed
                // back bare \n on exactly the commented lines.
                out += "\r";
            } else if (character === "*" && next === "/") {
                state = "code";
                index++;
            }
            continue;
        }

        if (state === "single" || state === "double") {
            out += character;

            // Bounded at the line, because a quote that never closes is more
            // likely a stray apostrophe than a string - and unbounded it would
            // suppress every strip to the end of the file.
            if (character === "\\" && next !== undefined) {
                out += next;
                index++;
            } else if (character === "\n") {
                state = "code";
                prev = null;
                word = "";
                last = null;
                divided = false;
            } else if (character === (state === "single" ? "'" : '"')) {
                state = "code";
                closed(character);
            }
            continue;
        }

        if (state === "template") {
            if (character === "\\" && next !== undefined) {
                out += character + next;
                index++;
            } else if (character === "`") {
                out += character;
                state = "code";
                closed(character);
            } else if (character === "$" && next === "{") {
                out += "${";
                index++;
                templates.push(0);
                state = "code";
                closed("{");
            } else {
                out += character;
                if (character === "\n") divided = false;
            }
            continue;
        }

        if (character === "/") {
            if (next === "/") {
                if (divided) {
                    let end = index;
                    while (end < source.length && source[end] !== "\n" && source[end] !== "\r") end++;

                    out += source.slice(index, end);
                    index = end - 1;
                    continue;
                }

                state = "line";
                index++;
                continue;
            }

            if (next === "*") {
                state = "block";
                index++;
                continue;
            }

            if (opensRegex()) {
                const end = regexEnd(source, index);

                if (end !== -1) {
                    out += source.slice(index, end + 1);
                    index = end;
                    closed("/");
                    continue;
                }
            }

            divided = true;
            code(character);
            continue;
        }

        // JSX's own slashes - `</div>`, `<br />` - go through here too and
        // read as divisions, which costs nothing but the fail-closed noise
        // above: nothing is dropped, and a trailing comment on such a line
        // survives into the scan. Handling them specially was measured and
        // vetoed - not setting `divided` there let a URL in JSX text open a
        // line comment, which is the eating this walk exists to end.

        if (character === "'" || character === '"' || character === "`") {
            state = character === "'" ? "single" : character === '"' ? "double" : "template";
            out += character;
            continue;
        }

        if (templates.length > 0 && (character === "{" || character === "}")) {
            const depth = templates.length - 1;

            if (character === "{") templates[depth]++;
            else if (templates[depth] === 0) {
                templates.pop();
                out += character;
                state = "template";
                continue;
            } else templates[depth]--;
        }

        code(character);
    }

    // Fail loudly rather than quietly at the far end. Valid JavaScript cannot
    // end inside a template, a substitution or a block comment, so arriving
    // here in one of those states means a slash context was misread somewhere
    // above - and the silent version of that survives every suite: nothing is
    // dropped, the comments simply stop being stripped, and a scan whose
    // input keeps its comments cannot be trusted in either direction. The two
    // line-bounded states stay legal: a file may end in a line comment, and
    // the string states already die at each newline by design.
    if (state === "template" || state === "block" || templates.length > 0)
        throw new Error("the input ends inside a "
            + (templates.length > 0 ? "template substitution"
                : state === "block" ? "block comment" : "template")
            + ": a slash or backtick context was misread above, or a sliced input was cut inside one");

    return out;
};
