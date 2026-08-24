/**
 * Whether the database can be read, asked once at boot.
 *
 * Upstream #1549 is a boot that failed and then did it 137 more times, and the
 * reporter's way out was to delete the database - losing the history the
 * instance exists to keep - because nothing told them there was another one.
 * describeError already made the message say *what* failed. This says what to do
 * about it, and says it before runMigrations has begun applying itself to a file
 * nothing can read.
 *
 * What this deliberately does not claim is that the file is healthy. sqlite keeps
 * no page checksums, so damage to a page nothing reaches is damage nothing can
 * see: an experiment while writing this overwrote a free page and quick_check
 * answered "ok". "Nothing found" is the strongest available claim and is the one
 * made here.
 *
 * Two things this file exists to get right, both found by trying it rather than
 * by reading about it:
 *
 *  - On a badly damaged file the pragma does not answer with rows describing the
 *    problem. It throws SQLITE_CORRUPT, exactly as an ordinary SELECT would.
 *  - `synchronous` is already FULL under both runtimes in WAL mode - node:sqlite
 *    and bun:sqlite were each measured - so there is nothing to harden there.
 *    The durability half of this was a wrong guess, and setting the pragma would
 *    have been a no-op dressed up as a fix.
 */

/** What a clean answer says, whichever pragma was asked. */
const CLEAN = "ok";

/**
 * quick_check rather than integrity_check.
 *
 * The two differ in that integrity_check also verifies that every index agrees
 * with its table, which means reading every index in full - and this runs on
 * every boot, on a database that may hold a year of minutely tests. quick_check
 * finds a file that cannot be read, which is the question being asked.
 */
export const INTEGRITY_PRAGMA = "PRAGMA quick_check";

/** The driver's own names for "this file is not a database I can read". */
const DAMAGE_CODES = new Set(["SQLITE_CORRUPT", "SQLITE_NOTADB"]);

/** And the wording, for the paths that carry no code to read. */
const DAMAGE_WORDING = /malformed|not a database|file is encrypted/i;

/**
 * Whether a pragma's rows describe damage.
 *
 * The column is named after whichever pragma was run, so the value is taken from
 * the row rather than looked up by a key written out here.
 *
 * An answer with no rows, or one that is not rows at all, is not evidence of
 * anything - and reporting it as damage would send an operator to a recovery
 * procedure their database does not need, which is worse than the silence it
 * replaces.
 */
const problemsIn = (rows) => {
    if (!Array.isArray(rows)) return [];

    return rows
        .map((row) => (row && typeof row === "object" ? Object.values(row)[0] : undefined))
        .filter((value) => typeof value === "string" && value.trim() !== "" && value !== CLEAN);
};

export const isDamaged = (rows) => problemsIn(rows).length > 0;

/**
 * Whether a thrown error is sqlite saying the file is unreadable.
 *
 * Looks through a wrapper at the driver error underneath, because sequelize
 * wraps one - so the code that matters can be a level down.
 */
export const damageFrom = (error) => {
    if (error === null || typeof error !== "object") return false;

    for (const candidate of [error, error.parent, error.original]) {
        if (candidate === null || typeof candidate !== "object") continue;

        if (DAMAGE_CODES.has(candidate.code)) return true;
        if (typeof candidate.message === "string" && DAMAGE_WORDING.test(candidate.message)) return true;
    }

    return false;
};

/**
 * Runs the check.
 *
 * @param query an async function taking SQL and answering rows.
 *
 * A check that could not be run is not a check that failed: a locked database,
 * or a runtime that will not answer the pragma, passes. Only sqlite calling the
 * file unreadable counts, whether it says so in a row or by throwing.
 */
export const checkIntegrity = async (query) => {
    try {
        const rows = await query(INTEGRITY_PRAGMA);
        const problems = problemsIn(rows);

        return problems.length > 0 ? {ok: false, problems} : {ok: true, problems: []};
    } catch (error) {
        if (!damageFrom(error)) return {ok: true, problems: []};

        return {ok: false, problems: [error?.message ?? String(error)]};
    }
};

/**
 * What to print when the check fails.
 *
 * The three ways out, in the order somebody should try them. The destructive one
 * is last and says what it costs: it is what #1549's reporter found unaided, and
 * the history they lost is the thing this whole application is for.
 */
export const recoveryAdvice = (databasePath, problems) => [
    `The database at ${databasePath} could not be read:`,
    ...problems.map((problem) => `  ${problem}`),
    "The server will keep running, but reading or writing tests is likely to fail.",
    "In order of preference:",
    "  1. Restore a backup through Settings, or put back a copy of the file.",
    `  2. Recover what is readable: sqlite3 ${databasePath} ".recover" | sqlite3 recovered.db`,
    `  3. Last resort - delete ${databasePath} and start again. This loses the whole history.`
];
