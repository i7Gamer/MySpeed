/**
 * Cleaning provider-supplied text before it is interpolated into a message a
 * chat service will render as markdown.
 *
 * Both markdown sinks face the same hazard and only one of them handled it.
 * Telegram strips the metacharacters out of every interpolated value, because
 * its legacy parser has no escape syntax and rejects the whole message with a
 * 400 when the formatting does not balance - so a failure notification carrying
 * raw CLI output was dropped exactly when it mattered. Discord substitutes the
 * same values into an embed description, which Discord also renders as
 * markdown, and did nothing at all: a stray backtick re-pairs with the ones the
 * default template puts around `Ping`, so part of the sentence arrives as a
 * code span with the delimiters no longer visible, and `[text](url)` in an
 * error becomes a link the operator never wrote.
 *
 * One home for the cleaning, a character set per sink, because the two parsers
 * are not the same and over-stripping is its own way of mangling a message: a
 * pipe or a tilde carries no meaning to Telegram's legacy parser and removing
 * one from an error would be a change to the text for nothing.
 */

/** What Telegram's legacy parser treats as formatting. */
export const TELEGRAM_MARKDOWN = /[*_`[\]]/g;

/**
 * The same for Discord, which adds strikethrough, spoilers and its own escape
 * character - and renders masked links inside an embed description, which is
 * why the brackets matter here for more than balance.
 *
 * The backslash is stripped only where it can act as an escape: before a
 * character that is not a letter, a digit or whitespace. Taking every backslash
 * mangled the text this exists to deliver - a Windows path in a failure reason
 * arrived as `C:Program FilesMySpeedbinspeedtest.exe`, and the live installer
 * runs the server as a Windows service, so those paths are the ordinary case.
 * Discord renders a backslash before a letter as both characters, so removing
 * one there is a change to the operator's text for nothing - which is exactly
 * the over-stripping this module's own header warns against. What still goes:
 * `\\`, and a backslash sitting against punctuation or at the very end of a
 * value, where it could escape the template's own delimiter.
 */
export const DISCORD_MARKDOWN = /[*_`~|[\]]|\\(?![0-9A-Za-z\s])/g;

/**
 * Every string value with the given characters removed, the rest untouched.
 *
 * Only the interpolated values: the operator writes the template, and its own
 * formatting is deliberate.
 */
export const stripMarkdown = (variables, characters) => Object.fromEntries(
    Object.entries(variables ?? {}).map(([key, value]) =>
        [key, typeof value === "string" ? value.replace(characters, "") : value])
);

/**
 * The delimiters Telegram's legacy parser pairs, and the bracket it needs a
 * target for.
 */
const TELEGRAM_PAIRS = ["*", "_", "`"];

const occurrences = (text, character) => text.split(character).length - 1;

/**
 * Whether Telegram's legacy parser will accept this message at all.
 *
 * It has no escape syntax and refuses the whole request with a 400 when an
 * entity is left open, which is why every interpolated value is stripped of its
 * metacharacters above. What that pass cannot reach is the operator's own
 * template - deliberately, since its formatting is the point - and one thing
 * still cuts through it: the message is trimmed to 4096 characters on the way
 * out, and a template long enough to be trimmed can lose the closing half of a
 * pair it opened. What is then dropped is usually a failure alert, which is the
 * one nobody can afford to lose.
 *
 * A parity count rather than a parser. Reimplementing the grammar to decide
 * whether a message is sendable would be a second thing to be wrong about, and
 * the cost of the two mistakes is not the same: a message wrongly called
 * unbalanced arrives without its formatting, where one wrongly called balanced
 * does not arrive. So this errs towards plain text, and the caller sends
 * unformatted rather than not at all.
 *
 * Brackets are counted as a pair for the same reason: `[` opens a link the
 * parser then wants a target for, and a trim that took the target with it is
 * the same failure by a different route.
 */
export const balancedForTelegram = (text) => {
    const message = String(text ?? "");

    if (occurrences(message, "[") !== occurrences(message, "]")) return false;

    return TELEGRAM_PAIRS.every((character) => occurrences(message, character) % 2 === 0);
};
